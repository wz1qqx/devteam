'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'lib', 'devteam.cjs');

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function createWorkspace({ featureNames = ['feat-a'], featureConfigs = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-config-'));

  const workspaceYaml = [
    'schema_version: 2',
    `workspace: ${root}`,
    'defaults:',
    '  features:',
    ...featureNames.map(name => `    - ${name}`),
    'repos: {}',
    'clusters: {}',
  ].join('\n') + '\n';

  writeFile(path.join(root, 'workspace.yaml'), workspaceYaml);
  for (const [name, content] of Object.entries(featureConfigs)) {
    writeFile(path.join(root, '.dev', 'features', name, 'config.yaml'), content);
  }

  return root;
}

function createWorkspaceWithContent({ workspaceYaml, featureConfigs = {} }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-config-'));
  writeFile(path.join(root, 'workspace.yaml'), workspaceYaml);
  for (const [name, content] of Object.entries(featureConfigs)) {
    writeFile(path.join(root, '.dev', 'features', name, 'config.yaml'), content);
  }
  return root;
}

function runCli(cwd, args) {
  const stdout = execFileSync('node', [CLI, ...args], {
    cwd,
    encoding: 'utf8',
  });
  return JSON.parse(stdout);
}

function runCliError(cwd, args) {
  const result = spawnSync('node', [CLI, ...args], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status === 0) {
    throw new Error(`Expected command to fail: ${args.join(' ')}`);
  }
  return result.stderr;
}

function testFlowMappingsParseAsMappings() {
  const root = createWorkspace({
    featureConfigs: {
      'feat-a': [
        'description: Feature A',
        'scope: {}',
      ].join('\n') + '\n',
    },
  });

  const configRepos = runCli(root, ['config', 'get', 'repos']);
  const config = runCli(root, ['config', 'load']);
  const features = runCli(root, ['features', 'list']);

  assert.deepStrictEqual(configRepos.value, {});
  assert.deepStrictEqual(config.build_server, {});
  assert.deepStrictEqual(config.devlog, {});
  assert.deepStrictEqual(config.observability, {});
  assert.strictEqual(Object.prototype.hasOwnProperty.call(config, '_root'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(config, '_path'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(config, '_ws_path'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(config.features['feat-a'], '_path'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(config.features['feat-a'], 'name'), false);
  assert.strictEqual(typeof config.features, 'object');
  assert.strictEqual(config.features['feat-a'].phase, 'spec');
  assert.deepStrictEqual(config.features['feat-a'].scope, {});
  assert.strictEqual(config.defaults.tuning.build_history_limit, 5);
  assert.deepStrictEqual(config.features['feat-a'].build_history, []);
  assert.deepStrictEqual(config.features['feat-a'].invariants, {});
  assert.deepStrictEqual(config.features['feat-a'].hooks.pre_build, []);
  assert.deepStrictEqual(config.features['feat-a'].hooks.post_build, []);
  assert.deepStrictEqual(config.features['feat-a'].ship, {});
  assert.deepStrictEqual(config.features['feat-a'].build, {});
  assert.deepStrictEqual(config.features['feat-a'].deploy, {});
  assert.deepStrictEqual(config.features['feat-a'].benchmark, {});
  assert.deepStrictEqual(config.features['feat-a'].verify, {});
  assert.deepStrictEqual(features.features[0].scope, []);
  assert.strictEqual(features.features[0].phase, 'spec');

  const teamInit = runCli(root, ['init', 'team']);
  assert.deepStrictEqual(teamInit.build, {});
  assert.deepStrictEqual(teamInit.deploy, {});
  assert.deepStrictEqual(teamInit.benchmark, {});
  assert.deepStrictEqual(teamInit.verify, {});
  assert.deepStrictEqual(teamInit.build_server, {});
  assert.deepStrictEqual(teamInit.devlog, {});
  assert.deepStrictEqual(teamInit.all_clusters, {});

  const featureInit = runCli(root, ['init', 'feature', 'feat-a']);
  assert.deepStrictEqual(featureInit.ship, {});
  assert.deepStrictEqual(featureInit.build, {});
  assert.deepStrictEqual(featureInit.deploy, {});
  assert.deepStrictEqual(featureInit.benchmark, {});
  assert.deepStrictEqual(featureInit.verify, {});

  const workspaceInit = runCli(root, ['init', 'workspace']);
  assert.deepStrictEqual(workspaceInit.build_server, {});
  assert.deepStrictEqual(workspaceInit.devlog, {});
}

function testInvalidPhaseFailsFastAtLoadTime() {
  const root = createWorkspace({
    featureConfigs: {
      'feat-a': [
        'description: Feature A',
        'phase: investigate',
        'scope: {}',
      ].join('\n') + '\n',
    },
  });

  const stderr = runCliError(root, ['features', 'list']);
  assert.match(stderr, /unsupported phase 'investigate'/i);
}

function testMissingDeclaredFeatureConfigFailsFast() {
  const root = createWorkspace({
    featureNames: ['feat-a'],
    featureConfigs: {},
  });

  const stderr = runCliError(root, ['init', 'workspace']);
  assert.match(stderr, /Feature 'feat-a' is declared in defaults\.features but .*config\.yaml is missing/i);
}

function testInvalidScopeEntryFailsFast() {
  const root = createWorkspace({
    featureConfigs: {
      'feat-a': [
        'description: Feature A',
        'phase: code',
        'scope:',
        '  repo-a: main',
      ].join('\n') + '\n',
    },
  });

  const stderr = runCliError(root, ['features', 'list']);
  assert.match(stderr, /invalid scope entry for repo 'repo-a'/i);
}

function testInvalidOptionalFeatureMappingsFailFast() {
  const root = createWorkspace({
    featureConfigs: {
      'feat-a': [
        'description: Feature A',
        'scope: {}',
        'build:',
        '  - bad',
      ].join('\n') + '\n',
    },
  });

  const stderr = runCliError(root, ['config', 'load']);
  assert.match(stderr, /Feature 'feat-a' build must be a mapping/i);
}

function testNullOptionalFeatureMappingsNormalizeToEmptyObjects() {
  const root = createWorkspace({
    featureConfigs: {
      'feat-a': [
        'description: Feature A',
        'scope: {}',
        'ship: null',
        'build: null',
        'deploy: null',
        'benchmark: null',
        'verify: null',
      ].join('\n') + '\n',
    },
  });

  const config = runCli(root, ['config', 'load']);
  assert.deepStrictEqual(config.features['feat-a'].ship, {});
  assert.deepStrictEqual(config.features['feat-a'].build, {});
  assert.deepStrictEqual(config.features['feat-a'].deploy, {});
  assert.deepStrictEqual(config.features['feat-a'].benchmark, {});
  assert.deepStrictEqual(config.features['feat-a'].verify, {});
}

function testNullScopeNormalizesToEmptyObject() {
  const root = createWorkspace({
    featureConfigs: {
      'feat-a': [
        'description: Feature A',
        'scope: null',
      ].join('\n') + '\n',
    },
  });

  const config = runCli(root, ['config', 'load']);
  const features = runCli(root, ['features', 'list']);

  assert.deepStrictEqual(config.features['feat-a'].scope, {});
  assert.deepStrictEqual(features.features[0].scope, []);
}

function testWorkspaceOptionalMappingsNormalizeToEmptyObjects() {
  const root = createWorkspaceWithContent({
    workspaceYaml: [
      'schema_version: 2',
      `workspace: ${os.tmpdir()}`,
      'build_server: null',
      'devlog: null',
      'observability: null',
      'repos:',
      '  repo-a:',
      '    upstream: https://example.com/repo-a.git',
      '    baselines: null',
      'clusters:',
      '  dev:',
      '    namespace: dev-ns',
      '    hardware: null',
      '    network: null',
      'defaults:',
      '  active_cluster: dev',
      '  features:',
      '    - feat-a',
    ].join('\n') + '\n',
    featureConfigs: {
      'feat-a': [
        'description: Feature A',
        'scope: {}',
      ].join('\n') + '\n',
    },
  });

  const config = runCli(root, ['config', 'load']);
  assert.deepStrictEqual(config.build_server, {});
  assert.deepStrictEqual(config.devlog, {});
  assert.deepStrictEqual(config.observability, {});
  assert.deepStrictEqual(config.repos['repo-a'].baselines, {});
  assert.deepStrictEqual(config.clusters.dev.hardware, {});
  assert.deepStrictEqual(config.clusters.dev.network, {});
}

function testInvalidWorkspaceMappingsFailFast() {
  const root = createWorkspaceWithContent({
    workspaceYaml: [
      'schema_version: 2',
      `workspace: ${os.tmpdir()}`,
      'build_server:',
      '  - bad',
      'repos: {}',
      'clusters: {}',
      'defaults:',
      '  features:',
      '    - feat-a',
    ].join('\n') + '\n',
    featureConfigs: {
      'feat-a': [
        'description: Feature A',
        'scope: {}',
      ].join('\n') + '\n',
    },
  });

  const stderr = runCliError(root, ['config', 'load']);
  assert.match(stderr, /workspace\.yaml build_server must be a mapping/i);
}

function testInvalidRepoAndClusterNestedMappingsFailFast() {
  const root = createWorkspaceWithContent({
    workspaceYaml: [
      'schema_version: 2',
      `workspace: ${os.tmpdir()}`,
      'repos:',
      '  repo-a:',
      '    baselines:',
      '      - bad',
      'clusters:',
      '  dev:',
      '    hardware:',
      '      - bad',
      'defaults:',
      '  active_cluster: dev',
      '  features:',
      '    - feat-a',
    ].join('\n') + '\n',
    featureConfigs: {
      'feat-a': [
        'description: Feature A',
        'scope: {}',
      ].join('\n') + '\n',
    },
  });

  const stderr = runCliError(root, ['config', 'load']);
  assert.match(stderr, /workspace\.yaml repos\.repo-a\.baselines must be a mapping|workspace\.yaml clusters\.dev\.hardware must be a mapping/i);
}

function main() {
  testFlowMappingsParseAsMappings();
  testInvalidPhaseFailsFastAtLoadTime();
  testMissingDeclaredFeatureConfigFailsFast();
  testInvalidScopeEntryFailsFast();
  testInvalidOptionalFeatureMappingsFailFast();
  testNullOptionalFeatureMappingsNormalizeToEmptyObjects();
  testNullScopeNormalizesToEmptyObject();
  testWorkspaceOptionalMappingsNormalizeToEmptyObjects();
  testInvalidWorkspaceMappingsFailFast();
  testInvalidRepoAndClusterNestedMappingsFailFast();
  console.log('week1-config-validation: ok');
}

main();
