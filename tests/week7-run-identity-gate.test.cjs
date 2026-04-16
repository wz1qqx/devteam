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
  return spawnSync('node', [CLI, ...args], {
    cwd,
    encoding: 'utf8',
  });
}

function createWorkspace({ devWorktree }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week7-run-identity-'));
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
      'phase: code',
      'scope:',
      '  repo-a:',
      '    base_ref: main',
      `    dev_worktree: ${devWorktree}`,
      'current_tag: null',
      'base_image: null',
    ].join('\n') + '\n'
  );
  fs.mkdirSync(path.join(root, 'repo-a-base'), { recursive: true });
  return root;
}

function testMissingDevWorktreeBlocksPipeline() {
  const root = createWorkspace({ devWorktree: 'repo-a-dev-missing' });
  const run = runCli(root, ['run', 'init', '--feature', 'feat-a', '--stages', 'code,review']);

  assert.strictEqual(run.requires_execution_identity_fix, true);
  assert.strictEqual(run.ready_for_pipeline, false);
  assert.ok(Array.isArray(run.invalid_execution_repos));
  assert.strictEqual(run.invalid_execution_repos[0].repo, 'repo-a');
  assert.ok(run.invalid_execution_repos[0].reasons.includes('dev_worktree_missing'));

  const blocked = runCliError(root, ['pipeline', 'init', '--feature', 'feat-a', '--stages', 'code,review']);
  assert.notStrictEqual(blocked.status, 0);
  assert.match(blocked.stderr, /execution identity is invalid/i);
}

function testNonGitDevWorktreeBlocksPipeline() {
  const root = createWorkspace({ devWorktree: 'repo-a-dev' });
  fs.mkdirSync(path.join(root, 'repo-a-dev'), { recursive: true }); // Directory exists but is not a git repo.

  const run = runCli(root, ['run', 'init', '--feature', 'feat-a', '--stages', 'code,review']);
  assert.strictEqual(run.requires_execution_identity_fix, true);
  assert.strictEqual(run.ready_for_pipeline, false);
  assert.ok(run.invalid_execution_repos[0].reasons.includes('not_git_worktree'));
  assert.ok(run.invalid_execution_repos[0].reasons.includes('start_head_missing'));

  const blocked = runCliError(root, ['pipeline', 'init', '--feature', 'feat-a', '--stages', 'code,review']);
  assert.notStrictEqual(blocked.status, 0);
  assert.match(blocked.stderr, /execution identity is invalid/i);
}

function main() {
  testMissingDevWorktreeBlocksPipeline();
  testNonGitDevWorktreeBlocksPipeline();
  console.log('week7-run-identity-gate: ok');
}

main();
