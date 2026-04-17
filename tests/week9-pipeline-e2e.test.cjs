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

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function runCli(cwd, args) {
  const stdout = execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
  return JSON.parse(stdout);
}

function runCliError(cwd, args) {
  return spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
}

function runCliWithInput(cwd, args, input) {
  const result = spawnSync('node', [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    input,
  });
  if (result.status !== 0) {
    throw new Error(`Command failed (${args.join(' ')}):\n${result.stderr}\n${result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

function makeGitWorktree(root, name) {
  const repoPath = path.join(root, name);
  fs.mkdirSync(repoPath, { recursive: true });
  git(repoPath, ['init']);
  git(repoPath, ['config', 'user.email', 'devteam-test@example.com']);
  git(repoPath, ['config', 'user.name', 'Devteam Test']);
  writeFile(path.join(repoPath, 'README.md'), `# ${name}\n`);
  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '-m', `init ${name}`]);
  return repoPath;
}

function createSimpleWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week9-e2e-simple-'));
  writeFile(path.join(root, 'workspace.yaml'), [
    'schema_version: 2',
    `workspace: ${root}`,
    'defaults:',
    '  features:',
    '    - feat-a',
    'repos: {}',
    'clusters: {}',
  ].join('\n') + '\n');
  writeFile(path.join(root, '.dev', 'features', 'feat-a', 'config.yaml'), [
    'description: feat-a',
    'phase: code',
    'scope: {}',
    'current_tag: null',
    'base_image: null',
  ].join('\n') + '\n');
  return root;
}

function createDirtyWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week9-e2e-dirty-'));
  const repoPath = makeGitWorktree(root, 'repo-a-dev');
  writeFile(path.join(root, 'workspace.yaml'), [
    'schema_version: 2',
    `workspace: ${root}`,
    'defaults:',
    '  features:',
    '    - feat-a',
    'repos:',
    '  repo-a:',
    '    dev_slots:',
    '      default:',
    '        worktree: repo-a-dev',
    'clusters: {}',
  ].join('\n') + '\n');
  writeFile(path.join(root, '.dev', 'features', 'feat-a', 'config.yaml'), [
    'description: feat-a',
    'phase: build',
    'scope:',
    '  repo-a:',
    '    dev_slot: default',
    'current_tag: null',
    'base_image: null',
  ].join('\n') + '\n');

  // Keep repo dirty before run init.
  writeFile(path.join(repoPath, 'README.md'), '# dirty\n');
  return root;
}

function createConflictingWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week9-e2e-slot-'));
  makeGitWorktree(root, 'repo-shared-dev');
  fs.mkdirSync(path.join(root, 'repo-base'), { recursive: true });
  writeFile(path.join(root, 'workspace.yaml'), [
    'schema_version: 2',
    `workspace: ${root}`,
    'defaults:',
    '  features:',
    '    - feat-a',
    '    - feat-b',
    'repos:',
    '  repo-shared:',
    '    dev_slots:',
    '      shared-dev:',
    '        worktree: repo-shared-dev',
    'clusters: {}',
  ].join('\n') + '\n');

  for (const featureName of ['feat-a', 'feat-b']) {
    writeFile(path.join(root, '.dev', 'features', featureName, 'config.yaml'), [
      `description: ${featureName}`,
      'phase: build',
      'scope:',
      '  repo-shared:',
      '    dev_slot: shared-dev',
      'current_tag: null',
      'base_image: null',
    ].join('\n') + '\n');
  }

  return root;
}

function createBuildWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week9-e2e-build-'));
  makeGitWorktree(root, 'repo-a-dev');
  fs.mkdirSync(path.join(root, 'repo-a-base'), { recursive: true });

  writeFile(path.join(root, 'workspace.yaml'), [
    'schema_version: 2',
    `workspace: ${root}`,
    'build_server:',
    '  registry: registry.example.com',
    'defaults:',
    '  features:',
    '    - feat-a',
    'repos:',
    '  repo-a:',
    '    dev_slots:',
    '      default:',
    '        worktree: repo-a-dev',
    'clusters: {}',
  ].join('\n') + '\n');
  writeFile(path.join(root, '.dev', 'features', 'feat-a', 'config.yaml'), [
    'description: feat-a',
    'phase: build',
    'scope:',
    '  repo-a:',
    '    dev_slot: default',
    'current_tag: null',
    'base_image: nvcr.io/base/model:1.0',
    'build:',
    '  image_name: feat-a-image',
    'build_history: []',
  ].join('\n') + '\n');

  return root;
}

function testHappyPathLifecycleRunPipelineComplete() {
  const root = createSimpleWorkspace();
  const run = runCli(root, ['run', 'init', '--feature', 'feat-a', '--stages', 'code']);
  const init = runCli(root, ['pipeline', 'init', '--feature', 'feat-a', '--stages', 'code']);
  const done = runCli(root, ['pipeline', 'complete', '--feature', 'feat-a', '--stages', 'code']);
  const state = fs.readFileSync(path.join(root, '.dev', 'features', 'feat-a', 'STATE.md'), 'utf8');

  assert.strictEqual(run.ready_for_pipeline, true);
  assert.strictEqual(init.action, 'init');
  assert.strictEqual(done.action, 'complete');
  assert.match(state, /^feature_stage: completed$/m);
  assert.ok(fs.existsSync(path.join(root, '.dev', 'features', 'feat-a', 'RUN.json')));
}

function testDirtyGateDecisionContinueThenPipelineInit() {
  const root = createDirtyWorkspace();
  const pending = runCli(root, ['run', 'init', '--feature', 'feat-a', '--stages', 'build']);
  const continued = runCli(root, [
    'run', 'init',
    '--feature', 'feat-a',
    '--stages', 'build',
    '--restart',
    '--dirty-decision', 'continue',
  ]);
  const pipeline = runCli(root, ['pipeline', 'init', '--feature', 'feat-a', '--stages', 'build']);

  assert.strictEqual(pending.requires_dirty_decision, true);
  assert.strictEqual(continued.run.dirty_policy.decision, 'continue');
  assert.strictEqual(pipeline.action, 'init');
}

function testSlotConflictRejectThenOverride() {
  const root = createConflictingWorkspace();
  runCli(root, ['run', 'init', '--feature', 'feat-a', '--stages', 'build']);
  runCli(root, ['pipeline', 'init', '--feature', 'feat-a', '--stages', 'build']);
  runCli(root, ['run', 'init', '--feature', 'feat-b', '--stages', 'build']);

  const blocked = runCliError(root, ['pipeline', 'init', '--feature', 'feat-b', '--stages', 'build']);
  assert.notStrictEqual(blocked.status, 0);
  assert.match(blocked.stderr, /slot conflict/i);
  assert.match(blocked.stderr, /feat-a/);

  const override = runCli(root, [
    'pipeline', 'init',
    '--feature', 'feat-b',
    '--stages', 'build',
    '--allow-slot-conflict',
  ]);
  assert.strictEqual(override.action, 'init');
}

function testBuildRecordUsesRunProvenance() {
  const root = createBuildWorkspace();
  const run = runCli(root, ['run', 'init', '--feature', 'feat-a', '--stages', 'build']);
  const result = runCli(root, [
    'build', 'record',
    '--feature', 'feat-a',
    '--tag', 'v1',
    '--changes', 'e2e build provenance',
  ]);

  assert.strictEqual(result.run_id, run.run.run_id);
  assert.ok(Array.isArray(result.source_refs));
  assert.strictEqual(result.source_refs[0].repo, run.run.repos[0].repo);
  assert.strictEqual(result.source_refs[0].start_head, run.run.repos[0].start_head);
}

function testCompletedPipelineDoesNotBlockNextFeature() {
  const root = createConflictingWorkspace();
  runCli(root, ['run', 'init', '--feature', 'feat-a', '--stages', 'build']);
  runCli(root, ['pipeline', 'init', '--feature', 'feat-a', '--stages', 'build']);
  runCli(root, ['pipeline', 'complete', '--feature', 'feat-a', '--stages', 'build']);

  runCli(root, ['run', 'init', '--feature', 'feat-b', '--stages', 'build']);
  const result = runCli(root, ['pipeline', 'init', '--feature', 'feat-b', '--stages', 'build']);
  assert.strictEqual(result.action, 'init');
}

function testResolveStageLinkedChain() {
  const root = createSimpleWorkspace();
  runCli(root, ['run', 'init', '--feature', 'feat-a', '--stages', 'code']);
  runCli(root, ['pipeline', 'init', '--feature', 'feat-a', '--stages', 'code']);

  const stageMessage = [
    'Code stage completed successfully.',
    '',
    '## STAGE_RESULT',
    '```json',
    JSON.stringify({
      stage: 'code',
      status: 'completed',
      verdict: 'PASS',
      artifacts: [],
      next_action: 'Proceed to review.',
      retryable: false,
      metrics: { tasks_completed: 1 },
    }, null, 2),
    '```',
    '',
  ].join('\n');

  const resolved = runCliWithInput(root, [
    'orchestration', 'resolve-stage',
    '--feature', 'feat-a',
    '--stage', 'code',
    '--summary', 'Code complete for feat-a',
  ], stageMessage);

  assert.strictEqual(resolved.decision.decision, 'accept');
  assert.ok(resolved.acceptance && resolved.acceptance.accepted);
  assert.strictEqual(resolved.acceptance.feature, 'feat-a');
  assert.strictEqual(resolved.acceptance.stage, 'code');

  const completed = runCli(root, ['pipeline', 'complete', '--feature', 'feat-a', '--stages', 'code']);
  assert.strictEqual(completed.action, 'complete');
}

function main() {
  testHappyPathLifecycleRunPipelineComplete();
  testDirtyGateDecisionContinueThenPipelineInit();
  testSlotConflictRejectThenOverride();
  testBuildRecordUsesRunProvenance();
  testCompletedPipelineDoesNotBlockNextFeature();
  testResolveStageLinkedChain();
  console.log('week9-pipeline-e2e: ok');
}

main();
