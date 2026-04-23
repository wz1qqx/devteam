'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'lib', 'devteam.cjs');

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function runCli(cwd, args) {
  const stdout = execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
  return JSON.parse(stdout);
}

function testActiveProfileK8sDerivesStrategyAndDeployProfile() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week14-ap-k8s-'));
  writeFile(path.join(root, 'workspace.yaml'), [
    'schema_version: 2',
    `workspace: ${root}`,
    'defaults:',
    '  features:',
    '    - feat-ap',
    'repos: {}',
    'clusters: {}',
  ].join('\n') + '\n');
  writeFile(path.join(root, '.dev', 'features', 'feat-ap', 'config.yaml'), [
    'description: active profile k8s',
    'phase: ship',
    'scope: {}',
    'deploy:',
    '  active_profile: staging',
    '  profiles:',
    '    staging:',
    '      type: k8s',
    '      yaml: deploy/test.yaml',
    '      namespace: ns1',
  ].join('\n') + '\n');

  const config = runCli(root, ['config', 'load']);
  const f = config.features['feat-ap'];
  assert.strictEqual(f.ship.strategy, 'k8s');
  assert.strictEqual(f.deploy.deploy_profile, 'staging');
  assert.strictEqual(f.deploy.active_profile, 'staging');
}

function testActiveProfileBareMetalSetsDeployProfileOnMetal() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week14-ap-bm-'));
  writeFile(path.join(root, 'workspace.yaml'), [
    'schema_version: 2',
    `workspace: ${root}`,
    'defaults:',
    '  features:',
    '    - feat-bm',
    'repos: {}',
    'clusters: {}',
  ].join('\n') + '\n');
  writeFile(path.join(root, '.dev', 'features', 'feat-bm', 'config.yaml'), [
    'description: active profile bare',
    'phase: ship',
    'scope: {}',
    'ship:',
    '  metal:',
    '    host: root@10.0.0.2',
    '    profile: lab',
    '    sync_script: .dev/rapid-test/sync.sh',
    '    start_script: .dev/rapid-test/start.sh',
    '    service_url: 10.0.0.2:8000',
    'deploy:',
    '  active_profile: dev_metal',
    '  profiles:',
    '    dev_metal:',
    '      type: bare_metal_venv',
    '      health_url: http://10.0.0.2:8000/v1/models',
  ].join('\n') + '\n');

  const config = runCli(root, ['config', 'load']);
  const f = config.features['feat-bm'];
  assert.strictEqual(f.ship.strategy, 'bare_metal');
  assert.strictEqual(f.ship.metal.deploy_profile, 'dev_metal');
  assert.strictEqual(f.build.mode, 'sync_only');
}

function testInitDeployProfileOverrideFlag() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week14-init-flag-'));
  writeFile(path.join(root, 'workspace.yaml'), [
    'schema_version: 2',
    `workspace: ${root}`,
    'defaults:',
    '  features:',
    '    - feat-x',
    'repos: {}',
    'clusters: {}',
  ].join('\n') + '\n');
  writeFile(path.join(root, '.dev', 'features', 'feat-x', 'config.yaml'), [
    'description: init override',
    'phase: ship',
    'scope: {}',
    'ship:',
    '  strategy: k8s',
    'deploy:',
    '  profiles:',
    '    p1:',
    '      type: k8s',
    '    p2:',
    '      type: k8s',
  ].join('\n') + '\n');

  const init = runCli(root, [
    'init', 'team-deploy', '--feature', 'feat-x', '--deploy-profile', 'p2',
  ]);
  assert.strictEqual(init.deploy.deploy_profile, 'p2');
  assert.strictEqual(init.init_overrides.deploy_profile, 'p2');
}

function testInitShipStrategyOverrideFlag() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week14-ship-str-'));
  writeFile(path.join(root, 'workspace.yaml'), [
    'schema_version: 2',
    `workspace: ${root}`,
    'defaults:',
    '  features:',
    '    - feat-y',
    'repos: {}',
    'clusters: {}',
  ].join('\n') + '\n');
  writeFile(path.join(root, '.dev', 'features', 'feat-y', 'config.yaml'), [
    'description: ship strategy override',
    'phase: ship',
    'scope: {}',
    'ship:',
    '  strategy: k8s',
  ].join('\n') + '\n');

  const init = runCli(root, [
    'init', 'team-deploy', '--feature', 'feat-y', '--ship-strategy', 'k8s',
  ]);
  assert.strictEqual(init.ship.strategy, 'k8s');
  assert.strictEqual(init.init_overrides.ship_strategy, 'k8s');
}

function main() {
  testActiveProfileK8sDerivesStrategyAndDeployProfile();
  testActiveProfileBareMetalSetsDeployProfileOnMetal();
  testInitDeployProfileOverrideFlag();
  testInitShipStrategyOverrideFlag();
  console.log('week14-ship-profile-and-init-flags: ok');
}

main();
