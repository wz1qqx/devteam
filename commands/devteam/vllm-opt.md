---
name: devteam:vllm-opt
description: Standalone vLLM performance analysis — torch profiler, nsight kernels, optimization guidance
argument-hint: "<feature> [--regression-report <json>]"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
---
<objective>
Run vLLM performance profiling and kernel analysis for a feature. Produces optimization guidance for the planner. Can accept a regression report from a prior verify run or profile from scratch.
</objective>

<context>
$ARGUMENTS
</context>

<process>
**Step 1**: Discover CLI tool and load config:
```bash
DEVTEAM_BIN="${HOME}/.claude/plugins/marketplaces/devteam/lib/devteam.cjs"
[ -f "$DEVTEAM_BIN" ] || DEVTEAM_BIN=$(ls ~/.claude/plugins/cache/devteam/devteam/*/lib/devteam.cjs 2>/dev/null | head -1)
[ -n "$DEVTEAM_BIN" ] || { echo "ERROR: devteam.cjs not found" >&2; exit 1; }
INIT=$(node "$DEVTEAM_BIN" init team-vllm-opt)
```

If `$INIT` contains `"feature": null` and `"available_features"`, prompt the user to select a feature with AskUserQuestion, then re-run: `INIT=$(node "$DEVTEAM_BIN" init team-vllm-opt --feature $SELECTED)`

**Step 2**: Execute:
1. Load context via CLI init
2. Spawn the vllm-opter agent: Agent(subagent_type: "devteam:vllm-opter", prompt: "Analyze performance for feature '$FEATURE'. Workspace: $WORKSPACE. [regression report if provided]")
3. Display the optimization guidance report returned by the agent
</process>
