# Workflow: log

<purpose>Quick checkpoint: append a timestamped entry to the devlog.</purpose>

<process>
<step name="LOG" priority="first">
```bash
# Auto-discover devflow CLI (marketplace or local install)
DEVFLOW_BIN=$(ls ~/.claude/plugins/cache/devflow/devflow/*/skills/my-dev/bin/my-dev-tools.cjs 2>/dev/null | head -1)

INIT=$(node "$DEVFLOW_BIN" init log)
FEATURE=$(echo "$INIT" | jq -r '.feature.name')
PHASE=$(echo "$INIT" | jq -r '.feature.phase')
TAG=$(echo "$INIT" | jq -r '.feature.current_tag // "none"')
```

Checkpoint (@references/shared-patterns.md#checkpoint):
```bash
node "$DEVFLOW_BIN" checkpoint \
  --action "log" \
  --summary "$ARGUMENTS"
```

Output: `Checkpoint: $FEATURE ($PHASE) — $ARGUMENTS`
</step>
</process>
