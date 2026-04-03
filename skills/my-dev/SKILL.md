---
name: devflow
description: >
  Multi-repo development lifecycle: structured coding (spec/plan/exec/review),
  container build, K8s deploy, benchmark verify, Grafana observe, debug investigation.
  Trigger for: build image, deploy, benchmark, worktree, project status, debug, rollback,
  diff, clean, feature spec, code review, monitoring, checkpoint, resume/pause session.
  Proactively suggest even without explicit "/devflow" — any code/build/deploy/verify/observe
  workflow in a .dev.yaml project should use this skill.
---

# /devflow — Universal Development Lifecycle Management

4-layer architecture for full development lifecycle management.

## Commands

Invoke via `/devflow:<action>` or `/devflow <action> [args]`.

| Command | Description |
|---------|-------------|
| `next` | Auto-detect state, suggest next step |
| `quick` | Ad-hoc task with atomic commits |
| `init` | `workspace` or `feature <name>` |
| `resume` / `pause` | Session save/restore |
| `discuss` | Lock decisions before planning |
| `code` | Structured coding (auto pipeline depth) |
| `build` | Container image build |
| `deploy` / `rollback` | K8s deploy / rollback |
| `verify` | Post-deploy verification: smoke, bench, accuracy, profile, kernel |
| `observe` | Grafana monitoring |
| `debug` | Investigation mode |
| `diff` / `status` | Show changes / project overview |
| `switch` | Switch active feature |
| `clean` | Cleanup resources |
| `log` | Quick checkpoint |
| `cluster` | Manage cluster profiles |
| `knowledge` / `learn` | Knowledge base ops / deep-dive learning |

## Dispatch Rule

When invoked as `/devflow <action> [args]`:
1. Parse first token of `$ARGUMENTS` as `<action>`
2. Route to the corresponding `/devflow:<action>` command
3. Pass remaining args to the command

## Complexity Tiering

`/devflow:code` auto-classifies task complexity and selects pipeline depth:

| Size | Pipeline | Trigger |
|------|----------|---------|
| `quick` | exec → commit | Prefixes: `quick:`, `just:`, `typo:` or ≤20 words with small signals |
| `small` | plan → exec → review | 1-3 files, <100 lines, small signals |
| `medium` | spec → plan → exec → review | Default for most tasks |
| `large` | discuss → spec → plan → exec → review | `refactor`, `architect`, `migrate`, cross-repo, >150 words |

Override with explicit flags: `--spec`, `--plan`, `--exec`, `--review`.

## Composable Behavior Layers

`/devflow:code <feature> --exec` supports stackable behavior flags:

| Flag | Layer | Effect |
|------|-------|--------|
| `--verify` | Enhancement | Smoke test (lint/test) after each wave |
| `--review-each` | Enhancement | Mini code review after each task |
| `--persistent` | Guarantee | Auto-retry on failure, no user prompt (up to max_task_retries) |
| `--sequential` | Execution | Disable wave parallelism, run all tasks serially |

Flags compose freely: `--exec --persistent --verify --review-each`

## Specificity Gate

Build and deploy workflows check if the request is specific enough:
- Vague requests ("部署一下") → redirect to discuss/planning
- Specific requests (with file paths, tags, cluster names) → execute directly
- `--force` bypasses the gate

## References

Architecture, agents, CLI tools, memory system, hooks → see `./references/`

## Parameters

$ARGUMENTS - `<action> [args...]`
