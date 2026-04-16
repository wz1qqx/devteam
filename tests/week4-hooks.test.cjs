'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { getRepoRoot } = require('../lib/version.cjs');

const repoRoot = getRepoRoot();

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

function exists(relativePath) {
  return fs.existsSync(path.join(repoRoot, relativePath));
}

function testHookRegistryUsesDevteamEntrypoints() {
  const hooks = readJson('hooks/hooks.json').hooks;
  const postToolUseCommand = hooks.PostToolUse[0].hooks[0].command;
  const stopCommand = hooks.Stop[0].hooks[0].command;

  assert.match(postToolUseCommand, /hooks\/devteam-context-monitor\.js/);
  assert.match(stopCommand, /hooks\/devteam-persistent\.js/);
}

function testLegacyWrappersRemoved() {
  assert.strictEqual(exists('hooks/my-dev-context-monitor.js'), false, 'hooks/my-dev-context-monitor.js should be removed');
  assert.strictEqual(exists('hooks/devflow-persistent.js'), false, 'hooks/devflow-persistent.js should be removed');
  assert.strictEqual(exists('hooks/my-dev-statusline.js'), false, 'hooks/my-dev-statusline.js should be removed');
}

function main() {
  testHookRegistryUsesDevteamEntrypoints();
  testLegacyWrappersRemoved();
  console.log('week4-hooks: ok');
}

main();
