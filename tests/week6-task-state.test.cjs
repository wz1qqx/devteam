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

function createWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week6-task-state-'));
  writeFile(
    path.join(root, 'workspace.yaml'),
    [
      'schema_version: 2',
      `workspace: ${root}`,
      'defaults:',
      '  features:',
      '    - feat-a',
      'repos: {}',
      'clusters: {}',
    ].join('\n') + '\n'
  );
  writeFile(
    path.join(root, '.dev', 'features', 'feat-a', 'config.yaml'),
    [
      'description: Feature A',
      'phase: plan',
      'scope: {}',
      'current_tag: null',
      'base_image: null',
    ].join('\n') + '\n'
  );
  writeFile(
    path.join(root, '.dev', 'features', 'feat-a', 'plan.md'),
    [
      '# Implementation Plan: feat-a',
      '',
      '## Wave 1 (independent)',
      '',
      '### Task 1: Add parser',
      '- **Repo**: repo-a',
      `- **Worktree**: ${path.join(root, 'repo-a-dev')}`,
      '- **Files to Modify**: src/parser.py, tests/test_parser.py',
      '- **Files to Read**: src/parser.py',
      '- **Depends On**: none',
      '- **Status**: pending',
      '',
      '### Task 2: Add API endpoint',
      '- **Repo**: repo-b',
      `- **Worktree**: ${path.join(root, 'repo-b-dev')}`,
      '- **Files to Modify**: api/server.py',
      '- **Files to Read**: api/server.py, api/router.py',
      '- **Depends On**: 1',
      '- **Status**: pending',
      '',
    ].join('\n')
  );
  return root;
}

function testSyncFromPlanAndUpdateLifecycle() {
  const root = createWorkspace();
  const synced = runCli(root, ['tasks', 'sync-from-plan', '--feature', 'feat-a']);

  assert.strictEqual(synced.action, 'sync-from-plan');
  assert.strictEqual(synced.task_count, 2);
  assert.strictEqual(synced.summary.total_tasks, 2);
  assert.ok(fs.existsSync(path.join(root, '.dev', 'features', 'feat-a', 'tasks.json')));

  const fetched = runCli(root, ['tasks', 'get', '--feature', 'feat-a']);
  assert.strictEqual(fetched.exists, true);
  assert.strictEqual(fetched.task_state.tasks.length, 2);
  assert.strictEqual(fetched.task_state.tasks[0].id, '1');
  assert.strictEqual(fetched.task_state.tasks[0].title, 'Add parser');
  assert.deepStrictEqual(fetched.task_state.tasks[1].depends_on, ['1']);
  assert.strictEqual(fetched.task_state.tasks[0].status, 'pending');

  const inProgress = runCli(root, ['tasks', 'update', '--feature', 'feat-a', '--id', '1', '--status', 'in_progress']);
  assert.strictEqual(inProgress.task.status, 'in_progress');
  assert.strictEqual(inProgress.summary.by_status.in_progress, 1);

  const completed = runCli(root, [
    'tasks',
    'update',
    '--feature',
    'feat-a',
    '--id',
    '1',
    '--status',
    'completed',
    '--commit',
    'abc1234',
  ]);
  assert.strictEqual(completed.task.status, 'completed');
  assert.strictEqual(completed.task.commit, 'abc1234');
  assert.strictEqual(completed.summary.completed_tasks, 1);
  assert.strictEqual(completed.summary.remaining_tasks, 1);

  const summary = runCli(root, ['tasks', 'summary', '--feature', 'feat-a']);
  assert.strictEqual(summary.summary.total_tasks, 2);
  assert.strictEqual(summary.summary.completed_tasks, 1);
}

function testInvalidTaskStatusFailsLoudly() {
  const root = createWorkspace();
  runCli(root, ['tasks', 'sync-from-plan', '--feature', 'feat-a']);
  const result = runCliError(root, ['tasks', 'update', '--feature', 'feat-a', '--id', '1', '--status', 'done']);
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /Invalid task status 'done'/i);
}

function testSummaryDoesNotCountSkippedAsRemaining() {
  const root = createWorkspace();
  runCli(root, ['tasks', 'sync-from-plan', '--feature', 'feat-a']);
  runCli(root, ['tasks', 'update', '--feature', 'feat-a', '--id', '1', '--status', 'completed']);
  runCli(root, ['tasks', 'update', '--feature', 'feat-a', '--id', '2', '--status', 'skipped']);

  const summary = runCli(root, ['tasks', 'summary', '--feature', 'feat-a']);
  assert.strictEqual(summary.summary.total_tasks, 2);
  assert.strictEqual(summary.summary.completed_tasks, 1);
  assert.strictEqual(summary.summary.by_status.skipped, 1);
  assert.strictEqual(summary.summary.remaining_tasks, 0);
  assert.strictEqual(summary.summary.next_task, null);
}

function main() {
  testSyncFromPlanAndUpdateLifecycle();
  testInvalidTaskStatusFailsLoudly();
  testSummaryDoesNotCountSkippedAsRemaining();
  console.log('week6-task-state: ok');
}

main();
