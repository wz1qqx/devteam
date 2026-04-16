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

function createWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week6-pause-resume-'));
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
      'phase: code',
      'scope: {}',
      'current_tag: null',
      'base_image: null',
    ].join('\n') + '\n'
  );

  // Contradictory checkbox view artifact; pause/resume should not use this.
  writeFile(
    path.join(root, '.dev', 'features', 'feat-a', 'plan.md'),
    [
      '# Implementation Plan: feat-a',
      '',
      '- [x] task-a',
      '- [x] task-b',
      '',
    ].join('\n')
  );

  writeFile(
    path.join(root, '.dev', 'features', 'feat-a', 'tasks.json'),
    JSON.stringify({
      version: '1.0',
      feature: 'feat-a',
      updated_at: '2026-04-16T00:00:00.000Z',
      tasks: [
        {
          id: '1',
          title: 'Task A',
          repo: 'repo-a',
          dev_worktree: '/tmp/repo-a',
          files_to_modify: ['a.py'],
          files_to_read: ['a.py'],
          depends_on: [],
          wave: 1,
          status: 'completed',
          commit: 'abc123',
          notes: null,
        },
        {
          id: '2',
          title: 'Task B',
          repo: 'repo-a',
          dev_worktree: '/tmp/repo-a',
          files_to_modify: ['b.py'],
          files_to_read: ['b.py'],
          depends_on: ['1'],
          wave: 2,
          status: 'pending',
          commit: null,
          notes: null,
        },
      ],
    }, null, 2) + '\n'
  );

  return root;
}

function testPauseAndResumeInitUseTasksJsonSummary() {
  const root = createWorkspace();
  const pauseInit = runCli(root, ['init', 'pause', '--feature', 'feat-a']);
  const resumeInit = runCli(root, ['init', 'resume', '--feature', 'feat-a']);

  assert.strictEqual(pauseInit.task_state.exists, true);
  assert.strictEqual(pauseInit.task_state.summary.total_tasks, 2);
  assert.strictEqual(pauseInit.task_state.summary.completed_tasks, 1);
  assert.strictEqual(pauseInit.task_state.summary.remaining_tasks, 1);

  assert.strictEqual(resumeInit.task_state.exists, true);
  assert.strictEqual(resumeInit.task_state.summary.total_tasks, 2);
  assert.strictEqual(resumeInit.task_state.summary.completed_tasks, 1);
  assert.strictEqual(resumeInit.task_state.summary.remaining_tasks, 1);
}

function main() {
  testPauseAndResumeInitUseTasksJsonSummary();
  console.log('week6-pause-resume-task-state: ok');
}

main();
