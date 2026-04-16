'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'lib', 'devteam.cjs');
const {
  addDecision,
  addBlocker,
  writeHandoff,
  readHandoff,
  deleteHandoff,
} = require('../lib/session.cjs');

function runCli(cwd, args) {
  const stdout = execFileSync('node', [CLI, ...args], {
    cwd,
    encoding: 'utf8',
  });
  return JSON.parse(stdout);
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function createWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week2-handoff-'));
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
  return root;
}

function testDecisionAndBlockerRequireCanonicalFeatureField() {
  const root = createWorkspace();

  assert.throws(() => addDecision(root, {
    feature_name: 'feat-a',
    id: 'D-01',
    decision: 'old field should fail',
    rationale: 'canonical field is required',
    date: '2026-04-16',
  }), /Decision feature is required/);

  assert.throws(() => addBlocker(root, {
    feature_name: 'feat-a',
    id: 'B-01',
    blocker: 'old field should fail',
    type: 'design',
    workaround: 'use feature',
  }), /Blocker feature is required/);
}

function testHandoffHelpersRequireFeatureName() {
  const root = createWorkspace();

  assert.throws(() => writeHandoff(root, { next_action: 'continue' }), /Feature name is required for HANDOFF\.json/);
  assert.throws(() => readHandoff(root), /Feature name is required for HANDOFF\.json/);
  assert.throws(() => deleteHandoff(root), /Feature name is required for HANDOFF\.json/);
}

function testHandoffHelpersUseFeatureScopedPathsOnly() {
  const root = createWorkspace();
  const globalHandoffPath = path.join(root, '.dev', 'HANDOFF.json');
  writeFile(globalHandoffPath, JSON.stringify({ feature: 'feat-a', next_action: 'wrong scope' }, null, 2) + '\n');

  const writeResult = writeHandoff(root, {
    next_action: 'continue feat-a',
    context_notes: 'focus on handoff cleanup',
  }, 'feat-a');

  assert.strictEqual(
    writeResult.path,
    path.join(root, '.dev', 'features', 'feat-a', 'HANDOFF.json')
  );

  const handoff = readHandoff(root, 'feat-a');
  assert.strictEqual(handoff.feature, 'feat-a');
  assert.strictEqual(handoff.next_action, 'continue feat-a');
  assert.ok(handoff.paused_at);
  assert.strictEqual(handoff.version, '2.0');

  assert.strictEqual(deleteHandoff(root, 'feat-a'), true);
  assert.strictEqual(fs.existsSync(globalHandoffPath), true);
  assert.strictEqual(readHandoff(root, 'feat-a'), null);
}

function testInitResumeIgnoresWorkspaceLevelHandoffFallback() {
  const root = createWorkspace();

  writeFile(
    path.join(root, '.dev', 'HANDOFF.json'),
    JSON.stringify({
      feature: 'feat-a',
      next_action: 'wrong fallback',
      paused_at: '2026-04-16T00:00:00.000Z',
    }, null, 2) + '\n'
  );

  let result = runCli(root, ['init', 'resume', '--feature', 'feat-a']);
  assert.strictEqual(result.handoff, null);

  writeHandoff(root, {
    next_action: 'resume feat-a',
    paused_at: '2026-04-16T01:00:00.000Z',
  }, 'feat-a');

  result = runCli(root, ['init', 'resume', '--feature', 'feat-a']);
  assert.strictEqual(result.handoff.feature, 'feat-a');
  assert.strictEqual(result.handoff.next_action, 'resume feat-a');
  assert.strictEqual(result.handoff.paused_at, '2026-04-16T01:00:00.000Z');
}

function main() {
  testDecisionAndBlockerRequireCanonicalFeatureField();
  testHandoffHelpersRequireFeatureName();
  testHandoffHelpersUseFeatureScopedPathsOnly();
  testInitResumeIgnoresWorkspaceLevelHandoffFallback();
  console.log('week2-session-handoff: ok');
}

main();
