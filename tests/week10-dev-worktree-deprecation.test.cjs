'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'lib', 'devteam.cjs');

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function runCliRaw(cwd, args) {
  return spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
}

function createWorkspaceWithLegacyDevWorktree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week10-dev-worktree-legacy-'));
  writeFile(path.join(root, 'workspace.yaml'), [
    'schema_version: 2',
    `workspace: ${root}`,
    'defaults:',
    '  features:',
    '    - feat-a',
    'repos: {}',
    'clusters: {}',
  ].join('\n') + '\n');
  writeFile(path.join(root, '.dev', 'features', 'feat-a', 'config.yaml'), [
    'description: feat-a',
    'phase: code',
    'scope:',
    '  repo-a:',
    '    dev_worktree: repo-a-dev',
    'current_tag: null',
    'base_image: null',
  ].join('\n') + '\n');
  return root;
}

function createWorkspaceWithDevSlot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week10-dev-worktree-slot-'));
  writeFile(path.join(root, 'workspace.yaml'), [
    'schema_version: 2',
    `workspace: ${root}`,
    'defaults:',
    '  features:',
    '    - feat-a',
    'repos:',
    '  repo-a:',
    '    dev_slots:',
    '      slot-a:',
    '        worktree: repo-a-dev',
    'clusters: {}',
  ].join('\n') + '\n');
  writeFile(path.join(root, '.dev', 'features', 'feat-a', 'config.yaml'), [
    'description: feat-a',
    'phase: code',
    'scope:',
    '  repo-a:',
    '    dev_slot: slot-a',
    'current_tag: null',
    'base_image: null',
  ].join('\n') + '\n');
  return root;
}

function testErrorsWhenUsingLegacyScopeDevWorktree() {
  const root = createWorkspaceWithLegacyDevWorktree();
  const raw = runCliRaw(root, ['config', 'load']);
  assert.notStrictEqual(raw.status, 0);
  assert.match(raw.stderr, /removed.*dev_worktree/i);
  assert.match(raw.stderr, /dev_slot/i);
}

function testNoErrorWhenUsingDevSlot() {
  const root = createWorkspaceWithDevSlot();
  const raw = runCliRaw(root, ['config', 'load']);
  assert.strictEqual(raw.status, 0);
  assert.doesNotMatch(raw.stderr, /dev_worktree/i);
}

function main() {
  testErrorsWhenUsingLegacyScopeDevWorktree();
  testNoErrorWhenUsingDevSlot();
  console.log('week10-dev-worktree-deprecation: ok');
}

main();
