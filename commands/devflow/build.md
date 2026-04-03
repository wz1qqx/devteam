---
name: devflow:build
description: Build container image with incremental tag chain
argument-hint: "[tag] [--push] [variant]"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
---
<objective>
Build a container image using the feature's build configuration, maintaining the incremental tag chain.
</objective>

<execution_context>
@../../skills/my-dev/stages/build.md
</execution_context>

<context>
$ARGUMENTS
</context>

<process>
Execute the build stage from @../../skills/my-dev/stages/build.md end-to-end.
Load project config via: `node "$DEVFLOW_BIN" init build`
</process>
