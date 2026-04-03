# Workflow: build

<purpose>Orchestrate container image builds with hook execution, invariant checks, incremental tag chain enforcement, and state updates.</purpose>
<core_principle>CRITICAL: BASE_IMAGE must be the current_tag (incremental chain), NOT the official base image. Each build is an incremental layer on top of the previous one.</core_principle>

<process>
<step name="INIT" priority="first">
Initialize workflow and load build configuration.

```bash
# Auto-discover devflow CLI (marketplace or local install)
DEVFLOW_BIN=$(ls ~/.claude/plugins/cache/devflow/devflow/*/skills/my-dev/bin/my-dev-tools.cjs 2>/dev/null | head -1)

INIT=$(node "$DEVFLOW_BIN" init build)
WORKSPACE=$(echo "$INIT" | jq -r '.workspace')
FEATURE=$(echo "$INIT" | jq -r '.feature.name')
```

Extract build config:
```bash
CURRENT_TAG=$(echo "$INIT" | jq -r '.feature.current_tag')
BASE_IMAGE=$(echo "$INIT" | jq -r '.feature.base_image')
REGISTRY=$(echo "$INIT" | jq -r '.build_server.registry')
BUILD_COMMANDS=$(echo "$INIT" | jq -r '.build.commands')
BUILD_ENV=$(echo "$INIT" | jq -r '.build.env')
REPOS=$(echo "$INIT" | jq -r '.repos | keys[]')
```

Gate: `build.commands` must be configured. If not, abort: "No build commands configured in .dev.yaml"
</step>

<step name="SPECIFICITY_GATE">
Check prerequisites before building.

- `CURRENT_TAG` or `BASE_IMAGE` must exist to establish the incremental chain. If both null: "No base image or current tag. Is this the first build? Set `base_image` in feature config."
- `REGISTRY` must be non-empty. If null: "No registry configured in `build_server.registry`."
- At least one repo must have uncommitted or ahead commits. If all repos are clean: "No changes detected. Nothing to build."

If `$ARGUMENTS` contains `--force`, skip change detection check.
</step>

<step name="VALIDATE">
Run all pre-build checks: hooks, learned rules, and invariants.

1. Execute `.hooks.pre_build` checks (compat, uncommitted, etc.)
2. Execute `.hooks.learned` rules where `trigger == "pre_build"`
3. Verify `source_restriction`: if `dev_worktree_only`, all sources must be from registered dev_worktrees
4. Check uncommitted changes in dev_worktrees — warn but allow override

Gate: Hook/invariant violations abort. Uncommitted changes warn with override option.
</step>

<step name="SUGGEST_TAG">
Generate a tag suggestion and confirm with user.

```bash
# Auto-suggest tag: MMDD-<keyword>
DATE_PREFIX=$(date +%m%d)
# Derive keyword from recent changes
KEYWORD=$(git -C "$WORKSPACE/$FIRST_DEV_WORKTREE" log -1 --format=%s | head -c 20 | tr ' ' '-')
SUGGESTED_TAG="${DATE_PREFIX}-${KEYWORD}"
```

If user provided a tag argument, use that instead.

Present build summary:
```
Build Summary:
  Base image: $REGISTRY/$BASE_IMAGE:$CURRENT_TAG
  New tag: $SUGGESTED_TAG
  Build variant: $VARIANT (default if not specified)
  Command: $BUILD_COMMAND

  Repos included:
    <repo>: <dev_worktree> (<N files changed>)

Proceed? (yes / change tag / abort)
```

CRITICAL: Verify BASE_IMAGE uses `current_tag`, not the official base. If `current_tag` is empty, this is the first build -- use `base_image` from config.
</step>

<step name="EXECUTE_BUILD">
Run the build command in background.

```bash
# Set environment variables
export BASE_IMAGE="$REGISTRY/$BASE_IMAGE_NAME:$CURRENT_TAG"
export NEW_TAG="$CONFIRMED_TAG"

# Set per-repo env vars
for repo in $REPOS; do
  WORKTREE=$(echo "$INIT" | jq -r ".repos.$repo.dev_worktree")
  BASE_REF=$(echo "$INIT" | jq -r ".repos.$repo.base_ref")
  export "${repo^^}_WORKTREE=$WORKTREE"
  export "${repo^^}_BASE_REF=$BASE_REF"
done

# Set extra env from config
for key in $(echo "$BUILD_ENV" | jq -r 'keys[]? // empty'); do
  export "$key=$(echo "$BUILD_ENV" | jq -r ".$key")"
done

# Execute build command (background for long builds)
BUILD_CMD=$(echo "$BUILD_COMMANDS" | jq -r ".$VARIANT // .default")
bash -c "$BUILD_CMD"
```

Execute with `run_in_background=true` for long builds.
Monitor: check build output for errors.

Gate: Build command must exit 0. Non-zero exit aborts and shows logs.
</step>

<step name="POST_BUILD_HOOKS">
Run post-build hooks (warnings only, no abort).

Execute post_build checks from `.hooks.post_build` in .dev.yaml:
For each hook in `.hooks.post_build`, perform the check inline:
- Read the hook name and perform the corresponding verification
- Post-build hooks are non-blocking: warn on failure but do not abort
</step>

<step name="UPDATE_STATE">
Update .dev.yaml with new build info and checkpoint.

Update `.dev.yaml`:
- Set `project.current_tag` to `$CONFIRMED_TAG`
- Set `project.phase` to `build`
- Append to `project.build_history`:
  ```yaml
  - tag: <CONFIRMED_TAG>
    date: <TODAY>
    changes: <summary_of_changes>
    mode: <VARIANT>
    base: <CURRENT_TAG>
    cluster: <active_cluster>
  ```

Checkpoint (@references/shared-patterns.md#checkpoint):
```bash
node "$DEVFLOW_BIN" checkpoint \
  --action "build" \
  --summary "Built $CONFIRMED_TAG (base: $CURRENT_TAG, mode: $VARIANT)"
```

Output:
```
Build complete: $CONFIRMED_TAG
Base: $CURRENT_TAG
Mode: $VARIANT

Next: /devflow deploy
```
</step>

<step name="REFLECTION">
@references/shared-patterns.md#experience-sink

Detection criteria: build non-zero exit (even if retried), step retry, hook warnings, learned hook override
Target file: `docker-build-lessons.md`
Context fields: `tag=$CONFIRMED_TAG, base=$CURRENT_TAG, mode=$VARIANT`
</step>
</process>
