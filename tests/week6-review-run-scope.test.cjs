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

function createWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week6-review-scope-'));
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
      'clusters: {}',
    ].join('\n') + '\n'
  );
  writeFile(
    path.join(root, '.dev', 'features', 'feat-a', 'config.yaml'),
    [
      'description: Feature A',
      'phase: review',
      'scope:',
      '  repo-a:',
      '    base_ref: main',
      '    dev_worktree: repo-a-dev',
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

  writeFile(path.join(repoPath, 'feature.txt'), 'v1\n');
  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '-m', 'feature-start']);

  return { root, repoPath };
}

function testInitTeamReviewUsesFrozenRunStartHead() {
  const { root, repoPath } = createWorkspace();

  const runInit = runCli(root, ['run', 'init', '--feature', 'feat-a', '--stages', 'review']);
  const frozenHead = runInit.run.repos.find(repo => repo.repo === 'repo-a').start_head;
  const runPath = runInit.run_path;
  assert.ok(frozenHead);

  writeFile(path.join(repoPath, 'feature.txt'), 'v2\n');
  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '-m', 'post-run-change']);
  const currentHead = git(repoPath, ['rev-parse', 'HEAD']);
  assert.notStrictEqual(currentHead, frozenHead, 'repo should move after run init');

  const initReview = runCli(root, ['init', 'team-review']);
  assert.strictEqual(initReview.run.path, runPath);
  assert.strictEqual(initReview.repos['repo-a'].start_head, frozenHead);
  assert.strictEqual(initReview.repos['repo-a'].base_ref, 'main');
}

function main() {
  testInitTeamReviewUsesFrozenRunStartHead();
  console.log('week6-review-run-scope: ok');
}

main();
