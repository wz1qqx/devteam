# devflow

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Claude Code Plugin](https://img.shields.io/badge/Claude_Code-Plugin-blueviolet)](https://claude.ai/claude-code)
[![Node.js >= 18](https://img.shields.io/badge/Node.js-%3E%3D18-green)](https://nodejs.org)

A Claude Code plugin for managing multi-repo development lifecycles — structured coding, container build, K8s deploy, verification, observability, and debug — all from slash commands.

## Why devflow

Most AI coding tools handle single files. Real projects span multiple repos, need container builds, cluster deployments, and post-deploy verification. devflow bridges that gap with a **structured pipeline** that auto-classifies task complexity and scales ceremony accordingly:

| Complexity | Pipeline | When |
|-----------|----------|------|
| `quick` | exec → commit | Typos, config tweaks, one-liner fixes |
| `small` | plan → exec → review | 1–3 files, < 100 lines |
| `medium` | spec → plan → exec → review | Most feature work (default) |
| `large` | discuss → spec → plan → exec → review | Cross-repo, architecture changes |

No manual pipeline selection needed — devflow classifies automatically and you can always override.

## Quick Start

```bash
# Install from marketplace
claude plugin marketplace add wz1qqx/devflow-plugin
claude plugin install devflow@devflow

# In your project directory
/devflow:init                        # Initialize workspace (.dev.yaml)
/devflow:init feature my-feature     # Create a feature
/devflow:next                        # Auto-detect state, suggest next step
```

## Commands

### Core Workflow

| Command | Description |
|---------|-------------|
| `/devflow:next` | Auto-detect project state and suggest the next workflow step |
| `/devflow:code` | Structured coding pipeline (auto-selects complexity) |
| `/devflow:quick` | Ad-hoc task with atomic commits — skip full ceremony |
| `/devflow:discuss` | Lock design decisions before planning |

### Build & Deploy

| Command | Description |
|---------|-------------|
| `/devflow:build` | Build container image with incremental tag chain |
| `/devflow:deploy` | Deploy to K8s cluster with namespace safety |
| `/devflow:verify` | Post-deploy verification (smoke / bench / accuracy / full) |
| `/devflow:rollback` | Rollback deployment to a previous image tag |
| `/devflow:observe` | Deploy monitoring, query metrics, analyze performance |

### Project Management

| Command | Description |
|---------|-------------|
| `/devflow:init` | Initialize workspace or create a new feature |
| `/devflow:status` | Project overview — config, worktrees, deployments, pipeline stage |
| `/devflow:diff` | Show worktree changes across repositories |
| `/devflow:switch` | Switch active feature context |
| `/devflow:cluster` | Manage K8s cluster profiles (add / use / list) |
| `/devflow:clean` | Clean orphan worktrees, stale images, K8s resources |

### Knowledge & Session

| Command | Description |
|---------|-------------|
| `/devflow:debug` | Structured investigation with hypothesis tracking |
| `/devflow:learn` | Deep-dive into a feature, generate dual-layer knowledge docs |
| `/devflow:knowledge` | Knowledge base operations (list / coverage / update / search) |
| `/devflow:log` | Quick checkpoint — save progress snapshot to devlog |
| `/devflow:pause` | Save session state (HANDOFF.json + STATE.md) |
| `/devflow:resume` | Restore session state and continue where you left off |

## Architecture

```
User → Command (.md) → Workflow (.md) → Agent (.md) + CLI Tools (.cjs)
         Entry Layer    Orchestration     Execution      State Layer
```

**Commands** (`commands/devflow/`) — thin entry points that route to workflows.
**Workflows** (`skills/my-dev/workflows/`) — step-by-step orchestration logic.
**Agents** (`skills/my-dev/agents/`) — specialized AI agents with focused roles.
**CLI Tools** (`skills/my-dev/bin/`) — Node.js tools for state, config, and template management.

### Agents

Seven specialized agents, each scoped to a role with minimal tool access:

| Agent | Role | Default Model |
|-------|------|:---:|
| `my-dev-researcher` | Codebase exploration, knowledge loading | haiku |
| `my-dev-planner` | Implementation plan generation (wave-grouped tasks) | opus |
| `my-dev-plan-checker` | Plan verification (read-only) | sonnet |
| `my-dev-executor` | Code implementation, atomic commits | sonnet |
| `my-dev-reviewer` | Code review with severity grading (read-only) | sonnet |
| `my-dev-debugger` | Investigation + hypothesis tracking | sonnet |

Model assignment is profile-driven (`quality` / `balanced` / `budget`), configurable in `.dev.yaml`:

```yaml
defaults:
  model_profile: balanced   # quality | balanced | budget
```

### Hooks

| Hook | Event | Purpose |
|------|-------|---------|
| `my-dev-context-monitor` | PostToolUse | Warns at 35% / 25% context window remaining |
| `devflow-persistent` | Stop | Auto-retry on failure when `--persistent` flag is active |

## Configuration

Create `.dev.yaml` in your project root (or let `/devflow:init` generate it):

```yaml
schema_version: 2

workspace: ~/my-project
vault: ~/Obsidian/MyVault              # Optional: Obsidian knowledge persistence

repos:
  my-repo:
    upstream: https://github.com/org/repo
    baselines:
      v1.0: my-repo-v1.0              # worktree directory name

build_server:
  ssh: user@build-server
  work_dir: /data/builds
  registry: registry.example.com

clusters:
  dev-cluster:
    ssh: user@jump-server
    namespace: my-namespace
    safety: normal                     # normal | production (requires confirmation)
    hardware:
      gpu: "8x A100"

defaults:
  active_feature: my-feature
  active_cluster: dev-cluster
  model_profile: balanced              # quality | balanced | budget

features:
  my-feature:
    description: "My awesome feature"
    phase: init                        # 13 phases: init → ... → completed
    scope:
      my-repo:
        base_ref: v1.0
        dev_worktree: my-repo-dev
    invariants:
      source_restriction: dev_worktree_only
```

See [`skills/my-dev/references/schema.md`](skills/my-dev/references/schema.md) for the complete schema reference.

## Key Concepts

### Incremental Build Chain

Container builds use `BASE_IMAGE = current_tag` (not the upstream base), so each build patches on top of the previous one — faster iteration, smaller layers.

### Namespace Safety

All `kubectl` commands are enforced with `-n <namespace>`. Production clusters (`safety: production`) require explicit confirmation before any destructive operation.

### Wave-Based Parallel Execution

The planner groups independent tasks into waves. Tasks within a wave execute as parallel subagents, each producing atomic git commits. Dependencies between waves are respected sequentially.

### Three-Tier Knowledge

1. **System Index** (`KNOWLEDGE-INDEX.md`) — always loaded, lightweight pointers
2. **Insight Notes** (Obsidian `knowledge/` + `experience/`) — loaded on demand
3. **Archive** (Obsidian `devlog/`, `archive/`) — search only, never loaded into context

### Session Handoff

`/devflow:pause` captures uncommitted files, plan progress, and context notes into `HANDOFF.json` + `STATE.md`. `/devflow:resume` restores everything — zero-loss across sessions.

## Prerequisites

**Required:**
- **Node.js** >= 18
- **Python 3** + **PyYAML** (`pip install pyyaml`) — for `.dev.yaml` parsing

**Optional (for specific workflows):**
- **jq** — JSON processing
- **kubectl** — K8s operations (deploy, verify, rollback, cluster)
- **ssh** — remote build server and cluster access

## Local Development

```bash
git clone https://github.com/wz1qqx/devflow-plugin.git ~/devflow-plugin
bash ~/devflow-plugin/bin/setup.sh
```

After cloning, run `/devflow-setup` in Claude Code to verify the installation.

## License

MIT
