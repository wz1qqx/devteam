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

function createWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-stage-accept-'));
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
  return root;
}

function reviewMessage(verdict = 'PASS_WITH_WARNINGS') {
  return [
    '# Code Review: feat-a',
    '',
    'One medium issue remains, but it is non-blocking.',
    '',
    '## STAGE_RESULT',
    '```json',
    JSON.stringify({
      stage: 'review',
      status: 'completed',
      verdict,
      artifacts: [
        { kind: 'review', path: '.dev/features/feat-a/review.md' },
      ],
      next_action: 'Proceed to build or address the remaining warning.',
      retryable: false,
      metrics: {
        finding_counts: {
          critical: 0,
          high: 0,
          medium: verdict === 'PASS_WITH_WARNINGS' ? 1 : 0,
          low: 0,
          info: 0,
        },
      },
      remediation_items: verdict === 'FAIL' ? ['Fix the blocking review issue.'] : [],
    }, null, 2),
    '```',
    '',
  ].join('\n');
}

function planMessage() {
  return [
    '# Implementation Plan: feat-a',
    '',
    'Plan written successfully.',
    '',
    '## STAGE_RESULT',
    '```json',
    JSON.stringify({
      stage: 'plan',
      status: 'completed',
      verdict: 'PASS',
      artifacts: [
        { kind: 'plan', path: '.dev/features/feat-a/plan.md' },
      ],
      next_action: 'Coder can execute the plan.',
      retryable: false,
      metrics: {
        task_count: 2,
        wave_count: 1,
        build_mode: 'fast',
      },
    }, null, 2),
    '```',
    '',
  ].join('\n');
}

function testAcceptWritesStateCheckpointAndReport() {
  const root = createWorkspace();
  const reportPath = path.join(root, '.dev', 'features', 'feat-a', 'review.md');
  const stdout = execFileSync(
    'node',
    [
      CLI,
      'stage-result',
      'accept',
      '--stage',
      'review',
      '--summary',
      'Review PASS_WITH_WARNINGS for feat-a',
      '--report-path',
      reportPath,
    ],
    {
      cwd: root,
      input: reviewMessage(),
      encoding: 'utf8',
    }
  );
  const result = JSON.parse(stdout);
  const stateMd = fs.readFileSync(path.join(root, '.dev', 'features', 'feat-a', 'STATE.md'), 'utf8');
  const devlog = fs.readFileSync(path.join(root, '.dev', 'features', 'feat-a', 'devlog.md'), 'utf8');

  assert.strictEqual(result.accepted, true);
  assert.strictEqual(result.stage, 'review');
  assert.strictEqual(result.verdict, 'PASS_WITH_WARNINGS');
  assert.strictEqual(result.completed_stages, 'review');
  assert.strictEqual(result.report_path, reportPath);
  assert.match(stateMd, /^completed_stages: review$/m);
  assert.match(stateMd, /^feature_stage: review$/m);
  assert.strictEqual(fs.readFileSync(reportPath, 'utf8'), result.report);
  assert.match(devlog, /review: Review PASS_WITH_WARNINGS for feat-a/);
}

function testAcceptAppendsCompletedStagesWithoutDuplicates() {
  const root = createWorkspace();
  writeFile(
    path.join(root, '.dev', 'features', 'feat-a', 'STATE.md'),
    [
      '---',
      'completed_stages: spec',
      'feature_stage: spec',
      '---',
      '',
    ].join('\n')
  );

  execFileSync(
    'node',
    [CLI, 'stage-result', 'accept', '--stage', 'plan'],
    {
      cwd: root,
      input: planMessage(),
      encoding: 'utf8',
    }
  );

  execFileSync(
    'node',
    [CLI, 'stage-result', 'accept', '--stage', 'plan'],
    {
      cwd: root,
      input: planMessage(),
      encoding: 'utf8',
    }
  );

  const stateMd = fs.readFileSync(path.join(root, '.dev', 'features', 'feat-a', 'STATE.md'), 'utf8');
  assert.match(stateMd, /^completed_stages: spec,plan$/m);
  assert.match(stateMd, /^feature_stage: plan$/m);
}

function testRejectsNonAcceptableVerdict() {
  const root = createWorkspace();
  const result = spawnSync(
    'node',
    [CLI, 'stage-result', 'accept', '--stage', 'review'],
    {
      cwd: root,
      input: reviewMessage('FAIL'),
      encoding: 'utf8',
    }
  );

  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /cannot be accepted because verdict is 'FAIL'/);

  const statePath = path.join(root, '.dev', 'features', 'feat-a', 'STATE.md');
  if (fs.existsSync(statePath)) {
    const content = fs.readFileSync(statePath, 'utf8');
    assert.doesNotMatch(content, /^feature_stage: review$/m);
  }
}

function main() {
  testAcceptWritesStateCheckpointAndReport();
  testAcceptAppendsCompletedStagesWithoutDuplicates();
  testRejectsNonAcceptableVerdict();
  console.log('week3-stage-acceptance: ok');
}

main();
