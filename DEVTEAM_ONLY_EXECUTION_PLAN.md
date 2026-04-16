# Devteam-Only Hard Cut Execution Plan

This plan is for a full migration to `devteam` naming only.
It is derived from and aligned with `NEXT_SESSION_PLAN.md`, but explicitly removes all `devflow`/`my-dev` backward compatibility.

## Goal

Remove all runtime, script, test, and documentation support for legacy naming:

- `DEVFLOW_BIN`
- `devflow`
- `my-dev`

After completion, the repository and operational paths should support only `devteam`.

## Baseline and Scope

- Baseline reference: `NEXT_SESSION_PLAN.md`
- Strategy: execute Phase 4-style hygiene as a hard cut (no compatibility wrappers)
- In scope:
  - `hooks/*`
  - `bin/setup.sh`
  - `README.md`
  - `NEXT_SESSION_PLAN.md` (stale compatibility sections)
  - week4 tests related to hooks/hygiene
  - local config file in repo if still tracked: `.claude/settings.local.json`
- Out of scope:
  - New feature work
  - New ship strategies
  - Wave parallelization model changes

## Invariants

Must remain true after migration:

1. `commands/devteam/*.md` and `bin/generate-commands.cjs` stay `DEVTEAM_BIN` only.
2. Hook registry uses canonical devteam hooks only.
3. Stage-result/pipeline/orchestration behavior from week3 tests remains unchanged.
4. No runtime dependence on deleted compatibility wrappers.
5. Test files may retain legacy strings only inside explicit negative assertions or file-absence checks; runtime/docs/config targets may not.

## Execution Waves

### Wave 1: Runtime Hard Cut

1. Delete compatibility wrapper files:
   - `hooks/devflow-persistent.js`
   - `hooks/my-dev-context-monitor.js`
   - `hooks/my-dev-statusline.js`

2. Remove fallback logic in canonical hooks:
   - `hooks/devteam-persistent.js`: remove `devflow-persistent-*` fallback reads.
   - `hooks/devteam-context-monitor.js`: remove `my-dev-ctx-*` fallback reads.

3. Convert setup to devteam-only:
   - `bin/setup.sh`:
     - remove `cache/devflow/...` fallback probe
     - remove legacy symlink checks/warnings for `my-dev`/`devflow`
     - keep only devteam path guidance

### Wave 2: Tests Contract Update

1. Update `tests/week4-hooks.test.cjs`:
   - remove wrapper-content assertions
   - keep/assert canonical `hooks/hooks.json` references
   - add assertions that deleted wrapper files do not exist

2. Rewrite `tests/week4-release-hygiene.test.cjs`:
   - change from "legacy confined allowlist" to "legacy forbidden" policy for runtime/docs/config targets
   - scan `README.md`, `NEXT_SESSION_PLAN.md`, `bin`, `hooks`, `skills`, `lib`, `commands/devteam`
   - scan `.claude/settings.local.json` when it is tracked
   - do not repo-scan `tests`; tests may still contain legacy literals only for negative assertions and file-absence checks

3. Keep `tests/week4-command-generation.test.cjs` as existing guard.
   - Its legacy regex/string checks are acceptable because they enforce absence, not compatibility.

### Wave 3: Documentation Hard Cut

1. Update `README.md`:
   - remove backward-compat wrapper mentions from tree and text

2. Update `NEXT_SESSION_PLAN.md`:
   - remove stale statements that generator/docs still emit `DEVFLOW_BIN`
   - remove "keep for compatibility" wrapper policy
   - replace with devteam-only state

3. Update `.claude/settings.local.json` (if tracked intentionally):
   - remove old `devflow`/`my-dev` command/path references
   - keep only devteam path patterns

### Wave 4: Validation and Handoff

1. Runtime/docs/config string scan must be clean:

```bash
rg -n --hidden "DEVFLOW_BIN|devflow|my-dev" README.md NEXT_SESSION_PLAN.md bin hooks skills lib commands/devteam
if git ls-files --error-unmatch .claude/settings.local.json >/dev/null 2>&1; then
  rg -n --hidden "DEVFLOW_BIN|devflow|my-dev" .claude/settings.local.json
fi
```

2. Required validation tests:

```bash
node tests/week4-hooks.test.cjs
node tests/week4-release-hygiene.test.cjs
node tests/week4-command-generation.test.cjs
node tests/week4-statusline.test.cjs
node tests/week3-stage-result-parser.test.cjs
node tests/week3-stage-decision.test.cjs
node tests/week3-orchestration-kernel.test.cjs
node tests/week3-pipeline-state.test.cjs
node tests/week3-stage-result-errors.test.cjs
node tests/week3-pipeline-state-errors.test.cjs
node tests/week5-version.test.cjs
```

3. Optional full regression run (recommended before merge):
   - Use the full command set in `NEXT_SESSION_PLAN.md`.

## Acceptance Criteria

- No remaining legacy naming references in runtime/docs/config scan targets.
- `.claude/settings.local.json` is clean if it is tracked.
- No compatibility wrapper files remain, and week4 tests assert their absence.
- Setup script is devteam-only.
- week3/week4/week5 validation commands pass.
- Docs reflect actual runtime behavior (no compatibility claims).

## Risk Notes

- Removing fallback temp-file reads can drop old persisted hook state continuity.
- If any external/local environment still references removed wrapper script paths, those integrations must be updated before rollout.

## Suggested Commit Strategy

1. `refactor: remove legacy hook wrappers and fallback reads`
2. `test: enforce devteam-only naming and hook contracts`
3. `docs: remove devflow/my-dev compatibility references`
