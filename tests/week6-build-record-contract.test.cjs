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

function createGitRepo(repoPath) {
  fs.mkdirSync(repoPath, { recursive: true });
  execFileSync('git', ['init'], { cwd: repoPath, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'tests@example.com'], { cwd: repoPath, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Devteam Tests'], { cwd: repoPath, stdio: 'ignore' });
  fs.writeFileSync(path.join(repoPath, 'README.md'), '# repo\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: repoPath, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoPath, stdio: 'ignore' });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim();
}

function createWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week6-build-record-'));
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
      '    upstream: git@example.com/repo-a.git',
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
      'current_tag: v1',
      'base_image: nvcr.io/base/model:2.0',
      'build:',
      '  image_name: feat-a-image',
      'build_history: []',
    ].join('\n') + '\n'
  );

  fs.mkdirSync(path.join(root, 'repo-a-base'), { recursive: true });
  const head = createGitRepo(path.join(root, 'repo-a-dev'));
  return { root, head };
}

function testBuildRecordCapturesIncrementalParentAndRunRefs() {
  const { root, head } = createWorkspace();
  const run = runCli(root, ['run', 'init', '--feature', 'feat-a', '--stages', 'build']);

  const result = runCli(root, [
    'build',
    'record',
    '--feature',
    'feat-a',
    '--tag',
    'v2',
    '--changes',
    'incremental update',
    '--mode',
    'full',
    '--cluster',
    'dev',
  ]);

  assert.strictEqual(result.parent_image, 'registry.example.com/feat-a-image:v1');
  assert.strictEqual(result.fallback_base_image, 'nvcr.io/base/model:2.0');
  assert.strictEqual(result.resulting_image, 'registry.example.com/feat-a-image:v2');
  assert.strictEqual(result.run_id, run.run.run_id);
  assert.ok(Array.isArray(result.source_refs));
  assert.ok(result.source_refs.some(ref => ref.repo === 'repo-a' && ref.start_head === head));

  const cfg = runCli(root, ['config', 'load']);
  const entry = cfg.features['feat-a'].build_history[0];
  assert.strictEqual(cfg.features['feat-a'].current_tag, 'v2');
  assert.strictEqual(entry.parent_image, 'registry.example.com/feat-a-image:v1');
  assert.strictEqual(entry.fallback_base_image, 'nvcr.io/base/model:2.0');
  assert.strictEqual(entry.resulting_image, 'registry.example.com/feat-a-image:v2');
  assert.strictEqual(entry.resulting_tag, 'v2');
  assert.strictEqual(entry.base, 'registry.example.com/feat-a-image:v1');
  assert.strictEqual(entry.run_id, run.run.run_id);
  assert.deepStrictEqual(entry.source_repos, ['repo-a']);
  assert.ok(Array.isArray(entry.source_refs));
  assert.ok(entry.source_refs.some(ref => ref.repo === 'repo-a' && ref.start_head === head));

  const manifest = fs.readFileSync(path.join(root, '.dev', 'features', 'feat-a', 'build-manifest.md'), 'utf8');
  assert.match(manifest, /registry\.example\.com\/feat-a-image:v1/);
  assert.match(manifest, /registry\.example\.com\/feat-a-image:v2/);
  assert.match(manifest, new RegExp(`repo-a@${head}`));
}

function main() {
  testBuildRecordCapturesIncrementalParentAndRunRefs();
  console.log('week6-build-record-contract: ok');
}

main();
