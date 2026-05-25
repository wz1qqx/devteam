# devteam Release Notes

## Unreleased

- The workspace model is now `tracks` plus nested `features`. Tracks own the
  reusable env/sync/build execution profiles, validation/deploy instances,
  remote venv, and K8s dev capability bindings. Features only select
  incremental worktrees under that track.
- CLI selection is now `--set <track>` plus optional `--feat <feat>`. Session
  runs, latest-run lookup, stale-head checks, lint, supersede planning,
  remote-loop, sync, image, deploy, publish, and status all scope worktree/run
  state to the selected feature while reusing the track-owned profiles.
- Config parsing and generated scaffold configs now use the current `tracks:`
  plus nested `features:` model.
- Track image profiles can still refer to base worktrees; when a feature is
  selected, image planning maps same-repo profile worktree inputs to the
  selected feature worktree so patch/source heads stay feature-local.

## 2.2.2 - Portable workspace acceptance default

The workspace acceptance checker is now portable across Macs.

- `bin/check-workspace-acceptance.cjs` defaults to
  `~/Documents/llmd-vllm-v020-pega-v021` instead of a machine-specific
  `/Users/<name>/...` path.
- The version test now prevents the acceptance script from reintroducing the
  original local username path.

This keeps the new Mac install on a clean `devteam` checkout instead of relying
on a local dirty patch after sync.

## 2.2.1 - Portable agent plugin entrypoints

`devteam` now installs cleanly on another Mac without rewriting skill files by
hand.

- `devteam-console` and `devteam-status` discover `devteam.cjs` from
  `DEVTEAM_CLI`, `~/Documents/devteam`, the Claude marketplace plugin copy, or
  the versioned Claude plugin cache.
- Skill fallback command snippets no longer point at one machine-specific
  `/Users/<name>/Documents/devteam` path.
- Console/status helper scripts now fall back to the current directory when no
  workspace root is found instead of referencing an undefined `cwd` variable.

This release is intended for syncing `devteam` and managed workspaces across
machines while keeping the same Claude/Codex skill workflow.

## 2.2.0 - .devteam workspace runtime

`devteam` added the `.devteam` workspace runtime used by
`llmd-vllm-v020-pega-v021`: local Mac worktrees, session-selected tracks,
remote venv validation, image planning, pre-production deploy evidence, and
reusable skills.

### Daily Workflow

1. Open a devteam-managed workspace.
2. Read workspace context and choose a track and optional feature for the current session.
3. Start or continue a run under `.devteam/runs/<run-id>/`.
4. Inspect worktrees and sync selected changes to the remote test host.
5. Validate in the configured remote venv and record evidence.
6. Review image plans, prepare build contexts when useful, and record image
   build evidence.
7. Review deploy plans and record deploy plus post-deploy verification evidence.
8. Publish validated branches only after the run gate is ready.

### Runtime Surface

Primary CLI commands:

- `workspace scaffold|onboard|context`
- `track list|status|context|bind|use`
- `presence list|touch|clear`
- `session start|snapshot|record|status|handoff|list|lint|archive-plan|archive|supersede-plan|supersede-stale|close|supersede|reopen`
- `status`
- `doctor [agent-onboarding]`
- `ws status|materialize|publish-plan|publish`
- `env list|show|environments|doctor|refresh`
- `capability list|show`
- `validate list|plan`
- `sync plan|apply|status`
- `remote-loop plan|start|doctor|refresh|sync|record-test|status`
- `image plan|prepare|record`
- `deploy list|plan|record|verify-record`
- `skill list|status|lint|install`
- `knowledge list|search|lint|capture`

### Workspace And Track Model

- Tracks are session-scoped. `defaults.track` and optional `defaults.feat` are
  only default hints.
- Use `--set <track>` plus optional `--feat <feat>`, or
  `DEVTEAM_TRACK`/`DEVTEAM_FEAT`, for the current session.
- `track list --active-only --text` is the default picker surface for agents.
- `presence` records soft-lock hints for concurrent sessions; it never blocks
  sync, test, build, publish, or deploy.
- `session handoff --text` provides an agent continuation packet before a
  context switch.

### Remote Validation

- `env doctor` inspects local profile fields and optional read-only remote checks.
- `env refresh` plans or executes editable vLLM remote venv refreshes.
- `sync plan/apply` supports full rsync and relative patch sync strategies.
- `remote-loop` wraps the common source-to-remote-venv loop while leaving the
  exact test command flexible per change.
- Test evidence is recorded from explicit summaries or pytest logs.

### Image And Deploy Flow

Image profiles are contracts first:

- `tag_patch_image`: start from a pinned vLLM tag image and overlay safe source
  changes for fast iteration.
- `full_source_image`: build from source worktrees when the base is not a known
  tag or the patch is not safe for overlay.

`image prepare` materializes a local `.devteam/image-contexts` build context but
does not run Docker or push images. `image record` stores build evidence in the
run.

Deploy profiles describe pre-production targets. `deploy record` and
`deploy verify-record` are separate so deployment and validation evidence stay
auditable.

### Skills

Reusable skills are managed separately from recipes and wiki notes.

Included skills:

- `devteam-console`: one-screen daily workspace console.
- `devteam-status`: compact workspace/run status summary.
- `vllm-opt`: independent vLLM benchmark, profiler, and kernel-category
  optimization workflow.

Use `skill status --root <workspace> --text` to check whether installed skill
copies are current, missing, drifted, or invalid.

### Agent Onboarding

`workspace onboard --write` generates:

- `AGENTS.md`
- `CLAUDE.md`
- `README.devteam.md`

`doctor agent-onboarding --text` verifies that those files point agents to
workspace context, track selection, and the current skill entry points.

### Validation

Release checks:

```bash
node tests/command-generation.test.cjs
node tests/release-hygiene.test.cjs
node tests/hooks.test.cjs
node tests/statusline.test.cjs
node tests/version.test.cjs
node tests/workspace-runtime.test.cjs
node lib/devteam.cjs skill lint --root <workspace-root> --text
node lib/devteam.cjs doctor agent-onboarding --root <workspace-root> --text
node lib/devteam.cjs skill status --root <workspace-root> --text
node bin/check-workspace-acceptance.cjs --root <workspace-root>
git diff --check
```

## Deferred Work

- Knowledge/wiki import and capture flows still need a focused redesign.
- Build profiles should continue to be validated against real vLLM tag-patch and
  full-source image builds.
- Deploy verification should accumulate concrete recipes per cluster or target.
