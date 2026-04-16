'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'lib', 'devteam.cjs');
const { computeReuseKey } = require('../lib/build-index.cjs');

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

function runCli(cwd, args, extraEnv = {}) {
  const stdout = execFileSync('node', [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
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

function createDockerMock(root) {
  const binDir = path.join(root, 'mock-bin');
  fs.mkdirSync(binDir, { recursive: true });
  const dockerPath = path.join(binDir, 'docker');
  writeFile(dockerPath, [
    '#!/usr/bin/env node',
    "'use strict';",
    'const args = process.argv.slice(2);',
    "if (args[0] === 'manifest' && args[1] === 'inspect') {",
    "  const image = args[2] || '';",
    "  const available = String(process.env.DEVTEAM_TEST_AVAILABLE_IMAGES || '')",
    "    .split(',')",
    '    .map(s => s.trim())',
    '    .filter(Boolean);',
    '  process.exit(available.includes(image) ? 0 : 1);',
    '}',
    'process.exit(1);',
    '',
  ].join('\n'));
  fs.chmodSync(dockerPath, 0o755);
  return binDir;
}

function withDockerEnv(root, availableImages = []) {
  const binDir = createDockerMock(root);
  return {
    PATH: `${binDir}:${process.env.PATH}`,
    DEVTEAM_TEST_AVAILABLE_IMAGES: availableImages.join(','),
  };
}

function createWorkspace(features = ['feat-a']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week11-build-reuse-'));
  makeGitWorktree(root, 'repo-a-dev');
  fs.mkdirSync(path.join(root, 'repo-a-base'), { recursive: true });

  writeFile(path.join(root, 'workspace.yaml'), [
    'schema_version: 2',
    `workspace: ${root}`,
    'build_server:',
    '  registry: registry.example.com',
    'defaults:',
    '  features:',
    ...features.map(name => `    - ${name}`),
    'repos: {}',
    'clusters: {}',
  ].join('\n') + '\n');

  for (const featureName of features) {
    writeFile(path.join(root, '.dev', 'features', featureName, 'config.yaml'), [
      `description: ${featureName}`,
      'phase: build',
      'scope:',
      '  repo-a:',
      '    dev_worktree: repo-a-dev',
      'current_tag: null',
      'base_image: nvcr.io/base/model:1.0',
      'build:',
      `  image_name: ${featureName}-image`,
      'build_history: []',
    ].join('\n') + '\n');
  }
  return root;
}

function runInit(root, feature = 'feat-a') {
  return runCli(root, ['run', 'init', '--feature', feature, '--stages', 'build']);
}

function buildRecord(root, feature, tag, mode, extraArgs = [], env = {}) {
  return runCli(root, [
    'build', 'record',
    '--feature', feature,
    '--tag', tag,
    '--changes', `build ${tag}`,
    '--mode', mode,
    '--parent-image', 'nvcr.io/base/model:1.0',
    ...extraArgs,
  ], env);
}

function readIndex(root) {
  const indexPath = path.join(root, '.dev', 'build-index.json');
  return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
}

function testMissThenIndexPopulated() {
  const root = createWorkspace();
  const run = runInit(root, 'feat-a');
  const output = buildRecord(root, 'feat-a', 'v1', 'full');
  assert.strictEqual(output.reused, false);
  assert.ok(fs.existsSync(path.join(root, '.dev', 'build-index.json')));

  const expectedKey = computeReuseKey(run.run.repos.map(repo => ({
    repo: repo.repo,
    start_head: repo.start_head,
  })), 'full', 'nvcr.io/base/model:1.0');
  const index = readIndex(root);
  assert.strictEqual(index.entries[0].reuse_key, expectedKey);
}

function testHitThenReuse() {
  const root = createWorkspace();
  runInit(root, 'feat-a');
  const first = buildRecord(root, 'feat-a', 'v1', 'full');
  const env = withDockerEnv(root, [first.resulting_image]);
  const second = buildRecord(root, 'feat-a', 'v2', 'full', [], env);
  assert.strictEqual(second.reused, true);
  assert.strictEqual(second.tag, first.tag);
}

function testHitButImageGoneFallsBackToBuild() {
  const root = createWorkspace();
  runInit(root, 'feat-a');
  buildRecord(root, 'feat-a', 'v1', 'full');
  const env = withDockerEnv(root, []); // no image available
  const second = buildRecord(root, 'feat-a', 'v2', 'full', [], env);
  assert.strictEqual(second.reused, false);
  assert.strictEqual(second.tag, 'v2');
}

function testDifferentShaCausesMiss() {
  const root = createWorkspace();
  runInit(root, 'feat-a');
  const first = buildRecord(root, 'feat-a', 'v1', 'full');
  const repoPath = path.join(root, 'repo-a-dev');
  writeFile(path.join(repoPath, 'README.md'), '# new sha\n');
  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '-m', 'next sha']);
  runCli(root, ['run', 'init', '--feature', 'feat-a', '--stages', 'build', '--restart']);

  const env = withDockerEnv(root, [first.resulting_image]);
  const second = buildRecord(root, 'feat-a', 'v2', 'full', [], env);
  assert.strictEqual(second.reused, false);
}

function testDifferentModeCausesMiss() {
  const root = createWorkspace();
  runInit(root, 'feat-a');
  const first = buildRecord(root, 'feat-a', 'v1', 'fast');
  const env = withDockerEnv(root, [first.resulting_image]);
  const second = buildRecord(root, 'feat-a', 'v2', 'full', [], env);
  assert.strictEqual(second.reused, false);
}

function testNoReuseFlagForcesBuild() {
  const root = createWorkspace();
  runInit(root, 'feat-a');
  const first = buildRecord(root, 'feat-a', 'v1', 'full');
  const env = withDockerEnv(root, [first.resulting_image]);
  const second = buildRecord(root, 'feat-a', 'v2', 'full', ['--no-reuse'], env);
  assert.strictEqual(second.reused, false);
  assert.strictEqual(second.tag, 'v2');
}

function testCrossFeatureReuse() {
  const root = createWorkspace(['feat-a', 'feat-b']);
  runInit(root, 'feat-a');
  const first = buildRecord(root, 'feat-a', 'v1', 'full');

  runInit(root, 'feat-b');
  const env = withDockerEnv(root, [first.resulting_image]);
  const reused = buildRecord(root, 'feat-b', 'v9', 'full', [], env);
  assert.strictEqual(reused.reused, true);
  assert.strictEqual(reused.tag, first.tag);
}

function testCorruptIndexDegradesGracefully() {
  const root = createWorkspace();
  runInit(root, 'feat-a');
  const indexPath = path.join(root, '.dev', 'build-index.json');
  writeFile(indexPath, '{not-json');
  const result = buildRecord(root, 'feat-a', 'v1', 'full');
  assert.strictEqual(result.reused, false);
  const parsed = readIndex(root);
  assert.ok(Array.isArray(parsed.entries));
}

function main() {
  testMissThenIndexPopulated();
  testHitThenReuse();
  testHitButImageGoneFallsBackToBuild();
  testDifferentShaCausesMiss();
  testDifferentModeCausesMiss();
  testNoReuseFlagForcesBuild();
  testCrossFeatureReuse();
  testCorruptIndexDegradesGracefully();
  console.log('week11-build-reuse-index: ok');
}

main();
