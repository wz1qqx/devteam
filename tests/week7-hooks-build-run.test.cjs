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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week7-hooks-build-run-'));
  const logPath = path.join(root, 'hooks.log');
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
      'repos:',
      '  repo-a:',
      '    upstream: https://example.com/repo-a.git',
      '    baselines:',
      '      main: repo-a-base',
      '    dev_slots:',
      '      default:',
      '        worktree: repo-a-dev',
      '        baseline_id: main',
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
      '    base_ref: main',
      '    dev_slot: default',
      'current_tag: null',
      'base_image: nvcr.io/base/model:1.0',
      'build:',
      '  image_name: feat-a-image',
      'hooks:',
      '  pre_build:',
      `    - 'printf "pre-build\\n" >> "${logPath}"'`,
      '  post_build:',
      "    - 'exit 3'",
      `    - 'printf "post-build\\n" >> "${logPath}"'`,
      '  pre_deploy: []',
      '  post_deploy: []',
      '  post_verify: []',
      '  learned:',
      "    - name: learned-pre-build",
      '      trigger: pre_build',
      `      command: 'printf "learned-pre\\n" >> "${logPath}"'`,
      "    - name: learned-post-build",
      '      trigger: post_build',
      `      command: 'printf "learned-post\\n" >> "${logPath}"'`,
      'build_history: []',
    ].join('\n') + '\n'
  );

  fs.mkdirSync(path.join(root, 'repo-a-base'), { recursive: true });
  const repoPath = path.join(root, 'repo-a-dev');
  fs.mkdirSync(repoPath, { recursive: true });
  git(repoPath, ['init']);
  git(repoPath, ['config', 'user.email', 'devteam-test@example.com']);
  git(repoPath, ['config', 'user.name', 'Devteam Test']);
  writeFile(path.join(repoPath, 'README.md'), '# Repo A\n');
  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '-m', 'init']);
  const head = git(repoPath, ['rev-parse', 'HEAD']);

  return { root, logPath, head };
}

function readHookLog(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

function testRunSnapshotHooksAndBuildChainIntegration() {
  const { root, logPath, head } = createWorkspace();

  const run = runCli(root, ['run', 'init', '--feature', 'feat-a', '--stages', 'build,ship,verify']);
  assert.strictEqual(run.ready_for_pipeline, true);
  assert.strictEqual(run.run.repos[0].repo, 'repo-a');
  assert.strictEqual(run.run.repos[0].start_head, head);

  const preBuild = runCli(root, ['hooks', 'run', '--feature', 'feat-a', '--phase', 'pre_build']);
  assert.strictEqual(preBuild.failed_count, 0);
  const postBuild = runCli(root, ['hooks', 'run', '--feature', 'feat-a', '--phase', 'post_build']);
  assert.strictEqual(postBuild.failed_count, 1);
  assert.strictEqual(postBuild.blocking, false);

  const build1 = runCli(root, [
    'build',
    'record',
    '--feature',
    'feat-a',
    '--tag',
    'v1',
    '--changes',
    'first build',
    '--mode',
    'fast',
  ]);
  const build2 = runCli(root, [
    'build',
    'record',
    '--feature',
    'feat-a',
    '--tag',
    'v2',
    '--changes',
    'incremental build',
    '--mode',
    'full',
  ]);

  assert.strictEqual(build1.parent_image, 'nvcr.io/base/model:1.0');
  assert.strictEqual(build2.parent_image, 'registry.example.com/feat-a-image:v1');
  assert.strictEqual(build2.run_id, run.run.run_id);
  assert.ok(build2.source_refs.some(ref => ref.repo === 'repo-a' && ref.start_head === head));

  const hookLog = readHookLog(logPath);
  assert.deepStrictEqual(hookLog, ['pre-build', 'learned-pre', 'post-build', 'learned-post']);

  const config = runCli(root, ['config', 'load']);
  const history = config.features['feat-a'].build_history;
  assert.strictEqual(history.length, 2);
  assert.strictEqual(history[0].tag, 'v2');
  assert.strictEqual(history[0].parent_image, 'registry.example.com/feat-a-image:v1');
  assert.strictEqual(history[1].tag, 'v1');
  assert.strictEqual(history[1].parent_image, 'nvcr.io/base/model:1.0');
  assert.strictEqual(history[0].run_id, run.run.run_id);

  const manifestPath = path.join(root, '.dev', 'features', 'feat-a', 'build-manifest.md');
  const manifest = fs.readFileSync(manifestPath, 'utf8');
  assert.match(manifest, /Tag \| Date \| Parent Image \| Fallback Base \| Result Image \| Source Refs/);
  assert.match(manifest, /registry\.example\.com\/feat-a-image:v1/);
  assert.match(manifest, /registry\.example\.com\/feat-a-image:v2/);
  assert.match(manifest, new RegExp(`repo-a@${head}`));
}

function main() {
  testRunSnapshotHooksAndBuildChainIntegration();
  console.log('week7-hooks-build-run: ok');
}

main();
