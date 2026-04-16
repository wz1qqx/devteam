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

function createWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week6-builder-first-build-'));
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
      'repos: {}',
      'clusters: {}',
    ].join('\n') + '\n'
  );

  writeFile(
    path.join(root, '.dev', 'features', 'feat-a', 'config.yaml'),
    [
      'description: Feature A',
      'phase: build',
      'scope: {}',
      'current_tag: null',
      'base_image: nvcr.io/base/model:1.0',
      'build:',
      '  image_name: feat-a-image',
      'build_history: []',
    ].join('\n') + '\n'
  );
  return root;
}

function testFirstBuildUsesConfiguredBaseImage() {
  const root = createWorkspace();
  const result = runCli(root, [
    'build',
    'record',
    '--feature',
    'feat-a',
    '--tag',
    'v1',
    '--changes',
    'initial image build',
    '--mode',
    'fast',
  ]);

  assert.strictEqual(result.feature, 'feat-a');
  assert.strictEqual(result.tag, 'v1');
  assert.strictEqual(result.parent_image, 'nvcr.io/base/model:1.0');
  assert.strictEqual(result.fallback_base_image, 'nvcr.io/base/model:1.0');
  assert.strictEqual(result.resulting_image, 'registry.example.com/feat-a-image:v1');

  const cfg = runCli(root, ['config', 'load']);
  const feature = cfg.features['feat-a'];
  assert.strictEqual(feature.current_tag, 'v1');
  assert.ok(Array.isArray(feature.build_history));
  assert.strictEqual(feature.build_history.length, 1);

  const entry = feature.build_history[0];
  assert.strictEqual(entry.tag, 'v1');
  assert.strictEqual(entry.parent_image, 'nvcr.io/base/model:1.0');
  assert.strictEqual(entry.fallback_base_image, 'nvcr.io/base/model:1.0');
  assert.strictEqual(entry.resulting_tag, 'v1');
  assert.strictEqual(entry.resulting_image, 'registry.example.com/feat-a-image:v1');
  assert.strictEqual(entry.base, entry.parent_image);
  assert.ok(!String(entry.parent_image).includes(':null'));

  const manifest = fs.readFileSync(path.join(root, '.dev', 'features', 'feat-a', 'build-manifest.md'), 'utf8');
  assert.match(manifest, /Parent Image/);
  assert.match(manifest, /nvcr\.io\/base\/model:1\.0/);
  assert.match(manifest, /registry\.example\.com\/feat-a-image:v1/);
}

function main() {
  testFirstBuildUsesConfiguredBaseImage();
  console.log('week6-builder-first-build: ok');
}

main();
