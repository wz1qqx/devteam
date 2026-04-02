# Workflow: verify

<purpose>Post-deploy verification through smoke tests, benchmarks, accuracy checks, or full verification suites. Detects regressions and triggers debug mode on anomalies.</purpose>
<core_principle>Verify before claiming success. Benchmark comparisons must use temperature=0.0 for deterministic results. Regression threshold is configurable via `tuning.regression_threshold` (default 20%).</core_principle>

<process>
<step name="INIT" priority="first">
Parse verification flags and load configuration.

```bash
INIT=$(node "$HOME/.claude/my-dev/bin/my-dev-tools.cjs" init verify)
WORKSPACE=$(echo "$INIT" | jq -r '.workspace')
```

Parse flags from arguments:
- `--smoke` (default if no flag): quick smoke test
- `--bench`: full benchmark run
- `--accuracy`: accuracy verification
- `--full`: all of the above + observe --analyze

Extract verify config:
```bash
CURRENT_TAG=$(echo "$INIT" | jq -r '.feature.current_tag')
BENCHMARK_CONFIG=$(echo "$INIT" | jq -r '.benchmark')
ACCURACY_CONFIG=$(echo "$INIT" | jq -r '.benchmark.accuracy // empty')
CLUSTER_NAME=$(echo "$INIT" | jq -r '.cluster.name')
NAMESPACE=$(echo "$INIT" | jq -r '.cluster.namespace')
SSH=$(echo "$INIT" | jq -r '.cluster.ssh')
```

Gate: Deployment must exist. Check pods are running before starting verification.
</step>

<step name="SMOKE_TEST">
Run quick smoke test (always runs first).

1. **Warmup**: Send 2-3 throwaway requests to ensure model is loaded
   ```bash
   # Project-specific warmup command from config, or generic curl
   for i in 1 2 3; do
     echo "Warmup request $i..."
     # Execute warmup request (project-specific)
   done
   ```

2. **Measure**: 5 sequential requests, capture key metrics
   ```bash
   echo "Running smoke test: 5 sequential requests..."
   # Execute 5 requests, capture: TTFT, TPOT, E2E latency, throughput
   ```

3. **Report**:
   ```
   Smoke Test: $CURRENT_TAG
   | Metric     | p50    | p90    | p99    |
   |------------|--------|--------|--------|
   | TTFT       | X ms   | X ms   | X ms   |
   | TPOT       | X ms   | X ms   | X ms   |
   | E2E        | X ms   | X ms   | X ms   |
   | Throughput | X tok/s |       |        |

   Status: PASS (all requests succeeded)
   ```

If smoke test fails (errors, timeouts): abort further verification.
```
Smoke test FAILED. N/5 requests failed.
Suggestion: /devflow debug verify-smoke
```
</step>

<step name="BENCHMARK">
Run full benchmark if `--bench` or `--full` flag.

```bash
MTB_DIR=$(echo "$BENCHMARK_CONFIG" | jq -r '.mtb_dir')
MODEL_PATH=$(echo "$BENCHMARK_CONFIG" | jq -r '.model_path')
```

Execute benchmark command (background for long runs):
```bash
# Build benchmark command from config
# CRITICAL: temperature=0.0 for reproducible results
BENCH_CMD="<constructed from benchmark config>"
echo "Starting benchmark (background)..."
```

Execute with `run_in_background=true`.

On completion:
1. Save results to `bench-results/`:
   - JSON log: `bench-results/mtb-${CURRENT_TAG}-run${N}.txt`
   - Terminal report: `bench-results/mtb-${CURRENT_TAG}-run${N}-report.txt`

2. Compare with previous results via bench-compare skill:
   ```bash
   # Find previous benchmark for comparison
   PREV_TAG=$(echo "$INIT" | jq -r '.build_history[-2].tag // empty')
   PREV_RESULT="bench-results/mtb-${PREV_TAG}-run*.txt"
   CURR_RESULT="bench-results/mtb-${CURRENT_TAG}-run${N}.txt"
   ```

3. Regression check (threshold from `tuning.regression_threshold`, default 20%):
   ```bash
   REGRESSION_THRESHOLD=$(echo "$INIT" | jq -r '.tuning.regression_threshold')
   ```
   - If any key metric regressed > $REGRESSION_THRESHOLD%:
     ```
     [ANOMALY] Performance regression detected:
       TTFT p99: 2.3s -> 3.1s (+35%)

     Enter debug mode? /devflow debug bench-regression
     ```
</step>

<step name="ACCURACY_TEST">
Run accuracy verification if `--accuracy` or `--full` flag.

```bash
if [ -n "$ACCURACY_CONFIG" ]; then
  ACCURACY_CMD=$(echo "$ACCURACY_CONFIG" | jq -r '.command')
  BASELINE=$(echo "$ACCURACY_CONFIG" | jq -r '.baseline')
  THRESHOLD=$(echo "$ACCURACY_CONFIG" | jq -r '.threshold')
  OUTPUT_DIR=$(echo "$ACCURACY_CONFIG" | jq -r '.output_dir // "bench-results"')
fi
```

Execute accuracy test:
```bash
echo "Running accuracy verification..."
bash -c "$ACCURACY_CMD"
```

Save results: `$OUTPUT_DIR/accuracy-${CURRENT_TAG}-run${N}.json`

Compare against baseline:
- Within threshold: PASS
- Exceeds threshold:
  ```
  [ANOMALY] Accuracy deviation detected:
    Metric: <name>
    Baseline: <value>
    Current: <value>
    Deviation: <pct>% (threshold: <threshold>%)

  Enter debug mode? /devflow debug accuracy-regression
  ```
</step>

<step name="FULL_ANALYSIS">
Run full analysis if `--full` flag. Includes observe --analyze.

After smoke + bench + accuracy complete:
```
Running cross-analysis...
```

Use external Grafana dashboard for metrics correlation analysis.

Generate comprehensive verification report:
```markdown
# Verification Report: $CURRENT_TAG

## Smoke Test: PASS/FAIL
<smoke results>

## Benchmark: PASS/FAIL/REGRESSION
<bench comparison table>

## Accuracy: PASS/FAIL/DEVIATION
<accuracy comparison>

## Metrics Analysis
<from observe --analyze>

## Overall Verdict: PASS / PASS_WITH_WARNINGS / FAIL
```
</step>

<step name="POST_VERIFY_HOOKS">
Run post-verify hooks and update state.

Execute post_verify checks from `.hooks.post_verify` in .dev.yaml:
For each hook in `.hooks.post_verify`, perform the check inline:
- Read the hook name and perform the corresponding verification
- Post-verify hooks are non-blocking: warn on failure but do not abort

Update `.dev.yaml`:
- Set `project.phase` to `verify`

Checkpoint (@references/shared-patterns.md#checkpoint):
```bash
node "$HOME/.claude/my-dev/bin/my-dev-tools.cjs" checkpoint \
  --action "verify" \
  --summary "Verify $VERDICT: $CURRENT_TAG ($FLAGS)"
```

Output:
```
Verification complete: $CURRENT_TAG
Verdict: $VERDICT

Results saved:
  bench-results/mtb-$CURRENT_TAG-run$N.txt
  bench-results/mtb-$CURRENT_TAG-run$N-report.txt

Next: /devflow observe --analyze (for deeper analysis)
```
</step>

<step name="REFLECTION">
@references/shared-patterns.md#experience-sink

Detection criteria: benchmark regression > $REGRESSION_THRESHOLD%, accuracy deviation > threshold, smoke test failure
Target file: `performance-lessons.md` (bench/smoke) or `accuracy-lessons.md` (accuracy)
Context fields: `tag=$CURRENT_TAG, verdict=$VERDICT, flags=$FLAGS`
</step>
</process>
