# devteam

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Claude Code Plugin](https://img.shields.io/badge/Claude_Code-Plugin-blueviolet)](https://claude.ai/claude-code)
[![Node.js >= 18](https://img.shields.io/badge/Node.js-%3E%3D18-green)](https://nodejs.org)
[![v2.0.0](https://img.shields.io/badge/version-2.0.0-orange)](https://github.com/wz1qqx/devflow-plugin)

Multi-agent pipeline orchestration for Claude Code. One command launches a team of specialized AI agents that take a feature from spec to verified deployment — with automatic feedback loops.

## Why devteam

Most AI coding tools operate as a single agent on a single file. Real projects need requirements gathering, multi-file implementation, code review, container builds, cluster deployments, and post-deploy verification. devteam orchestrates **8 specialized agents** through a **7-stage pipeline** with built-in feedback loops:

```
Spec → Plan → Code → Review → Build → Ship → Verify
                       ↑                        │
                       └── vLLM-Opter (on FAIL) ─┘
                           (optimization loop, max N iterations)
```

The orchestrator is a coordinator, not an implementer. Each agent has scoped tools and a single responsibility. Review failures trigger code fixes. Verification failures trigger performance analysis and re-optimization.

## Quick Start

```bash
# Install from marketplace
claude plugin marketplace add wz1qqx/devflow-plugin
claude plugin install devteam@devteam

# In your project directory
/devteam init workspace              # Initialize workspace (.dev.yaml)
/devteam init feature my-feature     # Create a feature

# Launch the full automated pipeline
/devteam team my-feature
```

## The Agent Team

Eight specialized agents, each with scoped tool access and a single role:

| Agent | Role | Tools |
|-------|------|-------|
| **Spec** | Interactive QA (5 mandatory questions), surface gray areas, lock decisions | Read, Write, Bash, AskUserQuestion |
| **Planner** | Wave-grouped task plan with dependency graph, build mode detection | Read, Write, Bash, Glob, Grep |
| **Coder** | TDD implementation, one atomic `git commit` per task | Read, Write, Edit, Bash, Grep, Glob |
| **Reviewer** | 5-axis review: correctness, readability, architecture, security, performance | Read, Bash, Grep, Glob (read-only) |
| **Builder** | Pre-ship checklist, incremental Docker tag chain, registry push | Read, Write, Bash, Glob, Grep |
| **Shipper** | GPU env check, namespace safety, kubectl deploy, pod readiness | Read, Write, Bash, AskUserQuestion |
| **Verifier** | Smoke tests (3/3 required), 3x benchmarks, metric comparison | Read, Write, Bash, Glob, Grep |
| **vLLM-Opter** | Torch profiler + nsight kernel analysis, 9-category classification | Read, Write, Bash, Glob, Grep |

All agents follow the same team protocol: claim task → mark in_progress → do work → mark completed → message orchestrator.

## Commands

### Core — Automated Pipeline

| Command | Description |
|---------|-------------|
| `/devteam team <feature>` | Full pipeline: spec → plan → code → review → build → ship → verify |

Options: `--max-loops N` (optimization iterations, default 3), `--skip-spec` (skip if spec.md exists)

### Session Management

| Command | Description |
|---------|-------------|
| `/devteam pause` | Save session state (HANDOFF.json + STATE.md) |
| `/devteam resume` | Restore session, show status dashboard, suggest next action |

### Project View

| Command | Description |
|---------|-------------|
| `/devteam status` | Dashboard: feature, phase, repos, cluster, build history, team status |
| `/devteam diff [repo]` | Worktree changes across repositories |

### Knowledge

| Command | Description |
|---------|-------------|
| `/devteam learn <topic\|URL\|file>` | Research and create/update interlinked wiki pages |
| `/devteam knowledge <search\|lint\|list>` | Search wiki, run health checks, list pages |

### Project Management

| Command | Description |
|---------|-------------|
| `/devteam init <workspace\|feature>` | Initialize workspace or add a new feature |
| `/devteam cluster <add\|use\|list>` | Manage K8s cluster profiles |
| `/devteam clean [--dry-run]` | Clean orphan worktrees, stale images, K8s resources |

## Architecture

```
User → /devteam team
         │
         ├── Command (.md)        Entry point (commands/devteam/)
         ├── Orchestrator (.md)   Pipeline coordinator (skills/orchestrator.md)
         ├── Agents (.md)         8 specialized agents (agents/)
         ├── CLI (.cjs)           State & config management (lib/)
         └── Hooks (.js)          Context monitor, persistent mode, statusline (hooks/)
```

### Pipeline Flow

```
/devteam team my-feature
  │
  ├── TeamCreate("devteam-my-feature")
  ├── Create 6-7 tasks with dependency chain
  │
  ├── Spawn Spec agent      → writes spec.md
  ├── Spawn Planner agent   → writes plan.md (wave-grouped tasks)
  ├── Spawn Coder agent     → implements plan, atomic commits
  ├── Spawn Reviewer agent  → 5-axis review
  │     └── FAIL? → re-spawn Coder (max 2 cycles)
  ├── Spawn Builder agent   → Docker build + push
  ├── Spawn Shipper agent   → K8s deploy + readiness
  └── Spawn Verifier agent  → smoke + benchmarks
        └── FAIL? → Spawn vLLM-Opter → re-run plan/code/review/build/ship/verify
                    (max N optimization loops)
```

### Feedback Loops

- **Review loop**: Reviewer FAIL → Coder fix → Reviewer re-check (max 2 cycles)
- **Optimization loop**: Verifier FAIL → vLLM-Opter analysis → Planner re-plan → full re-execution (max N loops, configurable via `tuning.max_optimization_loops`)

### Anti-Rationalization

Every skill and agent includes:
- **Anti-rationalization table**: common excuses mapped to reality checks
- **Red flags**: warning signs that the agent is cutting corners
- **Verification checklist**: concrete evidence required before proceeding

The agent cannot self-certify — evidence is required at every gate.

### Directory Layout

```
devflow-plugin/
├── .claude-plugin/
│   ├── plugin.json                # Plugin manifest (devteam v2.0.0)
│   └── marketplace.json           # Marketplace listing
│
├── agents/                        # 8 specialized agent definitions
│   ├── spec.md                    # Requirements gathering
│   ├── planner.md                 # Wave-grouped task planning
│   ├── coder.md                   # TDD implementation
│   ├── reviewer.md                # 5-axis code review (read-only)
│   ├── builder.md                 # Docker build + push
│   ├── shipper.md                 # K8s deployment
│   ├── verifier.md                # Smoke tests + benchmarks
│   └── vllm-opter.md              # Performance analysis + optimization
│
├── commands/devteam/              # 10 slash commands
│   ├── _registry.yaml             # Source of truth
│   ├── team.md                    # Primary pipeline command (hand-maintained)
│   └── *.md                       # Generated from registry
│
├── skills/                        # Process definitions
│   ├── SKILL.md                   # Meta-skill: routing table + 6 core behaviors
│   ├── orchestrator.md            # Full pipeline orchestration
│   ├── learn.md                   # Wiki ingest (code/URL/file sources)
│   ├── pause.md                   # Session state save
│   ├── resume.md                  # Session state restore
│   └── references/schema.md       # .dev.yaml schema reference
│
├── lib/                           # Node.js CLI modules
│   ├── devteam.cjs                # CLI entry point
│   ├── init.cjs                   # Compound context loader (17 workflow types)
│   ├── config.cjs                 # .dev.yaml loading + resolution
│   ├── state.cjs                  # Phase management
│   ├── session.cjs                # STATE.md + HANDOFF.json read/write
│   ├── checkpoint.cjs             # Devlog checkpoints
│   ├── yaml.cjs                   # YAML parser
│   └── core.cjs                   # Shared utilities
│
├── hooks/                         # Claude Code hooks
│   ├── hooks.json                 # Hook registrations
│   ├── my-dev-context-monitor.js  # PostToolUse: context window warnings
│   ├── devflow-persistent.js      # Stop: persistent mode engine
│   └── my-dev-statusline.js       # Statusline: model | ctx usage | project | feature
│
├── templates/STATE.md             # STATE.md template
└── bin/
    ├── generate-commands.cjs      # Regenerate commands from registry
    ├── migrate-to-wiki.cjs        # Migration tool
    └── setup.sh                   # Local dev verification
```

## Configuration

Create `.dev.yaml` in your project root (or let `/devteam init` generate it):

```yaml
schema_version: 2

workspace: ~/my-project
vault: ~/Obsidian/MyVault              # Optional: wiki persistence

repos:
  my-repo:
    upstream: https://github.com/org/repo
    baselines:
      v1.0: my-repo-v1.0

build_server:
  ssh: user@build-server
  work_dir: /data/builds
  registry: registry.example.com

clusters:
  dev-cluster:
    ssh: user@jump-server
    namespace: my-namespace
    safety: normal                     # normal | prod (requires confirmation)
    hardware:
      gpu: "8x A100"

defaults:
  active_feature: my-feature
  active_cluster: dev-cluster

features:
  my-feature:
    description: "My awesome feature"
    phase: spec                        # spec|plan|code|test|review|ship|debug|dev|completed
    scope:
      my-repo:
        base_ref: v1.0
        dev_worktree: my-repo-dev
    invariants:
      source_restriction: dev_worktree_only
    ship:
      strategy: k8s                    # docker | k8s | ci-cd
```

See [`skills/references/schema.md`](skills/references/schema.md) for the complete schema reference.

## Key Concepts

### Wave-Based Parallel Execution

The planner groups independent tasks into waves. Tasks within a wave execute in parallel via subagents, each producing atomic git commits. Dependencies between waves are respected sequentially.

### Strategy-Driven Shipping

`/devteam team` reads `ship.strategy` from `.dev.yaml` and routes to the appropriate flow:
- **docker** — build image → push → update tag
- **k8s** — build + deploy to cluster → wait ready → health check
- **ci-cd** — trigger CI pipeline → wait → verify

### Namespace Safety

All `kubectl` commands are enforced with `-n <namespace>`. Production clusters (`safety: prod`) require the user to type the namespace name as confirmation before any destructive operation.

### Three-Tier Knowledge

1. **Wiki Index** (`wiki/index.md`) — always loaded, content catalog
2. **Wiki Pages** (`wiki/` + `experience/`) — loaded on demand via semantic matching
3. **Archive** (`devlog/`, `archive/`) — search only, never loaded into context

### Session Handoff

`/devteam pause` captures uncommitted files, plan progress, and context notes into `HANDOFF.json` + `STATE.md`. `/devteam resume` restores everything — zero-loss across sessions.

### Hooks

| Hook | Event | Purpose |
|------|-------|---------|
| Context Monitor | PostToolUse | Warns at 35% (warning) and 25% (critical) context remaining |
| Persistent Mode | Stop | Prevents session exit during active pipeline execution |
| Statusline | Always | Shows `Model | ctx [====    ] 42% | project | feature | [phase]` |

## Prerequisites

**Required:**
- **Node.js** >= 18

**Optional (for specific workflows):**
- **jq** — JSON processing in skill steps
- **kubectl** — K8s operations (ship, cluster, clean)
- **ssh** — remote build server and cluster access

## Local Development

```bash
git clone https://github.com/wz1qqx/devflow-plugin.git ~/devflow-plugin
bash ~/devflow-plugin/bin/setup.sh
```

Regenerate commands after modifying `_registry.yaml`:

```bash
node bin/generate-commands.cjs
```

## License

MIT
