# devteam Release Notes

## 2026-04-17 - Bare-Metal Integration Release

This release marks devteam as production-usable for hybrid deployment workflows.  
The core milestone is making `bare_metal` a first-class shipping strategy across config, orchestration, docs, and tests.

### Highlights

- **First-class ship strategy**
  - `ship.strategy` now supports `k8s | bare_metal`
  - `bare_metal` no longer behaves like a side-path workaround

- **Strategy-aware build stage**
  - `ship.metal.build_mode` supports:
    - `skip`
    - `sync_only` (default when omitted)
    - `source_install`
    - `docker`
  - Runtime override supported with:
    - `/devteam team <feature> --build-mode <mode>`

- **Fail-fast configuration validation**
  - Reject invalid `ship.strategy`
  - Reject `bare_metal` missing `ship.metal`
  - Reject `bare_metal` missing `ship.metal.host`
  - Reject invalid `ship.metal.build_mode`

- **Execution-boundary hardening retained**
  - run identity freeze via `RUN.json`
  - dirty-worktree gate
  - slot conflict gate
  - source path gate (`run check-path`)
  - build provenance capture (`source_refs`)

### Behavior Summary

- **Builder**
  - Docker mode: build + push + `build record`
  - Bare-metal modes: sync/install style build stage without Docker dependency

- **Shipper**
  - k8s mode: `kubectl`-driven deployment
  - bare_metal mode: stop -> sync -> start -> health poll -> first inference

- **Verifier**
  - k8s mode: cluster log and service checks
  - bare_metal mode: SSH log checks + direct service smoke checks

### Documentation Updates

- `README.md`
  - added release snapshot and strategy-aware behavior notes
  - added `--build-mode` option documentation
  - aligned agent table and architecture flow with actual runtime behavior
  - replaced absolute local-file links with repository-relative links

- `skills/references/schema.md`
  - formalized `ship.metal.build_mode` in schema reference

### Regression Coverage

Validated with integration-focused tests, including:

- `tests/week12-bare-metal-ship-strategy.test.cjs`
- `tests/week3-stage-result-contract.test.cjs`
- `tests/week1-core.test.cjs`

### Known Deferred Work

- automated A/B compare workflow for bare metal
- multi-node bare-metal orchestration
- additional shipping strategies beyond `k8s` and `bare_metal`

### Upgrade Guidance

If you are adopting bare metal now:

1. set `ship.strategy: bare_metal`
2. provide `ship.metal.host`, `sync_script`, `start_script`
3. optionally set `ship.metal.build_mode` (defaults to `sync_only`)
4. run a smoke pipeline first:

```bash
/devteam team <feature> --stages build,ship,verify --build-mode sync_only
```
