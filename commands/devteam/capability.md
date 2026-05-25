---
name: devteam:capability
description: Capability registry — list or inspect validation/build/deploy capability definitions
argument-hint: "<list|show> [--root <path>] [--method <capability>]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
---
<objective>
Inspect CRD-like capability standards such as remote-vllm-venv, k8s-vllm-dev, image build modes, and k8s deploy.
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
Run `node "$DEVTEAM_BIN" capability $ARGUMENTS`. list shows capability definitions, maturity, compatible environment kind, evidence gates, and production_gate. show displays the full capability definition plus compatible environments and validation/deploy instances. This command is read-only and does not bootstrap, sync, build, deploy, or mutate remote state.
</process>
