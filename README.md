# devteam

[![v2.2.2](https://img.shields.io/badge/version-2.2.2-orange)](https://github.com/wz1qqx/devteam)

`devteam` is a lightweight workspace control layer for multi-repo development.
It helps an agent or human session understand the current workspace, choose a
track and optional feature, sync local worktree changes to a remote development
host, record remote venv validation, plan image builds, and capture
pre-production deployment evidence.

The current architecture uses a thin `.devteam/config.yaml` entrypoint, shared
environment/capability registries, and lane-owned track files. Reusable
capabilities such as `vllm-opt` live on as independent skills instead of being
mixed into workspace recipes.

## Daily Model

The normal workflow is:

1. Open a devteam-managed workspace.
2. Ask for workspace context or the devteam console.
3. Choose a track and optional feature for the current session.
4. Start or continue a run for that track/feature scope.
5. Inspect local worktrees and sync code changes to the remote dev host.
6. Validate in the configured remote venv and record test evidence.
7. Review image build plans and record completed image evidence.
8. Review deployment plans and record pre-production verification evidence.
9. Publish validated branches when the run gate is ready.

Tracks and features are session-scoped. `defaults.track` and optional
`defaults.feat` in `.devteam/config.yaml` are only default hints; they must not
be treated as global active state when multiple sessions may be open.

## Core Concepts

- **Workspace**: a directory containing `.devteam/config.yaml`, optional
  `.devteam/registry/*.yaml`, and lane files under `.devteam/lanes/`.
- **Environment**: a fixed machine or cluster inventory entry, such as an SSH
  host, K8s cluster, namespace, node, registry, cache root, or model root.
- **Capability Definition**: a CRD-like standard for a reusable validation,
  build, or deploy method, such as `remote-vllm-venv`, `k8s-vllm-dev`, image
  build modes, or `k8s-deploy`.
- **Validation/Deploy Instance**: a CR-like binding of track or feature,
  capability, environment, and lane-local execution profile.
- **Track**: one stable development lane. It owns the reusable worktrees,
  env/sync/build profiles, validation/deploy instances, and shared validation
  environment for features under that lane.
- **Feature**: an incremental branch/worktree selection nested under a track.
  A feature reuses the track's environment and capability choices while
  narrowing commands to its own worktrees with `--feat <feat>`.
- **Run**: an auditable directory under `.devteam/runs/<run-id>/` containing
  session metadata, evidence events, a generated README, and `runtime.sh` with
  the track-scoped proxy, work directory, K8s, and worktree path exports.
- **Presence**: lightweight soft-lock hints under `.devteam/presence/` for
  concurrent sessions. Presence never blocks work by itself.
- **Evidence**: recorded facts such as sync, env-doctor, env-refresh, test,
  image-build, deploy, deploy-verify, and publish.
- **Skill**: reusable Codex skill folders managed separately from wiki/recipe
  knowledge.

## Tracks And Features

A track is the stable lane. It owns the shared remote venv, K8s dev validation
instance, env/sync/build/deploy execution profiles, capability bindings, and
any base/integration worktrees. Features live under that track and select only
the incremental feature worktrees. This lets multiple feature branches under
the same base commit reuse one development and validation environment.

```yaml
defaults:
  track: base-track
  feat: feat-a

worktrees:
  repo_a__base:
    repo: repo-a
    path: repos/repo-a
    branch: base
    base_ref: base-v1
    sync:
      profile: remote-base

  repo_a__feat_a:
    repo: repo-a
    path: worktrees/feat-a/repo-a
    branch: feat/a
    base_ref: base-v1
    sync:
      profile: remote-base
      remote_path: /remote/features/feat-a/repo-a

tracks:
  base-track:
    env: remote-base
    sync: remote-base
    build: base-track-image
    deploy: preprod
    deploy_flow: base-track-preprod
    validation: base-track-remote-venv
    worktrees: [repo_a__base]
    features:
      feat-a:
        aliases: [a]
        worktrees: [repo_a__feat_a]
```

Commands use `--set <track>` for the reusable lane and `--feat <feat>` for the
incremental branch:

```bash
node lib/devteam.cjs remote-loop start --root "$PWD" --set base-track --feat feat-a --text
node lib/devteam.cjs sync plan --root "$PWD" --set base-track --feat feat-a
node lib/devteam.cjs image plan --root "$PWD" --set base-track --feat feat-a
```

If a track image profile points at the base worktree, devteam maps that profile
input to the selected feature worktree by matching the repository for the
current `--feat` selection. The track-owned profile stays shared.

## Agent Entry Points

For a compact agent-facing workspace context:

```bash
node lib/devteam.cjs workspace context --root "$PWD" --for codex --text
```

For the track picker:

```bash
node lib/devteam.cjs track list --root "$PWD" --active-only --text
```

For selected-track context:

```bash
node lib/devteam.cjs track context --root "$PWD" --set "<track>" --text
node lib/devteam.cjs track context --root "$PWD" --set "<track>" --feat "<feat>" --text
```

For a one-screen status view:

```bash
node lib/devteam.cjs status --root "$PWD" --set "<track>"
node lib/devteam.cjs status --root "$PWD" --set "<track>" --feat "<feat>"
```

For a session handoff before a context switch:

```bash
node lib/devteam.cjs session handoff --root "$PWD" --set "<track>" --text
node lib/devteam.cjs session handoff --root "$PWD" --set "<track>" --feat "<feat>" --text
```

## Onboarding Files

Generate project-local agent instructions for any devteam workspace:

```bash
node lib/devteam.cjs workspace onboard --root "$PWD" --write --text
```

Check that the onboarding files and skills are ready:

```bash
node lib/devteam.cjs doctor agent-onboarding --root "$PWD" --text
```

Generated files:

- `AGENTS.md`
- `CLAUDE.md`
- `README.devteam.md`

These files are derived from `templates/onboarding/` and should teach
Claude/Codex how to work in the workspace without relying on repository-specific
memory.

## Primary CLI Surface

- `workspace scaffold|onboard|context`
- `track list|status|context|bind|use`
- `presence list|touch|clear`
- `session start|snapshot|record|status|handoff|list|lint|archive-plan|archive|supersede-plan|supersede-stale|close|supersede|reopen`
- `status`
- `doctor [agent-onboarding]`
- `ws status|materialize|publish-plan|publish`
- `env list|show|environments|doctor|runtime|refresh`
- `capability list|show`
- `validate list|plan`
- `sync plan|apply|status`
- `remote-loop plan|start|doctor|refresh|sync|record-test|status`
- `image plan|prepare|record`
- `deploy list|plan|record|verify-record`
- `skill list|status|lint|install`
- `knowledge list|search|lint|capture`

Command metadata lives in `commands/devteam/_registry.yaml`. Generated command
docs live in `commands/devteam/*.md`.

## Repository Map

- `lib/devteam.cjs`: CLI router.
- `lib/workspace-scaffold.cjs`: `.devteam` workspace layout creation.
- `lib/workspace-onboarding.cjs`: generated agent onboarding and dynamic context.
- `lib/track-profile.cjs`: track listing, context, aliases, and session binding.
- `lib/session-manager.cjs`: run sessions, evidence, gates, lifecycle cleanup, and handoff.
- `lib/presence.cjs`: concurrent session presence hints.
- `lib/workspace-inventory.cjs`: local worktree status and publish planning.
- `lib/env-profile.cjs`: remote/k8s environment profile doctor and refresh.
- `lib/runtime-context.cjs`: effective env/profile/worktree runtime exports for
  sessions, validation plans, and deploy plans.
- `lib/capability-registry.cjs`: environment/capability/validation instance registry and read-only validation plans.
- `lib/sync-plan.cjs`: local-to-remote sync planning and execution.
- `lib/action-plan.cjs`: image/deploy instance planning, image/deploy planning, and evidence gates.
- `lib/skill-manager.cjs`: skill discovery, lint, and installation.
- `lib/knowledge-manager.cjs`: lightweight recipes/wiki/skills knowledge layer.
- `skills/devteam-console`: one-shot workspace console skill.
- `skills/devteam-status`: compact workspace/run status skill.
- `templates/onboarding`: generated `AGENTS.md`, `CLAUDE.md`, and `README.devteam.md`.
- `tests/workspace-runtime.test.cjs`: current broad regression suite for the
  lightweight workspace model.

## Validation

Useful checks while changing devteam:

```bash
node tests/workspace-runtime.test.cjs
node tests/command-generation.test.cjs
node tests/release-hygiene.test.cjs
node lib/devteam.cjs skill lint --root <workspace-root> --text
node lib/devteam.cjs doctor agent-onboarding --root <workspace-root> --text
node bin/check-workspace-acceptance.cjs --root <workspace-root>
git diff --check
```

For application workspace changes, run the smallest meaningful validation for
the selected track first, then record the result as run evidence.
