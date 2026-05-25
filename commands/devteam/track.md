---
name: devteam:track
description: Track management — list, inspect, bind, or set default workspace tracks
argument-hint: "<list|status|context|bind|use> [track] [--root <path>] [--set <track>] [--feat <feat>] [--text] [--no-runtime] [--active-only] [--dry-run]"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
---
<objective>
Inspect tracks, print selected-track agent context, bind one track to the current terminal/session, or update the workspace default track hint.
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
Run `node "$DEVTEAM_BIN" track $ARGUMENTS`. Track selection order is --set, DEVTEAM_TRACK, then .devteam/config.yaml defaults.track; feature selection order is --feat, DEVTEAM_FEAT/DEVTEAM_FEATURE, then defaults.feat or the track default_feat. Track and feature names accept canonical names plus configured aliases, normalized for spaces, underscores, and hyphens; if an alias is ambiguous, ask the user to choose the canonical name. Tracks own reusable env, sync, build, deploy flow, validation, remote venv, K8s dev, and capability instance bindings. Features are nested under a track and select only incremental feature worktrees. For list, display each track with aliases, lifecycle status, inferred profiles/instances, repo count, selected marker, workspace dirty/missing totals, latest run phase, and presence hints; pass --text for the compact track dashboard and --no-runtime to skip workspace/run/presence inspection. Tracks may declare status: active, parked, or archived. With --active-only, show active tracks plus selected/default, dirty/missing, presence, or unfinished-run tracks; omit it to inspect all tracks. For status/context, pass --feat when working on one feature; runtime worktrees and latest runs are scoped to that feature while profiles and instances stay inherited from the track. For bind <track>, print an export DEVTEAM_TRACK command for this terminal/session without modifying config. For use <track>, update only the defaults block in .devteam/config.yaml; use --dry-run to preview and avoid it when multiple sessions may be active. This command does not touch worktrees, remote servers, images, or clusters.
</process>
