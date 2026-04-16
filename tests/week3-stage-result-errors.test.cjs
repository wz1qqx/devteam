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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-stage-result-errors-'));
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
      'phase: review',
      'scope: {}',
      'current_tag: null',
      'base_image: null',
    ].join('\n') + '\n'
  );
  return root;
}

function buildMessage(result) {
  return [
    '# Stage Report',
    '',
    'Body text.',
    '',
    '## STAGE_RESULT',
    '```json',
    JSON.stringify(result, null, 2),
    '```',
    '',
  ].join('\n');
}

function buildReviewFailMessage() {
  return buildMessage({
    stage: 'review',
    status: 'completed',
    verdict: 'FAIL',
    artifacts: [],
    next_action: 'Ask the user how to proceed.',
    retryable: false,
    metrics: {},
    remediation_items: ['Fix validation path'],
  });
}

function buildVerifyFailMessage() {
  return buildMessage({
    stage: 'verify',
    status: 'completed',
    verdict: 'FAIL',
    artifacts: [],
    next_action: 'Run optimization loop if enabled.',
    retryable: false,
    metrics: {
      regressions: [{ metric: 'ttft_p50', delta_pct: 18 }],
    },
  });
}

function runCli(args, options = {}) {
  return spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    ...options,
  });
}

function testMissingJsonBlockFailsLoudly() {
  const result = runCli(
    ['stage-result', 'parse', '--stage', 'review'],
    { input: '# Report\n\n## STAGE_RESULT\n\nnot-json\n' }
  );

  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /STAGE_RESULT JSON block must be the final content/i);
}

function testMissingRequiredKeyFailsLoudly() {
  const invalid = buildMessage({
    stage: 'review',
    status: 'completed',
    verdict: 'FAIL',
    artifacts: [],
    retryable: false,
    metrics: {},
  });
  const result = runCli(
    ['stage-result', 'parse', '--stage', 'review'],
    { input: invalid }
  );

  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /missing required key 'next_action'/i);
}

function testWrongRetryableTypeFailsLoudly() {
  const invalid = buildMessage({
    stage: 'review',
    status: 'completed',
    verdict: 'FAIL',
    artifacts: [],
    next_action: 'Retry later',
    retryable: 'false',
    metrics: {},
  });
  const result = runCli(
    ['stage-result', 'parse', '--stage', 'review'],
    { input: invalid }
  );

  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /retryable must be a boolean/i);
}

function testWrongStageFailsLoudly() {
  const result = runCli(
    ['stage-result', 'parse', '--stage', 'build'],
    { input: buildReviewFailMessage() }
  );

  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /expected 'build', got 'review'/i);
}

function testUnknownStageFailsLoudly() {
  const invalid = buildMessage({
    stage: 'qa',
    status: 'completed',
    verdict: 'PASS',
    artifacts: [],
    next_action: 'Proceed.',
    retryable: false,
    metrics: {},
  });
  const result = runCli(
    ['stage-result', 'parse'],
    { input: invalid }
  );

  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /Invalid STAGE_RESULT\.stage 'qa'/i);
}

function testDisableOptimizationLoopMapsToNeedsInput() {
  const root = createWorkspace();
  const stdout = execFileSync(
    'node',
    [CLI, 'orchestration', 'resolve-stage', '--stage', 'verify', '--disable-optimization-loop'],
    {
      cwd: root,
      input: buildVerifyFailMessage(),
      encoding: 'utf8',
    }
  );
  const parsed = JSON.parse(stdout);

  assert.strictEqual(parsed.decision.decision, 'needs_input');
  assert.strictEqual(parsed.decision.needs_user_input, true);
  assert.deepStrictEqual(parsed.decision.loop_context, {
    kind: 'optimization',
    optimization_enabled: false,
  });
  assert.deepStrictEqual(parsed.decision.regressions, [{ metric: 'ttft_p50', delta_pct: 18 }]);
}

function testReviewCycleBoundaryMapsToNeedsInput() {
  const root = createWorkspace();
  const stdout = execFileSync(
    'node',
    [
      CLI,
      'orchestration',
      'resolve-stage',
      '--stage', 'review',
      '--review-cycle', '2',
      '--max-review-cycles', '2',
    ],
    {
      cwd: root,
      input: buildReviewFailMessage(),
      encoding: 'utf8',
    }
  );
  const parsed = JSON.parse(stdout);

  assert.strictEqual(parsed.decision.decision, 'needs_input');
  assert.strictEqual(parsed.decision.needs_user_input, true);
  assert.strictEqual(parsed.decision.remaining_review_cycles, 0);
  assert.deepStrictEqual(parsed.decision.loop_context, {
    kind: 'review',
    review_cycle: 2,
    max_review_cycles: 2,
    remaining_review_cycles: 0,
    within_loop_budget: false,
  });
}

function testInvalidReviewCycleFlagFailsLoudly() {
  const root = createWorkspace();
  const result = runCli(
    ['orchestration', 'resolve-stage', '--stage', 'review', '--review-cycle', 'abc'],
    {
      cwd: root,
      input: buildReviewFailMessage(),
    }
  );

  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /Invalid --review-cycle 'abc'/i);
}

function testInvalidReviewCycleBoundsFailLoudly() {
  const root = createWorkspace();
  const result = runCli(
    [
      'orchestration', 'resolve-stage',
      '--stage', 'review',
      '--review-cycle', '3',
      '--max-review-cycles', '2',
    ],
    {
      cwd: root,
      input: buildReviewFailMessage(),
    }
  );

  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /cannot exceed --max-review-cycles/i);
}

function main() {
  testMissingJsonBlockFailsLoudly();
  testMissingRequiredKeyFailsLoudly();
  testWrongRetryableTypeFailsLoudly();
  testWrongStageFailsLoudly();
  testUnknownStageFailsLoudly();
  testDisableOptimizationLoopMapsToNeedsInput();
  testReviewCycleBoundaryMapsToNeedsInput();
  testInvalidReviewCycleFlagFailsLoudly();
  testInvalidReviewCycleBoundsFailLoudly();
  console.log('week3-stage-result-errors: ok');
}

main();
