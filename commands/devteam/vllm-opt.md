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
DEVFLOW_BIN=$(ls ~/.claude/plugins/cache/devteam/devteam/*/lib/devteam.cjs 2>/dev/null | head -1)
INIT=$(node "$DEVFLOW_BIN" init team-vllm-opt)
```

If `$INIT` contains `"feature": null` and `"available_features"`, prompt the user to select a feature with AskUserQuestion, then re-run: `INIT=$(node "$DEVFLOW_BIN" init team-vllm-opt --feature $SELECTED)`

**Step 2**: Execute:
1. Extract from `$INIT`:
   ```bash
   FEATURE=$(echo "$INIT" | jq -r '.feature.name')
   WORKSPACE=$(echo "$INIT" | jq -r '.workspace')
   ```
2. Parse `--regression-report <json>` from `$ARGUMENTS` if present.
3. Spawn the vllm-opter agent:
   ```
   Agent(
     subagent_type: "devteam:vllm-opter",
     prompt: "Analyze performance for feature '$FEATURE'. Workspace: $WORKSPACE.
       [If regression report was passed: Regression report from verifier: <json>]"
   )
   ```
4. Display the optimization guidance report returned by the agent.
</process>
