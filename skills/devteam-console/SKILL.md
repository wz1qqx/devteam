---
name: devteam-console
description: "一键唤醒 devteam workspace 控制台。当用户说“打开 devteam 控制台 / 唤醒 devteam / devteam console / workspace 控制台 / 给我 devteam 入口 / 我该怎么继续”时使用。只读汇总当前 workspace harness 状态，默认输出一屏内的 Daily Shortcuts、当前 Primary Next 和 track/repo/worktree/env/runtime/run 摘要；需要完整 track/repo/worktree/run/remote env/sync/image/publish/deploy/skill 命令墙时才使用 --full。不修改代码、不提交、不构建、不部署。"
---

# Devteam Console

Use this skill as the daily entrypoint for the lightweight devteam workflow.
It is a control surface, not an automation pipeline.

## Root Selection

Choose the workspace root in this order:

1. A path explicitly provided by the user.
2. Current working directory or nearest parent containing `.devteam/config.yaml`.
3. `DEVTEAM_ROOT` if it is set and exists.

If no devteam workspace can be found, ask the user for a workspace root.

## Primary Command

When the user opens the console without naming a track and the environment does
not already provide `DEVTEAM_TRACK`, first show the track picker:

```bash
python3 scripts/devteam_console.py --root <workspace-root> --tracks-only
```

Ask the user to choose by number or track name. If they also name a feature
under that track, pass `--feat <feat>`. After the user chooses, reopen the
console with `--set <track>` and optional `--feat <feat>`:

```bash
python3 scripts/devteam_console.py --root <workspace-root> --set <track> [--feat <feat>]
```

Do not ask the user to run `export DEVTEAM_TRACK` manually. Passing `--set` is
the default session-local selection mechanism for Codex conversations.

Track choices may use canonical names or configured aliases such as `v0201`,
`tokenspeed`, or `ts mla`. The CLI resolves aliases centrally; if the choice is
ambiguous, show the matching canonical tracks and ask the user to choose one.

The picker defaults to the daily working set. It hides parked/archived tracks
unless they are selected/default, dirty or missing locally, have active
presence, or have an unfinished latest run. If the user asks for "all tracks",
run the picker with `--all-tracks`.

For parallel terminal sessions, the user may still bind a track per shell with
`DEVTEAM_TRACK`, but do not rely on mutating the workspace default track when
multiple sessions may be active.
When the user needs a reusable shell/session selection, use
`track bind <track> [--feat <feat>] --write --text` and source the printed
`.devteam/state/selection-*.sh` file. This records selection under harness
state without changing `.devteam/config.yaml`.

If the shell already has `DEVTEAM_TRACK` and optionally `DEVTEAM_FEAT`, or the
user explicitly names a track/feature, run the bundled console script directly:

```bash
python3 scripts/devteam_console.py --root <workspace-root>
```

If the user names a track:

```bash
python3 scripts/devteam_console.py --root <workspace-root> --set <track> [--feat <feat>]
```

If the user names a run:

```bash
python3 scripts/devteam_console.py --root <workspace-root> --run <run-id>
```

Use `--full` only when the user asks for a larger command surface or needs to
inspect less common commands. Default output should fit on one screen and
should feel like a daily work entrypoint rather than a command reference page.

## Response Shape

Relay the script output directly or summarize it with the same structure:

- current workspace, active track, optional feature, repo/upstream state,
  effective env/runtime, stable runtime binding file, bootstrap plan status,
  latest run when available
- track source (`--set`, `DEVTEAM_TRACK`, single track, or workspace default)
- track picker dashboard with aliases, dirty/missing worktrees, latest run,
  phase, build profile, active session presence, and next action when no track
  is selected; mention hidden track count when lifecycle filtering hides tracks
- worktree dirty summary and repo upstream drift
- evidence/gate summary only as secondary run context
- current Primary Next
- `dt()` bootstrap snippet
- compact `Daily Shortcuts` for inspect, work loop, verify/build, and skills
- full command panels for status, track, repo, worktree, run, remote env, sync,
  image, publish/deploy, and skill management only when `--full` is requested

Do not execute mutating commands unless the user explicitly asks. In particular,
do not run `sync apply --yes`, `env refresh --yes`, `image prepare`, `ws publish
--yes`, `deploy record`, or `session archive --yes` just because they appear in
the console.

If the runtime binding is missing or stale, recommend `env bind --text` for the
selected track/feature before remote or K8s helper work. The user should source
the printed `.devteam/state/runtime-*.sh` file in new shells so proxy, workdir,
namespace, and worktree path exports stay aligned with the harness selection.
Use `env bootstrap --text` when the user needs initial machine or cluster setup;
it is a read-only plan that prints recipe/preflight/configured commands for
manual review and must not be executed without explicit user intent.

If the selected run is stale because the local worktree HEAD changed after its
evidence was recorded, treat the run as read-only history. The console should
keep status and plan commands visible, but it must not present old-run evidence
writers as the next step: avoid `session record --run <old-run>`,
`env doctor --run <old-run>`, `env refresh --run <old-run>`,
`sync apply --run <old-run>`, `image prepare --run <old-run>`,
`image record --run <old-run>`, `ws publish --run <old-run> --yes`, and
deploy record commands. The correct next action is to start a fresh run for the
current HEAD, then sync and validate that run.

When a newer run has replaced an old stale run, use
`session supersede --run <old-run> --by <new-run>` or `session close --run
<run>` to remove it from active history without deleting evidence. Closed and
superseded runs remain auditable and are visible with `session list --all` or
`session lint --all`, but default console/status output should focus on open
runs.

For a track with several stale historical runs, use `session supersede-plan`
before mutating anything. `session supersede-stale --yes` may be used after
reviewing the plan; it only marks older stale runs as superseded and keeps the
latest stale run visible as the active next-action signal.

When opening a selected track, the console script may touch
`.devteam/presence/<session-id>.json` for that track. Treat this as a soft-lock
hint only: it helps users notice concurrent sessions, but it never blocks work.
The presence id should be stable for the current conversation or terminal
session, so reopening the console should refresh the same entry instead of
creating duplicate sessions.

## Fallback

If the script is unavailable, run:

```bash
DEVTEAM_BIN="${DEVTEAM_CLI:-${HOME}/Documents/devteam/lib/devteam.cjs}"
[ -f "$DEVTEAM_BIN" ] || DEVTEAM_BIN="${HOME}/.claude/plugins/marketplaces/devteam/lib/devteam.cjs"
[ -f "$DEVTEAM_BIN" ] || DEVTEAM_BIN=$(ls ~/.claude/plugins/cache/devteam/devteam/*/lib/devteam.cjs 2>/dev/null | tail -1)
node "$DEVTEAM_BIN" status --root <root>
node "$DEVTEAM_BIN" repo status --root <root> --text
node "$DEVTEAM_BIN" track list --root <root> --text --no-runtime
node "$DEVTEAM_BIN" track status --root <root> --text
node "$DEVTEAM_BIN" track bind <track> --root <root> --text
node "$DEVTEAM_BIN" presence list --root <root> --text
node "$DEVTEAM_BIN" skill list --root <root> --text
```

Then ask the user to choose a track, provide the selected-track console with
`--set`, and include the smallest useful set of next commands.
