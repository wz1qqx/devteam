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

function createWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-orchestration-kernel-'));
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

function assertNormalizedDecisionShape(decision) {
  const expectedKeys = [
    'stage',
    'decision',
    'reason',
    'needs_user_input',
    'retryable',
    'next_action',
    'user_prompt',
    'loop_context',
    'remediation_items',
    'regressions',
    'should_accept',
    'should_checkpoint',
    'review_cycle',
    'max_review_cycles',
    'remaining_review_cycles',
  ];
  for (const key of expectedKeys) {
    assert.ok(Object.prototype.hasOwnProperty.call(decision, key), `missing decision key: ${key}`);
  }
}

function reviewMessage(verdict = 'PASS_WITH_WARNINGS') {
  return [
    '# Code Review: feat-a',
    '',
    verdict === 'FAIL' ? 'Blocking issue found.' : 'One warning remains.',
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
      next_action: verdict === 'FAIL'
        ? 'Send remediation items back to the coder.'
        : 'Proceed to build.',
      retryable: false,
      metrics: {
        finding_counts: {
          critical: 0,
          high: verdict === 'FAIL' ? 1 : 0,
          medium: verdict === 'PASS_WITH_WARNINGS' ? 1 : 0,
          low: 0,
          info: 0,
        },
      },
      remediation_items: verdict === 'FAIL' ? ['Fix the blocking issue.'] : [],
    }, null, 2),
    '```',
    '',
  ].join('\n');
}

function testResolveStageAcceptsPassingResult() {
  const root = createWorkspace();
  const reportPath = path.join(root, '.dev', 'features', 'feat-a', 'review.md');
  const stdout = execFileSync(
    'node',
    [
      CLI,
      'orchestration',
      'resolve-stage',
      '--stage',
      'review',
      '--report-path',
      reportPath,
      '--summary',
      'Review PASS_WITH_WARNINGS for feat-a',
    ],
    {
      cwd: root,
      input: reviewMessage('PASS_WITH_WARNINGS'),
      encoding: 'utf8',
    }
  );
  const parsed = JSON.parse(stdout);
  const stateMd = fs.readFileSync(path.join(root, '.dev', 'features', 'feat-a', 'STATE.md'), 'utf8');

  assert.strictEqual(parsed.decision.decision, 'accept');
  assertNormalizedDecisionShape(parsed.decision);
  assert.ok(parsed.acceptance);
  assert.strictEqual(parsed.acceptance.stage, 'review');
  assert.strictEqual(parsed.acceptance.completed_stages, 'review');
  assert.strictEqual(fs.readFileSync(reportPath, 'utf8'), parsed.report);
  assert.match(stateMd, /^feature_stage: review$/m);
}

function testResolveStageReturnsDecisionWithoutAcceptingFailingResult() {
  const root = createWorkspace();
  const reportPath = path.join(root, '.dev', 'features', 'feat-a', 'review.md');
  const stdout = execFileSync(
    'node',
    [
      CLI,
      'orchestration',
      'resolve-stage',
      '--stage',
      'review',
      '--report-path',
      reportPath,
      '--review-cycle',
      '0',
      '--max-review-cycles',
      '2',
    ],
    {
      cwd: root,
      input: reviewMessage('FAIL'),
      encoding: 'utf8',
    }
  );
  const parsed = JSON.parse(stdout);
  const statePath = path.join(root, '.dev', 'features', 'feat-a', 'STATE.md');

  assert.strictEqual(parsed.decision.decision, 'review_fix_loop');
  assertNormalizedDecisionShape(parsed.decision);
  assert.strictEqual(parsed.acceptance, null);
  assert.deepStrictEqual(parsed.decision.remediation_items, ['Fix the blocking issue.']);
  assert.strictEqual(fs.readFileSync(reportPath, 'utf8'), parsed.report);
  assert.strictEqual(fs.existsSync(statePath), false);
}

function main() {
  testResolveStageAcceptsPassingResult();
  testResolveStageReturnsDecisionWithoutAcceptingFailingResult();
  console.log('week3-orchestration-kernel: ok');
}

main();
