---
name: devteam-status
description: "快速查看 devteam 对整个 workspace 的聚合状态。当用户说“看下 devteam 状态 / workspace 状况 / 当前 track / repo upstream / 环境绑定 / runtime / run gate”时使用。只读执行本地 devteam CLI，优先汇总 harness、repo、worktree、env/runtime、sync state、presence 和最近 run；需要时再展示 session evidence/gate。"
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

Default output is the compact daily dashboard. It starts from harness state:
selected track/feature, repo upstream drift, worktree dirty/missing state,
effective environment/runtime exports, stable runtime binding, proxy binding,
bootstrap plan status, sync state, presence, primary next action, recent runs,
and history cleanup hint. When a latest run is present, it can also show session
evidence/gates as secondary context. Track selection order is `--set`, then
`DEVTEAM_TRACK`, then `.devteam/config.yaml defaults.track`. Feature selection
is `--feat`, then `DEVTEAM_FEAT`, then `defaults.feat`.
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
node "$DEVTEAM_BIN" repo status --root <root> --set <track> [--feat <feat>]
node "$DEVTEAM_BIN" status --root <root> --set <track> [--feat <feat>] --session --json
node "$DEVTEAM_BIN" session list --root <root> --set <track> [--feat <feat>] --limit 3
node "$DEVTEAM_BIN" session lint --root <root> --set <track> [--feat <feat>]
node "$DEVTEAM_BIN" session archive-plan --root <root> --text
```

For session detail it auto-selects the latest readable `.devteam/runs/<run-id>` when present,
skipping malformed, deleted track, closed, and superseded history. Use
`--no-run` only if the user wants workspace state without run evidence; that
mode uses the current selected track/feature. If history lint reports error-level
run metadata issues, the script prints a cleanup plan command but does not move
or delete anything.

## Response Shape

Summarize these points:

- workspace root, track, optional feature
- repo/upstream status: behind and unknown counts
- worktree count, dirty worktrees, branch/head
- effective environment profile, runtime export availability, stable binding
  file, and proxy binding
- bootstrap plan status and recipe/command count when configured
- sync state and presence
- latest run id, phase, and reason when a run exists
- evidence/gates only when relevant to the user's question or next action
- image profile completeness and planned image tag when configured
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
