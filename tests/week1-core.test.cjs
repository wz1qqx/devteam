'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { DevteamError, error: throwCoreError } = require('../lib/core.cjs');

const CLI = path.resolve(__dirname, '..', 'lib', 'devteam.cjs');

function runCli(cwd, args) {
  const stdout = execFileSync('node', [CLI, ...args], {
    cwd,
    encoding: 'utf8',
  });
  return JSON.parse(stdout);
}

function runCliError(cwd, args) {
  try {
    execFileSync('node', [CLI, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    return err.stderr;
  }
  throw new Error(`Expected command to fail: ${args.join(' ')}`);
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function createWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week1-'));
  const workspaceYaml = [
    'schema_version: 2',
    `workspace: ${root}`,
    'defaults:',
    '  active_cluster: dev',
    '  features:',
    '    - feat-a',
    '    - feat-b',
    'clusters:',
    '  dev:',
    '    namespace: dev-ns',
    'repos:',
    '  repo-a:',
    '    upstream: https://example.com/repo-a.git',
    '    baselines:',
    '      main: repo-a-base',
    '    dev_slots:',
    '      default:',
    '        worktree: repo-a-dev',
    '        baseline_id: main',
    '        sharing_mode: shared',
    '        owner_features:',
    '          - feat-a',
    '          - feat-b',
  ].filter(Boolean).join('\n') + '\n';

  writeFile(path.join(root, 'workspace.yaml'), workspaceYaml);
  writeFile(
    path.join(root, '.dev', 'features', 'feat-a', 'config.yaml'),
    [
      'description: Feature A',
      'phase: spec',
      'scope:',
      '  repo-a:',
      '    base_ref: main',
      '    dev_slot: default',
      'current_tag: null',
      'base_image: null',
    ].join('\n') + '\n'
  );
  writeFile(
    path.join(root, '.dev', 'features', 'feat-b', 'config.yaml'),
    [
      'description: Feature B',
      'phase: plan',
      'scope:',
      '  repo-a:',
      '    base_ref: main',
      '    dev_slot: default',
      'current_tag: null',
      'base_image: null',
    ].join('\n') + '\n'
  );

  return root;
}

function testInitClusterWithoutActiveFeature() {
  const root = createWorkspace();
  const result = runCli(root, ['init', 'cluster']);

  assert.strictEqual(result.feature, null);
  assert.deepStrictEqual(result.available_features, ['feat-a', 'feat-b']);
  assert.strictEqual(result.workspace, root);
  assert.strictEqual(result.cluster.name, 'dev');
  assert.strictEqual(result.cluster.namespace, 'dev-ns');
  assert.ok(result.all_clusters.dev);
}

function testInitStatusWithoutActiveFeature() {
  const root = createWorkspace();
  const result = runCli(root, ['init', 'status']);

  assert.strictEqual(result.feature, null);
  assert.deepStrictEqual(result.available_features, ['feat-a', 'feat-b']);
  assert.deepStrictEqual(result.feature_state, {});
  assert.deepStrictEqual(result.build_history, []);
  assert.strictEqual(result.cluster.name, 'dev');
}

function testStateUpdateAllowsEmptyString() {
  const root = createWorkspace();
  const result = runCli(root, ['state', 'update', 'completed_stages', '', '--feature', 'feat-a']);
  const statePath = path.join(root, '.dev', 'features', 'feat-a', 'STATE.md');
  const content = fs.readFileSync(statePath, 'utf8');

  assert.strictEqual(result.field, 'completed_stages');
  assert.strictEqual(result.value, '');
  assert.match(content, /^phase: spec$/m);
  assert.match(content, /^completed_stages: ""$/m);
  assert.doesNotMatch(content, /^current_feature:/m);
  assert.doesNotMatch(content, /^## Decisions$/m);
  assert.doesNotMatch(content, /^## Blockers$/m);
  assert.doesNotMatch(content, /^## Metrics$/m);
}

function testStateUpdateStripsLegacyStateArtifacts() {
  const root = createWorkspace();
  const statePath = path.join(root, '.dev', 'features', 'feat-a', 'STATE.md');
  writeFile(
    statePath,
    [
      '---',
      'phase: spec',
      'current_feature: feat-a',
      'feature_stage: code',
      '---',
      '',
      '## Position',
      'Currently working on: legacy state',
      'Next step: clean it up',
      '',
      '## Decisions',
      '| ID | Decision | Rationale | Date | Feature |',
      '|----|----------|-----------|------|---------|',
      '| D-01 | old | stale | 2026-01-01 | feat-a |',
      '',
      '## Blockers',
      '| ID | Blocker | Type | Status | Workaround |',
      '|----|---------|------|--------|------------|',
      '| B-01 | old blocker | infra | active | wait |',
      '',
      '## Metrics',
      '| Feature | Spec | Plan | Exec | Review | Duration |',
      '|---------|------|------|------|--------|----------|',
    ].join('\n') + '\n'
  );

  runCli(root, ['state', 'update', 'last_activity', '2026-04-16T00:00:00.000Z', '--feature', 'feat-a']);
  const content = fs.readFileSync(statePath, 'utf8');

  assert.doesNotMatch(content, /^current_feature:/m);
  assert.doesNotMatch(content, /^## Decisions$/m);
  assert.doesNotMatch(content, /^## Blockers$/m);
  assert.doesNotMatch(content, /^## Metrics$/m);
  assert.match(content, /^feature_stage: code$/m);
  assert.match(content, /^last_activity: \"2026-04-16T00:00:00.000Z\"$/m);
}

function testStateCommandsRequireFeatureSelectionForMultiFeatureWorkspace() {
  const root = createWorkspace();

  const getError = runCliError(root, ['state', 'get']);
  const updateError = runCliError(root, ['state', 'update', 'feature_stage', 'review']);

  assert.match(getError, /No feature specified\. Use --feature <name>\. Available: feat-a, feat-b/);
  assert.match(updateError, /No feature specified\. Use --feature <name>\. Available: feat-a, feat-b/);
}

function testFeaturesSwitchSubcommandRemoved() {
  const root = createWorkspace();
  const error = runCliError(root, ['features', 'switch', 'feat-b']);
  assert.match(error, /Unknown features subcommand: switch\. Use: list, delete/);
}

function testStateUpdatePhaseAcceptsVerifyWhenFeatureSpecified() {
  const root = createWorkspace();
  const result = runCli(root, ['state', 'update', 'phase', 'verify', '--feature', 'feat-a']);
  const featureConfig = fs.readFileSync(path.join(root, '.dev', 'features', 'feat-a', 'config.yaml'), 'utf8');

  assert.strictEqual(result.feature, 'feat-a');
  assert.strictEqual(result.phase, 'verify');
  assert.match(featureConfig, /^phase: verify$/m);
}

function testDevflowErrorAliasRemoved() {
  const coreExports = require('../lib/core.cjs');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(coreExports, 'DevflowError'), false);
  assert.throws(
    () => throwCoreError('boom'),
    err => err instanceof DevteamError && err.name === 'DevteamError' && err.message === 'boom'
  );
}

function main() {
  testInitClusterWithoutActiveFeature();
  testInitStatusWithoutActiveFeature();
  testStateUpdateAllowsEmptyString();
  testStateUpdateStripsLegacyStateArtifacts();
  testStateCommandsRequireFeatureSelectionForMultiFeatureWorkspace();
  testFeaturesSwitchSubcommandRemoved();
  testStateUpdatePhaseAcceptsVerifyWhenFeatureSpecified();
  testDevflowErrorAliasRemoved();
  console.log('week1-core: ok');
}

main();
