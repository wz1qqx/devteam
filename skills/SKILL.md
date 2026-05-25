---
name: devteam
description: "Workspace harness for devteam-managed multi-track development. Use for workspace context, track selection, repo/upstream state, environment/runtime binding, sync helpers, optional run evidence, and devteam skill management."
---

# devteam

Use the `.devteam` workspace harness by default. Let devteam manage repeatable
workspace state: repo/upstream status, track/feature selection, environments,
runtime exports, worktree inventory, sync state, presence, and optional run
history. Treat code editing, optimization, feature testing, and performance
analysis as independent skills or human-managed work.

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

`workspace context` and daily harness `status` read
`.devteam/state/selection-session.json` when no explicit `--set` or
`DEVTEAM_TRACK` is present, then show the matching runtime binding and
bootstrap summary.

Use `workspace activate --set <track> [--feat <feat>] --text` when one command
should write both the stable selection binding and the matching runtime binding.
It does not change workspace defaults or execute remote/K8s commands.

## Command Surface

Route `/devteam <action>` to the matching lightweight command:

| Action | Command | Purpose |
| --- | --- | --- |
| `workspace` | `workspace scaffold|onboard|context|activate` | Workspace layout, binding activation, and agent onboarding/context |
| `track` | `track list|status|context|bind|use` | Track discovery and session-local binding |
| `presence` | `presence list|touch|clear` | Concurrent session soft-lock hints |
| `repo` | `repo list|status|fetch|update-plan` | Repo/upstream state and clean update planning |
| `session` | `session start|status|handoff|record|list|lint|...` | Optional run lifecycle, evidence, and handoff |
| `status` | `status` | One-screen harness status |
| `doctor` | `doctor [agent-onboarding]` | Workspace/env/sync/onboarding checks |
| `ws` | `ws status|materialize|publish-plan|publish` | Local worktree inventory and publish planning |
| `env` | `env list|show|environments|doctor|runtime|bind|bootstrap|remote-status|refresh` | Machine/cluster environments, runtime bindings, bootstrap plans, and remote/k8s checks |
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
- Prefer `track bind <track> [--feat <feat>] --write --text` when a shell or
  agent session needs a stable local selection file; source the printed
  `.devteam/state/selection-*.sh` instead of changing workspace defaults.
- Use presence as a hint for concurrent sessions, not as a hard lock.
- Use `repo status` before branch updates or when upstream freshness matters.
- Prefer `env bind --text` before remote/K8s helper commands. It writes a
  stable `.devteam/state/runtime-*.sh` source file for the selected
  track/feature/profile/environment so new shells inherit proxies, work
  directories, namespaces, and worktree paths.
- Use `env bootstrap --text` to inspect initial machine/cluster setup. It is
  read-only and prints recipe/preflight/configured commands for manual review;
  do not execute those commands unless the user explicitly asks to initialize
  that environment.
- Use `env remote-status --text` before sync or env refresh when remote state
  matters. It is read-only and compares the selected local worktree to the
  remote source mirror branch/head/dirty state.

## Mutation Discipline

- Read-only commands are safe: `workspace context`, `track list`, `track context`,
  `status`, `repo status`, `repo update-plan`, `session status`,
  `session handoff`, `ws status`, `image plan`, `deploy plan`, `skill status`,
  and `doctor`.
- Commands that sync, refresh envs, publish, build, deploy, or write evidence
  require clear user intent or an already agreed run flow.
- Record evidence after sync/test/build/deploy/publish only when a run handoff
  actually needs it. Do not turn normal development into mandatory gatekeeping.
