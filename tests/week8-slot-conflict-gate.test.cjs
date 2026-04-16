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
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function runCli(cwd, args) {
  const stdout = execFileSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
  return JSON.parse(stdout);
}

function runCliError(cwd, args) {
  return spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
}

/**
 * Create a real git worktree so run init can snapshot it.
 */
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

/**
 * Mark a feature's pipeline as completed in STATE.md so the run is
 * considered inactive by collectActiveRuns.
 */
function markPipelineCompleted(root, featureName) {
  const statePath = path.join(root, '.dev', 'features', featureName, 'STATE.md');
  writeFile(statePath, [
    '---',
    'feature_stage: completed',
    'pipeline_stages: build',
    'completed_stages: build',
    '---',
    '',
  ].join('\n'));
}

// ---------------------------------------------------------------------------
// Workspace helpers
// ---------------------------------------------------------------------------

/**
 * Single shared worktree: both feat-a and feat-b point at repo-shared-dev.
 */
function createConflictingWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week8-slot-conflict-'));
  makeGitWorktree(root, 'repo-shared-dev');
  fs.mkdirSync(path.join(root, 'repo-base'), { recursive: true });

  writeFile(path.join(root, 'workspace.yaml'), [
    'schema_version: 2',
    `workspace: ${root}`,
    'defaults:',
    '  features:',
    '    - feat-a',
    '    - feat-b',
    'repos: {}',
    'clusters: {}',
  ].join('\n') + '\n');

  for (const featureName of ['feat-a', 'feat-b']) {
    writeFile(path.join(root, '.dev', 'features', featureName, 'config.yaml'), [
      `description: ${featureName}`,
      'phase: build',
      'scope:',
      '  repo-shared:',
      '    dev_worktree: repo-shared-dev',
      'current_tag: null',
      'base_image: null',
    ].join('\n') + '\n');
  }
  return root;
}

/**
 * Two features with sharing_mode: shared and owner_features covering both.
 */
function createSharedSlotWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week8-slot-shared-'));
  makeGitWorktree(root, 'repo-a-dev');
  fs.mkdirSync(path.join(root, 'repo-a-base'), { recursive: true });

  writeFile(path.join(root, 'workspace.yaml'), [
    'schema_version: 2',
    `workspace: ${root}`,
    'defaults:',
    '  features:',
    '    - feat-a',
    '    - feat-b',
    'repos:',
    '  repo-a:',
    '    baselines:',
    '      main: repo-a-base',
    '    dev_slots:',
    '      shared-slot:',
    '        worktree: repo-a-dev',
    '        baseline_id: main',
    '        sharing_mode: shared',
    '        owner_features:',
    '          - feat-a',
    '          - feat-b',
    'clusters: {}',
  ].join('\n') + '\n');

  for (const featureName of ['feat-a', 'feat-b']) {
    writeFile(path.join(root, '.dev', 'features', featureName, 'config.yaml'), [
      `description: ${featureName}`,
      'phase: build',
      'scope:',
      '  repo-a:',
      '    dev_slot: shared-slot',
      'current_tag: null',
      'base_image: null',
    ].join('\n') + '\n');
  }
  return root;
}

/**
 * Single feature workspace: no conflict possible.
 */
function createSingleFeatureWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week8-slot-single-'));
  makeGitWorktree(root, 'repo-dev');
  fs.mkdirSync(path.join(root, 'repo-base'), { recursive: true });

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
    'phase: build',
    'scope:',
    '  repo-x:',
    '    dev_worktree: repo-dev',
    'current_tag: null',
    'base_image: null',
  ].join('\n') + '\n');
  return root;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function testSingleFeatureNeverConflicts() {
  const root = createSingleFeatureWorkspace();
  runCli(root, ['run', 'init', '--feature', 'feat-a', '--stages', 'build']);
  // pipeline init must succeed for a single-feature workspace
  const result = runCli(root, ['pipeline', 'init', '--feature', 'feat-a', '--stages', 'build']);
  assert.strictEqual(result.action, 'init');
  assert.strictEqual(result.feature, 'feat-a');
}

function testConflictingRunBlocksPipelineInit() {
  const root = createConflictingWorkspace();

  // Init run for feat-a and start its pipeline
  runCli(root, ['run', 'init', '--feature', 'feat-a', '--stages', 'build']);
  runCli(root, ['pipeline', 'init', '--feature', 'feat-a', '--stages', 'build']);

  // Init run for feat-b (same dev worktree)
  runCli(root, ['run', 'init', '--feature', 'feat-b', '--stages', 'build']);

  // pipeline init for feat-b must be blocked
  const blocked = runCliError(root, ['pipeline', 'init', '--feature', 'feat-b', '--stages', 'build']);
  assert.notStrictEqual(blocked.status, 0);
  assert.match(blocked.stderr, /slot conflict/i);
  assert.match(blocked.stderr, /feat-a/);
}

function testAllowSlotConflictFlagBypasses() {
  const root = createConflictingWorkspace();

  runCli(root, ['run', 'init', '--feature', 'feat-a', '--stages', 'build']);
  runCli(root, ['pipeline', 'init', '--feature', 'feat-a', '--stages', 'build']);
  runCli(root, ['run', 'init', '--feature', 'feat-b', '--stages', 'build']);

  // --allow-slot-conflict must let feat-b proceed
  const result = runCli(root, [
    'pipeline', 'init',
    '--feature', 'feat-b',
    '--stages', 'build',
    '--allow-slot-conflict',
  ]);
  assert.strictEqual(result.action, 'init');
  assert.strictEqual(result.feature, 'feat-b');
}

function testCompletedPipelineDoesNotBlock() {
  const root = createConflictingWorkspace();

  // Init and immediately mark feat-a pipeline as completed
  runCli(root, ['run', 'init', '--feature', 'feat-a', '--stages', 'build']);
  markPipelineCompleted(root, 'feat-a');

  runCli(root, ['run', 'init', '--feature', 'feat-b', '--stages', 'build']);
  // feat-a is completed → should not block feat-b
  const result = runCli(root, ['pipeline', 'init', '--feature', 'feat-b', '--stages', 'build']);
  assert.strictEqual(result.action, 'init');
  assert.strictEqual(result.feature, 'feat-b');
}

function testSharingModeSharedExemptsConflict() {
  const root = createSharedSlotWorkspace();

  runCli(root, ['run', 'init', '--feature', 'feat-a', '--stages', 'build']);
  runCli(root, ['pipeline', 'init', '--feature', 'feat-a', '--stages', 'build']);

  runCli(root, ['run', 'init', '--feature', 'feat-b', '--stages', 'build']);
  // sharing_mode: shared with both as owners → no conflict error
  const result = runCli(root, ['pipeline', 'init', '--feature', 'feat-b', '--stages', 'build']);
  assert.strictEqual(result.action, 'init');
  assert.strictEqual(result.feature, 'feat-b');
}

function main() {
  testSingleFeatureNeverConflicts();
  testConflictingRunBlocksPipelineInit();
  testAllowSlotConflictFlagBypasses();
  testCompletedPipelineDoesNotBlock();
  testSharingModeSharedExemptsConflict();
  console.log('week8-slot-conflict-gate: ok');
}

main();
