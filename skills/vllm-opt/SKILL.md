---
name: vllm-opt
description: "Analyze vLLM inference performance regressions with benchmarks, profiler traces, and kernel/category breakdowns. Use when the user asks for vLLM optimization, profiling, latency/throughput regression analysis, TTFT/TPOT diagnosis, Nsight, torch profiler, or kernel bottleneck guidance."
---

# vLLM Optimization

Use this skill as an independent optimization workflow for a selected devteam
track. It reads workspace and track context through the devteam CLI, then works
from benchmark and profiler evidence.

Core rule: benchmark first, profile second, recommend changes last.

## Workspace And Track

Start by resolving the devteam workspace and selected track:

```bash
DEVTEAM_BIN="${DEVTEAM_CLI:-${HOME}/Documents/devteam/lib/devteam.cjs}"
[ -f "$DEVTEAM_BIN" ] || DEVTEAM_BIN="${HOME}/.claude/plugins/marketplaces/devteam/lib/devteam.cjs"
[ -f "$DEVTEAM_BIN" ] || DEVTEAM_BIN=$(ls ~/.claude/plugins/cache/devteam/devteam/*/lib/devteam.cjs 2>/dev/null | tail -1)
node "$DEVTEAM_BIN" workspace context --root <workspace-root> --for codex --text
node "$DEVTEAM_BIN" track list --root <workspace-root> --active-only --text
node "$DEVTEAM_BIN" track context --root <workspace-root> --set <track> --text
```

If the user has not selected a track, ask them to choose one. Do not mutate the
workspace default track just to run optimization analysis.

## Inputs To Collect

Before running expensive profiling, collect:

- target track and worktree under test
- model name and serving endpoint
- hardware type and GPU count
- current image or editable venv source being tested
- baseline result and current result
- exact benchmark command, request rate, prompt/output lengths, concurrency,
  dataset, and sampling settings
- metric deltas: TTFT, TPOT, ITL, throughput, e2e latency, error rate
- whether CUDA graphs, eager mode, chunked prefill, speculative decoding,
  disaggregated prefill/decode, NIXL, MLA, or custom kernels are involved

If these are missing, ask for the smallest missing set or derive them from the
run evidence and remote env profile when possible.

## Benchmark Rules

- Compare medians across repeated runs, preferably 3 or more runs.
- Keep model, image/source, GPU topology, request shape, and server flags fixed.
- Do not compare profiled latency with non-profiled latency.
- Check GPU health before profiling: temperature, memory pressure, clocks,
  utilization, ECC/Xid errors, and stale processes.
- Use `--enforce-eager` when the goal is kernel visibility and CUDA graphs hide
  the relevant kernels.

## Profiling Paths

Prefer the least disruptive path that answers the question.

Torch profiler over a running vLLM server:

```bash
curl -sf -X POST "http://<host>:<port>/start_profile"
# send a short controlled request burst to /v1/completions or /v1/chat/completions
curl -sf -X POST "http://<host>:<port>/stop_profile"
```

Nsight Systems for kernel visibility:

```bash
nsys profile -t cuda,nvtx -o /tmp/vllm_nsys_<label> -f true \
  vllm bench latency \
  --model <model> \
  --batch-size <batch> \
  --input-len <input-len> \
  --output-len <output-len> \
  --num-iters <iters> \
  --enforce-eager
```

For remote dev hosts, first inspect the track context and env profile. Then
adapt the commands to the configured remote path, venv, proxy, and source sync
layout. Do not refresh envs, sync, or restart services unless the user asked for
that action.

## Kernel Categories

Classify profiler and Nsight results into these categories:

| Category | Patterns |
| --- | --- |
| gemm | `aten::mm`, `cublas`, `cutlass`, `matmul`, linear kernels |
| attention | `flash`, `fmha`, paged attention, MLA attention kernels |
| norm | `rmsnorm`, `layernorm`, fused norm kernels |
| activation | `silu`, `gelu`, gated activation kernels |
| rope | rotary embedding, position encoding |
| cache | `reshape_and_cache`, KV cache copy/register/transfer |
| sampling | top-k/top-p, softmax, argmax, logits processors |
| memory | memcpy, memset, D2D/H2D/D2H copies, layout conversion |
| scheduler | queueing, waiting, CPU overhead, request scheduling |
| other | anything not fitting the above |

Flag likely bottlenecks:

- single kernel over 15 percent of GPU time
- category over 40 percent of GPU time
- memory movement over 10 percent of GPU time
- CPU/scheduler overhead dominating TTFT while GPU is underutilized
- regression without kernel distribution change, which often suggests
  scheduling, memory pressure, changed batching, or environmental noise

## Analysis Mapping

Use metric symptoms to guide investigation:

- TTFT regression with attention/cache growth: prefill attention, KV cache, or
  prefix/paged cache path.
- TPOT regression with gemm growth: decode GEMM, quantization, tensor parallel
  shape, or kernel selection.
- Throughput drop with memory growth: layout conversion, KV movement, all-reduce,
  or host/device transfer overhead.
- Error-rate or timeout increase with stable kernels: server flags, scheduling,
  batching, memory pressure, or networking.
- Speculative decoding regressions: draft/target layer split, acceptance rate,
  draft KV registration, or scheduler interaction.
- Disaggregated PD regressions: NIXL transfer, KV registration/filtering,
  connector setup, or remote memory path.

## Output

Produce a concise optimization note:

```markdown
# vLLM Optimization Note

## Context
- Track:
- Worktree/head:
- Model:
- Hardware:
- Baseline:
- Current:

## Regression Summary
| Metric | Baseline | Current | Delta | Severity |
| --- | --- | --- | --- | --- |

## Bottleneck
Primary bottleneck:
Evidence:

## Category Breakdown
| Category | Share | Top Kernel/Event | Notes |
| --- | --- | --- | --- |

## Recommendations
1. Change:
   Why:
   Expected impact:
   Risk:

## Suggested Validation
- Benchmark:
- Unit/smoke:
- Runtime check:

## Evidence To Record
- Record benchmark/profiler summary in the current `.devteam/runs/<run>/`.
- If the analysis changes code, start or continue a run for that track and
  record sync/test evidence after validation.
```

Keep recommendations tied to profiler evidence. If profiling is not yet
available, label the output as a hypothesis and list the exact measurement that
would confirm or reject it.
