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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week9-pause-resume-run-'));
  makeGitWorktree(root, 'repo-a-slot-a-dev');
  makeGitWorktree(root, 'repo-a-slot-b-dev');

  writeFile(path.join(root, 'workspace.yaml'), [
    'schema_version: 2',
    `workspace: ${root}`,
    'defaults:',
    '  features:',
    '    - feat-a',
    'repos:',
    '  repo-a:',
    '    dev_slots:',
    '      slot-a:',
    '        worktree: repo-a-slot-a-dev',
    '      slot-b:',
    '        worktree: repo-a-slot-b-dev',
    'clusters: {}',
  ].join('\n') + '\n');

  writeFeatureConfig(root, 'slot-a');
  return root;
}

function writeFeatureConfig(root, slotId) {
  writeFile(path.join(root, '.dev', 'features', 'feat-a', 'config.yaml'), [
    'description: feat-a',
    'phase: code',
    'scope:',
    '  repo-a:',
    `    dev_slot: ${slotId}`,
    'current_tag: null',
    'base_image: null',
  ].join('\n') + '\n');
}

function testPauseAndResumeReposStayBoundToRunSnapshot() {
  const root = createWorkspace();
  const slotA = path.join(root, 'repo-a-slot-a-dev');
  const slotB = path.join(root, 'repo-a-slot-b-dev');

  const run = runCli(root, ['run', 'init', '--feature', 'feat-a', '--stages', 'code']);
  assert.strictEqual(run.run.repos[0].dev_worktree, slotA);

  // Mutate live config after RUN snapshot creation.
  writeFeatureConfig(root, 'slot-b');

  const pauseInit = runCli(root, ['init', 'pause', '--feature', 'feat-a']);
  const resumeInit = runCli(root, ['init', 'resume', '--feature', 'feat-a']);

  assert.strictEqual(pauseInit.repos['repo-a'].dev_worktree, slotA);
  assert.strictEqual(resumeInit.repos['repo-a'].dev_worktree, slotA);
  assert.notStrictEqual(pauseInit.repos['repo-a'].dev_worktree, slotB);
  assert.notStrictEqual(resumeInit.repos['repo-a'].dev_worktree, slotB);
}

function main() {
  testPauseAndResumeReposStayBoundToRunSnapshot();
  console.log('week9-pause-resume-frozen-repos: ok');
}

main();
