# Skill: pause

<purpose>Save session state for zero-loss resume. Write HANDOFF.json, update STATE.md, prompt for knowledge sink. Nothing valuable should be lost between sessions.</purpose>
<core_principle>Working memory is ephemeral -- anything worth keeping must be explicitly saved. HANDOFF.json captures precise position; STATE.md captures accumulated decisions. Knowledge worth persisting goes to the wiki.</core_principle>

<process>
<step name="INIT" priority="first">
Load current project state and configuration.

```bash
# Auto-discover devteam CLI (marketplace or local install)
DEVFLOW_BIN=$(ls ~/.claude/plugins/cache/devteam/devteam/*/lib/devteam.cjs 2>/dev/null | head -1)

INIT=$(node "$DEVFLOW_BIN" init pause)
WORKSPACE=$(echo "$INIT" | jq -r '.workspace')
FEATURE=$(echo "$INIT" | jq -r '.feature.name')
```

Gate: `.dev.yaml` must exist. If not: "No project found. Nothing to pause."
</step>

<step name="GATHER_STATE">
Collect current session state from all sources.

1. **Read STATE.md** (if exists):
   ```bash
   STATE_PATH="$WORKSPACE/.dev/STATE.md"
   ```
   Parse frontmatter: project, phase, current_feature, feature_stage, plan_progress

2. **Detect active feature**: from STATE.md frontmatter or recent `.dev/features/` activity

3. **Scan uncommitted files** across all dev worktrees:
   ```bash
   git -C "$WORKSPACE" status --porcelain
   # For each additional repo worktree
   ```

4. **Parse plan progress** (if feature has a plan):
   ```bash
   PLAN_PATH="$WORKSPACE/.dev/features/$FEATURE/plan.md"
   # Count completed vs total tasks from checkbox markers
   DONE=$(grep -c '^\- \[x\]' "$PLAN_PATH" 2>/dev/null || echo 0)
   TOTAL=$(grep -c '^\- \[' "$PLAN_PATH" 2>/dev/null || echo 0)
   ```

5. **Collect decisions** made this session: scan recent STATE.md additions

6. **Collect active blockers**: from STATE.md Blockers table where status=active

7. **Identify next action**: what should the next session do first?
   - If mid-plan execution: "Continue task N of plan"
   - If mid-review: "Address review feedback"
   - If mid-debug: "Continue investigating <topic>"
   - If between phases: "Start next phase: <phase>"
</step>

<step name="WRITE_HANDOFF">
Write HANDOFF.json with precise session state for zero-loss resume.

```bash
mkdir -p "$WORKSPACE/.dev/features/$FEATURE"
```

Write `.dev/features/$FEATURE/HANDOFF.json`:
```json
{
  "version": "1.0",
  "timestamp": "<ISO-8601 now>",
  "project": "<project_name>",
  "feature": "$FEATURE",
  "feature_stage": "<current stage: spec/plan/exec/review/etc>",
  "task_progress": { "current": <DONE>, "total": <TOTAL> },
  "completed_tasks": ["<list of done task titles>"],
  "remaining_tasks": ["<list of pending task titles>"],
  "blockers": [<active blockers from STATE.md>],
  "decisions_this_session": ["<decisions added during this session>"],
  "uncommitted_files": ["<paths with uncommitted changes>"],
  "next_action": "<specific first action for next session>",
  "context_notes": "<any mental state or context worth preserving>"
}
```

Rules:
- `next_action` must be specific and actionable, not vague
- `context_notes` captures reasoning that won't be obvious from artifacts alone
- `uncommitted_files` warns the next session about unsaved work
</step>

<step name="UPDATE_STATE_MD">
Update STATE.md with current position.

If STATE.md does not exist, create from template:
```bash
DEVFLOW_ROOT=$(dirname "$(dirname "$DEVFLOW_BIN")")
TEMPLATE="$DEVFLOW_ROOT/templates/state.md"
```

Update frontmatter fields:
- `last_activity`: current ISO-8601 timestamp
- `current_feature`: active feature name or null
- `feature_stage`: current stage or null
- `plan_progress`: current progress string (e.g., "3/7 tasks")

Update Position section:
```markdown
## Position
Currently working on: <current activity summary>
Next step: <what to do next session>
```

Do NOT modify Decisions or Blockers sections (append-only, handled elsewhere).
</step>

<step name="KNOWLEDGE_SINK_PROMPT">
Prompt user to persist valuable knowledge before ending session.

```
Session paused successfully.

HANDOFF.json written: .dev/features/$FEATURE/HANDOFF.json
STATE.md updated: .dev/STATE.md
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
node "$DEVFLOW_BIN" checkpoint \
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
| "STATE.md is enough" | STATE.md is accumulated history. HANDOFF is precise position. Both needed. |
| "I'll pause later" | Context window runs out without warning. Pause early, pause often. |

## Red Flags

- HANDOFF.json with vague `next_action` ("continue working")
- Uncommitted files not listed in HANDOFF
- STATE.md Position section not updated
- Knowledge sink skipped entirely
- No checkpoint recorded
- Pausing without feature context (no active feature detected)

## Verification Checklist

- [ ] HANDOFF.json written with specific next_action
- [ ] All uncommitted files documented
- [ ] STATE.md frontmatter updated (timestamp, feature, stage, progress)
- [ ] STATE.md Position section reflects current state
- [ ] Knowledge sink prompt shown to user
- [ ] Checkpoint recorded
- [ ] Output shows resume command

</anti_rationalization>
