---
name: devflow:switch
description: Switch active feature context
argument-hint: "<feature-name>"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
---
<objective>
Switch the active feature by updating defaults.active_feature in .dev.yaml and loading the target feature's context.
</objective>

<execution_context>
@~/.claude/my-dev/references/schema.md
</execution_context>

<context>
$ARGUMENTS
</context>

<process>
Load project config via: `node "$HOME/.claude/my-dev/bin/my-dev-tools.cjs" init switch`
Execute inline based on arguments.
</process>
