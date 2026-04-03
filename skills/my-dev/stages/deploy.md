# Workflow: deploy

<purpose>Deploy container image to Kubernetes cluster with hook execution, namespace safety, and pod readiness verification.</purpose>
<core_principle>Namespace safety is non-negotiable. ALL kubectl commands MUST include -n <namespace>. Production clusters require explicit confirmation for every destructive operation.</core_principle>

<process>
<step name="INIT" priority="first">
Initialize workflow and load deploy configuration.

```bash
# Auto-discover devflow CLI (marketplace or local install)
DEVFLOW_BIN=$(ls ~/.claude/plugins/cache/devflow/devflow/*/skills/my-dev/bin/my-dev-tools.cjs 2>/dev/null | head -1)

INIT=$(node "$DEVFLOW_BIN" init deploy)
WORKSPACE=$(echo "$INIT" | jq -r '.workspace')
```

Extract deploy config:
```bash
CURRENT_TAG=$(echo "$INIT" | jq -r '.feature.current_tag')
CLUSTER_NAME=$(echo "$INIT" | jq -r '.cluster.name')
NAMESPACE=$(echo "$INIT" | jq -r '.cluster.namespace')
SSH=$(echo "$INIT" | jq -r '.cluster.ssh')
SAFETY=$(echo "$INIT" | jq -r '.cluster.safety')
DEPLOY_CONFIG=$(echo "$INIT" | jq -r '.deploy')
STRATEGY=$(echo "$DEPLOY_CONFIG" | jq -r '.strategy // "apply"')
```
</step>

<step name="SPECIFICITY_GATE">
Check if the deploy request is specific enough for direct execution.

```bash
SPEC_CHECK=$(node "$DEVFLOW_BIN" check-specificity "$ARGUMENTS")
SPECIFIC=$(echo "$SPEC_CHECK" | jq -r '.specific')
```

If NOT specific (missing cluster, tag, or feature context):
- Check: `CURRENT_TAG` must be non-empty. If null: "No image tag set. Run `/devflow:build` first?"
- Check: `CLUSTER_NAME` must be non-empty. If null: present cluster selection via AskUserQuestion
- Check: `NAMESPACE` must be non-empty. If null: abort with clear error

If `$ARGUMENTS` contains `--force`, skip this gate.
</step>

<step name="COLLISION_CHECK">
Check if another feature is already deployed to the same cluster/namespace.

```bash
ALL_FEATURES=$(echo "$INIT" | jq -r '.all_clusters // empty')
```

Scan all features in `.dev.yaml` for:
- Same `cluster` value as current deploy target
- Different feature name than current feature
- Phase is `deploy`, `verify`, or `observe` (actively using the cluster)

If collision detected:
```
⚠️  Feature "$OTHER_FEATURE" is already deployed to $CLUSTER_NAME / $NAMESPACE
    Tag: $OTHER_TAG | Phase: $OTHER_PHASE

    Proceeding will overwrite the existing deployment.
    Continue? [Y/n]
```

For `safety: prod` clusters, require explicit confirmation even without collision.
</step>

Gate: `current_tag` must exist (build completed). If not, abort: "No built image. Run `/devflow build` first."
Gate: `active_cluster` must be set. If not, abort: "No cluster configured. Run `/devflow cluster use <name>`."
</step>

<step name="PRE_DEPLOY_HOOKS">
Execute pre-deploy hooks and learned hooks.

Execute pre_deploy checks from `.hooks.pre_deploy` in .dev.yaml:
For each hook in `.hooks.pre_deploy`, perform the check inline:
- `pre_deploy_yaml_validate`: Validate deploy YAML syntax and required fields (namespace, image tag, resource limits)
- `pre_deploy_tag_exists`: Verify the image tag exists in the registry
- (Other hooks as listed in config — read the hook name and perform the corresponding verification)

Execute learned checks for pre_deploy phase:
For each entry in `.hooks.learned` where `trigger == "pre_deploy"`:
- Read the `rule` field and verify it inline
- Example rules: "YAML port name <= 15 chars", "namespace must match .dev.yaml cluster config"
- If the rule is unclear, show it to the user and ask for guidance

Load experience anti-patterns:
```bash
VAULT=$(echo "$INIT" | jq -r '.vault')
DEVLOG_GROUP=$(echo "$INIT" | jq -r '.devlog.group')
EXPERIENCE_DIR="$VAULT/$DEVLOG_GROUP/experience"
```
Scan `$EXPERIENCE_DIR/` for files matching deploy-related topics (e.g., `k8s-deploy-lessons.md`, `*-patterns.md`).
Extract all **Anti-patterns** sections and display as warnings:
```
⚠ 已知部署陷阱 (来自历史经验):
  ✗ <anti-pattern 1> — <why it's wrong>
  ✗ <anti-pattern 2> — <why it's wrong>
```
This is informational — does not block deploy, but ensures the operator is aware before proceeding.

Gate: ALL pre_deploy hooks must pass.
</step>

<step name="NAMESPACE_SAFETY">
Verify namespace and apply safety checks.

```bash
# CRITICAL: Verify namespace is correct
echo "Target namespace: $NAMESPACE"
echo "Target cluster: $CLUSTER_NAME"
```

If `safety == "prod"`:
```
[PRODUCTION CLUSTER]
You are deploying to a PRODUCTION cluster: $CLUSTER_NAME
Namespace: $NAMESPACE
Image: $CURRENT_TAG

Type the namespace name to confirm: _____
```
Require user to type the exact namespace name. Mismatch aborts.

If `safety == "normal"`:
```
Deploying $CURRENT_TAG to $CLUSTER_NAME/$NAMESPACE
Confirm? (yes/abort)
```
</step>

<step name="EXECUTE_DEPLOY">
Run the deployment based on configured strategy.

**Strategy: delete-then-apply** (typical for DGD):
```bash
# Step 1: Delete existing resource
RESOURCE_KIND=$(echo "$DEPLOY_CONFIG" | jq -r '.resource_kind // "deployment"')
DGD_NAME=$(echo "$DEPLOY_CONFIG" | jq -r '.dgd_name')
echo "Deleting existing $RESOURCE_KIND/$DGD_NAME..."
$SSH kubectl delete "$RESOURCE_KIND" "$DGD_NAME" -n "$NAMESPACE" --ignore-not-found=true

# Step 2: Wait for cleanup
echo "Waiting for pods to terminate..."
$SSH kubectl wait --for=delete pod -l "app=$DGD_NAME" -n "$NAMESPACE" --timeout=120s 2>/dev/null || true

# Step 3: Apply new deployment
YAML_FILE=$(echo "$DEPLOY_CONFIG" | jq -r '.yaml_file')
echo "Applying deployment from $YAML_FILE..."
$SSH kubectl apply -f "$YAML_FILE" -n "$NAMESPACE"
```

**Strategy: apply** (standard rolling update):
```bash
YAML_FILE=$(echo "$DEPLOY_CONFIG" | jq -r '.yaml_file')
$SSH kubectl apply -f "$YAML_FILE" -n "$NAMESPACE"
```

**Strategy: custom** (project-specific commands):
```bash
DEPLOY_CMD=$(echo "$DEPLOY_CONFIG" | jq -r '.commands.default')
bash -c "$DEPLOY_CMD"
```

Execute with `run_in_background=true` if expected to be long-running.
</step>

<step name="POST_DEPLOY_HOOKS">
Run post-deploy hooks (warn on failure, don't abort).

Execute post_deploy checks from `.hooks.post_deploy` in .dev.yaml:
For each hook in `.hooks.post_deploy`, perform the check inline:
- `post_deploy_label_services`: Label headless services with dynamo discovery labels
- `wait_all_pods_ready`: Wait for all pods to reach Running+Ready state
- (Other hooks as listed in config — read the hook name and perform the corresponding action)
Post-deploy hooks are non-blocking: warn on failure but do not abort.
</step>

<step name="WAIT_FOR_READY">
Wait for pods to be ready with timeout monitoring.

```bash
echo "Waiting for pods to become ready..."
TIMEOUT=$(echo "$INIT" | jq -r '.tuning.deploy_timeout')
ELAPSED=0
INTERVAL=$(echo "$INIT" | jq -r '.tuning.deploy_poll_interval')

while [ $ELAPSED -lt $TIMEOUT ]; do
  PODS=$($SSH kubectl get pods -n "$NAMESPACE" -l "app=$DGD_NAME" -o json)
  READY=$(echo "$PODS" | jq '[.items[].status.containerStatuses[]?.ready] | all')
  TOTAL=$(echo "$PODS" | jq '.items | length')
  RUNNING=$(echo "$PODS" | jq '[.items[] | select(.status.phase=="Running")] | length')

  echo "Pods: $RUNNING/$TOTAL running"

  if [ "$READY" == "true" ] && [ "$TOTAL" -gt 0 ]; then
    echo "All pods ready!"
    break
  fi

  # CRITICAL: If stuck past timeout, check logs immediately
  if [ $ELAPSED -ge $TIMEOUT ]; then
    echo "[ALERT] Pods stuck after ${TIMEOUT}s. Checking logs..."
    PROBLEM_POD=$($SSH kubectl get pods -n "$NAMESPACE" -l "app=$DGD_NAME" --no-headers | head -1 | awk '{print $1}')
    $SSH kubectl logs "$PROBLEM_POD" -n "$NAMESPACE" --tail=50
    echo "Consider: /devflow debug deploy-stuck"
    break
  fi

  sleep $INTERVAL
  ELAPSED=$((ELAPSED + INTERVAL))
done
```

Gate: If pods not ready after timeout, warn but don't fail (user may want to investigate).
</step>

<step name="UPDATE_STATE">
Update .dev.yaml and checkpoint.

Update `.dev.yaml`:
- Set `project.phase` to `deploy`
- Record deploy timestamp

Checkpoint (@references/shared-patterns.md#checkpoint):
```bash
node "$DEVFLOW_BIN" checkpoint \
  --action "deploy" \
  --summary "Deployed $CURRENT_TAG to $CLUSTER_NAME/$NAMESPACE ($STRATEGY)"
```

Output:
```
Deploy complete: $CURRENT_TAG -> $CLUSTER_NAME/$NAMESPACE
Strategy: $STRATEGY
Pods: $RUNNING/$TOTAL ready

Next: /devflow verify --smoke
```
</step>

<step name="REFLECTION">
@references/shared-patterns.md#experience-sink

Detection criteria: pod stuck >5min, hook warnings, stale_pod_cleanup needed, strategy retry, post-deploy warnings
Target file: `k8s-deploy-lessons.md`
Context fields: `tag=$CURRENT_TAG, cluster=$CLUSTER_NAME, namespace=$NAMESPACE, strategy=$STRATEGY`
</step>
</process>
