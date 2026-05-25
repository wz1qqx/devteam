---
name: devteam:image
description: Image planning and evidence recording for a track or feature
argument-hint: "<plan|prepare|record> [--root <path>] [--set <track>] [--feat <feat>] [--profile <build-profile>] [--run <id>] [--output <path>] [--image <ref>] [--digest <digest>]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
---
<objective>
Show the build contract, target image, source heads, gates, and patch safety before an image build; prepare dry-run build contexts; record completed image build evidence.
</objective>

<context>
$ARGUMENTS
</context>

<process>
**Step 1**: Discover the devteam CLI:
```bash
DEVTEAM_BIN="${HOME}/.claude/plugins/marketplaces/devteam/lib/devteam.cjs"
[ -f "$DEVTEAM_BIN" ] || DEVTEAM_BIN=$(ls ~/.claude/plugins/cache/devteam/devteam/*/lib/devteam.cjs 2>/dev/null | head -1)
[ -n "$DEVTEAM_BIN" ] || { echo "ERROR: devteam.cjs not found" >&2; exit 1; }
```

If no `--root` is provided, use the current workspace or nearest parent containing `.devteam/config.yaml`. Do not select a global active track; ask the user to choose a track or pass `--set <track>` when the command needs one.

**Step 2**: Execute:
Run `node "$DEVTEAM_BIN" image plan $ARGUMENTS` unless the user explicitly asks for prepare or record. Build profile selection comes from the track; --feat narrows source_heads and patch inputs to one feature worktree. Display mode, builder, target image, source_heads, recipe, strategy, gates, missing fields, unsafe_patch_files, notes, and next_action. Treat command as optional because new build profiles are contracts first. `image prepare` may materialize a local .devteam/image-contexts context but must not run Docker or push images. Do not execute remote builds unless the user explicitly asks. Use image record after a build completes to update events.jsonl and README.md.
</process>
