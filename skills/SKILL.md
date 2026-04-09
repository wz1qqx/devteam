---
name: devteam
description: "Automated multi-agent pipeline orchestration for full development lifecycle. One command from spec to verified deployment with optimization feedback loops. Trigger for: feature development, automated pipeline, team orchestration, build, deploy, verify."
---

# devteam — Automated Multi-Agent Pipeline

## Skill Discovery

When the user invokes `/devteam <action> [args]`, route to the matching command:

| Action | Command | Description |
|--------|---------|-------------|
| `team <feature>` | `/devteam team` | **Primary**: Automated multi-agent pipeline — full lifecycle |
| `pause` | `/devteam pause` | Save session state for later resume |
| `resume` | `/devteam resume` | Restore session state |
| `status` | `/devteam status` | Project overview dashboard |
| `diff` | `/devteam diff` | Show worktree changes |
| `learn <topic>` | `/devteam learn` | Research and create wiki pages |
| `knowledge <action>` | `/devteam knowledge` | Wiki operations |
| `init <workspace\|feature>` | `/devteam init` | Initialize workspace or add feature |
| `cluster <add\|use\|list>` | `/devteam cluster` | Manage K8s cluster profiles |
| `clean` | `/devteam clean` | Cleanup orphan worktrees/images/pods |

## Dispatch Rule

1. Parse first token of `$ARGUMENTS` as `<action>`
2. Route to corresponding `/devteam:<action>` command
3. Pass remaining args forward

If no action specified, suggest `/devteam team <feature>` as the primary workflow.

## Pipeline Roles

The `/devteam team` command orchestrates 8 specialized agents:

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
