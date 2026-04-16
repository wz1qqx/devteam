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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-pipeline-state-'));
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

function testPipelineInitWritesStagesAndResetsProgress() {
  const root = createWorkspace();
  const result = runCli(root, ['pipeline', 'init', '--stages', 'code,review,build']);
  const stateMd = fs.readFileSync(path.join(root, '.dev', 'features', 'feat-a', 'STATE.md'), 'utf8');

  assert.strictEqual(result.action, 'init');
  assert.strictEqual(result.pipeline_stages, 'code,review,build');
  assert.strictEqual(result.completed_stages, '');
  assert.strictEqual(result.pipeline_loop_count, '0');
  assert.match(stateMd, /^pipeline_stages: code,review,build$/m);
  assert.match(stateMd, /^completed_stages: ""$/m);
  assert.match(stateMd, /^pipeline_loop_count: 0$/m);
}

function testPipelineLoopUpdatesLoopCounter() {
  const root = createWorkspace();
  runCli(root, ['pipeline', 'init', '--stages', 'code,review']);
  const result = runCli(root, ['pipeline', 'loop', '--count', '2']);
  const stateMd = fs.readFileSync(path.join(root, '.dev', 'features', 'feat-a', 'STATE.md'), 'utf8');

  assert.strictEqual(result.action, 'loop');
  assert.strictEqual(result.pipeline_loop_count, '2');
  assert.match(stateMd, /^pipeline_loop_count: 2$/m);
}

function testPipelineResetClearsProgress() {
  const root = createWorkspace();
  writeFile(
    path.join(root, '.dev', 'features', 'feat-a', 'STATE.md'),
    [
      '---',
      'pipeline_stages: code,review',
      'completed_stages: code',
      'pipeline_loop_count: 3',
      'feature_stage: review',
      '---',
      '',
    ].join('\n')
  );

  const result = runCli(root, ['pipeline', 'reset']);
  const stateMd = fs.readFileSync(path.join(root, '.dev', 'features', 'feat-a', 'STATE.md'), 'utf8');

  assert.strictEqual(result.action, 'reset');
  assert.strictEqual(result.completed_stages, '');
  assert.strictEqual(result.pipeline_loop_count, '0');
  assert.strictEqual(result.feature_stage, '');
  assert.match(stateMd, /^completed_stages: ""$/m);
  assert.match(stateMd, /^pipeline_loop_count: 0$/m);
  assert.match(stateMd, /^feature_stage: ""$/m);
  assert.match(stateMd, /^pipeline_stages: code,review$/m);
}

function testPipelineCompleteMarksPhaseAndWritesCheckpoint() {
  const root = createWorkspace();
  runCli(root, ['pipeline', 'init', '--stages', 'code,review,build']);
  const result = runCli(root, ['pipeline', 'complete', '--summary', 'Pipeline complete for feat-a']);
  const stateMd = fs.readFileSync(path.join(root, '.dev', 'features', 'feat-a', 'STATE.md'), 'utf8');
  const featureConfig = fs.readFileSync(path.join(root, '.dev', 'features', 'feat-a', 'config.yaml'), 'utf8');
  const devlog = fs.readFileSync(path.join(root, '.dev', 'features', 'feat-a', 'devlog.md'), 'utf8');

  assert.strictEqual(result.action, 'complete');
  assert.strictEqual(result.completed_stages, 'code,review,build');
  assert.strictEqual(result.feature_stage, 'completed');
  assert.strictEqual(result.phase.phase, 'completed');
  assert.match(stateMd, /^completed_stages: code,review,build$/m);
  assert.match(stateMd, /^feature_stage: completed$/m);
  assert.match(featureConfig, /^phase: completed$/m);
  assert.match(devlog, /team-complete: Pipeline complete for feat-a/);
}

function main() {
  testPipelineInitWritesStagesAndResetsProgress();
  testPipelineLoopUpdatesLoopCounter();
  testPipelineResetClearsProgress();
  testPipelineCompleteMarksPhaseAndWritesCheckpoint();
  console.log('week3-pipeline-state: ok');
}

main();
