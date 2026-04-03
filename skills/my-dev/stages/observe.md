# Workflow: observe (ensure-monitoring)

<purpose>Check if the active cluster has the required monitoring stack. If not, trigger setup. Called automatically by cluster:use and deploy.</purpose>
<core_principle>Idempotent check: fast path when already configured, full setup when not. No manual observe commands needed.</core_principle>

<process>
<step name="INIT" priority="first">
Load cluster and observability configuration.

```bash
# Auto-discover devflow CLI (marketplace or local install)
DEVFLOW_BIN=$(ls ~/.claude/plugins/cache/devflow/devflow/*/skills/my-dev/bin/my-dev-tools.cjs 2>/dev/null | head -1)

INIT=$(node "$DEVFLOW_BIN" init observe)
WORKSPACE=$(echo "$INIT" | jq -r '.workspace')
CLUSTER_NAME=$(echo "$INIT" | jq -r '.cluster.name')
CLUSTER_SSH=$(echo "$INIT" | jq -r '.cluster.ssh')
NAMESPACE=$(echo "$INIT" | jq -r '.cluster.namespace')
PROM_SVC=$(echo "$INIT" | jq -r '.observability.prometheus.svc // empty')
```
</step>

<step name="CHECK">
Verify monitoring stack health via SSH.

```bash
# 1. Prometheus running?
PROM_PODS=$($CLUSTER_SSH "kubectl get pods -n monitor -l app.kubernetes.io/name=prometheus --no-headers 2>/dev/null" | grep -c Running)

# 2. PodMonitors exist?
PODMON_COUNT=$($CLUSTER_SSH "kubectl get podmonitor -n $NAMESPACE --no-headers 2>/dev/null" | wc -l | tr -d ' ')

# 3. Remote-write secret exists?
RW_SECRET=$($CLUSTER_SSH "kubectl get secret remote-write-creds -n monitor --no-headers 2>/dev/null" | wc -l | tr -d ' ')
```

Evaluate:
- `PROM_PODS >= 1` AND `PODMON_COUNT >= 1` → **READY**
- Otherwise → **NEEDS_SETUP**

If READY:
```
Monitoring: OK (Prometheus running, $PODMON_COUNT PodMonitors, remote-write: ${RW_SECRET:+configured}${RW_SECRET:-not configured})
```
Return immediately.
</step>

<step name="SETUP">
Deploy monitoring stack. Only runs when CHECK finds gaps.

1. **Helm repos** (Chinese mirrors):
   ```bash
   $CLUSTER_SSH "helm repo add prometheus-community 'https://helm-charts.itboon.top/prometheus-community' --force-update && helm repo update"
   ```

2. **Install kube-prometheus-stack**:
   ```bash
   $CLUSTER_SSH "helm install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
     --set grafana.enabled=false \
     --set prometheus.prometheusSpec.podMonitorSelectorNilUsesHelmValues=false \
     --set-json 'prometheus.prometheusSpec.podMonitorNamespaceSelector={}' \
     --set-json 'prometheus.prometheusSpec.probeNamespaceSelector={}' \
     -n monitor --create-namespace"
   ```

3. **Remote-write to VictoriaMetrics** (if configured in .dev.yaml):
   ```bash
   REMOTE_URL=$(echo "$INIT" | jq -r '.observability.prometheus.remote_write.url // empty')
   if [ -n "$REMOTE_URL" ]; then
     # Create secret + upgrade with remote-write config
   fi
   ```

4. **Configure Dynamo Operator prometheusEndpoint**:
   ```bash
   $CLUSTER_SSH "helm upgrade dynamo-platform <chart> -n dynamo-system --reuse-values \
     --set prometheusEndpoint=http://prometheus-operated.monitor:9090"
   ```

5. **Verify**:
   ```bash
   $CLUSTER_SSH "kubectl -n monitor get pods --no-headers" | grep Running
   $CLUSTER_SSH "kubectl get podmonitor -n $NAMESPACE --no-headers"
   ```

Output:
```
Monitoring setup complete on $CLUSTER_NAME:
  Prometheus: Running
  PodMonitors: $PODMON_COUNT
  Remote-write: ${REMOTE_URL:-not configured}
```
</step>
</process>
