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

function runCli(cwd, args) {
  const stdout = execFileSync('node', [CLI, ...args], {
    cwd,
    encoding: 'utf8',
  });
  return JSON.parse(stdout);
}

function runCliError(cwd, args) {
  const result = spawnSync('node', [CLI, ...args], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status === 0) {
    throw new Error(`Expected command to fail: ${args.join(' ')}`);
  }
  return result.stderr;
}

function createWorkspace({ workspaceYaml, featureConfig }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week7-schema-'));
  writeFile(path.join(root, 'workspace.yaml'), workspaceYaml);
  writeFile(path.join(root, '.dev', 'features', 'feat-a', 'config.yaml'), featureConfig);
  return root;
}

function testRemotesAndObjectBaselinesNormalize() {
  const root = createWorkspace({
    workspaceYaml: [
      'schema_version: 2',
      `workspace: ${os.tmpdir()}`,
      'defaults:',
      '  features:',
      '    - feat-a',
      'repos:',
      '  repo-a:',
      '    remotes:',
      '      official: https://example.com/official/repo-a.git',
      '      corp: git@corp.example.com:team/repo-a.git',
      '      personal: git@github.com:me/repo-a.git',
      '    baselines:',
      '      main:',
      '        id: baseline-main',
      '        ref: main',
      '        worktree: repo-a-main',
      '        read_only: true',
      'clusters: {}',
    ].join('\n') + '\n',
    featureConfig: [
      'description: Feature A',
      'phase: spec',
      'scope: {}',
    ].join('\n') + '\n',
  });

  const config = runCli(root, ['config', 'load']);
  const repoA = config.repos['repo-a'];
  const baseline = repoA.baselines['baseline-main'];

  assert.strictEqual(repoA.upstream, 'https://example.com/official/repo-a.git');
  assert.strictEqual(repoA.remotes.official, 'https://example.com/official/repo-a.git');
  assert.strictEqual(repoA.remotes.corp, 'git@corp.example.com:team/repo-a.git');
  assert.strictEqual(repoA.remotes.personal, 'git@github.com:me/repo-a.git');
  assert.ok(baseline);
  assert.strictEqual(baseline.id, 'baseline-main');
  assert.strictEqual(baseline.ref, 'main');
  assert.strictEqual(baseline.worktree, 'repo-a-main');
  assert.strictEqual(baseline.read_only, true);
}

function testLegacyUpstreamAndCompactBaselinesStillSupported() {
  const root = createWorkspace({
    workspaceYaml: [
      'schema_version: 2',
      `workspace: ${os.tmpdir()}`,
      'defaults:',
      '  features:',
      '    - feat-a',
      'repos:',
      '  repo-a:',
      '    upstream: https://example.com/legacy/repo-a.git',
      '    baselines:',
      '      main: repo-a-main',
      'clusters: {}',
    ].join('\n') + '\n',
    featureConfig: [
      'description: Feature A',
      'phase: spec',
      'scope: {}',
    ].join('\n') + '\n',
  });

  const config = runCli(root, ['config', 'load']);
  const repoA = config.repos['repo-a'];
  const baseline = repoA.baselines.main;

  assert.strictEqual(repoA.upstream, 'https://example.com/legacy/repo-a.git');
  assert.strictEqual(repoA.remotes.official, 'https://example.com/legacy/repo-a.git');
  assert.strictEqual(repoA.remotes.corp, null);
  assert.strictEqual(repoA.remotes.personal, null);
  assert.ok(baseline);
  assert.strictEqual(baseline.id, 'main');
  assert.strictEqual(baseline.ref, 'main');
  assert.strictEqual(baseline.worktree, 'repo-a-main');
  assert.strictEqual(baseline.read_only, true);
}

function testInvalidRemoteFieldFailsFast() {
  const root = createWorkspace({
    workspaceYaml: [
      'schema_version: 2',
      `workspace: ${os.tmpdir()}`,
      'defaults:',
      '  features:',
      '    - feat-a',
      'repos:',
      '  repo-a:',
      '    remotes:',
      '      official:',
      '        nested: bad',
      'clusters: {}',
    ].join('\n') + '\n',
    featureConfig: [
      'description: Feature A',
      'phase: spec',
      'scope: {}',
    ].join('\n') + '\n',
  });

  const stderr = runCliError(root, ['config', 'load']);
  assert.match(stderr, /workspace\.yaml repos\.repo-a\.remotes\.official must be a string or null/i);
}

function main() {
  testRemotesAndObjectBaselinesNormalize();
  testLegacyUpstreamAndCompactBaselinesStillSupported();
  testInvalidRemoteFieldFailsFast();
  console.log('week7-schema-remotes: ok');
}

main();
