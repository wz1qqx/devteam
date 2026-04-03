# Workflow: verify

<purpose>Post-deploy verification through smoke tests, benchmarks, accuracy checks, or full verification suites. All commands are config-driven from `.dev.yaml` fields `verify` and `benchmark`.</purpose>
<core_principle>Verify before claiming success. Never guess commands — if config is missing, abort with a clear message telling the user which field to add.</core_principle>

<process>
<step name="INIT" priority="first">
Parse verification mode and load configuration.

```bash
# Auto-discover devflow CLI (marketplace or local install)
DEVFLOW_BIN=$(ls ~/.claude/plugins/cache/devflow/devflow/*/skills/my-dev/bin/my-dev-tools.cjs 2>/dev/null | head -1)

INIT=$(node "$DEVFLOW_BIN" init verify)
WORKSPACE=$(echo "$INIT" | jq -r '.workspace')
```

Extract verify config:
```bash
CURRENT_TAG=$(echo "$INIT" | jq -r '.feature.current_tag')
CLUSTER_NAME=$(echo "$INIT" | jq -r '.cluster.name')
NAMESPACE=$(echo "$INIT" | jq -r '.cluster.namespace')
SSH=$(echo "$INIT" | jq -r '.cluster.ssh')
REGRESSION_THRESHOLD=$(echo "$INIT" | jq -r '.tuning.regression_threshold')

# Verify config
SMOKE_CMD=$(echo "$INIT" | jq -r '.verify.smoke_cmd // empty')
SMOKE_COUNT=$(echo "$INIT" | jq -r '.verify.smoke_count // 5')
WARMUP_COUNT=$(echo "$INIT" | jq -r '.verify.warmup_count // 3')
POD_SELECTOR=$(echo "$INIT" | jq -r '.verify.pod_selector // empty')

# Benchmark config
BENCH_CMD=$(echo "$INIT" | jq -r '.benchmark.mtb_cmd // empty')
BENCH_OUTPUT_DIR=$(echo "$INIT" | jq -r '.benchmark.output_dir // "bench-results"')

# Accuracy config
ACCURACY_CMD=$(echo "$INIT" | jq -r '.verify.accuracy.command // empty')
ACCURACY_BASELINE=$(echo "$INIT" | jq -r '.verify.accuracy.baseline // empty')
ACCURACY_THRESHOLD=$(echo "$INIT" | jq -r '.verify.accuracy.threshold // empty')
ACCURACY_OUTPUT_DIR=$(echo "$INIT" | jq -r '.verify.accuracy.output_dir // "bench-results"')
```

Parse mode from `$ARGUMENTS`: `--smoke`, `--bench`, `--accuracy`, `--full`.

**If NO flag provided**: present modes via AskUserQuestion:

| Mode | Description | When to use |
|------|-------------|-------------|
| smoke | Pod health + single-request test | Quick sanity check |
| bench | Full benchmark via `benchmark.mtb_cmd` | Performance comparison |
| accuracy | Output comparison via `verify.accuracy.command` | Quality validation |
| full | smoke + bench + accuracy | Before release |

Gate: `CURRENT_TAG` must exist. If empty: "No current_tag set. Run `/devflow build` first."
</step>

<step name="SMOKE_TEST">
Quick deployment health check. Runs for `--smoke` and `--full`.

Gate: `SMOKE_CMD` must be non-empty. If empty: "No `verify.smoke_cmd` configured in .dev.yaml. Add it to run smoke tests."

1. **Check pods** (if cluster configured and `POD_SELECTOR` set):
   ```bash
   $SSH kubectl get pods -n $NAMESPACE -l $POD_SELECTOR --no-headers
   ```
   Verify all pods show `Running` + `Ready`. If not, abort: "Pods not ready. Check deployment."

2. **Warmup** ($WARMUP_COUNT requests, discard output):
   ```bash
   for i in $(seq 1 $WARMUP_COUNT); do
     echo "Warmup $i/$WARMUP_COUNT..."
     bash -c "$SMOKE_CMD" > /dev/null 2>&1
   done
   ```

3. **Measure** ($SMOKE_COUNT sequential requests, capture timing):
   ```bash
   for i in $(seq 1 $SMOKE_COUNT); do
     echo "Test $i/$SMOKE_COUNT..."
     time bash -c "$SMOKE_CMD"
   done
   ```

4. **Report**: Show success/failure count and timing summary.

If any request fails (non-zero exit): abort further verification.
```
Smoke test FAILED. N/$SMOKE_COUNT requests failed.
Suggestion: /devflow debug verify-smoke
```
</step>

<step name="BENCHMARK">
Full benchmark execution. Runs for `--bench` and `--full`.

Gate: `BENCH_CMD` must be non-empty. If empty: "No `benchmark.mtb_cmd` configured in .dev.yaml. Add it to run benchmarks."

```bash
mkdir -p "$BENCH_OUTPUT_DIR"
echo "Starting benchmark: $BENCH_CMD"
bash -c "$BENCH_CMD"
```

Execute with `run_in_background=true` for long runs.

On completion:
1. Save results:
   - `$BENCH_OUTPUT_DIR/mtb-${CURRENT_TAG}-run${N}.txt`
   - `$BENCH_OUTPUT_DIR/mtb-${CURRENT_TAG}-run${N}-report.txt`

2. Compare with previous results:
   ```bash
   PREV_TAG=$(echo "$INIT" | jq -r '.build_history[-2].tag // empty')
   ```
   If `PREV_TAG` exists, find `$BENCH_OUTPUT_DIR/mtb-${PREV_TAG}-run*.txt` and compare key metrics.

3. Regression check (threshold: `$REGRESSION_THRESHOLD`%, default 20%):
   - If any key metric regressed beyond threshold:
     ```
     [ANOMALY] Performance regression detected:
       <metric>: <old> -> <new> (+<pct>%)
     Enter debug mode? /devflow debug bench-regression
     ```
</step>

<step name="ACCURACY_TEST">
Accuracy verification. Runs for `--accuracy` and `--full`.

Gate: `ACCURACY_CMD` must be non-empty. If empty: "No `verify.accuracy.command` configured in .dev.yaml. Add it to run accuracy tests."

```bash
mkdir -p "$ACCURACY_OUTPUT_DIR"
echo "Running accuracy verification: $ACCURACY_CMD"
bash -c "$ACCURACY_CMD"
```

Save results: `$ACCURACY_OUTPUT_DIR/accuracy-${CURRENT_TAG}-run${N}.json`

Compare against baseline (`$ACCURACY_BASELINE`):
- Within `$ACCURACY_THRESHOLD`%: PASS
- Exceeds threshold:
  ```
  [ANOMALY] Accuracy deviation detected:
    Deviation: <pct>% (threshold: $ACCURACY_THRESHOLD%)
  Enter debug mode? /devflow debug accuracy-regression
  ```
</step>

<step name="POST_VERIFY">
Run post-verify hooks and update state.

Execute `.hooks.post_verify` checks from .dev.yaml (non-blocking: warn on failure).

Update `.dev.yaml`:
- Set `feature.phase` to `verify`

Checkpoint (@references/shared-patterns.md#checkpoint):
```bash
node "$DEVFLOW_BIN" checkpoint \
  --action "verify" \
  --summary "Verify $VERDICT: $CURRENT_TAG ($MODE)"
```

Output:
```
Verification complete: $CURRENT_TAG
Mode: $MODE
Verdict: $VERDICT

Next: /devflow observe (for ongoing monitoring)
```
</step>

<step name="REFLECTION">
@references/shared-patterns.md#experience-sink

Detection criteria: benchmark regression > $REGRESSION_THRESHOLD%, accuracy deviation > threshold, smoke test failure
Target file: `verify-lessons.md`
Context fields: `tag=$CURRENT_TAG, verdict=$VERDICT, mode=$MODE`
</step>
</process>
