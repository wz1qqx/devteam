---
name: devteam:env
description: Environment registry — list profiles/environments, inspect machine facts, doctor, or refresh remote/k8s profiles
argument-hint: "<list|show|environments|doctor|runtime|bind|refresh> [--root <path>] [--set <track>] [--feat <feat>] [--env <environment>] [--profile <name>] [--sync <profile>] [--remote] [--yes] [--run <id>] [--text]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
---
<objective>
Inspect machine/cluster environments plus lightweight remote_dev and k8s environment profiles, and refresh vLLM editable remote venvs when explicitly requested.
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
Run `node "$DEVTEAM_BIN" env $ARGUMENTS`. list prints lane-local env_profiles plus the shared machine/cluster environments registry. show/environments inspect fixed machine or cluster facts, compatible capabilities, and status without remote side effects. runtime prints the effective track/feature env exports, including inherited environment proxy, work_dir/source_dir/venv, K8s namespace/kubeconfig, and selected worktree remote paths. bind writes the same effective runtime context to `.devteam/state/runtime-*.sh` and `.devteam/state/runtime-*.json` for the selected track/feature/profile/environment, then prints the source command; use this stable binding before remote or K8s helper sessions so new shells inherit proxies, work dirs, namespaces, and worktree paths. For run-scoped handoff, session start still writes `.devteam/runs/<id>/runtime.sh`. For doctor, display local command checks and missing profile fields for env_profiles. --remote performs explicit read-only SSH checks. With doctor --remote --run <id>, append an env-doctor event to that run. For refresh, show the generated command unless --yes is present; only execute remote editable venv refresh with explicit --yes. With refresh --yes --run <id>, append an env-refresh event to that run.
</process>
