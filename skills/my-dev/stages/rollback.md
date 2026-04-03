# Workflow: rollback

<purpose>Roll back deployment to a previous image tag from build history.</purpose>
<core_principle>Safe rollback with confirmation. Update all state (deploy YAML, .dev.yaml, checkpoint) atomically.</core_principle>

<process>
<step name="INIT" priority="first">
Load configuration and determine rollback target.

```bash
# Auto-discover devflow CLI (marketplace or local install)
DEVFLOW_BIN=$(ls ~/.claude/plugins/cache/devflow/devflow/*/skills/my-dev/bin/my-dev-tools.cjs 2>/dev/null | head -1)

INIT=$(node "$DEVFLOW_BIN" init rollback)
WORKSPACE=$(echo "$INIT" | jq -r '.workspace')
CURRENT_TAG=$(echo "$INIT" | jq -r '.feature.current_tag')
TARGET_TAG="$1"  # Optional: specific tag to roll back to
```
</step>

<step name="RESOLVE_TARGET">
Determine which tag to roll back to.

If `TARGET_TAG` provided:
```bash
# Verify tag exists in build_history
EXISTS=$(echo "$INIT" | jq -r ".build_history[] | select(.tag == \"$TARGET_TAG\") | .tag")
if [ -z "$EXISTS" ]; then
  echo "Tag '$TARGET_TAG' not found in build_history. Available tags:"
  echo "$INIT" | jq -r '.build_history[].tag'
  exit 1
fi
```

If no tag provided:
```bash
# Pick previous tag (one before current)
PREV_TAG=$(echo "$INIT" | jq -r '.build_history[-2].tag // empty')
if [ -z "$PREV_TAG" ]; then
  echo "No previous tag in build_history. Cannot rollback."
  exit 1
fi
TARGET_TAG="$PREV_TAG"
```

Confirm:
```
Rollback: $CURRENT_TAG -> $TARGET_TAG
Cluster: $CLUSTER_NAME/$NAMESPACE
Strategy: $STRATEGY

Proceed? (yes/abort)
```
</step>

<step name="EXECUTE_ROLLBACK">
Update deploy YAML and re-deploy.

```bash
# Update image tag in deploy YAML
YAML_FILE=$(echo "$INIT" | jq -r '.deploy.yaml_file')
REGISTRY=$(echo "$INIT" | jq -r '.build_server.registry')
# Replace current tag with target tag in the YAML
sed -i '' "s|$CURRENT_TAG|$TARGET_TAG|g" "$YAML_FILE"
```

Re-deploy using the deploy workflow strategy:
```bash
STRATEGY=$(echo "$INIT" | jq -r '.deploy.strategy // "apply"')
SSH=$(echo "$INIT" | jq -r '.cluster.ssh')
NAMESPACE=$(echo "$INIT" | jq -r '.cluster.namespace')

if [ "$STRATEGY" == "delete-then-apply" ]; then
  DGD_NAME=$(echo "$INIT" | jq -r '.deploy.dgd_name')
  RESOURCE_KIND=$(echo "$INIT" | jq -r '.deploy.resource_kind // "deployment"')
  $SSH kubectl delete "$RESOURCE_KIND" "$DGD_NAME" -n "$NAMESPACE" --ignore-not-found=true
  sleep 10
fi

$SSH kubectl apply -f "$YAML_FILE" -n "$NAMESPACE"
```

Execute post_deploy checks from `.hooks.post_deploy` in .dev.yaml:
For each hook in `.hooks.post_deploy`, perform the check inline:
- `post_deploy_label_services`: Label headless services with dynamo discovery labels
- `wait_all_pods_ready`: Wait for all pods to reach Running+Ready state
- (Other hooks as listed in config — read the hook name and perform the corresponding action)
Post-deploy hooks are non-blocking: warn on failure but do not abort.
</step>

<step name="UPDATE_STATE">
Update .dev.yaml and checkpoint.

Update `.dev.yaml`:
- Set `project.current_tag` to `$TARGET_TAG`
- Set `project.phase` to `deploy`

Checkpoint (@references/shared-patterns.md#checkpoint):
```bash
node "$DEVFLOW_BIN" checkpoint \
  --action "rollback" \
  --summary "Rollback: $CURRENT_TAG -> $TARGET_TAG on $CLUSTER_NAME/$NAMESPACE"
```

Output:
```
Rollback complete: $CURRENT_TAG -> $TARGET_TAG
Cluster: $CLUSTER_NAME/$NAMESPACE

Next: /devflow verify --smoke
```
</step>
</process>
