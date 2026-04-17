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
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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

function createWorkspace({ features = ['feat-a'] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week8-build-prov-'));
  makeGitWorktree(root, 'repo-a-dev');
  fs.mkdirSync(path.join(root, 'repo-a-base'), { recursive: true });

  writeFile(path.join(root, 'workspace.yaml'), [
    'schema_version: 2',
    `workspace: ${root}`,
    'build_server:',
    '  registry: registry.example.com',
    'defaults:',
    '  features:',
    ...features.map(f => `    - ${f}`),
    'repos:',
    '  repo-a:',
    '    dev_slots:',
    '      default:',
    '        worktree: repo-a-dev',
    'clusters: {}',
  ].join('\n') + '\n');

  for (const featureName of features) {
    writeFile(path.join(root, '.dev', 'features', featureName, 'config.yaml'), [
      `description: ${featureName}`,
      'phase: build',
      'scope:',
      '  repo-a:',
      '    dev_slot: default',
      'current_tag: null',
      'base_image: nvcr.io/base/model:1.0',
      'build:',
      `  image_name: ${featureName}-image`,
      'build_history: []',
    ].join('\n') + '\n');
  }

  return root;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function testBuildRecordAutoReadsRunForSourceRefs() {
  const root = createWorkspace();

  const run = runCli(root, ['run', 'init', '--feature', 'feat-a', '--stages', 'build']);
  const startHead = run.run.repos[0].start_head;
  assert.ok(startHead, 'start_head must be set in run snapshot');

  const result = runCli(root, [
    'build', 'record',
    '--feature', 'feat-a',
    '--tag', 'v1',
    '--changes', 'initial build',
  ]);

  assert.strictEqual(result.feature, 'feat-a');
  assert.strictEqual(result.tag, 'v1');
  assert.ok(Array.isArray(result.source_refs), 'source_refs must be an array');
  assert.strictEqual(result.source_refs.length, 1);
  assert.strictEqual(result.source_refs[0].repo, 'repo-a');
  assert.strictEqual(result.source_refs[0].start_head, startHead);
  assert.ok('start_branch' in result.source_refs[0]);
  assert.ok('dev_worktree' in result.source_refs[0]);
  assert.ok(result.run_id, 'run_id must be set');
}

function testBuildRecordRunPathOverride() {
  const root = createWorkspace();

  // Init run normally (creates RUN.json)
  const run = runCli(root, ['run', 'init', '--feature', 'feat-a', '--stages', 'build']);
  const runPath = run.run_path;
  const startHead = run.run.repos[0].start_head;

  // Build a separate RUN.json that references a different phantom SHA
  const altRunPath = path.join(root, 'ALT_RUN.json');
  const altRun = JSON.parse(fs.readFileSync(runPath, 'utf8'));
  altRun.run_id = 'alt-run-id';
  altRun.repos[0].start_head = 'deadbeefdeadbeef';
  fs.writeFileSync(altRunPath, JSON.stringify(altRun, null, 2), 'utf8');

  const result = runCli(root, [
    'build', 'record',
    '--feature', 'feat-a',
    '--tag', 'v2',
    '--changes', 'override test',
    '--run-path', altRunPath,
  ]);

  assert.strictEqual(result.tag, 'v2');
  // source_refs must come from the override run, not the real RUN.json
  assert.strictEqual(result.source_refs[0].start_head, 'deadbeefdeadbeef');
  assert.strictEqual(result.run_id, 'alt-run-id');
  // The canonical start_head from the real run should NOT appear
  assert.notStrictEqual(result.source_refs[0].start_head, startHead);
}

function testBuildRecordWithoutRunProducesEmptySourceRefs() {
  const root = createWorkspace();
  // No run init → no RUN.json

  const result = runCli(root, [
    'build', 'record',
    '--feature', 'feat-a',
    '--tag', 'v0',
    '--changes', 'no run snapshot',
  ]);

  assert.strictEqual(result.tag, 'v0');
  assert.ok(Array.isArray(result.source_refs));
  assert.strictEqual(result.source_refs.length, 0);
  assert.strictEqual(result.run_id, null);
}

function testBuildManifestContainsSourceRefs() {
  const root = createWorkspace();

  runCli(root, ['run', 'init', '--feature', 'feat-a', '--stages', 'build']);
  runCli(root, [
    'build', 'record',
    '--feature', 'feat-a',
    '--tag', 'v1',
    '--changes', 'manifest test',
  ]);

  const manifestPath = path.join(root, '.dev', 'features', 'feat-a', 'build-manifest.md');
  assert.ok(fs.existsSync(manifestPath), 'build-manifest.md must exist');
  const manifestContent = fs.readFileSync(manifestPath, 'utf8');
  assert.match(manifestContent, /## Source Refs/);
  assert.match(manifestContent, /\| Repo \| Branch \| SHA \|/);
  assert.match(manifestContent, /repo-a/);
}

function main() {
  testBuildRecordAutoReadsRunForSourceRefs();
  testBuildRecordRunPathOverride();
  testBuildRecordWithoutRunProducesEmptySourceRefs();
  testBuildManifestContainsSourceRefs();
  console.log('week8-build-source-provenance: ok');
}

main();
