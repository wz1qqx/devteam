# `.dev.yaml` Schema Reference

核心设计：**Workspace 级（固定）** 和 **Feature 级（动态、多个）** 彻底分离。

```yaml
schema_version: 2

# ═══════════════════════════════════════
# WORKSPACE 级 (一次性配置，所有 feature 共享)
# ═══════════════════════════════════════

workspace: <path>                   # Root workspace directory
vault: <path>                       # Obsidian vault path (optional, enables knowledge persistence)

build_server:
  ssh: <string>                     # SSH connection string
  work_dir: <path>                  # Remote working directory
  registry: <string>                # Docker registry URL

devlog:
  group: <string>                   # Vault group name e.g. "dynamo"
  checkpoint: <template>            # e.g. "{vault}/{group}/devlog/{feature}-checkpoint.md"
  investigation: <template>         # e.g. "{vault}/{group}/devlog/{topic}-investigation.md"

clusters:
  <name>:
    ssh: <string>                   # SSH command to reach cluster jump server
    namespace: <string>             # K8s namespace
    safety: normal | prod           # prod requires explicit confirm for destructive ops
    network:                        # Free-form cluster-specific fields
      socket_ifname: <string>
      ucx_tls: <string>
    hardware:
      gpu: <string>
      rdma: <string>
      nvlink: <string>
      min_driver: <string>            # Minimum NVIDIA driver version (optional, e.g. "535.0")
      expected_tp: <int>              # Expected tensor_parallel_size for GPU free-count check (optional, default 1)

# ═══════════════════════════════════════
# REPO 定义 (workspace 级，所有 feature 共享)
# ═══════════════════════════════════════
# 每个 repo 声明 upstream URL 和已创建的 baseline worktrees
# Feature 从这里选择需要的 repo + base_ref

repos:
  <name>:
    upstream: <git-url>             # Remote repository URL
    baselines:                      # 已创建的 baseline worktrees
      <ref>: <worktree-dir>        # ref → worktree dir name

# ═══════════════════════════════════════
# 默认值
# ═══════════════════════════════════════

defaults:
  active_feature: <string>          # Currently active feature
  active_cluster: <string>          # Which cluster to use by default
  model_profile: balanced           # Agent model tier: quality | balanced | budget
  agent_models:                     # Optional per-agent model overrides
    <agent-name>: <model>           # e.g., my-custom-auditor: opus
  tuning:                           # Optional tunable parameters (all have defaults)
    regression_threshold: 20        # Benchmark regression alert threshold (%)
    max_task_retries: 2             # code max retries per failed task
    deploy_timeout: 300             # Pod readiness timeout (seconds)
    deploy_poll_interval: 15        # Pod status poll interval (seconds)
    build_history_limit: 5          # Number of build history entries in context
    commit_format: "feat({feature}): {title}"  # Commit message template

# ═══════════════════════════════════════
# FEATURES (多个，按需创建，独立生命周期)
# ═══════════════════════════════════════

features:
  <name>:
    description: <string>
    created: <YYYY-MM-DD>

    scope:                          # 涉及哪些 repo
      <repo-name>:
        base_ref: <tag|commit>      # Baseline version from repos.<name>.baselines
        base_worktree: <dir>        # Optional: detached HEAD worktree (read-only)
        dev_worktree: <dir|null>    # Active dev worktree (null = not yet created)
        shared_with: <feature>      # Optional: if worktree is shared with another feature
        build_type: <string>        # Optional: e.g. "wheel"

    # 生命周期状态
    phase: spec | plan | code | test | review | ship | debug | dev | completed
    current_tag: <string>           # Latest built image tag
    base_image: <string|null>       # Base Docker image
    cluster: <string>               # Override cluster for this feature

    # Feature-specific 配置 (all optional)
    invariants:
      source_restriction: dev_worktree_only | any
      build_compat_check: <bool>
      pre_deploy_node_check: <bool>

    hooks:
      pre_build: [<script_name>, ...]
      post_build: [<script_name>, ...]
      pre_deploy: [<script_name>, ...]
      post_deploy: [<script_name>, ...]
      post_verify: [<script_name>, ...]
      learned:
        - name: <string>
          trigger: <phase>
          added: <YYYY-MM-DD>
          rule: <string>

    build:
      commands:
        default: <string|path>
        <variant>: <string|path>
      env:
        <KEY>: <value>

    deploy:
      yaml_file: <path>
      dgd_name: <string>
      resource_kind: <string>
      strategy: <string>            # delete-then-apply | apply
      model_path: <path>            # Model weights path on cluster (optional, for GPU_ENVIRONMENT_CHECK)
      model_name: <string>          # Model name for API calls (optional, for WAIT_FOR_READY first-request)
      service_url: <string>         # vLLM service URL after deploy (optional, e.g. "10.0.0.5:8000")
      validation_tests: <string>    # Quick test paths for CODE_VALIDATION (optional, space-separated)
      validation_tests_gate: <bool> # If true, test failure aborts deploy (default false)

    benchmark:
      bench_node: cluster | dedicated
      mtb_cmd: <string>              # Benchmark execution command
      mtb_dir: <path>
      dataset_path: <path>
      model_path: <path>
      api_key: <string>
      frontend_svc_label: <string>
      output_dir: <string>           # Results directory (default: bench-results)
      standard:
        arrival_rate: <float>
        total_sessions: <int>
        num_rounds: <distribution>
        turn_interval: <distribution>
        init_prompt_length: <distribution>
        input_length: <distribution>
        output_length: <distribution>

    verify:
      smoke_cmd: <string>            # Single request command (used for warmup + test)
      smoke_count: <int>             # Number of test requests (default: 5)
      warmup_count: <int>            # Number of warmup requests (default: 3)
      pod_selector: <string>         # kubectl label selector for pod health check
      accuracy:
        command: <string>            # Accuracy test command
        baseline: <string|path>      # Baseline file path for comparison
        threshold: <float>           # Deviation threshold percentage
        output_dir: <string>         # Results directory (default: bench-results)
      profile:                         # --profile mode configuration
        trace_dir: <path>              # Remote dir for trace output (default: /tmp/vllm_profile_{tag})
        num_prompts: <int>             # Workload size for profiling (default: 10)
        request_rate: <float>          # Request rate during profiling (default: 4)
        input_len: <int>               # Synthetic input length (default: 128)
        output_len: <int>              # Synthetic output length (default: 64)
        analyzers:                     # Extensible analysis scripts (optional)
          - name: <string>             # Analyzer name
            command: <string>          # Command template with {trace} and {output_dir} placeholders
      kernel:                          # --kernel mode configuration (nsight)
        batch_size: <int>              # Batch size for latency profiling (default: 1)
        input_len: <int>               # Input sequence length (default: 128)
        output_len: <int>              # Output sequence length (default: 32)
        num_iters: <int>               # Benchmark iterations (default: 3)
        nsys_path: <path>              # Override nsys binary path (optional, auto-detected)

    ship:
      strategy: docker | k8s | ci-cd
      # ... existing build/deploy config fields

    build_history:
      - tag: <string>
        date: <YYYY-MM-DD>
        changes: <string>
        mode: <string>
        base: <string>
        cluster: <string>
        note: <string>

# ═══════════════════════════════════════
# WORKSPACE 级 (optional sections)
# ═══════════════════════════════════════

observability:
  prometheus:
    svc: <string>
    remote_write:
      url: <string>
      secret: <string>
  grafana:
    enabled: <bool>
    dashboards_dir: <path>
    external_url: <string>
  alerts:
    gpu_utilization_min: <int>
    p99_latency_increase_pct: <int>
    error_rate_max_pct: <float>
    check_interval_min: <int>

skills:
  learn: <string|null>
  debug:
    <topic>: <skill>
```

## Init 流程

```
/devflow:init workspace     → 一次性：repos + 基础设施 + baselines
/devflow:init feature <name> → 按需：选 repo 子集 + 创建 dev_worktree + 设 phase
```

## Template Variables

| Variable | Source |
|----------|--------|
| `{vault}` | Top-level `vault` field |
| `{group}` | `devlog.group` |
| `{feature}` | `defaults.active_feature` |
| `{topic}` | Debug topic argument |

## Distribution Format

Benchmark distribution fields use comma-separated key=value pairs:
```
avg=28568.9,p50=21983.0,p75=45631.0,p90=66307.2,p95=74262.9
```
