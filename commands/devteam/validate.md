---
name: devteam:validate
description: Validation registry — list or plan validation capability instances
argument-hint: "<list|plan> [--root <path>] [--set <track>] [--feat <feat>] [--method <capability>] [--env <environment>] [--instance <name>] [--text]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
---
<objective>
Choose and inspect CR-like validation instances that bind track/feature, capability definition, and environment.
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
Run `node "$DEVTEAM_BIN" validate $ARGUMENTS`. list shows validation_instances for the selected track/feature and optional method/environment filters. plan resolves one validation instance, checks required environment/instance facts, reports evidence gates and production_gate, prints the shared runtime env context, and prints explicit execution bridge commands such as env doctor, sync plan, or K8s helper usage prefixed with the runtime source command when needed. This command is read-only; bootstrap/sync/test/snapshot require explicit follow-up commands.
</process>
