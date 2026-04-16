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
  const stdout = execFileSync('node', [CLI, ...args], {
    cwd,
    encoding: 'utf8',
  });
  return JSON.parse(stdout);
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function initRepo(repoPath, markerFile, markerValue) {
  fs.mkdirSync(repoPath, { recursive: true });
  git(repoPath, ['init']);
  git(repoPath, ['config', 'user.email', 'devteam-test@example.com']);
  git(repoPath, ['config', 'user.name', 'Devteam Test']);
  writeFile(path.join(repoPath, markerFile), `${markerValue}\n`);
  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '-m', `init ${markerValue}`]);
  return git(repoPath, ['rev-parse', 'HEAD']);
}

function createWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week7-multi-repo-run-'));

  writeFile(
    path.join(root, 'workspace.yaml'),
    [
      'schema_version: 2',
      `workspace: ${root}`,
      'defaults:',
      '  features:',
      '    - feat-a',
      '    - feat-b',
      'repos:',
      '  repo-a:',
      '    remotes:',
      '      official: https://example.com/repo-a.git',
      '    baselines:',
      '      main:',
      '        id: baseline-main',
      '        ref: main',
      '        worktree: repo-a-base',
      '    dev_slots:',
      '      slot-feat-a:',
      '        worktree: repo-a-dev-feat-a',
      '        baseline_id: baseline-main',
      '        owner_features:',
      '          - feat-a',
      '      slot-feat-b:',
      '        worktree: repo-a-dev-feat-b',
      '        baseline_id: baseline-main',
      '        owner_features:',
      '          - feat-b',
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
      '    dev_slot: slot-feat-a',
      'current_tag: null',
      'base_image: null',
    ].join('\n') + '\n'
  );
  writeFile(
    path.join(root, '.dev', 'features', 'feat-b', 'config.yaml'),
    [
      'description: Feature B',
      'phase: code',
      'scope:',
      '  repo-a:',
      '    dev_slot: slot-feat-b',
      'current_tag: null',
      'base_image: null',
    ].join('\n') + '\n'
  );

  fs.mkdirSync(path.join(root, 'repo-a-base'), { recursive: true });

  const headA = initRepo(path.join(root, 'repo-a-dev-feat-a'), 'feat-a.txt', 'feat-a');
  const headB = initRepo(path.join(root, 'repo-a-dev-feat-b'), 'feat-b.txt', 'feat-b');

  return { root, headA, headB };
}

function testTwoFeaturesOnSameRepoUseDifferentDevSlots() {
  const { root, headA, headB } = createWorkspace();

  const initA = runCli(root, ['init', 'feature', '--feature', 'feat-a']);
  const initB = runCli(root, ['init', 'feature', '--feature', 'feat-b']);
  assert.strictEqual(initA.repos['repo-a'].dev_slot, 'slot-feat-a');
  assert.strictEqual(initB.repos['repo-a'].dev_slot, 'slot-feat-b');
  assert.strictEqual(initA.repos['repo-a'].dev_worktree, path.join(root, 'repo-a-dev-feat-a'));
  assert.strictEqual(initB.repos['repo-a'].dev_worktree, path.join(root, 'repo-a-dev-feat-b'));
  assert.notStrictEqual(initA.repos['repo-a'].dev_worktree, initB.repos['repo-a'].dev_worktree);

  const runA = runCli(root, ['run', 'init', '--feature', 'feat-a', '--stages', 'code,review']);
  const runB = runCli(root, ['run', 'init', '--feature', 'feat-b', '--stages', 'code,review']);

  assert.strictEqual(runA.run.repos[0].repo, 'repo-a');
  assert.strictEqual(runB.run.repos[0].repo, 'repo-a');
  assert.strictEqual(runA.run.repos[0].dev_worktree, path.join(root, 'repo-a-dev-feat-a'));
  assert.strictEqual(runB.run.repos[0].dev_worktree, path.join(root, 'repo-a-dev-feat-b'));
  assert.strictEqual(runA.run.repos[0].start_head, headA);
  assert.strictEqual(runB.run.repos[0].start_head, headB);
  assert.notStrictEqual(runA.run.run_id, runB.run.run_id);

  const runStateA = runCli(root, ['run', 'get', '--feature', 'feat-a']);
  const runStateB = runCli(root, ['run', 'get', '--feature', 'feat-b']);
  assert.strictEqual(runStateA.run.repos[0].dev_worktree, path.join(root, 'repo-a-dev-feat-a'));
  assert.strictEqual(runStateB.run.repos[0].dev_worktree, path.join(root, 'repo-a-dev-feat-b'));
}

function main() {
  testTwoFeaturesOnSameRepoUseDifferentDevSlots();
  console.log('week7-multi-repo-run: ok');
}

main();
