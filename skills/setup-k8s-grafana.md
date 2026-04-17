# Skill: setup-k8s-grafana

<purpose>Deploy and configure Prometheus remote_write + Grafana dashboards on the active K8s cluster. Reads all config from workspace.yaml observability block.</purpose>
<core_principle>Config-driven: every parameter comes from $INIT.observability. Nothing is hardcoded. Idempotent — safe to re-run to update dashboards or alert rules.</core_principle>

<process>

<step name="INIT" priority="first">
Load workspace and observability config.

```bash
DEVTEAM_BIN="${HOME}/.claude/plugins/marketplaces/devteam/lib/devteam.cjs"
[ -f "$DEVTEAM_BIN" ] || DEVTEAM_BIN=$(ls ~/.claude/plugins/cache/devteam/devteam/*/lib/devteam.cjs 2>/dev/null | head -1)
[ -n "$DEVTEAM_BIN" ] || { echo "ERROR: devteam.cjs not found" >&2; exit 1; }
INIT=$(node "$DEVTEAM_BIN" init observability)

SSH=$(echo "$INIT" | jq -r '.cluster.ssh')
NAMESPACE=$(echo "$INIT" | jq -r '.cluster.namespace')

# Observability config
PROM_SVC=$(echo "$INIT" | jq -r '.observability.prometheus.svc // empty')
PROM_RW_URL=$(echo "$INIT" | jq -r '.observability.prometheus.remote_write.url // empty')
PROM_RW_SECRET=$(echo "$INIT" | jq -r '.observability.prometheus.remote_write.secret // empty')
GRAFANA_ENABLED=$(echo "$INIT" | jq -r '.observability.grafana.enabled // false')
GRAFANA_DASHBOARDS_DIR=$(echo "$INIT" | jq -r '.observability.grafana.dashboards_dir // empty')
GRAFANA_URL=$(echo "$INIT" | jq -r '.observability.grafana.external_url // empty')

# Alert thresholds
ALERT_GPU_MIN=$(echo "$INIT" | jq -r '.observability.alerts.gpu_utilization_min // 20')
ALERT_P99_PCT=$(echo "$INIT" | jq -r '.observability.alerts.p99_latency_increase_pct // 30')
ALERT_ERR_MAX=$(echo "$INIT" | jq -r '.observability.alerts.error_rate_max_pct // 1.0')
ALERT_INTERVAL=$(echo "$INIT" | jq -r '.observability.alerts.check_interval_min // 5')
```

Gate: `observability` block must be present in workspace.yaml. If `$PROM_SVC` and `$GRAFANA_ENABLED` are both empty/false, warn and exit — nothing to configure.
</step>

<step name="PROMETHEUS_REMOTE_WRITE">
**Skip if `$PROM_RW_URL` is empty.**

Configure vLLM service to expose metrics and set up Prometheus remote_write.

1. Verify Prometheus is reachable on the cluster:
```bash
$SSH "kubectl get svc $PROM_SVC -n $NAMESPACE -o jsonpath='{.spec.clusterIP}'"
```

2. Patch remote_write into the Prometheus configmap:
```bash
$SSH "kubectl get configmap prometheus-config -n $NAMESPACE -o json" \
  # Add remote_write block with url=$PROM_RW_URL and bearer_token_file=$PROM_RW_SECRET
  # Apply with: kubectl apply -f -
```

3. Reload Prometheus config:
```bash
$SSH "kubectl exec -n $NAMESPACE deploy/prometheus -- \
  curl -sX POST http://localhost:9090/-/reload"
```
</step>

<step name="GRAFANA_DASHBOARDS">
**Skip if `$GRAFANA_ENABLED != true` or `$GRAFANA_DASHBOARDS_DIR` is empty.**

Deploy dashboard JSON files from `$GRAFANA_DASHBOARDS_DIR` to Grafana via API.

```bash
# List dashboard files
ls "$GRAFANA_DASHBOARDS_DIR"/*.json 2>/dev/null

# For each dashboard file, upload via Grafana HTTP API
for DASH in "$GRAFANA_DASHBOARDS_DIR"/*.json; do
  DASH_NAME=$(basename "$DASH" .json)
  echo "Uploading dashboard: $DASH_NAME"
  curl -sf -X POST "$GRAFANA_URL/api/dashboards/db" \
    -H "Content-Type: application/json" \
    -d "{\"dashboard\": $(cat $DASH), \"overwrite\": true, \"folderId\": 0}"
done
```

Report: list of uploaded dashboards and their Grafana URLs.
</step>

<step name="ALERT_RULES">
Generate and apply PrometheusRule for the configured thresholds.

Create alert rule manifest from `$ALERT_*` variables:
```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: vllm-alerts
  namespace: $NAMESPACE
spec:
  groups:
    - name: vllm.rules
      interval: ${ALERT_INTERVAL}m
      rules:
        - alert: GPUUtilizationLow
          expr: avg(vllm_gpu_utilization) < $ALERT_GPU_MIN
          for: 10m
          annotations:
            summary: "GPU utilization below ${ALERT_GPU_MIN}%"

        - alert: P99LatencyRegression
          expr: |
            (vllm_request_latency_p99 - vllm_request_latency_p99 offset 1h)
            / vllm_request_latency_p99 offset 1h * 100 > $ALERT_P99_PCT
          for: 5m
          annotations:
            summary: "p99 latency increased by >${ALERT_P99_PCT}% vs 1h ago"

        - alert: ErrorRateHigh
          expr: rate(vllm_request_errors_total[5m]) / rate(vllm_requests_total[5m]) * 100 > $ALERT_ERR_MAX
          for: 2m
          annotations:
            summary: "Error rate >${ALERT_ERR_MAX}%"
```

Apply:
```bash
$SSH "kubectl apply -f - -n $NAMESPACE" < alert_rules.yaml
```
</step>

<step name="VERIFY">
Confirm each component is active:

```bash
# Prometheus scraping
$SSH "curl -sf http://$PROM_SVC/api/v1/targets | jq '.data.activeTargets | length'"

# Grafana reachable
[ -n "$GRAFANA_URL" ] && curl -sf "$GRAFANA_URL/api/health" | jq '.database'

# Alert rules loaded
$SSH "kubectl get prometheusrule vllm-alerts -n $NAMESPACE"
```

Output summary:
```
Observability setup complete for $NAMESPACE
  Prometheus: $PROM_SVC  remote_write → $PROM_RW_URL
  Grafana:    $GRAFANA_URL  (N dashboards deployed)
  Alerts:     GPU <$ALERT_GPU_MIN%  p99 +$ALERT_P99_PCT%  err >$ALERT_ERR_MAX%
```
</step>

</process>
