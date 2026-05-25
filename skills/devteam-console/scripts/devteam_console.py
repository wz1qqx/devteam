#!/usr/bin/env python3
import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Optional


DEFAULT_ROOT = Path(os.environ["DEVTEAM_ROOT"]).expanduser() if os.environ.get("DEVTEAM_ROOT") else None


def find_devteam_root(start: Path) -> Optional[Path]:
    current = start.resolve()
    while current != current.parent:
        if (current / ".devteam" / "config.yaml").exists():
            return current
        current = current.parent
    return None


def find_devteam_cli(cli_arg: Optional[str]) -> Path:
    if cli_arg:
        return Path(cli_arg).expanduser().resolve()

    if os.environ.get("DEVTEAM_CLI"):
        return Path(os.environ["DEVTEAM_CLI"]).expanduser().resolve()

    script = Path(__file__).resolve()
    candidates = []
    for parent in script.parents:
        candidates.append(parent / "lib" / "devteam.cjs")

    home = Path.home()
    candidates.extend([
        home / "Documents" / "devteam" / "lib" / "devteam.cjs",
        home / ".claude" / "plugins" / "marketplaces" / "devteam" / "lib" / "devteam.cjs",
    ])

    cache_root = home / ".claude" / "plugins" / "cache" / "devteam" / "devteam"
    if cache_root.exists():
        candidates.extend(sorted(cache_root.glob("*/lib/devteam.cjs"), reverse=True))

    for candidate in candidates:
        if candidate.exists():
            return candidate.resolve()

    return candidates[0].resolve()


def find_root(root_arg: Optional[str]) -> Path:
    if root_arg:
        return Path(root_arg).expanduser().resolve()

    found = find_devteam_root(Path.cwd())
    if found:
        return found

    if DEFAULT_ROOT and DEFAULT_ROOT.exists():
        return DEFAULT_ROOT

    return Path.cwd().resolve()


def env_track() -> Optional[str]:
    return os.environ.get("DEVTEAM_TRACK")


def env_feat() -> Optional[str]:
    return os.environ.get("DEVTEAM_FEAT") or os.environ.get("DEVTEAM_FEATURE")


def run_json_result(cli: Path, root: Path, args: list[str]) -> tuple[Optional[dict], Optional[str]]:
    cmd = ["node", str(cli), *args, "--root", str(root)]
    proc = subprocess.run(cmd, text=True, capture_output=True)
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or f"exit {proc.returncode}").strip()
        return None, detail
    try:
        return json.loads(proc.stdout), None
    except json.JSONDecodeError as exc:
        return None, f"invalid JSON from devteam CLI: {exc}"


def run_json(cli: Path, root: Path, args: list[str]) -> Optional[dict]:
    payload, _ = run_json_result(cli, root, args)
    return payload


def run_text(cli: Path, root: Path, args: list[str]) -> Optional[str]:
    cmd = ["node", str(cli), *args, "--root", str(root)]
    proc = subprocess.run(cmd, text=True, capture_output=True)
    if proc.returncode != 0:
        return None
    return proc.stdout.strip()


def quoted(value: object) -> str:
    return json.dumps(str(value))


def scope_args(track: Optional[str], feat: Optional[str] = None) -> list[str]:
    args = []
    if track:
        args.extend(["--set", str(track)])
    if feat:
        args.extend(["--feat", str(feat)])
    return args


def scope_text(track: Optional[str], feat: Optional[str] = None) -> str:
    parts = []
    if track:
        parts.extend(["--set", str(track)])
    if feat:
        parts.extend(["--feat", str(feat)])
    return " ".join(parts)


def compact_list(values: object, max_items: int = 4) -> str:
    if not isinstance(values, list) or not values:
        return "-"
    shown = [str(item) for item in values[:max_items]]
    if len(values) > max_items:
        shown.append(f"+{len(values) - max_items}")
    return ",".join(shown)


def phase_summary(run: object) -> str:
    if not isinstance(run, dict) or not run:
        return "no-run"
    phase = run.get("phase") or {}
    return f"{phase.get('name') or '-'}:{phase.get('status') or '-'}"


def is_harness_status(status: object) -> bool:
    return isinstance(status, dict) and status.get("action") == "harness_status"


def latest_run(status: dict) -> Optional[dict]:
    if is_harness_status(status):
        return ((status.get("recent_runs") or {}).get("latest") or None)
    return status if status.get("run_id") else None


def selected_track(status: dict) -> Optional[str]:
    return status.get("workspace_set") or status.get("track")


def selected_feat(status: dict) -> Optional[str]:
    return status.get("feat")


def track_badges(track: dict) -> str:
    badges = []
    status = track.get("status")
    if status:
        badges.append(str(status))
    runtime = track.get("runtime") or {}
    workspace = runtime.get("workspace") or {}
    latest = runtime.get("latest_run")
    if workspace.get("missing", 0):
        badges.append("missing")
    if workspace.get("dirty", 0):
        badges.append("dirty")
    if runtime.get("presence_count", 0):
        badges.append(f"presence:{runtime.get('presence_count')}")
    if latest and ((latest.get("phase") or {}).get("status") in ["needs_attention", "blocked"]):
        badges.append(str((latest.get("phase") or {}).get("status")))
    if not latest:
        badges.append("no-run")
    if track.get("build"):
        badges.append("build")
    return ",".join(badges) if badges else "ready"


def short_head(value: object) -> str:
    text = str(value or "")
    return text[:9] if text else "-"


def dirty_summary_text(summary: object) -> str:
    if not isinstance(summary, dict):
        summary = {}
    return (
        f"staged:{summary.get('staged', 0) or 0} "
        f"unstaged:{summary.get('unstaged', 0) or 0} "
        f"untracked:{summary.get('untracked', 0) or 0}"
    )


def run_history_text(history: object) -> str:
    if not isinstance(history, dict):
        history = {}
    totals = history.get("totals") if isinstance(history.get("totals"), dict) else {}
    parts = [f"open:{totals.get('open', 0) or 0}"]
    for key in ["closed", "superseded", "archived", "other", "unreadable"]:
        value = totals.get(key, 0) or 0
        if value:
            parts.append(f"{key}:{value}")
    return " ".join(parts)


def phase_text(status: dict) -> str:
    if is_harness_status(status):
        run = latest_run(status)
        if not run:
            return "harness/ready"
        phase = run.get("phase") or {}
        name = phase.get("name") or "-"
        state = phase.get("status") or "-"
        reason = phase.get("reason") or ""
        return f"{name}/{state}" + (f" - {reason}" if reason else "")
    phase = status.get("phase") or {}
    name = phase.get("name") or "-"
    state = phase.get("status") or "-"
    reason = phase.get("reason") or ""
    return f"{name}/{state}" + (f" - {reason}" if reason else "")


def evidence_text(status: dict) -> str:
    if is_harness_status(status):
        run = latest_run(status)
        return evidence_text(run) if run else "no run evidence"
    evidence = status.get("evidence") or {}
    publish = status.get("publish") or {}
    passed = []
    missing = []
    attention = []
    keys = ["env-doctor", "sync", "test"]
    if (evidence.get("env-refresh") or {}).get("status") not in [None, "missing"]:
        keys.append("env-refresh")
    if publish and (publish.get("totals") or {}).get("entries", 0):
        keys.append("publish")
    if status.get("image"):
        keys.append("image-build")
    if status.get("deploy"):
        keys.extend(["deploy", "deploy-verify"])
    for key in keys:
        item = evidence.get(key) or {}
        state = item.get("status") or "missing"
        if state == "passed":
            passed.append(key)
        elif state == "missing":
            missing.append(key)
        else:
            attention.append(f"{key}:{state}")
    parts = []
    if passed:
        parts.append(f"passed={compact_list(passed)}")
    if attention:
        parts.append(f"attention={compact_list(attention)}")
    if missing:
        parts.append(f"missing={compact_list(missing)}")
    return "; ".join(parts) if parts else "none"


def gate_text(status: dict, name: str) -> str:
    if is_harness_status(status):
        return "n/a"
    gate = (status.get("gates") or {}).get(name) or {}
    return gate.get("status") or "n/a"


def head_changed(status: dict) -> bool:
    if is_harness_status(status):
        return False
    return ((status.get("head_check") or {}).get("status") == "changed")


def active_session_text(item: dict) -> str:
    label = str(item.get("session_id") or "-")
    if item.get("purpose"):
        label += f":{item.get('purpose')}"
    if item.get("run_id"):
        label += f" run={item.get('run_id')}"
    return label


def emit_presence_summary(cli: Path, root: Path, track: str, feat: Optional[str], current_session: Optional[str]) -> None:
    payload = run_json(cli, root, ["presence", "list", *scope_args(track, feat)])
    if not payload:
        return
    entries = payload.get("entries") or []
    other_entries = [
        item for item in entries
        if str(item.get("session_id") or "") != str(current_session or "")
    ]
    if not entries:
        print("- Active sessions on scope: 0")
        return
    print(f"- Active sessions on scope: {len(entries)}")
    if other_entries:
        shown = ", ".join(active_session_text(item) for item in other_entries[:3])
        more = f", +{len(other_entries) - 3}" if len(other_entries) > 3 else ""
        print(f"- Other active sessions: {shown}{more}")


def worktree_text(status: dict) -> str:
    if is_harness_status(status):
        totals = (status.get("worktrees") or {}).get("totals") or {}
        worktrees = (status.get("worktrees") or {}).get("entries") or []
    else:
        totals = status.get("workspace_status") or {}
        worktrees = status.get("worktrees") or []
    base = (
        f"{totals.get('present', 0)}/{totals.get('worktrees', 0)} present, "
        f"{totals.get('dirty', 0)} dirty, {totals.get('missing', 0)} missing"
    )
    if not worktrees:
        return base
    current = worktrees[0]
    dirty = "dirty" if current.get("dirty") else "clean"
    files = current.get("dirty_file_count") or 0
    file_text = f", files={files} ({dirty_summary_text(current.get('dirty_summary'))})" if files else ""
    more = f", +{len(worktrees) - 1} more" if len(worktrees) > 1 else ""
    return (
        f"{base}; {current.get('id', '-')} "
        f"{current.get('branch') or current.get('desired_branch') or '-'} "
        f"@ {short_head(current.get('head'))}, {dirty}{file_text}{more}"
    )


def primary_next(status: dict) -> list[str]:
    if is_harness_status(status):
        return [str(item) for item in (status.get("next_actions") or [])[:2]] or ["No immediate action is required."]
    actions = status.get("next_actions") or []
    if actions:
        return [str(item) for item in actions[:2]]
    workspace_set = status.get("workspace_set") or ""
    feat = status.get("feat") or None
    scope = scope_text(workspace_set, feat)
    totals = status.get("workspace_status") or {}
    if totals.get("dirty", 0):
        return [
            "Review local dirty files before syncing or publishing.",
            f"dt ws status {scope} --text --full".strip(),
        ]
    return ["No immediate action is required."]


def display_command(text: object, cli: Path, root: Path) -> str:
    value = str(text)
    cli_pattern = re.escape(str(cli))
    root_pattern = re.escape(str(root))
    value = re.sub(rf'^node\s+"{cli_pattern}"\s+', "dt ", value)
    value = re.sub(rf"^node\s+'{cli_pattern}'\s+", "dt ", value)
    value = re.sub(rf"^node\s+{cli_pattern}\s+", "dt ", value)
    value = re.sub(rf'\s+--root\s+"{root_pattern}"', "", value)
    value = re.sub(rf"\s+--root\s+'{root_pattern}'", "", value)
    value = re.sub(rf"\s+--root\s+{root_pattern}", "", value)
    return value


def command(cli: Path, root: Path, *parts: str) -> str:
    return f"node {quoted(cli)} {' '.join(parts)} --root {quoted(root)}"


def dt_command(*parts: str) -> str:
    return "dt " + " ".join(parts)


def emit_cmd(command_text: str) -> None:
    print(f"  - {dt_command(command_text)}")


def emit_track_picker(track_list: dict, cli: Path, root: Path) -> None:
    tracks = track_list.get("tracks") or []
    totals = track_list.get("totals") or {}
    print("Devteam Track Picker")
    print(f"- Workspace: {track_list.get('workspace') or str(root)}")
    print(f"- Workspace default: {track_list.get('default_track') or '-'}")
    print(f"- Current env track: {env_track() or '-'}")
    print(f"- Track filter: {track_list.get('filter') or 'all'} ({totals.get('shown', len(tracks))}/{totals.get('tracks', len(tracks))} shown, {totals.get('hidden', 0)} hidden)")
    print("")
    print("Tracks")
    if not tracks:
        print("- (none)")
    for index, track in enumerate(tracks, start=1):
        active = " default" if track.get("name") == track_list.get("default_track") else ""
        aliases = compact_list(track.get("aliases"), max_items=3)
        runtime = track.get("runtime") or {}
        workspace = runtime.get("workspace") or {}
        latest = runtime.get("latest_run")
        next_actions = runtime.get("next_actions") or []
        next_summary = (next_actions[0] or {}).get("summary") if next_actions else None
        presence = runtime.get("presence") or []
        print(
            f"{index}. {track.get('name')}{active} [{track_badges(track)}] - "
            f"{track.get('description') or ''}".rstrip()
        )
        print(
            "   "
            f"aliases={aliases} "
            f"repos={compact_list(track.get('repos'))} "
            f"worktrees={workspace.get('present', 0)}/{workspace.get('worktrees', track.get('worktrees') or 0)} "
            f"dirty={workspace.get('dirty', 0)} "
            f"env={track.get('env') or '-'} "
            f"build={track.get('build') or '-'} "
            f"deploy={track.get('deploy') or '-'}"
        )
        print(
            "   "
            f"latest={latest.get('run_id') if latest else '-'} "
            f"phase={phase_summary(latest)} "
            f"runs={run_history_text(runtime.get('run_history'))}"
        )
        if next_summary:
            print(f"   next={next_summary}")
        if presence:
            sessions = []
            for item in presence[:3]:
                label = str(item.get("session_id") or "-")
                if item.get("purpose"):
                    label += f":{item.get('purpose')}"
                sessions.append(label)
            print(f"   active_sessions={','.join(sessions)}")
    print("")
    print("Choose")
    print("- Reply with a track number or track name.")
    print("- I will reopen this console with --set <track> for this session only.")
    if totals.get("hidden", 0):
        print("- Ask for all tracks to include parked/archived tracks hidden by default.")
    print("- This does not modify .devteam/config.yaml or require a manual export.")
    print("")
    print("Direct command template")
    print("```bash")
    print(f"python3 {quoted(Path(__file__).resolve())} --root {quoted(root)} --cli {quoted(cli)} --set <track>")
    print("```")


def emit_bootstrap(cli: Path, root: Path, track: Optional[str], feat: Optional[str] = None, status: Optional[dict] = None) -> None:
    status = status or {}
    selection_binding = status.get("selection_binding") or {}
    runtime_binding = ((status.get("runtime") or {}).get("binding") or {})
    print("\nBootstrap")
    print("```bash")
    print(f"cd {quoted(root)}")
    print(f"export DEVTEAM_BIN={quoted(cli)}")
    if selection_binding.get("exists") and selection_binding.get("source"):
        print(selection_binding.get("source"))
    elif track:
        print(f"export DEVTEAM_TRACK={quoted(track)}")
    if not (selection_binding.get("exists") and selection_binding.get("source")) and feat:
        print(f"export DEVTEAM_FEAT={quoted(feat)}")
    if runtime_binding.get("exists") and runtime_binding.get("current") and runtime_binding.get("source"):
        print(runtime_binding.get("source"))
    print(f"dt() {{ node \"$DEVTEAM_BIN\" \"$@\" --root {quoted(root)}; }}")
    print("```")


def emit_command_groups(status: dict, cli: Path, root: Path, full: bool, track_profile: Optional[dict] = None) -> None:
    workspace_set = selected_track(status) or "<track>"
    feat = selected_feat(status)
    scope = scope_text(workspace_set, feat)
    latest = latest_run(status)
    run_id = (latest or {}).get("run_id") or status.get("run_id") or "<run-id>"
    profiles = status.get("profiles") or {}
    track_profile = track_profile or {}
    harness_env = status.get("environment") or {}
    run_image_enabled = bool(profiles.get("build") or status.get("image"))
    run_deploy_enabled = bool(profiles.get("deploy") or status.get("deploy"))
    env_profile = profiles.get("env") or profiles.get("sync") or harness_env.get("profile") or track_profile.get("env")
    sync_profile = profiles.get("sync") or env_profile
    image_profile = profiles.get("build") or track_profile.get("build")
    deploy_profile = profiles.get("deploy") or track_profile.get("deploy")
    image = status.get("image") or {}
    if image:
        image_profile = image.get("profile") or image_profile
    deploy = status.get("deploy") or {}
    if deploy:
        deploy_profile = deploy.get("profile") or deploy_profile
    stale_run = head_changed(status)

    print("\nControl Panels")
    print("- Status:")
    emit_cmd("track status --text")
    emit_cmd(f"status {scope}".strip())
    emit_cmd("session list --text")

    print("- Track:")
    emit_cmd("track list --text")
    emit_cmd("track bind <track> --text")
    emit_cmd("track bind <track> --write --text")
    emit_cmd("track use <track> --dry-run")

    print("- Repo:")
    emit_cmd(f"repo status {scope} --text".strip())
    emit_cmd(f"repo update-plan {scope}".strip())

    print("- Worktree:")
    emit_cmd(f"ws status {scope} --text --full".strip())
    emit_cmd(f"ws publish-plan {scope} --run {run_id}".strip())
    if stale_run:
        print("  - publish is blocked for this run; refresh validation on a fresh run first")
    else:
        emit_cmd(f"ws publish {scope} --run {run_id} --yes".strip())

    print("- Run:")
    emit_cmd(f"remote-loop plan {scope}".strip())
    emit_cmd(f"remote-loop start {scope} --text".strip())
    emit_cmd(f"session status --run {run_id} --text")
    if stale_run:
        print("  - current run is stale; start a fresh run before recording test evidence")
    else:
        emit_cmd(f'session record --run {run_id} --kind test --status passed --summary "..."')

    print("- Remote env:")
    env_hint = env_profile or "<env-profile>"
    emit_cmd(f"env bootstrap {scope} --profile {env_hint} --text".strip())
    if stale_run:
        print("  - current run is stale; start a fresh run before recording env evidence")
        emit_cmd(f"env doctor --profile {env_hint} --remote")
        emit_cmd(f"env refresh --profile {env_hint}")
    else:
        emit_cmd(f"env doctor --profile {env_hint} --remote --run {run_id}")
        emit_cmd(f"env refresh --profile {env_hint} --run {run_id}")
        emit_cmd(f"env refresh --profile {env_hint} --run {run_id} --yes")

    print("- Sync:")
    sync_hint = sync_profile or "<env-profile>"
    emit_cmd(f"sync plan {scope} --profile {sync_hint} --dirty-only".strip())
    if stale_run:
        print("  - current run is stale; start a fresh run before sync apply --run")
    else:
        emit_cmd(f"sync apply {scope} --profile {sync_hint} --dirty-only --run {run_id} --yes".strip())
    if full:
        emit_cmd(f"sync plan {scope} --profile {sync_hint} --branch-patch".strip())

    image_label = "Image" if run_image_enabled else "Image (track optional)"
    print(f"- {image_label}:")
    image_hint = image_profile or "<build-profile>"
    emit_cmd(f"image plan {scope} --profile {image_hint} --run {run_id}".strip())
    if stale_run:
        print("  - current run is stale; start a fresh run before preparing image context")
        print("  - current run is stale; start a fresh run before recording image-build evidence")
    else:
        emit_cmd(f"image prepare {scope} --profile {image_hint} --run {run_id}".strip())
        emit_cmd(f"image record --run {run_id} --profile {image_hint} --image <image-ref>")

    deploy_label = "Deploy" if run_deploy_enabled else "Deploy (track optional)"
    print(f"- {deploy_label}:")
    deploy_hint = deploy_profile or "<deploy-profile>"
    emit_cmd(f"deploy plan {scope} --profile {deploy_hint} --run {run_id}".strip())
    if stale_run:
        print("  - current run is stale; start a fresh run before recording deploy evidence")
    else:
        emit_cmd(f"deploy record {scope} --profile {deploy_hint} --run {run_id} --image <image-ref>".strip())
        emit_cmd(f'deploy verify-record {scope} --profile {deploy_hint} --run {run_id} --status passed --summary "..."'.strip())

    print("- Skills:")
    emit_cmd("skill list --text")
    emit_cmd("skill lint --text")
    emit_cmd("skill install <skill-name> --yes")


def emit_daily_shortcuts(status: dict, cli: Path, root: Path, track_profile: Optional[dict] = None) -> None:
    workspace_set = selected_track(status) or "<track>"
    feat = selected_feat(status)
    scope = scope_text(workspace_set, feat)
    latest = latest_run(status)
    run_id = (latest or {}).get("run_id") or status.get("run_id")
    profiles = status.get("profiles") or {}
    track_profile = track_profile or {}
    harness_env = status.get("environment") or {}
    env_profile = profiles.get("env") or profiles.get("sync") or harness_env.get("profile") or track_profile.get("env")
    image_profile = profiles.get("build") or track_profile.get("build")
    image = status.get("image") or {}
    if image:
        image_profile = image.get("profile") or image_profile
    stale_run = head_changed(status)

    print("\nDaily Shortcuts")
    print("- Inspect:")
    emit_cmd(f"status {scope}".strip())
    emit_cmd(f"repo status {scope} --text".strip())
    emit_cmd(f"track status {scope} --text".strip())
    emit_cmd(f"ws status {scope} --text".strip())

    print("- Work loop:")
    emit_cmd(f"remote-loop plan {scope} --text".strip())
    emit_cmd(f"remote-loop start {scope} --text".strip())
    if run_id:
        emit_cmd(f"session status --run {run_id} --text")
    emit_cmd(f"session list {scope} --text".strip())

    print("- Verify / build:")
    env_hint = env_profile or "<env-profile>"
    emit_cmd(f"env bootstrap {scope} --profile {env_hint} --text".strip())
    if stale_run:
        print("  - current run is stale; start a fresh run before recording evidence")
        emit_cmd(f"env doctor --profile {env_hint} --remote")
    elif run_id:
        emit_cmd(f"env doctor --profile {env_hint} --remote --run {run_id}")
    else:
        emit_cmd(f"env doctor --profile {env_hint} --remote")
    if stale_run:
        print("  - image planning belongs on the fresh run after re-validation")
    elif image_profile and run_id:
        emit_cmd(f"image plan {scope} --profile {image_profile} --run {run_id}".strip())
    elif image_profile:
        emit_cmd(f"image plan {scope} --profile {image_profile}".strip())
    else:
        emit_cmd(f"image plan {scope} --profile <build-profile>".strip())

    print("- Skills:")
    emit_cmd("skill list --text")
    print("- Full command panels: reopen this console with --full")


def main() -> None:
    parser = argparse.ArgumentParser(description="Open the devteam workspace console.")
    parser.add_argument("--root", help="Workspace root. Defaults to cwd/parents with .devteam/config.yaml, then DEVTEAM_ROOT.")
    parser.add_argument("--set", help="Track. Defaults to DEVTEAM_TRACK, then workspace default.")
    parser.add_argument("--feat", help="Feature under the selected track. Defaults to DEVTEAM_FEAT, then workspace default.")
    parser.add_argument("--run", help="Run id.")
    parser.add_argument("--cli", help="Path to devteam.cjs. Defaults to DEVTEAM_CLI, then bundled plugin/repo locations.")
    parser.add_argument("--full", action="store_true", help="Print a larger command surface.")
    parser.add_argument("--tracks-only", action="store_true", help="Print available tracks and exit.")
    parser.add_argument("--all-tracks", action="store_true", help="Show parked/archived tracks in the picker.")
    parser.add_argument("--use-default", action="store_true", help="Use the workspace default track when no session track is selected.")
    parser.add_argument("--session-id", help="Presence session id to touch when opening a selected track.")
    parser.add_argument("--purpose", help="Short purpose stored in session presence.")
    parser.add_argument("--no-presence", action="store_true", help="Do not touch session presence.")
    args = parser.parse_args()

    root = find_root(args.root)
    cli = find_devteam_cli(args.cli)
    if not cli.exists():
        raise SystemExit(f"devteam CLI not found: {cli}")

    selected_set = args.set or env_track()
    selected_feature = args.feat or env_feat()
    status = None
    if not args.tracks_only and not selected_set and not args.run and not args.use_default:
        status = run_json(cli, root, ["status", "--json"])
        selected_set = selected_track(status or {})
        selected_feature = selected_feat(status or {})
    if args.tracks_only or (not selected_set and not args.run and not args.use_default):
        track_list_args = ["track", "list"]
        if not args.all_tracks:
            track_list_args.append("--active-only")
        track_list = run_json(cli, root, track_list_args)
        if not track_list:
            sys.stderr.write("Failed to read devteam tracks.\n")
            raise SystemExit(1)
        tracks = track_list.get("tracks") or []
        if args.tracks_only or len(tracks) != 1:
            emit_track_picker(track_list, cli, root)
            return
        selected_set = tracks[0].get("name")

    status_args = ["status", "--json"]
    if args.run:
        status_args.extend(["--run", args.run])
    elif selected_set:
        status_args.extend(scope_args(selected_set, selected_feature))
    if status is None:
        status = run_json(cli, root, status_args)
    if not status:
        sys.stderr.write("Failed to read devteam status.\n")
        raise SystemExit(1)
    track_status = None
    track_profile = None
    if selected_set:
        track_status = run_json(cli, root, ["track", "status", *scope_args(selected_set, selected_feature), "--no-runtime"])
        if track_status:
            track_profile = track_status.get("track") or {}

    print("Devteam Console")
    print(f"- Workspace: {status.get('workspace') or str(root)}")
    track = selected_track(status) or selected_set
    feat = selected_feat(status) or selected_feature
    print(f"- Track: {track or '-'}")
    if feat:
        print(f"- Feature: {feat}")
    track_source = "--set" if args.set else ("DEVTEAM_TRACK" if env_track() else (status.get("workspace_set_source") or ("single track" if selected_set else "workspace default")))
    print(f"- Track source: {track_source}")
    if track and not args.no_presence:
        presence_args = ["presence", "touch", *scope_args(str(track), feat), "--tool", "devteam-console"]
        if args.run:
            presence_args.extend(["--run", args.run])
        if args.session_id:
            presence_args.extend(["--session-id", args.session_id])
        if args.purpose:
            presence_args.extend(["--purpose", args.purpose])
        presence, presence_error = run_json_result(cli, root, presence_args)
        if presence:
            print(f"- Presence: {presence.get('session_id')} touched")
            emit_presence_summary(cli, root, str(track), feat, presence.get("session_id"))
        elif presence_error:
            print(f"- Presence: unavailable ({presence_error})")
    latest = latest_run(status)
    print(f"- Run: {(latest or {}).get('run_id') or status.get('run_id') or '-'}")
    print(f"- State: {phase_text(status)}")
    print(f"- Worktree: {worktree_text(status)}")
    if is_harness_status(status):
        selection_binding = status.get("selection_binding") or {}
        if selection_binding.get("exists"):
            print(
                "- Selection binding: "
                f"{selection_binding.get('source') or '-'} "
                f"track={selection_binding.get('track') or '-'}"
                + (f" feat={selection_binding.get('feat')}" if selection_binding.get("feat") else "")
            )
        repo_totals = ((status.get("repos") or {}).get("totals") or {})
        environment = status.get("environment") or {}
        print(
            "- Repo: "
            f"{repo_totals.get('repos', 0)} repos, "
            f"{repo_totals.get('behind_upstream', 0)} behind, "
            f"{repo_totals.get('upstream_unknown', 0)} upstream unknown"
        )
        print(
            "- Environment: "
            f"{environment.get('profile') or '-'} "
            f"type={environment.get('type') or '-'} "
            f"proxy={'yes' if environment.get('proxy_configured') else 'no'}"
        )
        binding = ((status.get("runtime") or {}).get("binding") or {})
        if binding:
            state = "current" if binding.get("exists") and binding.get("current") else ("stale" if binding.get("exists") else "missing")
            print(f"- Runtime binding: {state} {binding.get('shell_path') or '-'}")
        bootstrap = environment.get("bootstrap") or {}
        if bootstrap:
            recipe = bootstrap.get("recipe") or {}
            print(
                "- Env bootstrap: "
                f"{bootstrap.get('status') or '-'} "
                f"commands={bootstrap.get('command_count', 0)} "
                f"recipe={recipe.get('path') or '-'}"
            )
    print(f"- Evidence: {evidence_text(status)}")
    print(
        "- Gates: "
        f"remote={gate_text(status, 'remote_validation')}, "
        f"publish={gate_text(status, 'publish')}, "
        f"image={gate_text(status, 'image_build')}, "
        f"deploy={gate_text(status, 'deploy')}"
    )

    image = status.get("image") or {}
    if image:
        print(f"- Image profile: {image.get('profile') or '-'}")
        if image.get("image"):
            print(f"- Planned image: {image.get('image')}")

    print("\nPrimary Next")
    for item in primary_next(status):
        print(f"- {display_command(item, cli, root)}")

    emit_bootstrap(cli, root, track, feat, status)
    if args.full:
        emit_command_groups(status, cli, root, args.full, track_profile)
    else:
        emit_daily_shortcuts(status, cli, root, track_profile)

    skill_text = run_text(cli, root, ["skill", "list", "--text"])
    if skill_text:
        first_lines = skill_text.splitlines()[:4]
        print("\nSkill Install State")
        for line in first_lines:
            print(f"- {line}")


if __name__ == "__main__":
    main()
