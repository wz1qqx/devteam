'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadState } = require('../lib/state.cjs');

const repoRoot = path.resolve(__dirname, '..');
const CLI = path.join(repoRoot, 'lib', 'devteam.cjs');

const AGENTS = [
  ['agents/spec.md', 'spec'],
  ['agents/planner.md', 'plan'],
  ['agents/coder.md', 'code'],
  ['agents/reviewer.md', 'review'],
  ['agents/builder.md', 'build'],
  ['agents/shipper.md', 'ship'],
  ['agents/verifier.md', 'verify'],
  ['agents/vllm-opter.md', 'vllm-opt'],
];

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function testReferenceContractExists() {
  const contract = read('skills/references/stage-result-contract.md');

  for (const key of ['"stage"', '"status"', '"verdict"', '"artifacts"', '"next_action"', '"retryable"', '"metrics"']) {
    assert.match(contract, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(contract, /The orchestrator owns:/);
}

function testAgentsUseStructuredStageResultAndDoNotOwnCheckpoints() {
  for (const [relativePath, stage] of AGENTS) {
    const content = read(relativePath);

    assert.match(content, /## STAGE_RESULT/);
    assert.match(content, new RegExp(`"stage": "${stage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
    for (const key of ['"status"', '"verdict"', '"artifacts"', '"next_action"', '"retryable"', '"metrics"']) {
      assert.match(content, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }

    assert.doesNotMatch(content, /checkpoint --action/);
    assert.doesNotMatch(content, /state update phase/);
    assert.doesNotMatch(content, /state update feature_stage/);
    assert.doesNotMatch(content, /state update completed_stages/);
  }

  assert.match(read('agents/builder.md'), /build record/);
}

function testOrchestratorConsumesStructuredStageResults() {
  const orchestrator = read('skills/orchestrator.md');

  assert.match(orchestrator, /stage-result-contract\.md/);
  assert.match(orchestrator, /STAGE_RESULT_PROTOCOL/);
  assert.match(orchestrator, /orchestration resolve-stage/);
  assert.match(orchestrator, /pipeline init/);
  assert.match(orchestrator, /pipeline reset/);
  assert.match(orchestrator, /pipeline loop/);
  assert.match(orchestrator, /pipeline complete/);
  assert.match(orchestrator, /Agents do NOT update `feature_stage`, `completed_stages`, or workflow checkpoints/);
  assert.doesNotMatch(orchestrator, /stage-result parse/);
  assert.doesNotMatch(orchestrator, /stage-result decide/);
  assert.doesNotMatch(orchestrator, /stage-result accept/);
  assert.doesNotMatch(orchestrator, /state update completed_stages/);
  assert.doesNotMatch(orchestrator, /state update feature_stage/);
  assert.doesNotMatch(orchestrator, /checkpoint --action/);
  assert.match(orchestrator, /--report-path "\$WORKSPACE\/\.dev\/features\/\$FEATURE\/review\.md"/);
  assert.match(orchestrator, /--report-path "\$WORKSPACE\/\.dev\/features\/\$FEATURE\/verify\.md"/);
  assert.match(orchestrator, /optimization-guidance\.md/);
}

function testFeatureArtifactStateIncludesVerifyAndOptimizationReports() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-stage-result-'));
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
      'phase: verify',
      'scope: {}',
    ].join('\n') + '\n'
  );
  writeFile(path.join(root, '.dev', 'features', 'feat-a', 'verify.md'), '# Verify\n');
  writeFile(path.join(root, '.dev', 'features', 'feat-a', 'optimization-guidance.md'), '# Guidance\n');

  const state = loadState('feat-a', root);
  assert.deepStrictEqual(state.verifies, ['feat-a']);
  assert.deepStrictEqual(state.optimizations, ['feat-a']);

  const stdout = execFileSync('node', [CLI, 'init', 'team'], {
    cwd: root,
    encoding: 'utf8',
  });
  const result = JSON.parse(stdout);

  assert.strictEqual(result.feature_state.verify_report_exists, true);
  assert.strictEqual(result.feature_state.optimization_guidance_exists, true);
}

function main() {
  testReferenceContractExists();
  testAgentsUseStructuredStageResultAndDoNotOwnCheckpoints();
  testOrchestratorConsumesStructuredStageResults();
  testFeatureArtifactStateIncludesVerifyAndOptimizationReports();
  console.log('week3-stage-result-contract: ok');
}

main();
