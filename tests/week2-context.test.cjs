'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'lib', 'devteam.cjs');
const { addDecision, addBlocker, resolveBlocker, loadFeatureContext } = require('../lib/session.cjs');

function runCli(cwd, args) {
  const stdout = execFileSync('node', [CLI, ...args], {
    cwd,
    encoding: 'utf8',
  });
  return JSON.parse(stdout);
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function createWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week2-'));
  writeFile(
    path.join(root, 'workspace.yaml'),
    [
      'schema_version: 2',
      `workspace: ${root}`,
      'defaults:',
      '  active_cluster: dev',
      '  features:',
      '    - feat-a',
      'clusters:',
      '  dev:',
      '    namespace: dev-ns',
      'repos:',
      '  repo-a:',
      '    upstream: https://example.com/repo-a.git',
      '    baselines:',
      '      main: repo-a-base',
    ].join('\n') + '\n'
  );
  writeFile(
    path.join(root, '.dev', 'features', 'feat-a', 'config.yaml'),
    [
      'description: Feature A',
      'phase: code',
      'scope:',
      '  repo-a:',
      '    base_ref: main',
      '    dev_worktree: repo-a-dev',
      'current_tag: null',
      'base_image: null',
    ].join('\n') + '\n'
  );
  return root;
}

function testInitUsesFeatureContextInsteadOfLegacyStateTables() {
  const root = createWorkspace();

  writeFile(
    path.join(root, '.dev', 'STATE.md'),
    [
      '---',
      'phase: code',
      'current_feature: feat-a',
      '---',
      '',
      '## Position',
      'Currently working on: legacy state',
      'Next step: do not trust state tables',
      '',
      '## Decisions',
      '| ID | Decision | Rationale | Date | Feature |',
      '|----|----------|-----------|------|---------|',
      '| D-legacy | legacy | old source | 2026-01-01 | feat-a |',
      '',
      '## Blockers',
      '| ID | Blocker | Type | Status | Workaround |',
      '|----|---------|------|--------|------------|',
      '| B-legacy | legacy blocker | infra | active | wait |',
    ].join('\n') + '\n'
  );
  writeFile(
    path.join(root, '.dev', 'features', 'feat-a', 'context.md'),
    [
      '---',
      'feature: feat-a',
      'last_updated: 2026-04-15T00:00:00.000Z',
      '---',
      '',
      '## Decisions',
      '| ID | Decision | Rationale | Date |',
      '|----|----------|-----------|------|',
      '| D-01 | use feature context | avoids cross-feature pollution | 2026-04-15 |',
      '',
      '## Active Blockers',
      '| ID | Blocker | Type | Workaround |',
      '|----|---------|------|------------|',
      '| B-01 | waiting on env | infra | use stubbed env |',
      '',
      '## Archived Blockers',
      '| ID | Blocker | Type | Resolved | Resolution |',
      '|----|---------|------|----------|------------|',
    ].join('\n') + '\n'
  );

  const result = runCli(root, ['init', 'team-code']);

  assert.strictEqual(result.state, null);
  assert.deepStrictEqual(result.decisions, [
    {
      id: 'D-01',
      decision: 'use feature context',
      rationale: 'avoids cross-feature pollution',
      date: '2026-04-15',
    },
  ]);
  assert.deepStrictEqual(result.blockers, [
    {
      id: 'B-01',
      blocker: 'waiting on env',
      type: 'infra',
      workaround: 'use stubbed env',
      status: 'active',
    },
  ]);
  assert.ok(result.feature_context.includes('## Decisions'));
  assert.ok(!JSON.stringify(result.decisions).includes('D-legacy'));
  assert.ok(!JSON.stringify(result.blockers).includes('B-legacy'));
}

function testFeatureContextWriteLifecycle() {
  const root = createWorkspace();

  addDecision(root, {
    feature: 'feat-a',
    id: 'D-10',
    decision: 'pin state model',
    rationale: 'make behavior deterministic',
    date: '2026-04-15',
  });
  addBlocker(root, {
    feature: 'feat-a',
    id: 'B-10',
    blocker: 'need migration',
    type: 'design',
    workaround: 'gate behind compat path',
  });

  let context = loadFeatureContext(root, 'feat-a');
  assert.strictEqual(context.decisions.length, 1);
  assert.strictEqual(context.blockers.length, 1);
  assert.strictEqual(context.blockers[0].id, 'B-10');

  const resolved = resolveBlocker(root, 'B-10', 'feat-a', 'migrated to context.md');
  assert.strictEqual(resolved.resolved, true);

  context = loadFeatureContext(root, 'feat-a');
  assert.strictEqual(context.blockers.length, 0);
  assert.strictEqual(context.archived_blockers.length, 1);
  assert.strictEqual(context.archived_blockers[0].id, 'B-10');
  assert.strictEqual(context.archived_blockers[0].resolution, 'migrated to context.md');
}

function main() {
  testInitUsesFeatureContextInsteadOfLegacyStateTables();
  testFeatureContextWriteLifecycle();
  console.log('week2-context: ok');
}

main();
