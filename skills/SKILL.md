---
name: devteam
description: "Workspace control layer for devteam-managed multi-track development. Use for workspace context, track selection, run evidence, remote venv validation, image/deploy planning, and devteam skill management."
---

# devteam

Use the `.devteam` workspace workflow by default. Treat reusable capabilities as
independent skills and keep workspace recipes, run evidence, and wiki notes
separate.

## Primary Entry

When the user asks for the devteam entry point, workspace console, current
status, how to continue, or what the workspace looks like, prefer the installed
skills:

- `devteam-console`: one-screen daily workspace console.
- `devteam-status`: compact workspace/run status summary.
- `vllm-opt`: independent vLLM benchmark/profiler/kernel optimization analysis.

If those skills are unavailable, run the CLI directly:

```bash
DEVTEAM_BIN="${DEVTEAM_CLI:-${HOME}/Documents/devteam/lib/devteam.cjs}"
[ -f "$DEVTEAM_BIN" ] || DEVTEAM_BIN="${HOME}/.claude/plugins/marketplaces/devteam/lib/devteam.cjs"
[ -f "$DEVTEAM_BIN" ] || DEVTEAM_BIN=$(ls ~/.claude/plugins/cache/devteam/devteam/*/lib/devteam.cjs 2>/dev/null | tail -1)
node "$DEVTEAM_BIN" workspace context --root "$PWD" --for codex --text
node "$DEVTEAM_BIN" track list --root "$PWD" --active-only --text
```

## Command Surface

Route `/devteam <action>` to the matching lightweight command:

| Action | Command | Purpose |
| --- | --- | --- |
| `workspace` | `workspace scaffold|onboard|context` | Workspace layout and agent onboarding/context |
| `track` | `track list|status|context|bind|use` | Track discovery and session-local binding |
| `presence` | `presence list|touch|clear` | Concurrent session soft-lock hints |
| `session` | `session start|status|handoff|record|list|lint|...` | Run lifecycle, evidence, and handoff |
| `status` | `status` | One-screen latest run status |
| `doctor` | `doctor [agent-onboarding]` | Workspace/env/sync/onboarding checks |
| `ws` | `ws status|materialize|publish-plan|publish` | Local worktree inventory and publish planning |
| `env` | `env list|show|environments|doctor|refresh` | Machine/cluster environments plus remote/k8s env profile checks and refresh |
| `capability` | `capability list|show` | CRD-like validation/build/deploy capability standards |
| `validate` | `validate list|plan` | CR-like validation instance selection and read-only plans |
| `sync` | `sync plan|apply|status` | Local-to-remote sync planning/execution |
| `remote-loop` | `remote-loop plan|start|doctor|refresh|sync|record-test|status` | Track-scoped remote validation loop |
| `image` | `image plan|prepare|record` | Image contract, context, and evidence |
| `deploy` | `deploy list|plan|record|verify-record` | CR-like k8s deploy instance planning and pre-production evidence |
| `skill` | `skill list|status|lint|install` | Devteam Codex skill management |
| `knowledge` | `knowledge list|search|lint|capture` | Recipes/wiki/skills knowledge layer |
| `vllm-opt` | `vllm-opt` | vLLM performance regression profiling and optimization guidance |

## Track Discipline

- Treat a devteam workspace as multi-repo and multi-track.
- Do not assume `defaults.track` is the current session track.
- Ask the user to choose a track, or pass `--set <track>` / use
  `DEVTEAM_TRACK` for the current session. Use `--feat <feat>` /
  `DEVTEAM_FEAT` when working on a feature under that track.
- Use presence as a hint for concurrent sessions, not as a hard lock.

## Mutation Discipline

- Read-only commands are safe: `workspace context`, `track list`, `track context`,
  `status`, `session status`, `session handoff`, `ws status`, `image plan`,
  `deploy plan`, `skill status`, and `doctor`.
- Commands that sync, refresh envs, publish, build, deploy, or write evidence
  require clear user intent or an already agreed run flow.
- Record evidence after sync/test/build/deploy/publish work so another session
  can continue from the run history.
