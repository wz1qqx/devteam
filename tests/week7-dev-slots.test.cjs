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

function createWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week7-slots-'));
  writeFile(
    path.join(root, 'workspace.yaml'),
    [
      'schema_version: 2',
      `workspace: ${root}`,
      'defaults:',
      '  features:',
      '    - feat-a',
      'repos:',
      '  repo-a:',
      '    remotes:',
      '      official: https://example.com/repo-a.git',
      '    baselines:',
      '      main:',
      '        id: baseline-main',
      '        ref: main',
      '        worktree: repo-a-main',
      '    dev_slots:',
      '      slot-a:',
      '        worktree: repo-a-dev-a',
      '        baseline_id: baseline-main',
      '        sharing_mode: shared',
      '        owner_features:',
      '          - feat-a',
      'clusters: {}',
    ].join('\n') + '\n'
  );
  writeFile(
    path.join(root, '.dev', 'features', 'feat-a', 'config.yaml'),
    [
      'description: Feature A',
      'phase: code',
      'scope:',
      '  repo-a:',
      '    dev_slot: slot-a',
      'current_tag: null',
      'base_image: null',
    ].join('\n') + '\n'
  );
  fs.mkdirSync(path.join(root, 'repo-a-main'), { recursive: true });
  fs.mkdirSync(path.join(root, 'repo-a-dev-a'), { recursive: true });
  return root;
}

function testInitFeatureResolvesDevSlotAndBaseline() {
  const root = createWorkspace();
  const initFeature = runCli(root, ['init', 'feature', 'feat-a']);
  const repo = initFeature.repos['repo-a'];

  assert.strictEqual(repo.dev_slot, 'slot-a');
  assert.strictEqual(repo.baseline_id, 'baseline-main');
  assert.strictEqual(repo.base_ref, 'main');
  assert.strictEqual(repo.upstream, 'https://example.com/repo-a.git');
  assert.strictEqual(repo.remotes.official, 'https://example.com/repo-a.git');
  assert.strictEqual(repo.base_worktree, path.join(root, 'repo-a-main'));
  assert.strictEqual(repo.dev_worktree, path.join(root, 'repo-a-dev-a'));

  const initWorkspace = runCli(root, ['init', 'workspace']);
  const slot = initWorkspace.repos['repo-a'].dev_slots['slot-a'];
  assert.ok(slot);
  assert.strictEqual(slot.baseline_id, 'baseline-main');
  assert.strictEqual(slot.sharing_mode, 'shared');
  assert.deepStrictEqual(slot.owner_features, ['feat-a']);
}

function testMissingDevSlotFailsFast() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week7-slots-missing-'));
  writeFile(
    path.join(root, 'workspace.yaml'),
    [
      'schema_version: 2',
      `workspace: ${root}`,
      'defaults:',
      '  features:',
      '    - feat-a',
      'repos:',
      '  repo-a:',
      '    baselines:',
      '      main: repo-a-main',
      'clusters: {}',
    ].join('\n') + '\n'
  );
  writeFile(
    path.join(root, '.dev', 'features', 'feat-a', 'config.yaml'),
    [
      'description: Feature A',
      'phase: code',
      'scope:',
      '  repo-a:',
      '    dev_slot: slot-missing',
    ].join('\n') + '\n'
  );

  const stderr = runCliError(root, ['init', 'feature', 'feat-a']);
  assert.match(stderr, /dev_slot 'slot-missing' not found/i);
}

function main() {
  testInitFeatureResolvesDevSlotAndBaseline();
  testMissingDevSlotFailsFast();
  console.log('week7-dev-slots: ok');
}

main();
