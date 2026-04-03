---
name: devflow-setup
description: >
  Verify devflow plugin installation and prerequisites.
  Trigger when: user says "setup devflow", "check devflow", "devflow not working",
  or when any /devflow command fails with plugin-not-found errors.
argument-hint: "[--check]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - AskUserQuestion
---

# devflow Setup

Verify marketplace installation and check prerequisites.

## Process

<step name="CHECK_INSTALL">
Check if devflow is installed via marketplace.

```bash
PLUGIN_DIR=$(ls -d ~/.claude/plugins/cache/devflow/devflow/*/skills/my-dev/bin/my-dev-tools.cjs 2>/dev/null | head -1)
if [ -n "$PLUGIN_DIR" ]; then
  PLUGIN_ROOT=$(cd "$(dirname "$PLUGIN_DIR")/../../.." && pwd)
  echo "Status: INSTALLED (marketplace)"
  echo "Plugin root: $PLUGIN_ROOT"
  echo "Version: $(basename "$(dirname "$(dirname "$(dirname "$PLUGIN_DIR")")")")"
else
  echo "Status: NOT_INSTALLED"
  echo ""
  echo "Install via marketplace:"
  echo "  claude plugin marketplace add wz1qqx/devflow-plugin"
  echo "  claude plugin install devflow@devflow"
fi
```

If `$ARGUMENTS` contains `--check`, report status and exit.
If NOT_INSTALLED, show install instructions and stop.
</step>

<step name="CHECK_PREREQUISITES">
Verify required tools are available.

```bash
echo "=== Prerequisites ==="
command -v node &>/dev/null && echo "[OK] Node.js $(node --version)" || echo "[FAIL] Node.js not found — required"
```

If any FAIL, advise the user to install the missing tools before proceeding.
</step>

<step name="VERIFY_TOOLS">
Test that CLI tools are callable.

```bash
DEVFLOW_BIN=$(ls ~/.claude/plugins/cache/devflow/devflow/*/skills/my-dev/bin/my-dev-tools.cjs 2>/dev/null | head -1)
if [ -n "$DEVFLOW_BIN" ] && node "$DEVFLOW_BIN" features list >/dev/null 2>&1; then
  echo "[OK] CLI tools working (workspace detected)"
else
  echo "[OK] CLI tools callable (no workspace configured yet)"
fi
```
</step>

<step name="CLEANUP_LEGACY">
Check for and clean up legacy symlinks from older installations.

```bash
LEGACY_ITEMS=()
[ -L "$HOME/.claude/my-dev" ] && LEGACY_ITEMS+=("~/.claude/my-dev (symlink)")
[ -L "$HOME/.claude/commands/devflow" ] && LEGACY_ITEMS+=("~/.claude/commands/devflow (symlink)")
[ -L "$HOME/.claude/hooks/my-dev-context-monitor.js" ] && LEGACY_ITEMS+=("~/.claude/hooks/my-dev-context-monitor.js")
[ -L "$HOME/.claude/hooks/devflow-persistent.js" ] && LEGACY_ITEMS+=("~/.claude/hooks/devflow-persistent.js")
[ -L "$HOME/.claude/hooks/my-dev-statusline.js" ] && LEGACY_ITEMS+=("~/.claude/hooks/my-dev-statusline.js")
```

If legacy items found, ask via AskUserQuestion:
- "发现旧版安装遗留的 symlink，清理掉？"
  - "是，清理" → remove each symlink with `rm`
  - "不，保留" → skip

Also check if `~/.claude/settings.json` contains hardcoded hook paths (not using `${CLAUDE_PLUGIN_ROOT}`).
If found, advise user to remove them to avoid duplicate hook triggers.
</step>

<step name="INIT_WORKSPACE">
After checks pass, ask if the user wants to initialize a workspace.

Ask via AskUserQuestion:
- "要在当前目录初始化 devflow workspace 吗？"
  - "是，初始化 workspace" → run `/devflow:init`
  - "不，稍后再说" → done

If yes, chain to `/devflow:init`.
</step>
