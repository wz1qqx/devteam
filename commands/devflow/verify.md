---
name: devflow:verify
description: Post-deploy verification - smoke, bench, accuracy, profile, kernel, or full
argument-hint: "[--smoke|--bench|--accuracy|--profile|--kernel|--full]"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
  - Agent
  - AskUserQuestion
---
<objective>
Run post-deployment verification suites including smoke tests, benchmarks, accuracy checks, or full verification.
</objective>

<execution_context>
@../../skills/my-dev/stages/verify.md
</execution_context>

<context>
$ARGUMENTS
</context>

<process>
Execute the verify stage from @../../skills/my-dev/stages/verify.md end-to-end.
Load project config via: `node "$DEVFLOW_BIN" init verify`
</process>
