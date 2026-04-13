---
name: devteam:cluster
description: Manage Kubernetes clusters — add, use, list
argument-hint: "<add|use|list> [name]"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - AskUserQuestion
---
<objective>
Manage cluster profiles in .dev.yaml.
</objective>

<context>
$ARGUMENTS
</context>

<process>
**Step 1**: Discover CLI tool and load config:
```bash
DEVFLOW_BIN=$(ls ~/.claude/plugins/cache/devteam/devteam/*/lib/devteam.cjs 2>/dev/null | head -1)
INIT=$(node "$DEVFLOW_BIN" init cluster)
```

If `$INIT` contains `"feature": null` and `"available_features"`, prompt the user to select a feature with AskUserQuestion, then re-run: `INIT=$(node "$DEVFLOW_BIN" init cluster --feature $SELECTED)`

**Step 2**: Execute:
Parse action (add/use/list). LIST: show clusters + active. USE: switch active_cluster. ADD: interactive cluster config collection — collect and save to .dev.yaml:
  - ssh, namespace, safety (normal|prod)
  - hardware: gpu, rdma, nvlink, min_driver, expected_tp
  - network: socket_ifname, ucx_tls (required for RDMA/UCX clusters)
</process>
