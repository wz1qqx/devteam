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

function runCli(cwd, args) {
  const stdout = execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
  return JSON.parse(stdout);
}

function runCliError(cwd, args) {
  return spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
}

function createBareMetalWorkspace(options = {}) {
  const {
    buildMode = 'source_install',
    includeBuildMode = true,
  } = options;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week12-bare-metal-'));
  writeFile(path.join(root, 'workspace.yaml'), [
    'schema_version: 2',
    `workspace: ${root}`,
    'defaults:',
    '  features:',
    '    - feat-metal',
    'repos: {}',
    'clusters: {}',
  ].join('\n') + '\n');
  const featureLines = [
    'description: bare metal test',
    'phase: ship',
    'scope: {}',
    'current_tag: null',
    'base_image: null',
    'ship:',
    '  strategy: bare_metal',
    '  metal:',
    '    host: root@10.0.0.1',
    '    venv: /opt/pd-venv',
    '    code_dir: /opt/dynamo',
    '    profile: test-lab',
    '    config: pp2tp1-decode-tp2',
    ...(includeBuildMode ? [`    build_mode: ${buildMode}`] : []),
    '    sync_script: .dev/rapid-test/sync.sh',
    '    start_script: .dev/rapid-test/start.sh',
    '    service_url: 10.0.0.1:8000',
    '    log_paths:',
    '      decode: /tmp/dynamo-decode.log',
    '      prefill: /tmp/dynamo-prefill.log',
  ];
  writeFile(path.join(root, '.dev', 'features', 'feat-metal', 'config.yaml'), featureLines.join('\n') + '\n');
  return root;
}

function createK8sWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week12-k8s-'));
  writeFile(path.join(root, 'workspace.yaml'), [
    'schema_version: 2',
    `workspace: ${root}`,
    'defaults:',
    '  active_cluster: dev',
    '  features:',
    '    - feat-k8s',
    'clusters:',
    '  dev:',
    '    namespace: default',
    'repos: {}',
  ].join('\n') + '\n');
  writeFile(path.join(root, '.dev', 'features', 'feat-k8s', 'config.yaml'), [
    'description: k8s test',
    'phase: ship',
    'scope: {}',
    'current_tag: null',
    'base_image: null',
    'ship:',
    '  strategy: k8s',
  ].join('\n') + '\n');
  return root;
}

function testBareMetalStrategyLoadsSuccessfully() {
  const root = createBareMetalWorkspace();
  const config = runCli(root, ['config', 'load']);
  const feat = config.features['feat-metal'];
  assert.strictEqual(feat.ship.strategy, 'bare_metal');
  assert.strictEqual(feat.ship.metal.host, 'root@10.0.0.1');
  assert.strictEqual(feat.ship.metal.venv, '/opt/pd-venv');
  assert.strictEqual(feat.ship.metal.profile, 'test-lab');
  assert.strictEqual(feat.ship.metal.config, 'pp2tp1-decode-tp2');
  assert.strictEqual(feat.ship.metal.build_mode, 'source_install');
  assert.strictEqual(feat.ship.metal.sync_script, '.dev/rapid-test/sync.sh');
  assert.strictEqual(feat.ship.metal.start_script, '.dev/rapid-test/start.sh');
  assert.strictEqual(feat.ship.metal.service_url, '10.0.0.1:8000');
  assert.strictEqual(feat.ship.metal.log_paths.decode, '/tmp/dynamo-decode.log');
  assert.strictEqual(feat.ship.metal.log_paths.prefill, '/tmp/dynamo-prefill.log');
}

function testBareMetalBuildModeDefaultsToSyncOnly() {
  const root = createBareMetalWorkspace({ includeBuildMode: false });
  const config = runCli(root, ['config', 'load']);
  assert.strictEqual(config.features['feat-metal'].ship.metal.build_mode, 'sync_only');
}

function testK8sStrategyStillWorks() {
  const root = createK8sWorkspace();
  const config = runCli(root, ['config', 'load']);
  const feat = config.features['feat-k8s'];
  assert.strictEqual(feat.ship.strategy, 'k8s');
  assert.strictEqual(feat.ship.metal, null);
}

function testInvalidBareMetalBuildModeErrors() {
  const root = createBareMetalWorkspace({ buildMode: 'fast_path' });
  const result = runCliError(root, ['config', 'load']);
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /ship\.metal\.build_mode.*invalid/i);
}

function testInvalidStrategyErrors() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week12-invalid-'));
  writeFile(path.join(root, 'workspace.yaml'), [
    'schema_version: 2',
    `workspace: ${root}`,
    'defaults:',
    '  features:',
    '    - feat-bad',
    'repos: {}',
    'clusters: {}',
  ].join('\n') + '\n');
  writeFile(path.join(root, '.dev', 'features', 'feat-bad', 'config.yaml'), [
    'description: bad strategy',
    'phase: ship',
    'scope: {}',
    'ship:',
    '  strategy: docker_compose',
  ].join('\n') + '\n');

  const result = runCliError(root, ['config', 'load']);
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /unsupported ship\.strategy.*docker_compose/i);
}

function testNoStrategyDefaultsToNull() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week12-no-strategy-'));
  writeFile(path.join(root, 'workspace.yaml'), [
    'schema_version: 2',
    `workspace: ${root}`,
    'defaults:',
    '  features:',
    '    - feat-none',
    'repos: {}',
    'clusters: {}',
  ].join('\n') + '\n');
  writeFile(path.join(root, '.dev', 'features', 'feat-none', 'config.yaml'), [
    'description: no strategy',
    'phase: code',
    'scope: {}',
  ].join('\n') + '\n');

  const config = runCli(root, ['config', 'load']);
  assert.strictEqual(config.features['feat-none'].ship.strategy, null);
  assert.strictEqual(config.features['feat-none'].ship.metal, null);
}

function testBareMetalWithoutMetalBlockErrors() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week12-bare-no-metal-'));
  writeFile(path.join(root, 'workspace.yaml'), [
    'schema_version: 2',
    `workspace: ${root}`,
    'defaults:',
    '  features:',
    '    - feat-sparse',
    'repos: {}',
    'clusters: {}',
  ].join('\n') + '\n');
  writeFile(path.join(root, '.dev', 'features', 'feat-sparse', 'config.yaml'), [
    'description: sparse bare metal',
    'phase: ship',
    'scope: {}',
    'ship:',
    '  strategy: bare_metal',
  ].join('\n') + '\n');

  const result = runCliError(root, ['config', 'load']);
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /ship\.metal is required when ship\.strategy is bare_metal/i);
}

function testInitTeamDeployIncludesShipConfig() {
  const root = createBareMetalWorkspace();
  const init = runCli(root, ['init', 'team-deploy', '--feature', 'feat-metal']);
  assert.ok(init.ship, 'init team-deploy must include ship');
  assert.strictEqual(init.ship.strategy, 'bare_metal');
  assert.strictEqual(init.ship.metal.host, 'root@10.0.0.1');
  assert.strictEqual(init.ship.metal.profile, 'test-lab');
}

function testInitTeamVerifyIncludesShipConfig() {
  const root = createBareMetalWorkspace();
  const init = runCli(root, ['init', 'team-verify', '--feature', 'feat-metal']);
  assert.ok(init.ship, 'init team-verify must include ship');
  assert.strictEqual(init.ship.strategy, 'bare_metal');
  assert.strictEqual(init.ship.metal.service_url, '10.0.0.1:8000');
}

function testInitTeamBuildIncludesShipConfig() {
  const root = createBareMetalWorkspace();
  const init = runCli(root, ['init', 'team-build', '--feature', 'feat-metal']);
  assert.ok(init.ship, 'init team-build must include ship');
  assert.strictEqual(init.ship.strategy, 'bare_metal');
  assert.strictEqual(init.ship.metal.build_mode, 'source_install');
}

function main() {
  testBareMetalStrategyLoadsSuccessfully();
  testBareMetalBuildModeDefaultsToSyncOnly();
  testK8sStrategyStillWorks();
  testInvalidBareMetalBuildModeErrors();
  testInvalidStrategyErrors();
  testNoStrategyDefaultsToNull();
  testBareMetalWithoutMetalBlockErrors();
  testInitTeamDeployIncludesShipConfig();
  testInitTeamVerifyIncludesShipConfig();
  testInitTeamBuildIncludesShipConfig();
  console.log('week12-bare-metal-ship-strategy: ok');
}

main();
