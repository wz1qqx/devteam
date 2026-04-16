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

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week7-hooks-frozen-run-'));
  const logPath = path.join(root, 'hooks.log');

  writeFile(
    path.join(root, 'workspace.yaml'),
    [
      'schema_version: 2',
      `workspace: ${root}`,
      'defaults:',
      '  features:',
      '    - feat-a',
      'repos:',
      '  repo-a:',
      '    remotes:',
      '      official: https://example.com/repo-a.git',
      '    baselines:',
      '      main:',
      '        id: baseline-main',
      '        ref: main',
      '        worktree: repo-a-base',
      '    dev_slots:',
      '      slot-a:',
      '        worktree: repo-a-dev-slot-a',
      '        baseline_id: baseline-main',
      '      slot-b:',
      '        worktree: repo-a-dev-slot-b',
      '        baseline_id: baseline-main',
      'clusters: {}',
    ].join('\n') + '\n'
  );
  writeFile(
    path.join(root, '.dev', 'features', 'feat-a', 'config.yaml'),
    [
      'description: Feature A',
      'phase: build',
      'scope:',
      '  repo-a:',
      '    dev_slot: slot-a',
      'current_tag: null',
      'base_image: null',
      'hooks:',
      '  pre_build:',
      `    - 'printf "%s\\n" "$DEVTEAM_DEV_WORKTREE" >> "${logPath}"'`,
      '  post_build: []',
      '  pre_deploy: []',
      '  post_deploy: []',
      '  post_verify: []',
      '  learned: []',
    ].join('\n') + '\n'
  );

  fs.mkdirSync(path.join(root, 'repo-a-base'), { recursive: true });

  for (const slotDir of ['repo-a-dev-slot-a', 'repo-a-dev-slot-b']) {
    const repoPath = path.join(root, slotDir);
    fs.mkdirSync(repoPath, { recursive: true });
    git(repoPath, ['init']);
    git(repoPath, ['config', 'user.email', 'devteam-test@example.com']);
    git(repoPath, ['config', 'user.name', 'Devteam Test']);
    writeFile(path.join(repoPath, 'README.md'), `# ${slotDir}\n`);
    git(repoPath, ['add', '.']);
    git(repoPath, ['commit', '-m', `init ${slotDir}`]);
  }

  return { root, logPath };
}

function testHooksStayBoundToFrozenRunScope() {
  const { root, logPath } = createWorkspace();

  const run = runCli(root, ['run', 'init', '--feature', 'feat-a', '--stages', 'build']);
  assert.strictEqual(run.ready_for_pipeline, true);
  assert.strictEqual(run.run.repos[0].dev_worktree, path.join(root, 'repo-a-dev-slot-a'));

  // Mutate live feature config after run init to a different slot.
  const configPath = path.join(root, '.dev', 'features', 'feat-a', 'config.yaml');
  const mutated = fs.readFileSync(configPath, 'utf8').replace('dev_slot: slot-a', 'dev_slot: slot-b');
  fs.writeFileSync(configPath, mutated, 'utf8');

  runCli(root, ['hooks', 'run', '--feature', 'feat-a', '--phase', 'pre_build']);

  const logged = fs.readFileSync(logPath, 'utf8').trim();
  assert.strictEqual(logged, path.join(root, 'repo-a-dev-slot-a'));
}

function main() {
  testHooksStayBoundToFrozenRunScope();
  console.log('week7-hooks-frozen-run-scope: ok');
}

main();
