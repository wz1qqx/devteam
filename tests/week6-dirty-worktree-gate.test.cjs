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

function runCliExpectError(cwd, args) {
  return spawnSync('node', [CLI, ...args], {
    cwd,
    encoding: 'utf8',
  });
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createWorkspace({ dirty = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week6-dirty-gate-'));
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
      '    upstream: https://example.com/repo-a.git',
      '    baselines:',
      '      main: repo-a-base',
      '    dev_slots:',
      '      default:',
      '        worktree: repo-a-dev',
      '        baseline_id: main',
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
      '    base_ref: main',
      '    dev_slot: default',
      'current_tag: null',
      'base_image: null',
    ].join('\n') + '\n'
  );

  fs.mkdirSync(path.join(root, 'repo-a-base'), { recursive: true });

  const repoPath = path.join(root, 'repo-a-dev');
  fs.mkdirSync(repoPath, { recursive: true });
  git(repoPath, ['init']);
  git(repoPath, ['config', 'user.email', 'devteam-test@example.com']);
  git(repoPath, ['config', 'user.name', 'Devteam Test']);
  writeFile(path.join(repoPath, 'README.md'), '# Repo A\n');
  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '-m', 'init']);

  if (dirty) {
    writeFile(path.join(repoPath, 'DIRTY.txt'), 'uncommitted change\n');
  }

  return { root };
}

function testDirtyGateRequiresDecisionAndBlocksPipelineInit() {
  const { root } = createWorkspace({ dirty: true });
  const init = runCli(root, ['run', 'init', '--feature', 'feat-a', '--stages', 'code,review']);

  assert.strictEqual(init.requires_dirty_decision, true);
  assert.strictEqual(init.ready_for_pipeline, false);
  assert.strictEqual(init.run.dirty_policy.decision, 'pending');
  assert.deepStrictEqual(init.dirty_repos, ['repo-a']);

  const blocked = runCliExpectError(root, ['pipeline', 'init', '--feature', 'feat-a', '--stages', 'code,review']);
  assert.notStrictEqual(blocked.status, 0);
  assert.match(blocked.stderr, /dirty-worktree gate is unresolved/i);
}

function testContinueDecisionUnblocksPipelineInit() {
  const { root } = createWorkspace({ dirty: true });
  runCli(root, ['run', 'init', '--feature', 'feat-a', '--stages', 'code,review']);

  const continued = runCli(root, [
    'run',
    'init',
    '--feature',
    'feat-a',
    '--stages',
    'code,review',
    '--restart',
    '--dirty-decision',
    'continue',
  ]);
  assert.strictEqual(continued.run.dirty_policy.decision, 'continue');
  assert.strictEqual(continued.ready_for_pipeline, true);

  const pipeline = runCli(root, ['pipeline', 'init', '--feature', 'feat-a', '--stages', 'code,review']);
  assert.strictEqual(pipeline.action, 'init');
  assert.strictEqual(pipeline.run_id, continued.run.run_id);
}

function testAbortDecisionKeepsPipelineBlocked() {
  const { root } = createWorkspace({ dirty: true });
  runCli(root, ['run', 'init', '--feature', 'feat-a', '--stages', 'code,review']);
  const aborted = runCli(root, [
    'run',
    'init',
    '--feature',
    'feat-a',
    '--stages',
    'code,review',
    '--restart',
    '--dirty-decision',
    'abort',
  ]);
  assert.strictEqual(aborted.run.dirty_policy.decision, 'abort');
  assert.strictEqual(aborted.ready_for_pipeline, false);

  const blocked = runCliExpectError(root, ['pipeline', 'init', '--feature', 'feat-a', '--stages', 'code,review']);
  assert.notStrictEqual(blocked.status, 0);
  assert.match(blocked.stderr, /marks dirty-worktree decision as abort/i);
}

function main() {
  testDirtyGateRequiresDecisionAndBlocksPipelineInit();
  testContinueDecisionUnblocksPipelineInit();
  testAbortDecisionKeepsPipelineBlocked();
  console.log('week6-dirty-worktree-gate: ok');
}

main();
