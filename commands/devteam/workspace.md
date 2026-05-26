---
name: devteam:workspace
description: Workspace management — scaffold .devteam layout, activate harness bindings, and agent onboarding/context
argument-hint: "<scaffold|onboard|context|activate> [--root <path>] [--set <track>] [--feat <feat>] [--scope <name>] [--profile <env-profile>] [--sync <profile>] [--env <environment>] [--name <name>] [--write] [--force] [--for codex|claude|human] [--text]"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
---
<objective>
Create a devteam workspace layout, activate stable selection/runtime bindings, and generate/read the agent onboarding protocol for any .devteam workspace.
</objective>

<context>
$ARGUMENTS
</context>

<process>
**Step 1**: Discover the devteam CLI:
```bash
DEVTEAM_BIN="${HOME}/.claude/plugins/marketplaces/devteam/lib/devteam.cjs"
[ -f "$DEVTEAM_BIN" ] || DEVTEAM_BIN=$(ls ~/.claude/plugins/cache/devteam/devteam/*/lib/devteam.cjs 2>/dev/null | head -1)
[ -n "$DEVTEAM_BIN" ] || { echo "ERROR: devteam.cjs not found" >&2; exit 1; }
```

If no `--root` is provided, use the current workspace or nearest parent containing `.devteam/config.yaml`. Do not select a global active track; ask the user to choose a track or pass `--set <track>` when the command needs one.

**Step 2**: Execute:
Run `node "$DEVTEAM_BIN" workspace $ARGUMENTS`. For scaffold, display created/skipped files and next_action; use --force only when intentionally replacing an existing workspace config. For activate, require --set <track>; write `.devteam/state/selection-<scope>.sh/json` and the matching `.devteam/state/runtime-*.sh/json` without changing defaults or executing remote/K8s commands, then print both source commands. For onboard, render AGENTS.md, CLAUDE.md, and README.devteam.md from the workspace config, registry, and lane files; dry-run by default, write only with --write, and overwrite drifted files only with --force. For context, print the dynamic agent context: workspace identity, track/feature selection policy, active/parked/archived tracks with configured features, selected/default track and feature, session-local selection binding source, runtime binding source or bind command, bootstrap summary, primary next action, and first commands. When no explicit --set/--feat or DEVTEAM_TRACK/DEVTEAM_FEAT is present, context reads `.devteam/state/selection-session.json` before asking the user to choose. `--feat` narrows runtime context and generated commands to one feature while preserving the track-owned profiles and capability instances. This command does not choose concrete repos, branches, remote venvs, image tags, or cluster targets.
</process>
