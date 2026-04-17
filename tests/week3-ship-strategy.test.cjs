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

function createWorkspace(shipStrategy) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week3-'));
  writeFile(
    path.join(root, 'workspace.yaml'),
    [
      'schema_version: 2',
      `workspace: ${root}`,
      'defaults:',
      '  active_cluster: dev',
      '  features:',
      '    - feat-a',
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
    ].join('\n') + '\n'
  );
  writeFile(
    path.join(root, '.dev', 'features', 'feat-a', 'config.yaml'),
    [
      'description: Feature A',
      'phase: ship',
      'scope:',
      '  repo-a:',
      '    base_ref: main',
      '    dev_slot: default',
      'ship:',
      `  strategy: ${shipStrategy}`,
      'current_tag: null',
      'base_image: null',
    ].join('\n') + '\n'
  );
  return root;
}

function testK8sStrategyLoadsNormally() {
  const root = createWorkspace('k8s');
  const stdout = execFileSync('node', [CLI, 'init', 'team'], {
    cwd: root,
    encoding: 'utf8',
  });
  const result = JSON.parse(stdout);

  assert.strictEqual(result.feature.name, 'feat-a');
  assert.strictEqual(result.feature.phase, 'ship');
}

function testUnsupportedStrategyFailsFast() {
  const root = createWorkspace('docker');
  const result = spawnSync('node', [CLI, 'init', 'team'], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.notStrictEqual(result.status, 0);
  assert.match(
    result.stderr,
    /unsupported ship\.strategy 'docker'.*supports only:/i
  );
}

function main() {
  testK8sStrategyLoadsNormally();
  testUnsupportedStrategyFailsFast();
  console.log('week3-ship-strategy: ok');
}

main();
