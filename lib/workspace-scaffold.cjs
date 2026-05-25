'use strict';

const fs = require('fs');
const path = require('path');

const { output, error, parseArgs, expandHome } = require('./core.cjs');
const { configPath, ensureWorkspaceDirs } = require('./workspace-config.cjs');

function quote(value) {
  if (value == null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(String(value));
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeIfAllowed(filePath, content, options, written) {
  const exists = fs.existsSync(filePath);
  if (exists && options.force !== true) {
    written.push({ path: filePath, action: 'skipped', reason: 'exists' });
    return;
  }
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf8');
  written.push({ path: filePath, action: exists ? 'overwritten' : 'created' });
}

function renderConfig(root, name) {
  return [
    'version: 2',
    `workspace: ${quote(root)}`,
    `name: ${quote(name)}`,
    '',
    'defaults:',
    '  track: "default"',
    '  feat: null',
    '  env: "local"',
    '  sync: "local"',
    '  build: "image-build"',
    '  deploy: "preprod"',
    '  deploy_flow: "preprod-validation"',
    '',
    'includes:',
    '  - ".devteam/registry/*.yaml"',
    '  - ".devteam/lanes/*.yaml"',
    '',
    'repos: {}',
    '',
    'builders: {}',
    '',
    'deploy_profiles:',
    '  preprod:',
    '    type: "k8s"',
    '    env: "preprod"',
    '    namespace: null',
    '',
    'workflow:',
    '  phases: ["local-dev", "remote-test", "image-build", "preprod-deploy", "knowledge-capture"]',
    '  source_of_truth: ".devteam/config.yaml plus .devteam/registry and .devteam/lanes"',
    '  mutable_state: ".devteam/state and .devteam/runs"',
    '',
    'knowledge:',
    '  recipes_dir: ".devteam/recipes"',
    '  wiki_dir: ".devteam/wiki"',
    '  skills_dir: ".devteam/skills"',
    '',
  ].join('\n');
}

function renderDefaultEnvironmentsConfig() {
  return [
    'version: 2',
    '',
    'environments:',
    '  local-dev:',
    '    kind: "local_host"',
    '    status: "ready"',
    '    notes: "Local development host. Replace or extend with SSH hosts and K8s clusters as they are chosen."',
    '  remote-dev:',
    '    kind: "ssh_host"',
    '    status: "planned"',
    '    ssh: null',
    '    host: null',
    '    source_root: null',
    '    venv_root: null',
    '    notes: "Fill when a remote source mirror and venv host is chosen."',
    '  preprod-cluster:',
    '    kind: "k8s_cluster"',
    '    status: "planned"',
    '    entry_ssh: null',
    '    namespace_defaults: []',
    '    registry: null',
    '    notes: "Fill when a K8s validation or deployment cluster is chosen."',
    '',
  ].join('\n');
}

function renderDefaultCapabilitiesConfig() {
  return [
    'version: 2',
    '',
    'capability_definitions:',
    '  remote-vllm-venv:',
    '    kind: "ValidationCapability"',
    '    maturity: "template"',
    '    environment_kind: "ssh_host"',
    '    production_gate: false',
    '    requires:',
    '      facts: ["ssh", "source_root", "venv_root"]',
    '    evidence_gate: ["sync", "test", "pre-commit"]',
    '    notes: "Template for source-level validation through a per-track remote source mirror and venv."',
    '  k8s-vllm-dev:',
    '    kind: "ValidationCapability"',
    '    maturity: "template"',
    '    environment_kind: "k8s_cluster"',
    '    production_gate: false',
    '    requires:',
    '      facts: ["entry_ssh", "namespace", "node", "dev_image"]',
    '    evidence_gate: ["doctor", "snapshot"]',
    '    notes: "Template for K8s development validation. Fill cluster and pod details before use."',
    '  image-build:',
    '    kind: "BuildCapability"',
    '    maturity: "template"',
    '    environment_kind: "ssh_host"',
    '    production_gate: true',
    '    requires:',
    '      facts: ["ssh", "registry"]',
    '    evidence_gate: ["image-build"]',
    '    notes: "Template image build contract."',
    '  k8s-deploy:',
    '    kind: "DeploymentCapability"',
    '    maturity: "template"',
    '    environment_kind: "k8s_cluster"',
    '    production_gate: true',
    '    requires:',
    '      facts: ["entry_ssh", "namespace", "image", "manifests", "service_health_check"]',
    '    evidence_gate: ["deploy", "deploy-verify"]',
    '    notes: "Template K8s deployment validation contract."',
    '',
  ].join('\n');
}

function renderDefaultLaneConfig() {
  return [
    'version: 2',
    '',
    'worktrees: {}',
    '',
    'tracks:',
    '  default:',
    '    description: "Active repos/worktrees for the current validation track. Fill this after choosing concrete code targets."',
    '    worktrees: []',
    '',
    'env_profiles:',
    '  local:',
    '    type: "local"',
    '    notes: "Default profile before remote server details are chosen."',
    '  remote-test:',
    '    type: "remote_dev"',
    '    ssh: null',
    '    host: null',
    '    source_dir: null',
    '    venv: null',
    '    strategy: "rsync"',
    '    enabled: false',
    '  image-build:',
    '    type: "remote_dev"',
    '    ssh: null',
    '    host: null',
    '    work_dir: null',
    '    registry: null',
    '    strategy: "recipe"',
    '    enabled: false',
    '  preprod:',
    '    type: "k8s"',
    '    ssh: null',
    '    host: null',
    '    namespace: null',
    '    enabled: false',
    '',
    'build_profiles:',
    '  image-build:',
    '    track: "default"',
    '    env: "image-build"',
    '    registry: null',
    '    image: null',
    '    tag: null',
    '    command: null',
    '    recipe: ".devteam/recipes/image-build-loop.md"',
    '    notes: "Fill after selecting the concrete image recipe."',
    '',
    'deploy_flows:',
    '  preprod-validation:',
    '    profile: "preprod"',
    '    guide: ".devteam/recipes/k8s-preprod-loop.md"',
    '    gateway_recipe: null',
    '    commands: {}',
    '',
  ].join('\n');
}

function workspaceReadme(name) {
  return [
    `# ${name} Devteam Workspace`,
    '',
    'This workspace is organized around lane-owned tracks and shared capability registries. Concrete repos, branches, remote venvs, K8s targets, image build modes, and deploy targets should be added as explicit profiles or instances after they are chosen.',
    '',
    '## Layout',
    '',
    '- `repos/`: local repo checkouts or worktrees. Keep code separate from devteam metadata.',
    '- `artifacts/`: generated build/deploy inputs that are worth keeping with the workspace.',
    '- `.devteam/config.yaml`: thin workspace-level entrypoint with defaults and include lists.',
    '- `.devteam/registry/`: optional shared machine/cluster facts and capability definitions.',
    '- `.devteam/lanes/`: one file per lane/track bundle: worktrees, env, build, validation instances, and deploy instances.',
    '- `.devteam/recipes/`: repeatable command recipes for the real workflow.',
    '- `.devteam/wiki/`: durable notes and decision records.',
    '- `.devteam/skills/`: reusable operational skills extracted from repeated work.',
    '- `.devteam/runs/`: timestamped run snapshots.',
    '- `.devteam/state/`: local mutable state; not durable validation evidence.',
    '',
    '## Intended Loop',
    '',
    '1. Edit code locally in one or more worktrees.',
    '2. Pick the validation or deploy capability for the current track/feature.',
    '3. Sync only the selected change set to the chosen environment.',
    '4. Run validation through a named validation instance.',
    '5. Build a versioned image from a named image profile when the track is ready.',
    '6. Deploy to a pre-production K8s target from a named deploy instance.',
    '7. Promote stable commands and lessons into recipes/wiki/skills.',
    '',
    'Add project-specific build, deploy, and verification commands as explicit recipes only when they become part of the real workflow.',
    '',
  ].join('\n');
}

function recipe(title, body) {
  return [`# ${title}`, '', body.trim(), ''].join('\n');
}

function scaffoldWorkspace(options = {}) {
  const root = path.resolve(expandHome(options.root || process.cwd()));
  const name = options.name || path.basename(root);
  const written = [];
  const cleaned = [];

  mkdirp(root);
  mkdirp(path.join(root, 'repos'));
  mkdirp(path.join(root, 'artifacts'));
  ensureWorkspaceDirs(root);
  writeIfAllowed(configPath(root), renderConfig(root, name), options, written);
  writeIfAllowed(path.join(root, '.devteam', 'registry', 'environments.yaml'), renderDefaultEnvironmentsConfig(), options, written);
  writeIfAllowed(path.join(root, '.devteam', 'registry', 'capabilities.yaml'), renderDefaultCapabilitiesConfig(), options, written);
  writeIfAllowed(path.join(root, '.devteam', 'lanes', 'default.yaml'), renderDefaultLaneConfig(), options, written);
  writeIfAllowed(path.join(root, '.devteam', 'README.md'), workspaceReadme(name), options, written);
  writeIfAllowed(path.join(root, '.devteam', 'profiles', 'README.md'), recipe('Profiles', [
    'Use this directory for optional profile fragments and notes.',
    '',
    'The machine-readable workspace model starts at `.devteam/config.yaml` and may include shared registries plus lane files.',
  ].join('\n')), options, written);
  writeIfAllowed(path.join(root, '.devteam', 'recipes', 'local-dev-loop.md'), recipe('Local Dev Loop', [
    'Purpose: define how local worktrees are selected, inspected, tested, and committed.',
    '',
    'Fill later:',
    '- repo/worktree naming convention',
    '- local test command policy',
    '- commit and push policy',
  ].join('\n')), options, written);
  writeIfAllowed(path.join(root, '.devteam', 'recipes', 'remote-test-loop.md'), recipe('Remote Test Loop', [
    'Purpose: define how local changes move to a remote test server and how validation runs there.',
    '',
    'Fill later:',
    '- remote SSH profile',
    '- remote source directory',
    '- runtime or venv activation',
    '- unit and end-to-end validation commands',
  ].join('\n')), options, written);
  writeIfAllowed(path.join(root, '.devteam', 'recipes', 'image-build-loop.md'), recipe('Image Build Loop', [
    'Purpose: define the exact image build contract once the recipe is chosen.',
    '',
    'Fill later:',
    '- build context location',
    '- base image policy',
    '- image name and versioning policy',
    '- dry-run/build/push/verify commands',
  ].join('\n')), options, written);
  writeIfAllowed(path.join(root, '.devteam', 'recipes', 'k8s-preprod-loop.md'), recipe('K8s Preprod Loop', [
    'Purpose: define how a verified image is deployed to a pre-production k8s target.',
    '',
    'Fill later:',
    '- cluster access profile',
    '- namespace and manifests',
    '- deploy, rollback, and verification commands',
  ].join('\n')), options, written);
  writeIfAllowed(path.join(root, '.devteam', 'recipes', 'knowledge-capture.md'), recipe('Knowledge Capture', [
    'Purpose: keep repeated fixes and operational lessons discoverable.',
    '',
    'Promote notes in this order:',
    '- one-off run details -> `.devteam/runs/`',
    '- repeatable command flow -> `.devteam/recipes/`',
    '- durable explanation or decision -> `.devteam/wiki/`',
    '- reusable agent behavior -> `.devteam/skills/`',
  ].join('\n')), options, written);
  writeIfAllowed(path.join(root, '.devteam', 'wiki', 'index.md'), [
    '# Wiki Index',
    '',
    'Add durable design notes, handoff summaries, and decisions here.',
    '',
    '## Seeds',
    '',
    '- Workspace architecture',
    '- Remote validation environments',
    '- Image versioning policy',
    '- Deployment verification checklist',
    '',
  ].join('\n'), options, written);
  writeIfAllowed(path.join(root, '.devteam', 'skills', 'README.md'), [
    '# Skills',
    '',
    'Add reusable operational skills here after a workflow has repeated enough times to deserve automation.',
    '',
  ].join('\n'), options, written);
  writeIfAllowed(path.join(root, '.devteam', 'runs', 'README.md'), [
    '# Runs',
    '',
    'Generated session snapshots belong here. Keep permanent lessons in recipes/wiki/skills instead.',
    '',
  ].join('\n'), options, written);

  return {
    action: 'workspace_scaffold',
    workspace: root,
    name,
    force: options.force === true,
    files: written,
    cleaned,
    next_action: 'Fill repos/worktrees and environment profiles only after the concrete repo, branch, remote server, build, and deploy choices are made.',
  };
}

function handleWorkspaceScaffold(subcommand, args) {
  const parsed = parseArgs(args || []);
  if (!subcommand || subcommand === 'scaffold') {
    output(scaffoldWorkspace({
      root: parsed.root || null,
      name: parsed.name || null,
      force: parsed.force === true,
    }));
    return;
  }
  if (subcommand === 'onboard' || subcommand === 'context') {
    const { handleWorkspaceOnboarding } = require('./workspace-onboarding.cjs');
    handleWorkspaceOnboarding(subcommand, args);
    return;
  }
  error(`Unknown workspace subcommand: '${subcommand}'. Use: scaffold, onboard, context`);
}

module.exports = {
  handleWorkspaceScaffold,
  scaffoldWorkspace,
};
