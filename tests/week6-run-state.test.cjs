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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week6-run-state-'));
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

  return { root, repoPath };
}

function testRunLifecycle() {
  const { root } = createWorkspace();

  const first = runCli(root, ['run', 'init', '--feature', 'feat-a', '--stages', 'code,review']);
  assert.strictEqual(first.action, 'init');
  assert.strictEqual(first.feature, 'feat-a');
  assert.strictEqual(first.requires_dirty_decision, false);
  assert.strictEqual(first.ready_for_pipeline, true);
  assert.deepStrictEqual(first.run.pipeline_stages, ['code', 'review']);
  assert.ok(first.run.run_id);
  assert.ok(fs.existsSync(first.run_path), 'RUN.json should be written');
  assert.strictEqual(first.run.dirty_policy.decision, 'clean');
  assert.strictEqual(first.run.repos[0].repo, 'repo-a');
  assert.ok(first.run.repos[0].start_head, 'start_head should be captured');

  const reused = runCli(root, ['run', 'init', '--feature', 'feat-a', '--stages', 'code,review']);
  assert.strictEqual(reused.action, 'reuse');
  assert.strictEqual(reused.run.run_id, first.run.run_id);

  const fetched = runCli(root, ['run', 'get', '--feature', 'feat-a']);
  assert.strictEqual(fetched.exists, true);
  assert.strictEqual(fetched.run.run_id, first.run.run_id);

  const restarted = runCli(root, ['run', 'init', '--feature', 'feat-a', '--stages', 'code,review', '--restart']);
  assert.strictEqual(restarted.action, 'restart');
  assert.notStrictEqual(restarted.run.run_id, first.run.run_id);

  const reset = runCli(root, ['run', 'reset', '--feature', 'feat-a']);
  assert.strictEqual(reset.action, 'reset');
  assert.strictEqual(reset.removed, true);

  const afterReset = runCli(root, ['run', 'get', '--feature', 'feat-a']);
  assert.strictEqual(afterReset.exists, false);
}

function main() {
  testRunLifecycle();
  console.log('week6-run-state: ok');
}

main();
