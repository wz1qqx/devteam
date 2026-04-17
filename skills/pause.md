# Skill: pause

<purpose>Save session state for zero-loss resume. Write feature-scoped HANDOFF.json, update feature STATE.md, sync context.md, prompt for knowledge sink. Nothing valuable should be lost between sessions.</purpose>
<core_principle>Working memory is ephemeral -- anything worth keeping must be explicitly saved. HANDOFF.json captures precise position; STATE.md captures workflow position; context.md captures feature-scoped decisions and blockers. Knowledge worth persisting goes to the wiki.</core_principle>

Runtime artifact precedence during pause:
1. `tasks.json` is the authoritative task source.
2. `RUN.json` is the authoritative execution identity source.
3. `plan.md` is a human-readable view, not a machine state source.

<process>
<step name="INIT" priority="first">
Load current project state and configuration.

```bash
# Auto-discover devteam CLI (marketplace or local install)
DEVTEAM_BIN="${HOME}/.claude/plugins/marketplaces/devteam/lib/devteam.cjs"
[ -f "$DEVTEAM_BIN" ] || DEVTEAM_BIN=$(ls ~/.claude/plugins/cache/devteam/devteam/*/lib/devteam.cjs 2>/dev/null | head -1)
[ -n "$DEVTEAM_BIN" ] || { echo "ERROR: devteam.cjs not found" >&2; exit 1; }

INIT=$(node "$DEVTEAM_BIN" init pause)
WORKSPACE=$(echo "$INIT" | jq -r '.workspace')
FEATURE=$(echo "$INIT" | jq -r '.feature.name')
```

Gate: `workspace.yaml` must exist. If not: "No project found. Nothing to pause."
</step>

<step name="GATHER_STATE">
Collect current session state from all sources.

	1. **Read STATE.md** (if exists):
   ```bash
   STATE_PATH="$WORKSPACE/.dev/features/$FEATURE/STATE.md"
   ```
   Parse frontmatter: project, phase, feature_stage, plan_progress

3. **Scan uncommitted files** across all dev worktrees (from `$INIT.repos`, which is RUN-frozen when `RUN.json` exists):
   ```bash
   echo "$INIT" | jq -r '.repos | to_entries[] | .value.dev_worktree // empty' | \
     while read DEV_WT; do git -C "$DEV_WT" status --porcelain; done
   ```

4. **Load task progress from authoritative tasks.json**:
   ```bash
   TASK_SUMMARY=$(node "$DEVTEAM_BIN" tasks summary --feature "$FEATURE")
   DONE=$(echo "$TASK_SUMMARY" | jq -r '.summary.completed_tasks')
   TOTAL=$(echo "$TASK_SUMMARY" | jq -r '.summary.total_tasks')
   TASK_STATE=$(node "$DEVTEAM_BIN" tasks get --feature "$FEATURE")
   COMPLETED_TASKS=$(echo "$TASK_STATE" | jq -c '.task_state.tasks // [] | map(select(.status=="completed") | {id, title})')
   REMAINING_TASKS=$(echo "$TASK_STATE" | jq -c '.task_state.tasks // [] | map(select(.status!="completed") | {id, title, status})')
   ```

	5. **Collect decisions** made this session: scan feature `context.md` additions or in-memory decisions gathered during the session

	6. **Collect active blockers**: from feature `context.md` Active Blockers table

7. **Identify next action**: what should the next session do first?
   - If mid-plan execution: "Continue task N of plan"
   - If mid-review: "Address review feedback"
   - If mid-debug: "Continue investigating <topic>"
   - If between phases: "Start next phase: <phase>"

8. **Capture run snapshot reference** (if present):
   ```bash
   RUN_STATE=$(node "$DEVTEAM_BIN" run get --feature "$FEATURE")
   RUN_PATH=$(echo "$RUN_STATE" | jq -r '.run_path')
   RUN_ID=$(echo "$RUN_STATE" | jq -r '.run.run_id // empty')
   ```
   Use this in `context_notes` so resume can correlate pending work with the frozen run identity.
</step>

<step name="WRITE_HANDOFF">
Write feature-scoped HANDOFF.json with precise session state for zero-loss resume.

```bash
mkdir -p "$WORKSPACE/.dev/features/$FEATURE"
```

Write `.dev/features/$FEATURE/HANDOFF.json`:
```json
{
  "version": "2.0",
  "paused_at": "<ISO-8601 now>",
  "ttl_days": 7,
  "project": "<project_name>",
  "feature": "$FEATURE",
  "feature_stage": "<current stage: spec/plan/exec/review/etc>",
  "task_progress": { "current": <DONE>, "total": <TOTAL> },
  "completed_tasks": [{"id": "<task-id>", "title": "<task-title>"}],
  "remaining_tasks": [{"id": "<task-id>", "title": "<task-title>", "status": "<task-status>"}],
  "decisions_this_session": ["<decisions added during this session>"],
  "uncommitted_files": ["<paths with uncommitted changes>"],
  "next_action": "<specific first action for next session>",
  "context_notes": "<any mental state or context worth preserving>"
}
```

Notes:
- `blockers` field removed from HANDOFF — active blockers are persisted in `context.md`.
- `completed_tasks` / `remaining_tasks` must come from `tasks.json`, not `plan.md` checkbox parsing.

Rules:
- `next_action` must be specific and actionable, not vague
- `context_notes` captures reasoning that won't be obvious from artifacts alone
- `uncommitted_files` warns the next session about unsaved work
</step>

<step name="UPDATE_STATE_MD">
Update STATE.md with current position.

If STATE.md does not exist, create from template:
```bash
DEVTEAM_ROOT=$(dirname "$(dirname "$DEVTEAM_BIN")")
TEMPLATE="$DEVTEAM_ROOT/templates/STATE.md"
```

Update frontmatter fields:
- `last_activity`: current ISO-8601 timestamp
- `feature_stage`: current stage or null
- `plan_progress`: current progress string (e.g., "3/7 tasks")

Update Position section:
```markdown
## Position
Currently working on: <current activity summary>
Next step: <what to do next session>
```

Do NOT write Decisions or Blockers to STATE.md — these are feature-scoped and handled by WRITE_FEATURE_CONTEXT.
</step>

<step name="WRITE_FEATURE_CONTEXT">
Persist decisions and blockers to the feature-scoped context.md.

```bash
CONTEXT_PATH="$WORKSPACE/.dev/features/$FEATURE/context.md"
TEMPLATE="$DEVTEAM_ROOT/templates/context.md"
```

**Create if missing**: If context.md does not exist, copy from template and replace `{{feature}}` / `{{timestamp}}`.

**Append decisions**: For each decision in `decisions_this_session` (from HANDOFF):
- Generate next D-NN ID by counting existing rows
- Append row to `## Decisions` table:
  ```
  | D-NN | <decision> | <rationale> | <ISO date> |
  ```

**Archive resolved blockers**: Find rows in `## Active Blockers` where user marked status as resolved this session:
- Move them to `## Archived Blockers` with `Resolved` = today's date and `Resolution` = resolution note
- Remove from `## Active Blockers`

**Update frontmatter**:
- `last_updated`: current ISO-8601 timestamp
</step>

<step name="KNOWLEDGE_SINK_PROMPT">
Prompt user to persist valuable knowledge before ending session.

```
Session paused successfully.

HANDOFF.json written: .dev/features/$FEATURE/HANDOFF.json
STATE.md updated: .dev/features/$FEATURE/STATE.md
```

Check for sinkable artifacts:

1. **Debug resolutions** (if any debug workflow ran this session):
   ```
   Debug resolution found: <topic>
   Save experience to wiki/Obsidian? [Y/n]
   ```
   If yes: create experience note (see debug.md EXPERIENCE_SINK)

2. **Reusable review patterns** (if code review found patterns):
   ```
   Reusable pattern: <pattern description>
   Save to wiki? [Y/n]
   ```
   If yes: create wiki page

3. **General knowledge prompt** (always ask):
   ```
   Anything else worth saving to wiki? (type topic or "no")
   ```

This step is interactive -- wait for user response before proceeding.
</step>

<step name="CHECKPOINT">
Record the pause in checkpoint log and produce final output.

```bash
node "$DEVTEAM_BIN" checkpoint \
  --action "pause" \
  --summary "Session paused. Feature: $FEATURE, Stage: $FEATURE_STAGE, Progress: $DONE/$TOTAL"
```

Output:
```
Session saved.
  Feature: $FEATURE (stage: $FEATURE_STAGE)
  Progress: $DONE/$TOTAL tasks
  Uncommitted: N files
  Next action: <next_action from HANDOFF>
  HANDOFF: .dev/features/$FEATURE/HANDOFF.json

Resume with: /devteam resume
If multiple features exist, re-select: $FEATURE
```
</step>
</process>

<anti_rationalization>

## Anti-Rationalization Table

| Temptation | Reality Check |
|---|---|
| "I'll remember where I was" | You won't. The next session has zero context. Write it down. |
| "The code is self-explanatory" | Code shows WHAT. HANDOFF captures WHY and WHAT'S NEXT. |
| "I'll just commit everything" | Uncommitted files may be intentional WIP. Document, don't force-commit. |
| "Knowledge sink takes too long" | 30 seconds now saves 30 minutes of re-derivation later. |
| "STATE.md is enough" | STATE.md tracks workflow position. HANDOFF is precise position. Both needed. |
| "I'll pause later" | Context window runs out without warning. Pause early, pause often. |

## Red Flags

- HANDOFF.json with vague `next_action` ("continue working")
- HANDOFF.json missing `paused_at` or `ttl_days` fields (breaks staleness detection on resume)
- Uncommitted files not listed in HANDOFF
- STATE.md Position section not updated
- Decisions written to STATE.md instead of context.md (causes cross-feature pollution)
- context.md not created for new features
- Resolved blockers left in Active section instead of archived
- Knowledge sink skipped entirely
- No checkpoint recorded
- Pausing without a resolved feature context

## Verification Checklist

- [ ] HANDOFF.json written with specific next_action, paused_at, and ttl_days
- [ ] All uncommitted files documented
- [ ] STATE.md frontmatter updated (timestamp, stage, progress)
- [ ] STATE.md Position section reflects current state
- [ ] context.md created/updated for current feature (decisions appended, resolved blockers archived)
- [ ] Knowledge sink prompt shown to user
- [ ] Checkpoint recorded
- [ ] Output shows resume command

</anti_rationalization>
