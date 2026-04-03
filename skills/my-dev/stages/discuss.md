# Workflow: discuss

<purpose>
Extract implementation decisions that the planner and executor need. Analyze the feature spec to identify gray areas, let the user choose, and lock decisions in context.md.

You are a thinking partner, not an interviewer. The user is the visionary — you are the builder.
</purpose>

<core_principle>
Capture decisions before a single line of code is written. This is the cheapest point to make expensive decisions. Decisions in context.md become NON-NEGOTIABLE constraints for the planner.
</core_principle>

<downstream_awareness>
context.md feeds into:

1. **my-dev-planner** — reads locked decisions, plans tasks around them
   - "User chose CPU DRAM" → planner creates memory-allocation task
   - "User chose session-aware eviction" → planner creates eviction-policy task

2. **my-dev-executor** — honors decisions during implementation
   - "Per D-01: use CPU DRAM" → executor implements exactly that

3. **research workflow** — research focuses on user's chosen direction
   - "User chose PegaPdConnector" → researcher investigates that class specifically

Your job: capture decisions clearly enough that downstream agents don't ask the user again.
</downstream_awareness>

<process>

<step name="INIT" priority="first">
Load feature context.

```bash
# Auto-discover devflow CLI (marketplace or local install)
DEVFLOW_BIN=$(ls ~/.claude/plugins/cache/devflow/devflow/*/skills/my-dev/bin/my-dev-tools.cjs 2>/dev/null | head -1)

INIT=$(node "$DEVFLOW_BIN" init code "$FEATURE")
WORKSPACE=$(echo "$INIT" | jq -r '.workspace')
FEATURE="$1"
FEATURE_DIR="$WORKSPACE/.dev/features/$FEATURE"
SPEC_PATH="$FEATURE_DIR/spec.md"
```

Gate: spec.md must exist. If not:
- "No spec found. Run `/devflow:code $FEATURE --spec` first."

Read spec content for analysis.

Also load:
- Existing context.md (if re-discussing)
- Obsidian knowledge notes matching feature (for informed questions)
- STATE.md decisions (avoid re-asking resolved decisions)
</step>

<step name="ANALYZE_GRAY_AREAS">
Read the spec and identify implementation decisions the user should make.

**Gray area identification method:**

1. Read the spec Goal and Scope
2. For each repo/file in scope, understand what kind of change:
   - New code → many design decisions (API shape, data structures, patterns)
   - Modification → fewer decisions (compatibility, approach)
   - Config change → minimal decisions
3. Generate specific gray areas (NOT generic categories):

**Good gray areas** (specific to the feature):
```
Feature: "PegaFlow L2 cache"
→ Cache storage medium (CPU DRAM vs NVMe vs hybrid)
→ Eviction policy (LRU vs session-aware vs TTL)
→ Prefill bypass behavior (full skip vs verification skip)
→ Configuration mechanism (env var vs CLI arg vs config file)
```

**Bad gray areas** (too generic):
```
→ "Performance considerations"
→ "Error handling approach"
→ "Testing strategy"
```

4. Filter out:
   - Decisions already in STATE.md (don't re-ask)
   - Decisions implied by constraints (source_restriction → no choice)
   - Technical details the user doesn't care about (planner handles those)
</step>

<step name="PRESENT_GRAY_AREAS">
Present identified gray areas to the user. Let them choose which to discuss.

```
Found <N> decisions that could shape the implementation:

1. ◆ Cache storage medium — where does L2 data live?
2. ◆ Eviction policy — how do we manage cache capacity?
3. ◆ Prefill bypass — how aggressive is the cache shortcut?
4. ◆ Configuration — how does the user control cache behavior?

Which areas do you want to discuss? (enter numbers, or 'all')
> _
```

For each selected area, deep-dive:
1. Present 2-4 concrete options with trade-offs
2. If Obsidian knowledge exists on this topic → reference it
3. Let user choose or provide their own approach
4. Record as a locked decision with rationale
</step>

<step name="CAPTURE_DECISIONS">
For each discussed area, record the decision.

Decision format:
```
| ID | Decision | Rationale | Area |
|----|----------|-----------|------|
| D-01 | CPU DRAM with env var DYN_DECODE_L2_CACHE_SIZE | Fast access, user already uses env vars for config | Storage |
| D-02 | Session-aware eviction | Multi-turn conversations need session locality | Eviction |
| D-03 | Full prefill skip with content hash verification | Maximum performance gain, hash is cheap | Bypass |
```

Also capture:
- **Deferred ideas**: things the user mentioned but said "not now"
- **Claude's discretion**: areas the user said "you decide"
</step>

<step name="SAVE_CONTEXT">
Write context.md to the feature directory.

```bash
mkdir -p "$FEATURE_DIR"
```

```markdown
# Context: $FEATURE

Created: <TODAY_DATE>
Spec: .dev/features/$FEATURE/spec.md

## Discussion Summary
<brief summary of what was discussed and why>

## Decisions (LOCKED — planner must honor these exactly)
| ID | Decision | Rationale | Area |
|----|----------|-----------|------|
| D-01 | ... | ... | ... |

## Deferred Ideas (NOT in scope — do not implement)
- <idea>: deferred because <reason>

## Claude's Discretion (planner can decide approach)
- <area>: <guidance if any>

## Constraints (from spec, repeated for planner convenience)
- source_restriction: <value>
- API compatibility: <value>
- Build mode: <value>

## References
- Spec: .dev/features/$FEATURE/spec.md
- Knowledge: <Obsidian notes referenced during discussion>
```

State update (@references/shared-patterns.md#state-update): stage=`discuss`
Append decisions to STATE.md Decisions table.

Output:
```
✅ Discussion complete
  Decisions locked: <N>
  Deferred: <N>
  Context saved: .dev/features/$FEATURE/context.md

  Planner will honor these decisions exactly.

→ Next: /devflow:code $FEATURE --plan [--research]
```
</step>

</process>

<scope_guardrail>
CRITICAL: No scope creep during discussion.

The spec boundary is FIXED. Discussion clarifies HOW to implement what's scoped, never WHETHER to add new capabilities.

Allowed: "How should the cache store data?" (implementation choice)
Not allowed: "Should we also add prefetch?" (new capability → defer)

When user suggests scope creep:
"That would be a new capability — worth its own feature.
Want me to note it as a deferred idea?
For now, let's focus on <spec scope>."
</scope_guardrail>
