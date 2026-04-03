# Memory System Reference

<purpose>Authoritative reference for the /devflow unified memory system. All workflows and agents reference this document for memory architecture, state specifications, and knowledge sink rules.</purpose>

## Architecture Overview — Three-Tier Bandwidth-Aware Design

```
Tier 1: SYSTEM INDEX (始终加载, ~2KB 硬限)
├── .dev/KNOWLEDGE-INDEX.md          ← 每行 ~150 字符轻量指针
│   格式: topic | insight摘要 | 路径 | 版本 状态
│

Tier 2: INSIGHT NOTES (按需加载, 仅匹配当前任务时拉取)
├── Obsidian/<group>/knowledge/      ← 仅存不可推导的洞察 (<=200行/篇)
├── Obsidian/<group>/experience/     ← 排障模式、运维经验
│

Tier 3: ARCHIVE (仅检索, 永不加载进上下文)
├── Obsidian/<group>/devlog/         ← checkpoint, investigation
├── Obsidian/<group>/archive/        ← 旧版全量笔记
└── .dev/features/<feature>/         ← 工作制品 (spec, plan, review)

Supporting Layers:
├── .dev/STATE.md, HANDOFF.json      ← 工作记忆 (per-session)
├── .dev.yaml                        ← 项目配置 (per-project)
└── hooks/                           ← 行为脚本 (per-project)
```

### 设计原则（8 条硬核原则）

1. **记忆=索引**: KNOWLEDGE-INDEX.md 始终加载，每行 <=150 字符轻量指针
2. **三层架构**: Index(始终) → Topic(按需) → Archive(仅检索)
3. **严格写入**: 先写文件，后更索引。禁止直接写入索引
4. **自维护**: knowledge maintain 合并、去重、消除矛盾、激进剪枝
5. **时效性优先**: 记忆与现实不符→记忆错。可推导的绝不存
6. **隔离性**: 维护任务在隔离子代理中运行，最小化工具权限
7. **怀疑而非盲信**: 记忆只是提示，使用前必须验证
8. **不存什么才是精髓**: 不存代码结构、API签名、文件路径、debug日志、PR历史

### Layer Responsibilities

| Layer | Location | Tier | Lifetime | Purpose |
|-------|----------|------|----------|---------|
| **System Index** | `.dev/KNOWLEDGE-INDEX.md` | 1 | Per-project | 知识导航，始终在上下文中 |
| **Insight Notes** | Obsidian `knowledge/` | 2 | Forever | 不可推导的洞察、设计决策、gotchas |
| **Experience** | Obsidian `experience/` | 2 | Forever | 排障模式、运维经验 |
| **Archive** | Obsidian `archive/`, `devlog/` | 3 | Forever | 全量分析、checkpoint、调查日志 |
| **Working** | `.dev/` | — | Per-session | 当前状态、决策、handoff、feature 制品 |
| **Config** | `.dev.yaml` | — | Per-project | 仓库、集群、构建配置 |
| **Behavioral** | `hooks/` | — | Per-project | 自动化检查、debug 习得行为 |

### 什么存 / 什么不存

**存（不可推导）**:
- 设计决策的 Why（代码只告诉 What）
- 非显而易见的陷阱（需踩坑或深度分析才知道）
- 跨组件耦合（需同时理解两个子系统）
- 性能特征（代码里看不出性能含义）
- 个人理解/综合分析

**不存（可推导）**:
- API 签名 → `grep "def function_name"`
- 代码片段 → 直接读源码
- 文件路径表 → `glob/find`
- 类层级图 → LSP / grep
- 枚举定义、配置选项 → 读源码

### Four Protocols

**1. Loading Protocol (带宽感知)**:
```
init() → ALWAYS load INDEX (Tier 1, ~2KB)
       → MATCH entries to current feature
       → SELECTIVE load matched Tier 2 files
       → NEVER load Tier 3
       → VERIFY specific claims before use
```

**2. Writing Protocol (严格纪律)**:
```
write() → EXTRACT insights only (filter derivable)
        → WRITE FILE: knowledge/<topic>.md (Tier 2, <=200 lines)
        → UPDATE INDEX: one-line entry in INDEX (Tier 1)
        → VALIDATE: file exists + index matches + <=200 lines
```

**3. Maintenance Protocol (autoDream 等价)**:
```
maintain() → ISOLATED sub-agent (read + Obsidian write only)
           → PRUNE derivable content
           → MERGE overlapping notes (>40%)
           → SHARPEN vague → precise
           → DEDUPLICATE across notes
           → FRESHNESS check repo_commits
           → REBUILD index
```

**4. Verification Protocol (怀疑而非盲信)**:
```
use() → note mentions file path → glob confirm
      → note mentions function → grep confirm
      → note mentions behavior → read code verify
      → confidence: high(验证过) / medium(可能正确) / low(必须验证)
```

### Flow Rules

1. **Working -> Permanent**: Valuable insights sink from `.dev/` to Obsidian. Only non-derivable insights pass through (原则 5, 8).
2. **Permanent -> Working**: System Index (Tier 1) always loaded. Tier 2 loaded selectively by feature match. Tier 3 never loaded (原则 1, 2).
3. **Write discipline**: File first, index second. Never write raw content to index (原则 3).
4. **Self-maintenance**: Periodic consolidation via isolated sub-agent (原则 4, 6).
5. **Config is read-only** during workflows (except `phase` updates).
6. **Behavioral hooks grow** from debug resolutions and are never deleted.

---

## STATE.md Specification

**Location**: `.dev/STATE.md`

STATE.md is the central working memory file. It tracks the current position, accumulated decisions, and active blockers across sessions.

### Format

```markdown
---
project: <name>
phase: <phase>
current_feature: <feature|null>
feature_stage: spec|discuss|plan|exec|review|null
plan_progress: "2/5"
last_activity: "2026-03-27T10:30:00Z"
---

## Position
Currently working on: <what>
Next step: <what>

## Decisions
| ID | Decision | Rationale | Date | Feature |
|----|----------|-----------|------|---------|
| D-01 | Use PegaPdConnector | MLA only stores 1 KV copy vs KVBM 8x | 2026-03-25 | pegaflow |

## Blockers
| ID | Blocker | Type | Status | Workaround |
|----|---------|------|--------|------------|
| B-01 | GPU OOM on 80GB cards | resource | active | Use 2x40GB split |

## Metrics
| Feature | Spec | Plan | Exec | Review | Duration |
|---------|------|------|------|--------|----------|
| pegaflow | done | done | 4/5 | - | 3d |
```

### Rules

- **Auto-updated** by workflows after each action (spec, plan, exec, review, debug)
- **Decisions are APPEND-ONLY** -- never delete, only mark as superseded with a new decision
- **Blocker statuses**: `active` | `resolved` | `workaround`
- **Every workflow's init** loads STATE.md into context
- **Frontmatter fields** are machine-readable; body sections are human-readable

### Field Semantics

| Field | Updated By | Description |
|-------|-----------|-------------|
| `project` | init | Project name from .dev.yaml |
| `phase` | all workflows | Current lifecycle phase |
| `current_feature` | code-* workflows | Active feature being developed |
| `feature_stage` | code-* workflows | Which code sub-workflow is active |
| `plan_progress` | code-exec | "done/total" task count |
| `last_activity` | all workflows | ISO-8601 timestamp of last action |

---

## HANDOFF.json Specification

**Location**: `.dev/HANDOFF.json`

HANDOFF.json captures precise session state for zero-loss context transfer between sessions.

### Format

```json
{
  "version": "1.0",
  "timestamp": "2026-03-27T10:30:00Z",
  "project": "<name>",
  "feature": "<feature|null>",
  "feature_stage": "<stage>",
  "task_progress": { "current": 2, "total": 5 },
  "completed_tasks": ["Task 1: Add config parsing", "Task 2: Update router"],
  "remaining_tasks": ["Task 3: Integration test", "Task 4: Update docs"],
  "blockers": [{ "id": "B-01", "description": "GPU OOM", "status": "active" }],
  "decisions_this_session": ["D-03: Use streaming API for large transfers"],
  "uncommitted_files": ["dynamo/src/config.rs", "vllm/scheduler.py"],
  "next_action": "Run Task 3 in vllm worktree",
  "context_notes": "Waiting for upstream fix in nixl before Task 4"
}
```

### Rules

- **Written by** `pause` action (or auto-written when session ends gracefully)
- **Read by** `resume` workflow to restore precise position
- **Deleted** after successful resume (consumed on read)
- Fields map directly to STATE.md for cross-validation

---

## Feature Directory Structure

**Location**: `.dev/features/<feature>/`

Each feature gets a dedicated directory containing all artifacts from the code lifecycle.

```
.dev/features/<feature>/
  devlog.md      <- feature devlog 索引 (链接 Obsidian checkpoint/investigation)
  spec.md        <- from code --spec (requirements and scope)
  context.md     <- from code --discuss (user decisions and discussion notes)
  plan.md        <- from code --plan (task breakdown with wave ordering)
  review.md      <- from code --review (review findings and verdict)
  summary.md     <- from code --exec (per-task execution summaries merged)
  # Knowledge lives in Obsidian: knowledge/<feature>.md (managed by learn workflow)
```

### Feature ↔ Devlog 双向关联 (CRITICAL)

**问题**：Obsidian devlog 里的 checkpoint 和 investigation 散落，不知道属于哪个 feature。
**解决**：双向链接。

**方向 1: Obsidian → Feature** (frontmatter `feature` 字段)

所有 devlog 文件的 frontmatter 必须包含 `feature` 字段：
```yaml
---
date: 2026-03-25
project: dynamo
feature: dynamo-with-pegaflow    # ← 关联到 .dev.yaml features 里的 key
tags: [devlog, feature/dynamo-with-pegaflow]
---
```

Obsidian 里可以用 Dataview 查询某个 feature 的所有 devlog：
```dataview
TABLE date, file.name
FROM "dynamo/devlog"
WHERE feature = "dynamo-with-pegaflow"
SORT date DESC
```

**方向 2: Feature → Devlog** (.dev/features/<feature>/devlog.md 索引)

每个 feature 目录下有 `devlog.md`，汇总链接：
```markdown
# Feature Devlog: <feature>
## Checkpoint
- [[checkpoint-name]] (date) — summary
## Investigations
- [[investigation-name]] (date) — summary
## Knowledge Notes
- [[note-name]] — topic
## Decisions
## Build History
## Learned Hooks
```

**自动维护规则**：
- `debug` workflow 解决问题后 → 自动 append 到 feature 的 devlog.md Investigations 段
- `build` workflow 完成后 → 自动 append 到 Build History 段
- `code --review` 发现并沉淀 pattern → 自动 append 到 Knowledge Notes 段
- 新 devlog 文件创建时 → frontmatter 必须包含 `feature` 字段

**`init feature` 自动创建 devlog.md**：
feature 初始化时就创建空的 devlog.md 索引框架。

### Migration from Flat Layout

Old layout (deprecated):
```
.dev/specs/<feature>.md
.dev/plans/<feature>.md
.dev/reviews/<feature>.md
```

New layout:
```
.dev/features/<feature>/spec.md
.dev/features/<feature>/plan.md
.dev/features/<feature>/review.md
```

Workflows check both locations for backward compatibility.

---

## Knowledge Link Standard (MOC-Driven)

Obsidian 的核心价值是链接。所有知识笔记通过 MOC (Map of Content) 组织。

### MOC 体系

```
knowledge/
  _moc-data-plane.md       ← 数据面: 路由、KV 传输、NIXL
  _moc-control-plane.md    ← 控制面: 调度、事件通信、编排
  _moc-infra.md            ← 基础设施: 构建、部署、集群
  _moc-features.md         ← Feature 项目索引
```

### 创建新笔记时必须

1. **frontmatter 加 `parent`**：指向所属 MOC
   ```yaml
   parent: "[[_moc-data-plane]]"
   ```

2. **正文加 wikilinks**：引用相关笔记
   - 提到其他组件 → `[[component-name]]`
   - 引用数据流上下游 → `[[upstream]] → [[downstream]]`
   - 引用排障经验 → `[[troubleshooting-topic]]`

3. **更新 MOC**：在对应 MOC 页中添加新笔记的链接

### Tags 统一格式

```yaml
tags:
  - project/dynamo           # 项目
  - knowledge                # 类型: knowledge | experience | devlog
  - domain/<data-plane|control-plane|infra>  # 领域
  - component/<name>         # 组件（可选）
  - feature/<name>           # Feature 关联（可选）
```

### Workflow 自动执行

当 learn/research/debug 创建新 Obsidian 笔记时：
1. 自动添加 `parent` frontmatter（从文件内容推断 MOC 归属）
2. 自动扫描正文中出现的已有笔记名称 → 转为 `[[wikilink]]`
3. 提示用户确认 MOC 归属：
   ```
   New note: nixl-buffer-optimization.md
   Suggested MOC: _moc-data-plane (contains NIXL references)
   Confirm? [Y/n]
   ```

---

## Knowledge Sink Rules

The "second brain" flow: valuable working knowledge sinks from ephemeral `.dev/` to permanent Obsidian.

### Sink 分级策略

| 场景 | 默认行为 | Obsidian 目标 | 理由 |
|------|---------|--------------|------|
| `debug` 解决问题 | **自动写入** (default-on) | `experience/<topic>-patterns.md` | 最有价值的经验，必须保存 |
| `research` MISS | **自动写入** | `knowledge/<topic>.md` | 研究结果本身就是知识 |
| `research` STALE | **自动更新** | `knowledge/<topic>.md` 追加 delta | 保持知识新鲜 |
| `learn` | **自动写入** | `knowledge/<feature>.md` | 主动学习就是为了产出 |
| `code --review` pattern | **opt-in** [Y/n] | `knowledge/<pattern>.md` | 不是每个 pattern 都值得 |
| `build` 失败/重试 | **异常时 opt-in** [Y/n] | `experience/docker-build-lessons.md` | 正常成功不打扰 |
| `deploy` 异常 | **异常时 opt-in** [Y/n] | `experience/k8s-deploy-lessons.md` | 正常成功不打扰 |
| `verify` 回归 | **异常时 opt-in** [Y/n] | `experience/performance-lessons.md` | 正常通过不打扰 |
| `observe` 异常 | **异常时 opt-in** [Y/n] | `experience/observability-insights.md` | 正常不打扰 |

**核心原则**：
- **debug + research + learn = 自动写入**（这些动作的目的就是产出知识）
- **review = opt-in**（人工判断是否有保存价值）
- **build/deploy/verify/observe = 异常时 opt-in**（正常流程不干扰，出问题才捕获）

### Sink Mechanism

**自动写入 (default-on)**:
1. 自动创建/追加 Obsidian note
2. 显示写入内容，用户可 edit 或 delete（但默认保留）
3. `📚 Experience auto-saved: experience/<topic>-patterns.md`

**异常时 opt-in (conditional)**:
1. 检测异常条件（build 失败、deploy pod stuck、verify 回归 > 20%）
2. 异常时提示：`"遇到问题。Save experience? [Y/n]"`
3. 正常完成时：静默通过，不打扰

**手动 opt-in**:
1. 提示：`"Found reusable pattern. Save? [Y/n]"`
2. 用户决定

### Checkpoint Standard

所有动作完成后写标准化 checkpoint（双写 Obsidian + feature devlog）：

```markdown
### #N | YYYY-MM-DD HH:MM | <action>: <summary>
**Feature**: <feature_name>
**Tag**: <current_tag>
**Result**: success | failed | warning
**Repos**: <changed repos>
```

CLI: `node my-dev-tools.cjs checkpoint --action <action> --summary "<text>" --result <result>`

写入目标：
1. Obsidian `devlog/<feature>-checkpoint.md`（永久记录）
2. `.dev/features/<feature>/devlog.md`（索引链接）

---

## Experience Note Template

**Location in Obsidian**: `<vault>/<group>/experience/<topic>-patterns.md`

```markdown
---
date: YYYY-MM-DD
project: <project>
tags: [debug, <topic>]
---

# <Topic> Patterns

## Pattern: <name>
**Symptom**: <what you see>
**Root Cause**: <why it happens>
**Fix**: <how to resolve>
**Prevention**: <learned hook or check>
**Source**: debug session <date>, investigation log: <link>
```

---

## Learn ↔ Obsidian Knowledge

The learn stage (`stages/learn.md`) manages Obsidian knowledge notes with staleness tracking via git commit IDs.

### Flow

```
code --plan (auto) or /devflow:learn (manual)
  │
  ├── CHECK: Glob Obsidian knowledge/ for matching notes
  │     ├── FRESH (repo commits match base worktree HEAD) → load directly
  │     ├── STALE (commits differ) → delta research on base worktrees → update note
  │     └── MISS → full research on base worktrees → create note
  │
  └── Result: Obsidian knowledge/<feature>.md (with repo_commits in frontmatter)
```

Code exploration always uses **base worktrees** (stable release code, not dev branches).

---

## Integration with init.cjs

The `init` command loads the following memory layers into workflow context:

1. **STATE.md** content: decisions, blockers, position, current feature/stage
2. **Active feature's context.md** if a feature is active
3. **HANDOFF.json** if it exists (previous session's precise state)
4. **Relevant knowledge notes** from Obsidian (matched by feature keyword)
5. **Recent experience notes** from Obsidian (matched by topic)

These are added to the init JSON output under keys:
- `state` -- parsed STATE.md frontmatter
- `decisions` -- decisions table rows
- `blockers` -- active blockers
- `feature_context` -- content of features/<feature>/context.md
- `handoff` -- HANDOFF.json content (null if not present)
- `knowledge_notes` -- list of matching Obsidian knowledge notes
- `experience_notes` -- list of matching Obsidian experience notes
