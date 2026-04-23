# devteam

`devteam` is a prompt-first multi-agent delivery framework for feature pipelines.
It combines Markdown-defined orchestration with a Node.js CLI state kernel, so each
stage can be automated while still preserving strict execution boundaries.

---

## Release Snapshot (2026-04-17)

- First-class `ship.strategy`: `k8s` and `bare_metal`
- Strategy-aware build behavior via top-level `build.mode` (legacy `ship.metal.build_mode` is mirrored from it) and `--build-mode`
- Frozen execution identity with `RUN.json`
- Slot conflict gate, dirty-worktree gate, and write-scope path gate
- Structured stage handoff contract (`STAGE_RESULT`) for deterministic orchestration

See full details in `RELEASE_NOTES.md`.

---

## Architecture Review (Current State)

### What is working well

- **Layered boundaries are clear**: CLI entry, config normalization, run/pipeline/task state, and agent orchestration are separated by module.
- **Runtime safety is explicit**: run identity freeze, slot conflict detection, and path scope checks enforce deterministic execution.
- **Prompt orchestration is machine-guarded**: stage outcomes use the `STAGE_RESULT` contract plus CLI-side parser/decision/acceptance helpers.
- **Strategy extension path is real**: ship strategy branching (`k8s` vs `bare_metal`) exists in config, orchestrator, builder, shipper, and verifier.

### Main risk to keep watching

- **Prompt and docs drift risk**: behavior spans Markdown prompts and CLI code. Any schema or invariant change must update both together.

---

## High-Level Architecture

```text
commands/devteam/*.md + skills/*.md + agents/*.md
                 |
                 v
          lib/devteam.cjs (CLI router)
                 |
     +-----------+--------------------+
     |                                |
     v                                v
lib/config.cjs                 lib/init.cjs
(schema/load/normalize)        (context assembly)
     |                                |
     +----------+---------------------+
                v
        Runtime state kernel
  (run-state / pipeline-state / task-state /
   session / state / stage-result / hooks)
                |
                v
      Team orchestrator + subagents
```

---

## Core Runtime Artifacts

All workflow state is feature-scoped under `.dev/features/<feature>/`:

- `RUN.json`: frozen run identity and repo snapshot (start SHA/branch/worktree/dirty policy/stages)
- `tasks.json`: machine-authoritative task state for planner/coder/pause/resume
- `STATE.md`: stage progress, pipeline markers, and operational checkpoint fields
- `HANDOFF.json`: pause/resume transfer payload
- `context.md`: decisions and blockers
- `build-manifest.md`: permanent build chain record

Workspace-scoped:

- `.dev/build-index.json`: build reuse index for fast no-op reuse hits

---

## Pipeline Model

Default stage order:

`spec -> plan -> code -> review -> build -> ship -> verify`

Control loop behavior:

- `review FAIL` can trigger review-fix loop (`coder <-> reviewer`)
- `verify FAIL` can trigger optimization loop (`vllm-opter -> planner -> code -> review -> build -> ship -> verify`)

Stage communication contract:

- Every stage ends with `## STAGE_RESULT` + fenced JSON
- CLI helpers:
  - `stage-result parse`
  - `stage-result decide`
  - `stage-result accept`
  - `orchestration resolve-stage`

Reference: `skills/references/stage-result-contract.md`

---

## Configuration Model

Split config design:

- Workspace-level: `workspace.yaml`
- Feature-level: `.dev/features/<name>/config.yaml`

Important rules:

- `schema_version: 2` is required
- Config loading is fail-fast on invalid type/shape/enum
- `scope.<repo>.dev_worktree` is removed (hard error); use `dev_slot`
- `ship.strategy` supports `k8s | bare_metal`
- `ship.metal.build_mode` supports `skip | sync_only | source_install | docker`

Reference: `skills/references/schema.md`

---

## Execution Boundary Guards

- **Dirty worktree gate**: run cannot proceed without explicit user decision
- **Execution identity gate**: missing/invalid repo identity in `RUN.json` blocks pipeline
- **Slot conflict gate**: same worktree in another active run blocks unless explicit override or shared slot exemption
- **Write-scope gate**: `run check-path` validates target paths are inside run-frozen dev worktrees
- **Stage compatibility gate**: pipeline stages must match the run snapshot

---

## Build and Ship Strategy Matrix

### `k8s` strategy

- Build normally in Docker mode
- Ship via `kubectl` flow (delete/apply or apply, ready checks, health checks)
- Verify with cluster log checks and benchmark/smoke workflow

### `bare_metal` strategy

- Build mode can be:
  - `skip`
  - `sync_only` (default)
  - `source_install`
  - `docker`
- Ship via SSH scripts (`stop -> sync -> start -> health`)
- Verify with SSH log checks + direct service smoke/benchmark checks

---

## Built-In Bare-Metal Bootstrap

Scaffold built-in rapid-test assets:

```bash
node lib/devteam.cjs init bare-metal --feature <name> --host <user@host> --profile <profile>
```

Generated assets:

- `.dev/rapid-test/sync.sh`
- `.dev/rapid-test/start.sh`
- `.dev/rapid-test/setup.sh`
- `.dev/rapid-test/<profile>.env`

Optional config write-back adds default `ship.strategy: bare_metal` and `ship.metal.*` fields to feature config.

---

## CLI Entry Points

Core:

- `node lib/devteam.cjs init <workflow>`
- `node lib/devteam.cjs config load|get`
- `node lib/devteam.cjs state get|update`
- `node lib/devteam.cjs run init|get|reset|check-path`
- `node lib/devteam.cjs pipeline init|loop|reset|complete`
- `node lib/devteam.cjs tasks init|get|summary|sync-from-plan|update|reset`
- `node lib/devteam.cjs hooks run`
- `node lib/devteam.cjs stage-result parse|decide|accept`
- `node lib/devteam.cjs orchestration resolve-stage`

High-level command metadata is defined in `commands/devteam/_registry.yaml`.

---

## Testing Focus

The test suite validates:

- config/schema normalization and fail-fast behavior
- stage-result parsing and decision contract
- run lifecycle, slot conflicts, and path gate enforcement
- build reuse index behavior
- bare-metal strategy and bootstrap behavior

Examples:

- `tests/week12-bare-metal-ship-strategy.test.cjs`
- `tests/week13-bare-metal-bootstrap.test.cjs`
- `tests/week3-stage-result-contract.test.cjs`
- `tests/week10-dev-worktree-deprecation.test.cjs`

---

## Repository Map

- `lib/`: CLI and state kernel implementation
- `skills/`: orchestrator and workflow prompt logic
- `agents/`: role-specific agent contracts
- `commands/devteam/`: command registry and generated command docs
- `templates/`: built-in scaffold files (including bare-metal rapid-test templates)
- `tests/`: regression and behavior tests

---

## Known Deferred Work

- Automated A/B comparison workflow
- Multi-node bare-metal orchestration
- Additional ship strategies beyond `k8s` and `bare_metal`
