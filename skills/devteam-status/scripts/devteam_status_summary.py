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


def scope_parts(workspace_set: Optional[str], feat: Optional[str] = None) -> list[str]:
    parts = []
    if workspace_set:
        parts.extend(["--set", workspace_set])
    if feat:
        parts.extend(["--feat", feat])
    return parts


def scope_command(workspace_set: Optional[str], feat: Optional[str] = None) -> str:
    parts = []
    if workspace_set:
        parts.extend(["--set", quoted(workspace_set)])
    if feat:
        parts.extend(["--feat", quoted(feat)])
    return " ".join(parts)


def run_devteam_status(
    cli: Path,
    root: Path,
    run_id: Optional[str],
    workspace_set: Optional[str],
    feat: Optional[str] = None,
) -> dict:
    cmd = ["node", str(cli), "status", "--root", str(root), "--session", "--json"]
    if run_id:
        cmd.extend(["--run", run_id])
    elif workspace_set:
        cmd.extend(scope_parts(workspace_set, feat))

    proc = subprocess.run(cmd, text=True, capture_output=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr or proc.stdout)
        raise SystemExit(proc.returncode)

    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        sys.stderr.write(proc.stdout)
        raise


def run_session_list(
    cli: Path,
    root: Path,
    limit: int = 3,
    workspace_set: Optional[str] = None,
    feat: Optional[str] = None,
) -> Optional[dict]:
    cmd = [
        "node",
        str(cli),
        "session",
        "list",
        "--root",
        str(root),
        "--limit",
        str(limit),
    ]
    if workspace_set:
        cmd.extend(scope_parts(workspace_set, feat))
    proc = subprocess.run(cmd, text=True, capture_output=True)
    if proc.returncode != 0:
        return None
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        return None


def run_session_lint(
    cli: Path,
    root: Path,
    workspace_set: Optional[str] = None,
    feat: Optional[str] = None,
) -> Optional[dict]:
    cmd = [
        "node",
        str(cli),
        "session",
        "lint",
        "--root",
        str(root),
    ]
    if workspace_set:
        cmd.extend(scope_parts(workspace_set, feat))
    proc = subprocess.run(cmd, text=True, capture_output=True)
    if proc.returncode != 0:
        return None
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        return None


def run_workspace_status(cli: Path, root: Path, workspace_set: Optional[str] = None, feat: Optional[str] = None) -> dict:
    cmd = ["node", str(cli), "status", "--root", str(root), "--json"]
    if workspace_set:
        cmd.extend(scope_parts(workspace_set, feat))
    proc = subprocess.run(cmd, text=True, capture_output=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr or proc.stdout)
        raise SystemExit(proc.returncode)
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        sys.stderr.write(proc.stdout)
        raise


def status_text(item: Optional[dict]) -> str:
    if not item:
        return "missing"
    status = item.get("status") or "unknown"
    ok = item.get("ok")
    if ok is True:
        return f"{status} ok"
    if ok is False:
        return f"{status} blocked"
    return status


def gate_text(gate: Optional[dict]) -> str:
    if not gate:
        return "n/a"
    return gate.get("status") or "unknown"


def short_head(head: Optional[str]) -> str:
    if not head:
        return "-"
    return head[:9]


def compact_list(values: object, max_items: int = 3) -> str:
    if not isinstance(values, list) or not values:
        return "-"
    shown = [str(item) for item in values[:max_items]]
    if len(values) > max_items:
        shown.append(f"+{len(values) - max_items}")
    return ",".join(shown)


def dirty_summary_text(summary: object) -> str:
    if not isinstance(summary, dict):
        summary = {}
    return (
        f"staged:{summary.get('staged', 0) or 0} "
        f"unstaged:{summary.get('unstaged', 0) or 0} "
        f"untracked:{summary.get('untracked', 0) or 0}"
    )


def dirty_file_suffix(item: dict) -> str:
    dirty_count = item.get("dirty_file_count") or 0
    if not dirty_count:
        return ""
    return f", files={dirty_count} ({dirty_summary_text(item.get('dirty_summary'))})"


def quoted(value: object) -> str:
    return json.dumps(str(value))


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


def archive_plan_command(cli: Path, root: Path, workspace_set: Optional[str] = None, feat: Optional[str] = None) -> str:
    command = f"node {quoted(cli)} session archive-plan --root {quoted(root)}"
    scope = scope_command(workspace_set, feat)
    if scope:
        command += f" {scope}"
    return f"{command} --text"


def remote_loop_command(cli: Path, root: Path, workspace_set: Optional[str], feat: Optional[str] = None) -> str:
    command = f"node {quoted(cli)} remote-loop start --root {quoted(root)}"
    scope = scope_command(workspace_set, feat)
    if scope:
        command += f" {scope}"
    command += " --text"
    return command


def history_counts(run_lint: Optional[dict]) -> dict:
    if not run_lint:
        return {"errors": 0, "warnings": 0, "invalid_runs": 0}
    totals = run_lint.get("totals") or {}
    invalid_runs = {
        issue.get("run_id")
        for issue in (run_lint.get("issues") or [])
        if issue.get("severity") == "error" and issue.get("run_id")
    }
    return {
        "errors": totals.get("errors", 0) or 0,
        "warnings": totals.get("warnings", 0) or 0,
        "invalid_runs": len(invalid_runs),
    }


def history_brief(run_lint: Optional[dict]) -> str:
    if not run_lint:
        return "unknown"
    counts = history_counts(run_lint)
    if counts["errors"]:
        return (
            f"needs cleanup, {counts['invalid_runs']} invalid run(s), "
            f"{counts['warnings']} stale-evidence warning(s)"
        )
    if counts["warnings"]:
        return f"needs attention, {counts['warnings']} stale-evidence warning(s)"
    return "clean"


def head_changed(data: dict) -> bool:
    return ((data.get("head_check") or {}).get("status") == "changed")


def evidence_brief(data: dict) -> str:
    evidence = data.get("evidence") or {}
    keys = ["env-doctor", "sync", "test"]
    if (evidence.get("env-refresh") or {}).get("status") not in [None, "missing"]:
        keys.append("env-refresh")
    publish = data.get("publish") or {}
    if publish and (publish.get("totals") or {}).get("entries", 0):
        keys.append("publish")
    if data.get("image"):
        keys.append("image-build")
    if data.get("deploy"):
        keys.extend(["deploy", "deploy-verify"])
    passed = []
    missing = []
    other = []
    for key in keys:
        item = evidence.get(key) or {}
        status = item.get("status") or "missing"
        if status == "passed":
            passed.append(key)
        elif status == "missing":
            missing.append(key)
        else:
            other.append(f"{key}:{status}")

    parts = []
    if passed:
        suffix = " (old HEAD)" if head_changed(data) else ""
        parts.append(f"passed={compact_list(passed, 5)}{suffix}")
    if other:
        parts.append(f"attention={compact_list(other, 4)}")
    if missing:
        parts.append(f"missing={compact_list(missing, 5)}")
    return "; ".join(parts) if parts else "none"


def worktree_brief(data: dict) -> str:
    if data.get("action") == "harness_status":
        workspace_status = ((data.get("worktrees") or {}).get("totals") or {})
        worktrees = ((data.get("worktrees") or {}).get("entries") or [])
    else:
        workspace_status = data.get("workspace_status") or {}
        worktrees = data.get("worktrees") or []
    base = (
        f"{workspace_status.get('present', 0)}/{workspace_status.get('worktrees', 0)} present, "
        f"{workspace_status.get('dirty', 0)} dirty"
    )
    if not worktrees:
        return base
    first = worktrees[0]
    suffix = ""
    if len(worktrees) > 1:
        suffix = f", +{len(worktrees) - 1} more"
    return (
        f"{base}; {first.get('id', '-')} "
        f"{first.get('branch', '-') or '-'} @ {short_head(first.get('head'))}, "
        f"{'dirty' if first.get('dirty') else 'clean'}{dirty_file_suffix(first)}{suffix}"
    )


def gate_brief(data: dict, key: str) -> str:
    gate = (data.get("gates") or {}).get(key)
    if not gate:
        return "n/a"
    status = gate.get("status") or "unknown"
    if head_changed(data) and status == "blocked":
        return "blocked (stale HEAD evidence)"
    return status


def phase_brief(data: dict) -> str:
    phase = data.get("phase") or {}
    name = phase.get("name", "-")
    status = phase.get("status", "-")
    reason = phase.get("reason") or ""
    if "worktree_head_changed" in reason:
        reason = "current HEAD changed after this run"
    return f"{name} / {status}" + (f" - {reason}" if reason else "")


def primary_actions(data: dict, run_lint: Optional[dict], cli: Path, root: Path) -> list[str]:
    if data.get("action") == "harness_status":
        return [str(item) for item in (data.get("next_actions") or [])[:2]] or ["No immediate action is required."]
    workspace_set = data.get("workspace_set") or None
    feat = data.get("feat") or None
    scope = scope_command(workspace_set, feat)
    workspace_status = data.get("workspace_status") or {}
    if workspace_status.get("missing", 0) > 0:
        return [
            "Materialize missing local worktrees before sync/test.",
            f"node {quoted(cli)} ws materialize --root {quoted(root)} {scope}".strip(),
        ]
    if workspace_status.get("dirty", 0) > 0:
        return [
            "Review local dirty files before syncing or publishing.",
            f"node {quoted(cli)} ws status --root {quoted(root)} {scope} --text --full".strip(),
        ]
    if head_changed(data):
        return [
            "Current HEAD changed after this run. Start a fresh run, sync current code, then record the relevant remote test.",
            remote_loop_command(cli, root, workspace_set, feat),
        ]

    next_actions = data.get("next_actions") or []
    if next_actions:
        return [str(item) for item in next_actions[:2]]

    if history_counts(run_lint)["errors"]:
        return [
            "Current workspace is usable; review invalid run history when convenient.",
            archive_plan_command(cli, root, workspace_set, feat),
        ]
    return ["No immediate action is required for the configured run stages."]


def secondary_actions(
    run_lint: Optional[dict],
    cli: Path,
    root: Path,
    workspace_set: Optional[str] = None,
    feat: Optional[str] = None,
) -> list[str]:
    if history_counts(run_lint)["errors"]:
        return [
            "Run history has invalid metadata. Preview cleanup without moving anything:",
            archive_plan_command(cli, root, workspace_set, feat),
        ]
    return []


def emit_recent_runs(run_list: Optional[dict], limit: int = 3) -> None:
    if not run_list or not isinstance(run_list.get("runs"), list):
        return
    print("\nRecent Runs")
    for run in run_list.get("runs", [])[:limit]:
        phase = run.get("phase") or {}
        evidence = run.get("evidence") or {}
        print(
            f"- {run.get('run_id', '-')}: "
            f"{phase.get('name', '-')}/{phase.get('status', '-')}; "
            f"passed={compact_list(evidence.get('passed'))}; "
            f"missing={compact_list(evidence.get('missing'))}"
        )
    unreadable = ((run_list.get("totals") or {}).get("unreadable") or 0)
    if unreadable:
        print(f"- unreadable: {unreadable}")


def emit_history_health(run_lint: Optional[dict], cli: Path, root: Path) -> None:
    if not run_lint:
        return
    totals = run_lint.get("totals") or {}
    latest = run_lint.get("latest_run_id") or "-"
    errors = totals.get("errors", 0) or 0
    print("\nHistory Health")
    print(
        "- Status: "
        f"{run_lint.get('status', '-')}, "
        f"checked={totals.get('checked', 0)}/{totals.get('runs', 0)}, "
        f"errors={errors}, warnings={totals.get('warnings', 0)}, "
        f"latest_readable={latest}"
    )
    shown = 0
    for issue in run_lint.get("issues") or []:
        if issue.get("severity") != "error":
            continue
        print(
            f"- {issue.get('run_id', '-')}: "
            f"{issue.get('kind', '-')} - {issue.get('message', '-')}"
        )
        shown += 1
        if shown >= 3:
            break
    if errors:
        print(f"- Cleanup plan: {display_command(archive_plan_command(cli, root, data.get('workspace_set') or None, data.get('feat') or None), cli, root)}")


def emit_brief_summary(
    data: dict,
    selected_latest: bool,
    run_list: Optional[dict],
    run_lint: Optional[dict],
    cli: Path,
    root: Path,
) -> None:
    workspace = data.get("workspace") or "-"
    run_id = data.get("run_id") or "-"
    workspace_set = data.get("workspace_set") or "-"
    feat = data.get("feat") or None
    image = data.get("image") or {}
    publish = data.get("publish") or {}

    print("Devteam Status")
    print(f"- Workspace: {workspace}")
    print(f"- Track: {workspace_set}")
    if feat:
        print(f"- Feature: {feat}")
    print(f"- Run: {run_id}{' (latest)' if selected_latest and run_id != '-' else ''}")
    print(f"- State: {phase_brief(data)}")
    print(f"- Worktree: {worktree_brief(data)}")
    print(f"- Evidence: {evidence_brief(data)}")
    print(f"- Remote validation: {gate_brief(data, 'remote_validation')}")
    if image:
        profile = image.get("profile") or "-"
        image_ref = image.get("image") or "-"
        print(f"- Image gate: {gate_brief(data, 'image_build')}; profile={profile}; image={image_ref}")
    if publish and publish.get("totals"):
        totals = publish.get("totals") or {}
        print(
            "- Publish: "
            f"{gate_brief(data, 'publish')}; ready={totals.get('ready', 0)}, "
            f"blocked={totals.get('blocked', 0)}, already={totals.get('already_published', 0)}"
        )
    print(f"- History: {history_brief(run_lint)}")

    print("\nPrimary Next")
    for item in primary_actions(data, run_lint, cli, root):
        print(f"- {display_command(item, cli, root)}")

    secondary = secondary_actions(run_lint, cli, root, data.get("workspace_set") or None, data.get("feat") or None)
    if secondary:
        print("\nSecondary")
        for item in secondary:
            print(f"- {display_command(item, cli, root)}")

    emit_recent_runs(run_list)
    print("\nUse --full for detailed evidence, gates, and history issues.")


def emit_full_summary(
    data: dict,
    selected_latest: bool,
    run_list: Optional[dict],
    run_lint: Optional[dict],
    cli: Path,
    root: Path,
) -> None:
    workspace = data.get("workspace") or "-"
    run_id = data.get("run_id") or "-"
    workspace_set = data.get("workspace_set") or "-"
    feat = data.get("feat") or None
    phase = data.get("phase") or {}
    workspace_status = data.get("workspace_status") or {}

    print("Devteam Status")
    print(f"- Workspace: {workspace}")
    print(f"- Track: {workspace_set}")
    if feat:
        print(f"- Feature: {feat}")
    if run_id != "-":
        suffix = " (latest)" if selected_latest else ""
        print(f"- Run: {run_id}{suffix}")
    print(
        "- Phase: "
        f"{phase.get('name', '-')} / {phase.get('status', '-')}"
        + (f" - {phase.get('reason')}" if phase.get("reason") else "")
    )
    print(
        "- Worktrees: "
        f"{workspace_status.get('present', 0)}/{workspace_status.get('worktrees', 0)} present, "
        f"{workspace_status.get('dirty', 0)} dirty"
    )

    worktrees = data.get("worktrees") or []
    if worktrees:
        print("\nWorktrees")
        for wt in worktrees:
            dirty = "dirty" if wt.get("dirty") else "clean"
            ahead = wt.get("commits_ahead")
            ahead_txt = f", ahead={ahead}" if ahead is not None else ""
            dirty_files = wt.get("dirty_files") or []
            print(
                f"- {wt.get('id', '-')}: {wt.get('branch', '-')} "
                f"@ {short_head(wt.get('head'))}, {dirty}{dirty_file_suffix(wt)}{ahead_txt}"
            )
            if dirty_files:
                for item in dirty_files[:5]:
                    print(
                        f"  - {item.get('status', '').strip() or '?'} "
                        f"{item.get('path', '-')}"
                    )

    evidence = data.get("evidence") or {}
    if evidence:
        print("\nEvidence")
        keys = ["env-doctor", "sync", "test"]
        if (evidence.get("env-refresh") or {}).get("status") not in [None, "missing"]:
            keys.append("env-refresh")
        publish = data.get("publish") or {}
        if publish and (publish.get("totals") or {}).get("entries", 0):
            keys.append("publish")
        if data.get("image"):
            keys.append("image-build")
        if data.get("deploy"):
            keys.extend(["deploy", "deploy-verify"])
        for key in keys:
            item = evidence.get(key)
            summary = item.get("summary") if isinstance(item, dict) else None
            line = f"- {key}: {status_text(item)}"
            if summary:
                line += f" - {summary}"
            print(line)

    gates = data.get("gates") or {}
    if gates:
        print("\nGates")
        for key in ["remote_validation", "publish", "image_build", "deploy", "deploy_verify"]:
            if key in gates:
                gate = gates.get(key)
                line = f"- {key}: {gate_text(gate)}"
                if isinstance(gate, dict) and gate.get("next_action"):
                    line += f" - {display_command(gate.get('next_action'), cli, root)}"
                print(line)

    image = data.get("image")
    if image:
        print("\nImage")
        print(f"- Profile: {image.get('profile', '-')}")
        print(f"- Complete: {image.get('complete', False)}")
        if image.get("image"):
            print(f"- Planned image: {image.get('image')}")
        run_gate = image.get("run_gate")
        if run_gate:
            print(f"- Run gate: {gate_text(run_gate)}")

    publish = data.get("publish")
    if publish:
        totals = publish.get("totals") or {}
        print("\nPublish")
        print(
            "- Totals: "
            f"ready={totals.get('ready', 0)}, blocked={totals.get('blocked', 0)}, "
            f"already_published={totals.get('already_published', 0)}"
        )
        for entry in publish.get("entries") or []:
            blocked = ",".join(entry.get("blocked_by") or [])
            reason = entry.get("reason") or ""
            details = f" ({blocked})" if blocked else ""
            if reason:
                details += f" - {reason}"
            print(f"- {entry.get('id', '-')}: {entry.get('action', '-')}{details}")

    next_actions = data.get("next_actions") or []
    if next_actions:
        print("\nNext")
        for item in next_actions[:3]:
            print(f"- {display_command(item, cli, root)}")

    if run_list and isinstance(run_list.get("runs"), list):
        print("\nRecent Runs")
        for run in run_list.get("runs", [])[:3]:
            phase = run.get("phase") or {}
            evidence = run.get("evidence") or {}
            print(
                f"- {run.get('run_id', '-')}: "
                f"{run.get('workspace_set', '-')} "
                f"{phase.get('name', '-')}/{phase.get('status', '-')}; "
                f"passed={compact_list(evidence.get('passed'))}; "
                f"missing={compact_list(evidence.get('missing'))}"
            )
        unreadable = ((run_list.get("totals") or {}).get("unreadable") or 0)
        if unreadable:
            print(f"- unreadable: {unreadable}")

    emit_history_health(run_lint, cli, root)


def emit_brief_workspace_summary(
    data: dict,
    run_list: Optional[dict],
    run_lint: Optional[dict],
    cli: Path,
    root: Path,
) -> None:
    workspace = data.get("workspace") or "-"
    workspace_set = data.get("workspace_set") or "-"
    feat = data.get("feat") or None
    harness = data.get("action") == "harness_status"
    totals = ((data.get("worktrees") or {}).get("totals") or {}) if harness else (data.get("totals") or {})
    repos = ((data.get("repos") or {}).get("totals") or {}) if harness else {}
    environment = data.get("environment") or {}
    print("Devteam Workspace")
    print(f"- Workspace: {workspace}")
    print(f"- Track: {workspace_set}")
    if feat:
        print(f"- Feature: {feat}")
    selection_binding = data.get("selection_binding") or {}
    if harness and selection_binding.get("exists"):
        print(
            "- Selection binding: "
            f"{selection_binding.get('source') or '-'} "
            f"track={selection_binding.get('track') or '-'}"
            + (f" feat={selection_binding.get('feat')}" if selection_binding.get("feat") else "")
        )
    if repos:
        print(
            "- Repos: "
            f"{repos.get('repos', 0)} repos, "
            f"{repos.get('behind_upstream', 0)} behind, "
            f"{repos.get('upstream_unknown', 0)} upstream unknown"
        )
    if environment:
        print(
            "- Environment: "
            f"{environment.get('profile') or '-'} "
            f"type={environment.get('type') or '-'} "
            f"proxy={'yes' if environment.get('proxy_configured') else 'no'}"
        )
    binding = ((data.get("runtime") or {}).get("binding") or {}) if harness else {}
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
    print(
        "- Worktrees: "
        f"{totals.get('present', 0)}/{totals.get('worktrees', 0)} present, "
        f"{totals.get('dirty', 0)} dirty, {totals.get('missing', 0)} missing"
    )
    worktrees = ((data.get("worktrees") or {}).get("entries") or []) if harness else (data.get("worktrees") or [])
    if worktrees:
        wt = worktrees[0]
        dirty = "dirty" if wt.get("dirty") else "clean"
        extra = f", +{len(worktrees) - 1} more" if len(worktrees) > 1 else ""
        print(
            f"- Current worktree: {wt.get('id', '-')} "
            f"{wt.get('branch', '-') or wt.get('desired_branch', '-')} "
            f"@ {short_head(wt.get('head'))}, {dirty}{dirty_file_suffix(wt)}{extra}"
        )
    print(f"- History: {history_brief(run_lint)}")

    print("\nPrimary Next")
    if totals.get("missing", 0) > 0:
        scope = scope_command(workspace_set, feat)
        print(
            "- "
            + display_command(
                f"node {quoted(cli)} ws materialize --root {quoted(root)} {scope}".strip(),
                cli,
                root,
            )
        )
    elif totals.get("dirty", 0) > 0:
        scope = scope_command(workspace_set, feat)
        print(
            "- "
            + display_command(
                f"node {quoted(cli)} ws status --root {quoted(root)} {scope} --text --full".strip(),
                cli,
                root,
            )
        )
    else:
        print("- No local workspace action is required.")

    secondary = secondary_actions(run_lint, cli, root, workspace_set if workspace_set != "-" else None, feat if feat != "-" else None)
    if secondary:
        print("\nSecondary")
        for item in secondary:
            print(f"- {display_command(item, cli, root)}")

    emit_recent_runs(run_list)
    print("\nUse --full for dirty-file details and history issues.")


def emit_full_workspace_summary(
    data: dict,
    run_list: Optional[dict],
    run_lint: Optional[dict],
    cli: Path,
    root: Path,
) -> None:
    workspace = data.get("workspace") or "-"
    workspace_set = data.get("workspace_set") or "-"
    feat = data.get("feat") or None
    harness = data.get("action") == "harness_status"
    totals = ((data.get("worktrees") or {}).get("totals") or {}) if harness else (data.get("totals") or {})
    print("Devteam Workspace")
    print(f"- Workspace: {workspace}")
    print(f"- Track: {workspace_set}")
    if feat:
        print(f"- Feature: {feat}")
    print(
        "- Worktrees: "
        f"{totals.get('present', 0)}/{totals.get('worktrees', 0)} present, "
        f"{totals.get('dirty', 0)} dirty"
    )
    worktrees = ((data.get("worktrees") or {}).get("entries") or []) if harness else (data.get("worktrees") or [])
    for wt in worktrees:
        dirty = "dirty" if wt.get("dirty") else "clean"
        print(
            f"- {wt.get('id', '-')}: {wt.get('branch', '-') or wt.get('desired_branch', '-')} "
            f"@ {short_head(wt.get('head'))}, {dirty}{dirty_file_suffix(wt)}"
        )
        for item in (wt.get("dirty_files") or [])[:5]:
            print(f"  - {item.get('status', '').strip() or '?'} {item.get('path', '-')}")

    if run_list and isinstance(run_list.get("runs"), list):
        print("\nRecent Runs")
        for run in run_list.get("runs", [])[:3]:
            phase = run.get("phase") or {}
            evidence = run.get("evidence") or {}
            print(
                f"- {run.get('run_id', '-')}: "
                f"{run.get('workspace_set', '-')} "
                f"{phase.get('name', '-')}/{phase.get('status', '-')}; "
                f"passed={compact_list(evidence.get('passed'))}; "
                f"missing={compact_list(evidence.get('missing'))}"
            )

    emit_history_health(run_lint, cli, root)


def main() -> None:
    parser = argparse.ArgumentParser(description="Summarize devteam workspace status.")
    parser.add_argument("--root", help="Workspace root. Defaults to cwd/parents with .devteam/config.yaml, then DEVTEAM_ROOT.")
    parser.add_argument("--set", help="Track. Defaults to DEVTEAM_TRACK, then .devteam/config.yaml defaults.track.")
    parser.add_argument("--feat", help="Feature under the selected track. Defaults to DEVTEAM_FEAT, then defaults.feat.")
    parser.add_argument("--run", help="Run id. Defaults to latest run if present.")
    parser.add_argument("--no-run", action="store_true", help="Do not auto-select latest run.")
    parser.add_argument("--cli", help="Path to devteam.cjs. Defaults to DEVTEAM_CLI, then bundled plugin/repo locations.")
    parser.add_argument("--raw-json", action="store_true", help="Print raw devteam status JSON.")
    parser.add_argument("--full", action="store_true", help="Print detailed evidence, gates, and history issues.")
    parser.add_argument("--brief", action="store_true", help="Print the compact daily dashboard view.")
    args = parser.parse_args()

    root = find_root(args.root)
    cli = find_devteam_cli(args.cli)
    if not cli.exists():
        raise SystemExit(f"devteam CLI not found: {cli}")

    selected_set = args.set or env_track()
    selected_feat = args.feat or env_feat()
    workspace_data = run_workspace_status(cli, root, selected_set, selected_feat)
    workspace_set = selected_set or workspace_data.get("workspace_set") or None
    feat = selected_feat or workspace_data.get("feat") or None
    run_list = run_session_list(cli, root, workspace_set=workspace_set, feat=feat)
    run_lint = run_session_lint(cli, root, workspace_set=workspace_set, feat=feat)
    if args.no_run and not args.run:
        data = workspace_data
        if args.raw_json:
            payload = {"workspace": data, "recent_runs": run_list, "session_lint": run_lint}
            print(json.dumps(payload, indent=2, ensure_ascii=False))
            return
        if args.full:
            emit_full_workspace_summary(data, run_list, run_lint, cli, root)
        else:
            emit_brief_workspace_summary(data, run_list, run_lint, cli, root)
        return

    run_id = args.run
    selected_latest = run_id is None
    data = run_devteam_status(cli, root, run_id, None if run_id else workspace_set, None if run_id else feat)
    if args.raw_json:
        payload = {"status": data, "recent_runs": run_list, "session_lint": run_lint}
        print(json.dumps(payload, indent=2, ensure_ascii=False))
        return

    if args.full:
        emit_full_summary(data, selected_latest, run_list, run_lint, cli, root)
    else:
        emit_brief_summary(data, selected_latest, run_list, run_lint, cli, root)


if __name__ == "__main__":
    main()
