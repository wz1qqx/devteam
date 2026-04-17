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

function runCliRaw(cwd, args) {
  return spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
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

function createWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week8-check-path-'));
  const devRepo = makeGitWorktree(root, 'repo-a-dev');
  const devRepoB = makeGitWorktree(root, 'repo-b-dev');
  fs.mkdirSync(path.join(root, 'repo-base'), { recursive: true });

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
    'phase: code',
    'scope:',
    '  repo-a:',
    '    dev_slot: default',
    'current_tag: null',
    'base_image: null',
  ].join('\n') + '\n');

  // Init run snapshot
  runCli(root, ['run', 'init', '--feature', 'feat-a', '--stages', 'code']);

  return { root, devRepo, devRepoB };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function testPathInsideDevWorktreeIsAllowed() {
  const { root, devRepo } = createWorkspace();
  const targetFile = path.join(devRepo, 'src', 'main.py');

  const result = runCli(root, ['run', 'check-path', '--feature', 'feat-a', '--path', targetFile]);
  assert.strictEqual(result.allowed, true);
  assert.strictEqual(result.matched_repo, 'repo-a');
  assert.ok(result.dev_worktree);
}

function testDevWorktreeRootItselfIsAllowed() {
  const { root, devRepo } = createWorkspace();

  const result = runCli(root, ['run', 'check-path', '--feature', 'feat-a', '--path', devRepo]);
  assert.strictEqual(result.allowed, true);
}

function testWorkspaceRootIsNotAllowed() {
  const { root } = createWorkspace();
  const raw = runCliRaw(root, ['run', 'check-path', '--feature', 'feat-a', '--path', root]);
  const result = JSON.parse(raw.stdout);
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.reason, 'outside_write_scope');
  assert.notStrictEqual(raw.status, 0);
}

function testOtherRepoDevWorktreeIsNotAllowed() {
  const { root, devRepoB } = createWorkspace();
  // repo-b-dev is NOT in feat-a's run scope
  const targetFile = path.join(devRepoB, 'src', 'utils.py');
  const raw = runCliRaw(root, ['run', 'check-path', '--feature', 'feat-a', '--path', targetFile]);
  const result = JSON.parse(raw.stdout);
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(raw.status, 1);
}

function testPathWithoutRunSnapshotFails() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week8-no-run-'));
  writeFile(path.join(root, 'workspace.yaml'), [
    'schema_version: 2',
    `workspace: ${root}`,
    'defaults:',
    '  features:',
    '    - feat-x',
    'repos: {}',
    'clusters: {}',
  ].join('\n') + '\n');
  writeFile(path.join(root, '.dev', 'features', 'feat-x', 'config.yaml'), [
    'description: feat-x',
    'phase: code',
    'scope: {}',
    'current_tag: null',
    'base_image: null',
  ].join('\n') + '\n');

  const raw = runCliRaw(root, ['run', 'check-path', '--feature', 'feat-x', '--path', root]);
  const result = JSON.parse(raw.stdout);
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(result.reason, 'no_run_snapshot');
  assert.strictEqual(raw.status, 1);
}

function testSymlinkTraversalPrevented() {
  const { root, devRepo } = createWorkspace();

  // Create a symlink inside the dev worktree that points outside it.
  const linkPath = path.join(devRepo, 'escape-link');
  try {
    fs.symlinkSync(root, linkPath);
  } catch (_) {
    // If symlink creation fails in this environment, skip gracefully.
    return;
  }

  // The symlink target resolves to root, which is outside the dev worktree.
  const raw = runCliRaw(root, ['run', 'check-path', '--feature', 'feat-a', '--path', linkPath]);
  const result = JSON.parse(raw.stdout);
  // After real-path resolution the link points to root → outside scope.
  assert.strictEqual(result.allowed, false);
  assert.strictEqual(raw.status, 1);
}

function main() {
  testPathInsideDevWorktreeIsAllowed();
  testDevWorktreeRootItselfIsAllowed();
  testWorkspaceRootIsNotAllowed();
  testOtherRepoDevWorktreeIsNotAllowed();
  testPathWithoutRunSnapshotFails();
  testSymlinkTraversalPrevented();
  console.log('week8-run-path-validation: ok');
}

main();
