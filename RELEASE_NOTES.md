# devteam Release Notes

## 2026-04-19 - Build mode + deploy profile ergonomics

- **Authoritative build stage mode**: feature `build.mode` (values: `skip`, `sync_only`, `source_install`, `docker`). Legacy `ship.metal.build_mode` is merged into `build.mode` when `build.mode` is omitted, then mirrored back onto `ship.metal.build_mode` for `bare_metal` features.
- **`deploy.active_profile`**: optional single-field switch; loader selects `deploy.profiles[key]`, derives `ship.strategy`, and sets `deploy.deploy_profile` (k8s) or `ship.metal.deploy_profile` (bare metal venv/docker).
- **`init team` / `init team-deploy` flags**: `--ship-strategy k8s|bare_metal` and `--deploy-profile <key>` merge into init JSON; presence is recorded under `init_overrides`.
- Tests: `tests/week14-ship-profile-and-init-flags.test.cjs`.

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
  - Built-in bootstrap supported with:
    - `/devteam init bare-metal --feature <name> --host <user@host> --profile <name>`

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
  - added built-in bare-metal scaffold bootstrap instructions
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
- **deploy symmetry** (tracked separately below)

### Upgrade Guidance

If you are adopting bare metal now:

1. set `ship.strategy: bare_metal`
2. provide `ship.metal.host`, `sync_script`, `start_script`
3. optionally set `ship.metal.build_mode` (defaults to `sync_only`)
4. run a smoke pipeline first:

```bash
/devteam team <feature> --stages build,ship,verify --build-mode sync_only
```

---

## Design Backlog

### Deploy symmetry: bare-metal and K8s as first-class citizens

**Intent:** Both deployment targets should be expressed uniformly through `deploy.profiles`,
with `deploy.active_profile` as the single switch. `ship.strategy` should be derived
automatically from the active profile type, not set explicitly.

**Current state (as of 2026-04-19):**
- `config.cjs:resolveDeployActiveProfile()` is fully implemented: reads `deploy.active_profile`,
  derives `ship.strategy`, writes back `deploy.deploy_profile` or `ship.metal.deploy_profile`.
- `shipper.md` still has `LEGACY_K8S_DEPLOY` and `LEGACY_BARE_METAL_DEPLOY` branches that
  bypass the unified `PROFILE_SHIP` path.
- `schema.md` documents `deploy.active_profile` as optional; `ship.strategy` is not marked
  as derived/deprecated.
- Feature configs (`kimi-pd-pegaflow`, etc.) still use explicit `ship.strategy` + flat
  `deploy.yaml_file` rather than `deploy.profiles` + `active_profile`.

**Work needed for next refactor:**
1. `shipper.md`: make `PROFILE_SHIP` the primary path; demote `LEGACY_*_DEPLOY` to explicit
   opt-in fallback (e.g., when `deploy.profiles` is absent).
2. `schema.md`: mark `deploy.active_profile` as the recommended primary field; annotate
   `ship.strategy` as "auto-derived when active_profile is set".
3. `orchestrator.md`: derive `SHIP_STRATEGY` from `active_profile` type first.
4. Feature config migration: express all deployment targets as named profiles under
   `deploy.profiles`; set `active_profile` to switch; remove explicit `ship.strategy`.
5. `ship.metal` remains for dev-workflow fields only (`sync_script`, `setup_script`,
   `start_script`); these are bare-metal dev loop concerns, not deployment config.

**Desired end state for a feature config:**
```yaml
deploy:
  active_profile: paigpu-a     # ← the only field to change when switching target
  profiles:
    b200-venv:
      type: bare_metal_venv    # → ship.strategy = bare_metal (auto-derived)
      host: ...
      start_cmd: ...
      health_url: ...
    paigpu-a:
      type: k8s                # → ship.strategy = k8s (auto-derived)
      cluster: paigpu-a
      namespace: dynamo-system
      yaml: deploy/feature/disagg.yaml
      dgd_name: ...

ship:
  metal:                       # dev-loop only; ignored when active profile is k8s
    profile: b200-lab
    sync_script: build/sync.sh
    setup_script: build/install-wheels.sh
    start_script: build/start.sh
```
