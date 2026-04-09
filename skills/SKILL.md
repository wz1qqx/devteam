---
name: devteam
description: "Automated multi-agent pipeline orchestration for full development lifecycle. One command from spec to verified deployment with optimization feedback loops. Trigger for: feature development, automated pipeline, team orchestration, build, deploy, verify."
---

# devteam — Automated Multi-Agent Pipeline

## Skill Discovery

When the user invokes `/devflow <action> [args]`, route to the matching command:

| Action | Command | Description |
|--------|---------|-------------|
| `team <feature>` | `/devflow team` | **Primary**: Automated multi-agent pipeline — full lifecycle |
| `pause` | `/devflow pause` | Save session state for later resume |
| `resume` | `/devflow resume` | Restore session state |
| `status` | `/devflow status` | Project overview dashboard |
| `diff` | `/devflow diff` | Show worktree changes |
| `learn <topic>` | `/devflow learn` | Research and create wiki pages |
| `knowledge <action>` | `/devflow knowledge` | Wiki operations |
| `init <workspace\|feature>` | `/devflow init` | Initialize workspace or add feature |
| `cluster <add\|use\|list>` | `/devflow cluster` | Manage K8s cluster profiles |
| `clean` | `/devflow clean` | Cleanup orphan worktrees/images/pods |

## Dispatch Rule

1. Parse first token of `$ARGUMENTS` as `<action>`
2. Route to corresponding `/devflow:<action>` command
3. Pass remaining args forward

If no action specified, suggest `/devflow team <feature>` as the primary workflow.

## Pipeline Roles

The `/devflow team` command orchestrates 8 specialized agents:

| Role | Agent | Responsibility |
|------|-------|---------------|
| Spec | `agents/spec.md` | Discuss requirements with user, generate spec |
| Planner | `agents/planner.md` | Create wave-grouped implementation plan |
| Coder | `agents/coder.md` | Implement plan with atomic commits |
| Reviewer | `agents/reviewer.md` | READ-ONLY five-axis code review |
| Builder | `agents/builder.md` | Docker image build and push |
| Shipper | `agents/shipper.md` | K8s deployment with GPU/safety checks |
| Verifier | `agents/verifier.md` | Smoke + benchmark verification |
| vLLM-Opter | `agents/vllm-opter.md` | Performance analysis (on-demand) |

## Core Operating Behaviors

These apply across ALL commands and agent interactions:

1. **Surface Assumptions** — State them explicitly, then wait for correction
2. **Manage Confusion** — Stop on inconsistencies; name the confusion; present the tradeoff
3. **Push Back When Warranted** — Point out problems, propose alternatives
4. **Enforce Simplicity** — Fewer lines? Are abstractions earning their complexity?
5. **Scope Discipline** — Never touch code outside the task scope
6. **Verify, Don't Assume** — Every task has a verification step; never done until verification passes
