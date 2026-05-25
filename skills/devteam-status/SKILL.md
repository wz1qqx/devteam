---
name: devteam-status
description: "快速查看 devteam 对整个 workspace 的聚合状态。当用户说“看下 devteam 状态 / workspace 状况 / 当前 track / run gate / build profile 状态 / 远程验证状态”时使用。只读执行本地 devteam CLI，汇总 worktree、run evidence、sync/test/publish/image/deploy/deploy-verify gate 和下一步，不修改代码、不提交、不构建。"
metadata:
  requires:
    bins: ["node", "python3"]
---

# Devteam Status

Use this skill when the user wants a quick, high-signal view of a devteam
workspace. Keep the answer concise; do not paste raw JSON unless asked.

## Root Selection

Choose the workspace root in this order:

1. A path explicitly provided by the user.
2. Current working directory or nearest parent containing `.devteam/config.yaml`.
3. `DEVTEAM_ROOT` if it is set and exists.

If no devteam workspace can be found, ask the user for a workspace root.

## Primary Command

Run the bundled summary script, resolving it relative to this `SKILL.md`:

```bash
python3 scripts/devteam_status_summary.py --root <workspace-root>
```

Default output is the compact daily dashboard: selected track/run conclusion,
worktree state, stale evidence, gates, primary next action, recent runs, and
history cleanup hint. It scopes the selected run and recent run list to the
current session track. Track selection order is `--set`, then `DEVTEAM_TRACK`,
then `.devteam/config.yaml defaults.track`. Feature
selection is `--feat`, then `DEVTEAM_FEAT`, then `defaults.feat`.
Use `--full` only when the user
asks for detailed evidence, gate internals, dirty-file details, or run-history
issue details.

If the user names a specific run:

```bash
python3 scripts/devteam_status_summary.py --root <workspace-root> --run <run-id>
```

The script uses:

```bash
DEVTEAM_BIN="${DEVTEAM_CLI:-${HOME}/Documents/devteam/lib/devteam.cjs}"
[ -f "$DEVTEAM_BIN" ] || DEVTEAM_BIN="${HOME}/.claude/plugins/marketplaces/devteam/lib/devteam.cjs"
[ -f "$DEVTEAM_BIN" ] || DEVTEAM_BIN=$(ls ~/.claude/plugins/cache/devteam/devteam/*/lib/devteam.cjs 2>/dev/null | tail -1)
node "$DEVTEAM_BIN" status --root <root> --json
node "$DEVTEAM_BIN" status --root <root> --set <track> [--feat <feat>] --json
node "$DEVTEAM_BIN" session list --root <root> --set <track> [--feat <feat>] --limit 3
node "$DEVTEAM_BIN" session lint --root <root> --set <track> [--feat <feat>]
node "$DEVTEAM_BIN" session archive-plan --root <root> --text
```

It auto-selects the latest readable `.devteam/runs/<run-id>` when present,
skipping malformed, deleted track, closed, and superseded history. Use
`--no-run` only if the user wants workspace state without run evidence; that
mode uses the current selected track/feature. If history lint reports error-level
run metadata issues, the script prints a cleanup plan command but does not move
or delete anything.

## Response Shape

Summarize these points:

- workspace root, track, optional feature, run id
- phase and reason
- worktree count, dirty worktrees, branch/head
- evidence: sync, test, publish, image-build, deploy, deploy-verify
- gates: remote validation, publish, image build, deploy, deploy-verify
- image profile completeness and planned image tag
- recent run history when available
- history health: unreadable or deleted track runs and stale evidence warnings
- one to three concrete next actions

For normal answers, lead with the compact conclusion and primary next action.
Only include full evidence/gate/history details when the user asks for them or
when a specific detail changes the recommended next action.

When evidence is stale because the current worktree HEAD no longer matches the
run snapshot, do not recommend writing more evidence to that old run. The
primary next action should be a fresh
`remote-loop start --set <track> [--feat <feat>]` for the current HEAD,
followed by sync and the relevant remote tests. Treat the old run as historical
evidence unless the user explicitly asks about stale-head escape hatches.

If the user decides an old stale run has been replaced by a newer run, prefer
`session supersede --run <old-run> --by <new-run> --reason "<why>"` over
archiving. Superseded or closed runs stay auditable in `.devteam/runs/`, but
default status/list/lint no longer count their stale-head warnings; use
`session list --all` or `session lint --all` for full history.

For multiple stale runs on the same track/feature, use `session supersede-plan`
first. It only proposes old stale runs when the same track/feature has a newer
open run, and it blocks the latest stale run so the active signal is not
hidden. Apply the plan with `session supersede-stale --yes` only after reviewing
it.

Interpretation rules:

- `image.complete: true` means the profile can materialize/build; it does not
  mean Docker build has run.
- `run_gate.status: ready` means required evidence exists for the checked run.
- `publish blocked by worktree_dirty` means the code is intentionally uncommitted
  or unstaged/staged locally.
- For TokenSpeed MLA work on the current v0201 track, remote SM89 validation only
  proves import/selection/rejection behavior; real kernel runtime requires SM100.

## Fallback

If the script is unavailable, run:

```bash
DEVTEAM_BIN="${DEVTEAM_CLI:-${HOME}/Documents/devteam/lib/devteam.cjs}"
[ -f "$DEVTEAM_BIN" ] || DEVTEAM_BIN="${HOME}/.claude/plugins/marketplaces/devteam/lib/devteam.cjs"
[ -f "$DEVTEAM_BIN" ] || DEVTEAM_BIN=$(ls ~/.claude/plugins/cache/devteam/devteam/*/lib/devteam.cjs 2>/dev/null | tail -1)
node "$DEVTEAM_BIN" status --root <root> --json
```

Then summarize the JSON using the response shape above.
