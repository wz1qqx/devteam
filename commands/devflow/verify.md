---
name: devflow:verify
description: Post-deploy verification - smoke, bench, accuracy, or full
argument-hint: "[--smoke|--bench|--accuracy|--full]"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
  - Agent
---
<objective>
Run post-deployment verification suites including smoke tests, benchmarks, accuracy checks, or full verification.
</objective>

<execution_context>
@~/.claude/my-dev/workflows/verify.md
</execution_context>

<context>
$ARGUMENTS
</context>

<process>
Execute the verify workflow from @~/.claude/my-dev/workflows/verify.md end-to-end.
Load project config via: `node "$HOME/.claude/my-dev/bin/my-dev-tools.cjs" init verify`
</process>
