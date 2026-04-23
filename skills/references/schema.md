# workspace.yaml + feature config.yaml Schema Reference

核心设计：**Workspace 级（固定）** 和 **Feature 级（动态、多个）** 彻底分离。

文件结构：
```
workspace.yaml                          ← workspace 级配置（clusters/repos/defaults）
.dev/features/<name>/config.yaml        ← 每个 feature 的独立配置（scope/deploy/benchmark）
```

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
# 每个 repo 声明 remotes / baselines / dev_slots
# Feature scope 必须引用 dev_slot（dev_worktree 已移除，使用会报错）

repos:
  <name>:
    # Legacy alias (still accepted): upstream
    # New model: explicit remotes
    remotes:
      official: <git-url|null>
      corp: <git-url|null>
      personal: <git-url|null>

    baselines:
      # Legacy compact form (still accepted):
      # <ref>: <worktree-dir>
      #
      # Recommended object form:
      <baseline-id>:
        id: <string>                 # Stable identity; defaults to map key
        ref: <string>                # Git ref/tag/branch represented by this baseline
        worktree: <worktree-dir>
        read_only: <bool>            # default true

    dev_slots:
      <slot-id>:
        repo: <repo-name>            # default current repo key
        worktree: <worktree-dir>
        baseline_id: <baseline-id>   # optional; links slot to baseline object
        baseline_ref: <ref>          # optional fallback when baseline_id omitted
        sharing_mode: exclusive | shared
        owner_features: [<feature>, ...]
        # Runtime semantics:
        # - pipeline init blocks when two active runs target the same worktree
        # - sharing_mode: shared exempts conflict only when both features are listed in owner_features
        # - --allow-slot-conflict bypasses remaining conflicts explicitly

# ═══════════════════════════════════════
# 默认值
# ═══════════════════════════════════════

defaults:
  active_cluster: <string>          # Which cluster to use by default
  features:                         # Explicit feature name list (managed by CLI — do not edit manually)
    - <name>                        # Each entry must have a corresponding .dev/features/<name>/config.yaml
  tuning:                           # Optional tunable parameters (loader fills missing keys with defaults)
    regression_threshold: 20        # Benchmark regression alert threshold (%)
    max_optimization_loops: 3       # Max vLLM-Opter → re-plan → re-verify iterations
    max_task_retries: 2             # code max retries per failed task
    deploy_timeout: 300             # Pod readiness timeout (seconds)
    deploy_poll_interval: 15        # Pod status poll interval (seconds)
    build_history_limit: 5          # Number of build history entries in context
    commit_format: "feat({feature}): {title}"  # Commit message template

# Workspace loading is fail-fast:
# - build_server/devlog/observability must be mappings or null
# - repos must be a mapping; each repos.<name> must be a mapping
# - repos.<name>.remotes must be a mapping or null
# - repos.<name>.baselines must be a mapping or null
# - repos.<name>.dev_slots must be a mapping or null
# - clusters must be a mapping; each clusters.<name> must be a mapping
# - clusters.<name>.hardware and network must be mappings or null
# - missing build_server/devlog/observability => normalized to {}
# - missing repos.<name>.remotes/baselines/dev_slots => normalized to {}
# - missing clusters.<name>.hardware/network => normalized to {}

# ═══════════════════════════════════════
# FEATURE 级 — .dev/features/<name>/config.yaml
# 每个 feature 独立文件，flat 结构（无 features: 嵌套）
# ═══════════════════════════════════════

# （以下字段直接在 config.yaml 顶层，无嵌套）
description: <string>
created: <YYYY-MM-DD>

scope:                          # 涉及哪些 repo
  # Empty scope may be {} or null
  <repo-name>:
    dev_slot: <slot-id|null>    # Preferred: reference repos.<name>.dev_slots.<slot-id>
    base_ref: <tag|commit>      # Optional override; otherwise derived from slot baseline
    # dev_worktree is removed. Use dev_slot instead.
    build_type: <string>        # Optional: e.g. "wheel"

# 生命周期状态
phase: spec | plan | code | review | build | ship | verify | vllm-opt | test | debug | dev | completed
# If omitted, loader normalizes phase to spec
current_tag: <string>           # Latest built image tag
base_image: <string|null>       # Base Docker image
cluster: <string>               # Override cluster for this feature

# Config loading is fail-fast:
# - invalid phase => error
# - scope must be a mapping or null
# - each scope.<repo> entry must be a mapping
# - ship/build/deploy/benchmark/verify/invariants must be mappings or null
# - unsupported ship.strategy => error
# - missing build_history => normalized to []
# - missing ship/build/deploy/benchmark/verify => normalized to {}
# - missing hooks arrays => normalized to []

    # Feature-specific 配置 (all optional)
    invariants:
      source_restriction: dev_worktree_only | any
      build_compat_check: <bool>
      pre_deploy_node_check: <bool>

    hooks:
      pre_build: [<command|string|object>, ...]
      post_build: [<command|string|object>, ...]
      pre_deploy: [<command|string|object>, ...]
      post_deploy: [<command|string|object>, ...]
      post_verify: [<command|string|object>, ...]
      learned:
        - name: <string>
          trigger: pre_build | post_build | pre_deploy | post_deploy | post_verify
          added: <YYYY-MM-DD>
          command: <string>             # Preferred executable command
          rule: <string>                # Backward-compatible alias; treated as command if command missing
          cwd: <path>                   # Optional; relative to workspace if not absolute
          env:
            <KEY>: <value>              # Optional extra env vars

    # Runtime hook execution contract (single path):
    #   node lib/devteam.cjs hooks run --feature <name> --phase <phase>
    #
    # Runner behavior:
    # - deterministic order: hooks.<phase>[] first, then hooks.learned[] filtered by trigger == <phase>
    # - phase blocking:
    #   - pre_build:  blocking
    #   - post_build: non-blocking
    #   - pre_deploy: blocking
    #   - post_deploy: non-blocking
    #   - post_verify: non-blocking
    # - environment injected to every hook command:
    #   DEVTEAM_FEATURE
    #   DEVTEAM_PHASE
    #   DEVTEAM_TRIGGER
    #   DEVTEAM_WORKSPACE
    #   DEVTEAM_RUN_PATH
    #   DEVTEAM_REPOS
    #   (plus per-repo DEVTEAM_REPO_<REPO>_{DEV_WORKTREE,BASE_WORKTREE,BASE_REF})

    ship:
      strategy: k8s | bare_metal     # Ship strategy. k8s uses kubectl, bare_metal uses SSH+rsync.
                                      # Auto-derived when deploy.active_profile is set (preferred).
                                      # Explicit value conflicts with active_profile derivation → loader error.
      metal:                          # Required when strategy == bare_metal
        host: <ssh-alias-or-user@host>    # SSH target
        venv: <path>                      # Remote venv path (e.g. /opt/pd-venv)
        code_dir: <path>                  # Remote source root (e.g. /opt/dynamo)
        profile: <string>                 # rapid-test profile name (e.g. rtx5090-lab)
        # config: <removed>               # start.sh config is user-provided at runtime, not managed here
        build_mode: <string>              # DEPRECATED for build stage — use top-level build.mode instead.
                                           # If present, loader copies into build.mode when build.mode is absent,
                                           # then mirrors back onto ship.metal.build_mode for bare_metal (single source: build.mode).
                                           # Valid: skip | sync_only | source_install | docker (default sync_only via build.mode when bare_metal)
        sync_script: <relative-path>      # Local sync script (e.g. .dev/rapid-test/sync.sh)
        start_script: <relative-path>     # Local start script (e.g. .dev/rapid-test/start.sh)
        setup_script: <relative-path>     # Optional setup script
        service_url: <host:port>          # Health/smoke endpoint
        deploy_profile: <string>          # Optional: key in deploy.profiles — shipper dispatches to
                                           #   ship_bare_metal_venv | ship_bare_metal_docker | ship_k8s
                                           #   (from workspace build/image-build.sh, sourced)
        log_paths:                        # Optional remote log locations
          decode: <path>
          prefill: <path>
      # When strategy == bare_metal:
      # - build stage behavior is controlled by effective build.mode (orchestrator --build-mode overrides
      #   feature build.mode; do not use ship.metal.build_mode as the authority — it is legacy + mirrored):
      #   skip (no build), sync_only (sync.sh only), source_install (sync + optional setup), docker
      # - ship stage uses SSH: stop → sync → start → health poll
      # - verify stage uses SSH for log checks instead of kubectl logs
      # - k8s-specific fields (deploy.yaml_file, deploy.dgd_name, etc.) are ignored

    build:
      mode: <string>                # Authoritative build-stage mode: skip | sync_only | source_install | docker
                                     # (orchestrator --build-mode overrides this). For bare_metal, defaults to sync_only.
                                     # Legacy ship.metal.build_mode is merged into mode when mode is omitted.
      recipe: <string>              # Optional: e.g. dynamo+vllm+pegaflow — when set, devteam:builder runs
                                     #   ./build/image-build.sh build ... --depth auto (workspace driver)
      image_tag: <string>           # Optional: docker image tag for pipeline (e.g. kimi-vllm-fe-v6).
                                     #   Also overridable via task prompt "Image tag:" or DEVTEAM_IMAGE_TAG
      image_name: <string>          # Docker image name (defaults to feature name if omitted)
      commands:
        default: <string|path>
        <variant>: <string|path>
      env:
        <KEY>: <value>

    deploy:
      active_profile: <string>    # PREFERRED: single-field switch — key in deploy.profiles. Loader derives
                                     # ship.strategy and sets deploy.deploy_profile (k8s) or ship.metal.deploy_profile
                                     # (bare_metal_venv | bare_metal_docker). Conflicts with an explicit ship.strategy → error.
                                     # Future: shipper will make PROFILE_SHIP primary; LEGACY_*_DEPLOY paths will be
                                     # demoted to fallback. See RELEASE_NOTES.md "Design Backlog".
      deploy_profile: <string>      # Optional: key into deploy.profiles (used when ship.strategy=k8s and
                                     #   top-level yaml_file is not used)
      profiles:                       # Optional: named deploy targets (bare_metal_venv | bare_metal_docker | k8s)
        <name>:
          type: bare_metal_venv | bare_metal_docker | k8s
          host: <string>             # bare_metal: SSH host (rapid-test profile still from ship.metal.profile)
          start_cmd: <string>        # bare_metal_venv: multiline
          stop_cmd: <string>
          health_url: <string>
          env_file: <path>
          run_cmd: <string>          # bare_metal_docker: optional; ship helper may use fixed run
          yaml: <path>               # k8s: relative to workspace
          namespace: <string>
          cluster: <string>
          image_placeholder: <string>
          resource_kind: <string>
          dgd_name: <string>
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
      mtb_cmd: <string>              # Benchmark command template. Supports substitution variables:
                                     #   {frontend_svc_label} → benchmark.frontend_svc_label
                                     #   {svc_url}            → deploy.service_url
                                     #   {arrival_rate}       → benchmark.standard.arrival_rate
                                     #   {total_sessions}     → benchmark.standard.total_sessions
                                     #   {dataset_path}       → benchmark.dataset_path
                                     #   {api_key}            → benchmark.api_key
                                     #   {output_dir}         → benchmark.output_dir
                                     # Example: "python run_mtb.py --svc {frontend_svc_label} --rate {arrival_rate} --sessions {total_sessions} --dataset {dataset_path}"
      mtb_dir: <path>               # Working directory for mtb_cmd (default: ".")
      dataset_path: <path>
      model_path: <path>
      api_key: <string>
      frontend_svc_label: <string>  # Service URL/label injected into {frontend_svc_label}
      output_dir: <string>           # Results directory (default: bench-results)
      standard:
        arrival_rate: <float>        # Injected into {arrival_rate}
        total_sessions: <int>        # Injected into {total_sessions}
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
      strategy: k8s | bare_metal       # current implementation supports both strategies
      # ... existing build/deploy config fields

    build_history:                     # Last N entries (truncated by tuning.build_history_limit)
      - tag: <string>                  # Image tag (e.g. "v8")
        date: <YYYY-MM-DD>
        parent_image: <string|null>    # Parent image actually used for this build
        fallback_base_image: <string|null>  # Configured feature.base_image at build time
        resulting_tag: <string>        # Result tag produced by this build
        resulting_image: <string|null> # Full result image ref if registry + image_name known
        changes: <string>              # One-line summary of what changed
        mode: <string>                 # fast | rust | full
        base: <string|null>            # Legacy alias for parent_image (kept for compatibility)
        cluster: <string>              # Cluster deployed to
        note: <string>                 # Optional free-form note
        run_id: <string|null>          # RUN.json run_id if available
        source_refs:
          - repo: <repo-name>
            start_branch: <branch|null>
            start_head: <sha|null>
            dev_worktree: <absolute-path|null>
          # Legacy compact string form [<repo@sha>, ...] is still readable for backward compatibility
        source_repos: [<repo>, ...]    # Participating repos from RUN.json

# Build history is written via CLI — NEVER manually edit build_history or current_tag:
#   node devteam.cjs build record --feature <name> --tag <tag> --changes "<summary>" \
#     [--run-path .dev/features/<name>/RUN.json] \
#     [--parent-image <image>] [--fallback-base-image <image>] [--result-image <image>] \
#     [--mode fast|rust|full] [--cluster <name>] [--note "<note>"]
#
# This also writes the permanent (never-truncated) record to:
#   .dev/features/<name>/build-manifest.md   ← canonical build chain, full history

# ═══════════════════════════════════════
# WORKSPACE 级 (optional sections)
# ═══════════════════════════════════════

# Used by: /devteam grafana  (deploys Prometheus remote_write + Grafana dashboards + alert rules)
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

```

## Init 流程

```
/devteam init workspace      → 新建 workspace.yaml（workspace 级配置）
/devteam init feature <name> → 新建 .dev/features/<name>/config.yaml + 注册到 defaults.features
/devteam init bare-metal --feature <name> [--host user@ip] [--profile name]
                            → 生成 .dev/rapid-test 内置脚手架并可自动写入 ship.metal 默认配置

```

## Template Variables

| Variable | Source |
|----------|--------|
| `{vault}` | Top-level `vault` field |
| `{group}` | `devlog.group` |
| `{feature}` | Current command/session feature selection |
| `{topic}` | Debug topic argument |

## Distribution Format

Benchmark distribution fields use comma-separated key=value pairs:
```
avg=28568.9,p50=21983.0,p75=45631.0,p90=66307.2,p95=74262.9
```
