'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const STATUSLINE = path.resolve(__dirname, '..', 'hooks', 'devteam-statusline.js');

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function runStatusline(input) {
  return execFileSync('node', [STATUSLINE], {
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
}

function createWorkspace({ featureCount = 1, phase = 'code' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week4-'));
  const featureLines = [];
  for (let i = 0; i < featureCount; i++) {
    featureLines.push(`    - feat-${String.fromCharCode(97 + i)}`);
  }

  writeFile(
    path.join(root, 'workspace.yaml'),
    [
      'schema_version: 2',
      `workspace: ${root}`,
      'devlog:',
      '  group: inference-platform',
      'defaults:',
      '  active_cluster: dev',
      '  features:',
      ...featureLines,
      'clusters:',
      '  dev:',
      '    namespace: dev-ns',
      'repos: {}',
    ].filter(Boolean).join('\n') + '\n'
  );

  for (let i = 0; i < featureCount; i++) {
    const featureName = `feat-${String.fromCharCode(97 + i)}`;
    writeFile(
      path.join(root, '.dev', 'features', featureName, 'config.yaml'),
      [
        `description: ${featureName}`,
        `phase: ${phase}`,
        'scope: {}',
      ].join('\n') + '\n'
    );
  }

  return root;
}

function testReadsNestedWorkspaceFields() {
  const root = createWorkspace({ featureCount: 2, phase: 'review' });
  const output = runStatusline({
    cwd: root,
    model: { display_name: 'Claude Test' },
    context_window: { used_percentage: 42 },
  });

  assert.match(output, /^Claude Test \| ctx \[====      \] 42% \| inference-platform$/);
}

function testFallsBackToSingleFeatureWithoutActiveFeature() {
  const root = createWorkspace({ featureCount: 1, phase: 'plan' });
  const output = runStatusline({
    workspace: { project_dir: root },
    model: { id: 'claude-opus-4-6' },
    context_window: { used_percentage: 5 },
  });

  assert.match(output, /^claude-opus-4-6 \| ctx \[=         \] 5% \| inference-platform \| feat-a \| \[plan\]$/);
}

function testFallsBackToFeatureStateForPhase() {
  const root = createWorkspace({ featureCount: 1, phase: '' });
  writeFile(
    path.join(root, '.dev', 'features', 'feat-a', 'STATE.md'),
    [
      '---',
      'feature_stage: verify',
      'phase: ship',
      '---',
    ].join('\n') + '\n'
  );

  const output = runStatusline({
    cwd: root,
    model: { display_name: 'Claude Test' },
  });

  assert.match(output, /^Claude Test \| inference-platform \| feat-a \| \[verify\]$/);
}

function testDoesNotReadGlobalStateFallback() {
  const root = createWorkspace({ featureCount: 1, phase: '' });
  writeFile(
    path.join(root, '.dev', 'STATE.md'),
    [
      '---',
      'feature_stage: ship',
      'phase: build',
      '---',
    ].join('\n') + '\n'
  );

  const output = runStatusline({
    cwd: root,
    model: { display_name: 'Claude Test' },
  });

  assert.match(output, /^Claude Test \| inference-platform \| feat-a$/);
}

function main() {
  testReadsNestedWorkspaceFields();
  testFallsBackToSingleFeatureWithoutActiveFeature();
  testFallsBackToFeatureStateForPhase();
  testDoesNotReadGlobalStateFallback();
  console.log('week4-statusline: ok');
}

main();
