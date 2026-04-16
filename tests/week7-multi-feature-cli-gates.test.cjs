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

function runCliWithInput(cwd, args, input) {
  const stdout = execFileSync('node', [CLI, ...args], {
    cwd,
    input,
    encoding: 'utf8',
  });
  return JSON.parse(stdout);
}

function runCliError(cwd, args, input = '') {
  return spawnSync('node', [CLI, ...args], {
    cwd,
    input,
    encoding: 'utf8',
  });
}

function createWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week7-multi-feature-cli-gates-'));
  writeFile(
    path.join(root, 'workspace.yaml'),
    [
      'schema_version: 2',
      `workspace: ${root}`,
      'build_server:',
      '  registry: registry.example.com',
      'defaults:',
      '  features:',
      '    - feat-a',
      '    - feat-b',
      'repos: {}',
      'clusters: {}',
    ].join('\n') + '\n'
  );

  for (const featureName of ['feat-a', 'feat-b']) {
    writeFile(
      path.join(root, '.dev', 'features', featureName, 'config.yaml'),
      [
        `description: ${featureName}`,
        'phase: plan',
        'scope: {}',
        'current_tag: null',
        'base_image: nvcr.io/base/model:1.0',
        'build:',
        `  image_name: ${featureName}-image`,
        'build_history: []',
      ].join('\n') + '\n'
    );
  }
  return root;
}

function planStageResultMessage() {
  return [
    '# Implementation Plan: feat-a',
    '',
    '## STAGE_RESULT',
    '```json',
    JSON.stringify({
      stage: 'plan',
      status: 'completed',
      verdict: 'PASS',
      artifacts: [{ kind: 'plan', path: '.dev/features/feat-a/plan.md' }],
      next_action: 'Coder can execute plan.',
      retryable: false,
      metrics: { task_count: 1, wave_count: 1, build_mode: 'fast' },
    }, null, 2),
    '```',
    '',
  ].join('\n');
}

function testExplicitFeatureFlagRequiredForMultiFeatureRuntimeCalls() {
  const root = createWorkspace();
  const message = planStageResultMessage();

  const resolveMissingFeature = runCliError(root, ['orchestration', 'resolve-stage', '--stage', 'plan'], message);
  assert.notStrictEqual(resolveMissingFeature.status, 0);
  assert.match(resolveMissingFeature.stderr, /No feature specified/i);

  const resolveWithFeature = runCliWithInput(root, ['orchestration', 'resolve-stage', '--feature', 'feat-a', '--stage', 'plan'], message);
  assert.strictEqual(resolveWithFeature.feature, 'feat-a');
  assert.strictEqual(resolveWithFeature.result.stage, 'plan');

  runCli(root, ['pipeline', 'init', '--feature', 'feat-a', '--stages', 'plan']);
  const completeMissingFeature = runCliError(root, ['pipeline', 'complete', '--stages', 'plan']);
  assert.notStrictEqual(completeMissingFeature.status, 0);
  assert.match(completeMissingFeature.stderr, /No feature specified/i);

  const completeWithFeature = runCli(root, ['pipeline', 'complete', '--feature', 'feat-a', '--stages', 'plan']);
  assert.strictEqual(completeWithFeature.feature, 'feat-a');
  assert.strictEqual(completeWithFeature.completed_stages, 'plan');

  const buildMissingFeature = runCliError(root, ['build', 'record', '--tag', 'v1', '--changes', 'test']);
  assert.notStrictEqual(buildMissingFeature.status, 0);
  assert.match(buildMissingFeature.stderr, /No feature specified/i);

  const buildWithFeature = runCli(root, ['build', 'record', '--feature', 'feat-a', '--tag', 'v1', '--changes', 'test']);
  assert.strictEqual(buildWithFeature.feature, 'feat-a');
  assert.strictEqual(buildWithFeature.tag, 'v1');
}

function main() {
  testExplicitFeatureFlagRequiredForMultiFeatureRuntimeCalls();
  console.log('week7-multi-feature-cli-gates: ok');
}

main();
