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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-pipeline-errors-'));
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

function runCli(cwd, args) {
  const stdout = execFileSync('node', [CLI, ...args], {
    cwd,
    encoding: 'utf8',
  });
  return JSON.parse(stdout);
}

function runCliExpectError(cwd, args) {
  return spawnSync('node', [CLI, ...args], {
    cwd,
    encoding: 'utf8',
  });
}

function testResetOnEmptyPipelineStateIsSafe() {
  const root = createWorkspace();
  const first = runCli(root, ['pipeline', 'reset']);
  const second = runCli(root, ['pipeline', 'reset']);
  const stateMd = fs.readFileSync(path.join(root, '.dev', 'features', 'feat-a', 'STATE.md'), 'utf8');

  assert.strictEqual(first.action, 'reset');
  assert.strictEqual(second.action, 'reset');
  assert.strictEqual(first.pipeline_loop_count, '0');
  assert.strictEqual(second.pipeline_loop_count, '0');
  assert.match(stateMd, /^completed_stages: ""$/m);
  assert.match(stateMd, /^pipeline_loop_count: 0$/m);
  assert.match(stateMd, /^feature_stage: ""$/m);
}

function testCompleteWithoutPriorLoopCountStillWorks() {
  const root = createWorkspace();
  writeFile(
    path.join(root, '.dev', 'features', 'feat-a', 'STATE.md'),
    [
      '---',
      'pipeline_stages: code,review,build',
      'completed_stages: code,review',
      'feature_stage: build',
      '---',
      '',
    ].join('\n')
  );

  const result = runCli(root, ['pipeline', 'complete', '--summary', 'Pipeline complete for feat-a']);
  const stateMd = fs.readFileSync(path.join(root, '.dev', 'features', 'feat-a', 'STATE.md'), 'utf8');

  assert.strictEqual(result.action, 'complete');
  assert.strictEqual(result.completed_stages, 'code,review,build');
  assert.strictEqual(result.feature_stage, 'completed');
  assert.match(stateMd, /^completed_stages: code,review,build$/m);
  assert.match(stateMd, /^feature_stage: completed$/m);
}

function testLoopCountSetAndUpdateBehavior() {
  const root = createWorkspace();
  runCli(root, ['pipeline', 'init', '--stages', 'code,review']);
  const first = runCli(root, ['pipeline', 'loop', '--count', '0']);
  const second = runCli(root, ['pipeline', 'loop', '--count', '5']);
  const stateMd = fs.readFileSync(path.join(root, '.dev', 'features', 'feat-a', 'STATE.md'), 'utf8');

  assert.strictEqual(first.pipeline_loop_count, '0');
  assert.strictEqual(second.pipeline_loop_count, '5');
  assert.match(stateMd, /^pipeline_loop_count: 5$/m);
}

function testCompleteWithoutKnownStagesFailsLoudly() {
  const root = createWorkspace();
  const result = runCliExpectError(root, ['pipeline', 'complete']);

  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /Cannot complete pipeline without known stages/i);
}

function testInvalidLoopCountFailsLoudly() {
  const root = createWorkspace();
  runCli(root, ['pipeline', 'init', '--stages', 'code,review']);
  const result = runCliExpectError(root, ['pipeline', 'loop', '--count', 'abc']);

  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /Invalid loop count 'abc'/i);
}

function main() {
  testResetOnEmptyPipelineStateIsSafe();
  testCompleteWithoutPriorLoopCountStillWorks();
  testLoopCountSetAndUpdateBehavior();
  testCompleteWithoutKnownStagesFailsLoudly();
  testInvalidLoopCountFailsLoudly();
  console.log('week3-pipeline-state-errors: ok');
}

main();
