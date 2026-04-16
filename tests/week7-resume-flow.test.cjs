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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week7-resume-flow-'));
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

  // Contradictory human view; authoritative source is tasks.json.
  writeFile(
    path.join(root, '.dev', 'features', 'feat-a', 'plan.md'),
    [
      '# Implementation Plan: feat-a',
      '',
      '- [x] task-1',
      '- [x] task-2',
      '- [x] task-3',
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
          title: 'Implement parser',
          repo: 'repo-a',
          dev_worktree: '/tmp/repo-a',
          files_to_modify: ['a.py'],
          files_to_read: ['a.py'],
          depends_on: [],
          wave: 1,
          status: 'completed',
          commit: 'abc111',
          notes: null,
        },
        {
          id: '2',
          title: 'Wire endpoint',
          repo: 'repo-a',
          dev_worktree: '/tmp/repo-a',
          files_to_modify: ['b.py'],
          files_to_read: ['b.py'],
          depends_on: ['1'],
          wave: 1,
          status: 'in_progress',
          commit: null,
          notes: 'resume here',
        },
        {
          id: '3',
          title: 'Add tests',
          repo: 'repo-a',
          dev_worktree: '/tmp/repo-a',
          files_to_modify: ['test_b.py'],
          files_to_read: ['b.py'],
          depends_on: ['2'],
          wave: 2,
          status: 'pending',
          commit: null,
          notes: null,
        },
      ],
    }, null, 2) + '\n'
  );

  writeFile(
    path.join(root, '.dev', 'features', 'feat-a', 'STATE.md'),
    [
      '---',
      'phase: code',
      'feature_stage: code',
      'pipeline_stages: code,review,build',
      'completed_stages: code',
      'pipeline_loop_count: 0',
      'last_activity: "2026-04-16T00:00:00.000Z"',
      '---',
      '',
      '## Position',
      'Currently working on: executing task 2',
      'Next step: continue task 2',
      '',
    ].join('\n')
  );

  writeFile(
    path.join(root, '.dev', 'features', 'feat-a', 'HANDOFF.json'),
    JSON.stringify({
      version: '2.0',
      paused_at: '2026-04-16T00:00:00.000Z',
      ttl_days: 7,
      feature: 'feat-a',
      feature_stage: 'code',
      task_progress: { current: 1, total: 3 },
      completed_tasks: [{ id: '1', title: 'Implement parser' }],
      remaining_tasks: [
        { id: '2', title: 'Wire endpoint', status: 'in_progress' },
        { id: '3', title: 'Add tests', status: 'pending' },
      ],
      decisions_this_session: ['Keep parser pure'],
      uncommitted_files: ['src/b.py'],
      next_action: 'Continue task 2: Wire endpoint',
      context_notes: 'Endpoint shape already agreed',
    }, null, 2) + '\n'
  );

  return root;
}

function testResumeUsesTasksJsonAsAuthoritativeSource() {
  const root = createWorkspace();

  const resume = runCli(root, ['init', 'resume', '--feature', 'feat-a']);
  assert.strictEqual(resume.task_state.exists, true);
  assert.strictEqual(resume.task_state.summary.total_tasks, 3);
  assert.strictEqual(resume.task_state.summary.completed_tasks, 1);
  assert.strictEqual(resume.task_state.summary.remaining_tasks, 2);
  assert.deepStrictEqual(resume.task_state.summary.next_task, {
    id: '2',
    title: 'Wire endpoint',
    status: 'in_progress',
  });
  assert.strictEqual(resume.handoff.next_action, 'Continue task 2: Wire endpoint');

  const completeTask2 = runCli(root, [
    'tasks',
    'update',
    '--feature',
    'feat-a',
    '--id',
    '2',
    '--status',
    'completed',
    '--commit',
    'abc222',
  ]);
  assert.strictEqual(completeTask2.summary.completed_tasks, 2);

  const refreshed = runCli(root, ['init', 'resume', '--feature', 'feat-a']);
  assert.deepStrictEqual(refreshed.task_state.summary.next_task, {
    id: '3',
    title: 'Add tests',
    status: 'pending',
  });
}

function main() {
  testResumeUsesTasksJsonAsAuthoritativeSource();
  console.log('week7-resume-flow: ok');
}

main();
