# Skill: resume

<purpose>Restore session state from HANDOFF.json and STATE.md. Zero context loss across sessions -- load everything needed to continue exactly where the user left off.</purpose>
<core_principle>The resumed session must have the same effective context as the paused session. HANDOFF.json gives precise position; STATE.md gives accumulated decisions and blockers. Feature artifacts provide domain context. The user should never need to re-explain.</core_principle>

<process>
<step name="INIT" priority="first">
Load project configuration and locate handoff artifacts.

```bash
# Auto-discover devteam CLI (marketplace or local install)
DEVFLOW_BIN=$(ls ~/.claude/plugins/cache/devteam/devteam/*/lib/devteam.cjs 2>/dev/null | head -1)

INIT=$(node "$DEVFLOW_BIN" init resume)
WORKSPACE=$(echo "$INIT" | jq -r '.workspace')
FEATURE=$(echo "$INIT" | jq -r '.feature.name')
PHASE=$(echo "$INIT" | jq -r '.feature.phase')
CURRENT_TAG=$(echo "$INIT" | jq -r '.feature.current_tag')
```

Gate: `.dev.yaml` must exist. If not: "No project found. Run `/devteam init` first."
</step>

<step name="LOAD_HANDOFF">
Parse HANDOFF.json for precise session position.

```bash
HANDOFF_PATH="$WORKSPACE/.dev/features/$FEATURE/HANDOFF.json"
```

If HANDOFF.json exists:
- Parse all fields: feature, feature_stage, task_progress, completed_tasks, remaining_tasks, blockers, decisions_this_session, uncommitted_files, next_action, context_notes
- Display restoration summary:
  ```
  Restoring from HANDOFF.json (paused: <timestamp>)
    Feature: <feature> (stage: <stage>)
    Progress: <current>/<total> tasks
    Next action: <next_action>
    Context: <context_notes>
  ```
- Delete HANDOFF.json after successful load (consumed):
  ```bash
  rm "$WORKSPACE/.dev/features/$FEATURE/HANDOFF.json"
  ```

If no HANDOFF.json: note "No HANDOFF found. Resuming from STATE.md and config."
</step>

<step name="LOAD_STATE">
Load STATE.md for accumulated decisions and blockers.

```bash
STATE_PATH="$WORKSPACE/.dev/STATE.md"
```

If STATE.md exists:
- Parse frontmatter: project, phase, current_feature, feature_stage, plan_progress, last_activity
- Display recent decisions:
  ```
  Decisions (recent):
    D-01: <decision> (<date>, <feature>)
    D-02: <decision> (<date>, <feature>)
  ```
- Display active blockers:
  ```
  Active Blockers:
    B-01: <blocker> [<type>] - workaround: <workaround>
  ```

If no STATE.md: "No STATE.md found. Will be created on next workflow action."
</step>

<step name="LOAD_FEATURE_CONTEXT">
Load feature-specific artifacts for domain context.

```bash
FEATURE_DIR="$WORKSPACE/.dev/features/$FEATURE"
```

Load if available:
- `features/$FEATURE/context.md` -- discussion decisions, user preferences
- `features/$FEATURE/plan.md` -- current plan with task statuses
- `features/$FEATURE/spec.md` -- feature specification
- `features/$FEATURE/review.md` -- code review results

**Wiki context** (auto-load relevant pages):
```bash
WIKI_DIR=$(echo "$INIT" | jq -r '.wiki_dir // empty')
```
If wiki exists: read pages matching feature topic (up to 5 pages for context).

Display feature artifact status:
```
Feature: $FEATURE
  Spec:    [exists/missing]
  Context: [exists/missing]
  Plan:    [exists/missing] (<done>/<total> tasks)
  Review:  [exists/missing] (verdict: <verdict>)
```

**Check uncommitted files** (from HANDOFF or fresh scan):
```bash
UNCOMMITTED=$(git -C "$WORKSPACE" status --porcelain)
if [ -n "$UNCOMMITTED" ]; then
  echo "Uncommitted files detected:"
  echo "$UNCOMMITTED"
fi
```
</step>

<step name="SHOW_STATUS">
Display comprehensive project status dashboard.

```
=== Session Resumed ===

Project: $PROJECT
Phase: $PHASE
Tag: $CURRENT_TAG

Feature: $FEATURE (stage: $FEATURE_STAGE)
  Progress: $DONE/$TOTAL tasks
  Last activity: $LAST_ACTIVITY

Repos:
  <repo>: <worktree> (<base_ref> + N commits) [uncommitted: Y/N]

Cluster: $CLUSTER ($NAMESPACE)
  Deploy: <current deployment status if available>

Knowledge: M/N features covered
  Stale pages: <count if any>
```

If HANDOFF was loaded, highlight:
```
Restored Context:
  Decisions this session: <list>
  Blockers: <list>
  Uncommitted: <file list>
```
</step>

<step name="SUGGEST_NEXT">
Suggest next action based on restored state.

**If HANDOFF was restored**: use `next_action` as primary suggestion:
```
Suggested next step: <next_action from HANDOFF>
  Command: <specific devflow command to run>
```

**Otherwise**, suggest based on current phase:

| Phase | Suggestion |
|---|---|
| `init` | "Project initialized. Start with: `/devteam team`" |
| `dev` | "Continue development. Build when ready: `/devteam team`" |
| `build` | "Build complete ($CURRENT_TAG). Deploy: `/devteam team`" |
| `deploy` | "Deployed. Verify: `/devteam team`" |
| `verify` | "Verified. Start next feature or observe." |
| `debug` | "Debug session active. Resume investigation." |

**Check for in-progress work**:
- Plan with pending tasks: "Resume execution: `/devteam team $FEATURE`"
- Review with FAIL verdict: "Fix review issues: `/devteam team $FEATURE`"
- Uncommitted files: "Warning: N uncommitted files. Commit or stash before proceeding."

**Check active blockers**: if unresolved blockers exist, warn:
```
Active blockers may affect next steps:
  B-01: <blocker> -- workaround: <workaround>
```
</step>
</process>

<anti_rationalization>

## Anti-Rationalization Table

| Temptation | Reality Check |
|---|---|
| "I remember the context" | This is a new session. You have zero prior context. Load everything. |
| "HANDOFF is enough" | HANDOFF is position. STATE.md is history. Feature artifacts are domain knowledge. Load all three. |
| "I'll figure out what to do" | The paused session already determined next_action. Follow it. |
| "Uncommitted files are fine" | They might be intentional WIP or forgotten changes. Surface them explicitly. |
| "Wiki context is optional" | Domain knowledge prevents re-derivation. Load it. |
| "I'll skip the status dashboard" | The user needs orientation. Show the full picture before suggesting actions. |

## Red Flags

- Resuming without loading HANDOFF.json (if it exists)
- Not deleting HANDOFF.json after consumption (stale state in next pause)
- Ignoring uncommitted files warning
- Suggesting actions that conflict with active blockers
- Skipping wiki context load (re-derivation overhead)
- Not showing feature artifact status (user can't assess completeness)

## Verification Checklist

- [ ] HANDOFF.json loaded and deleted (if existed)
- [ ] STATE.md parsed for decisions and blockers
- [ ] Feature artifacts status shown (spec, context, plan, review)
- [ ] Wiki context loaded (if available)
- [ ] Uncommitted files surfaced
- [ ] Project status dashboard displayed
- [ ] Next action suggested (from HANDOFF or phase-based)
- [ ] Active blockers warned about

</anti_rationalization>
