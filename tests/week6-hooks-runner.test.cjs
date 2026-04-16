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
  return spawnSync('node', [CLI, ...args], {
    cwd,
    encoding: 'utf8',
  });
}

function createWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-week6-hooks-runner-'));
  const logPath = path.join(root, 'hooks.log');

  writeFile(
    path.join(root, 'workspace.yaml'),
    [
      'schema_version: 2',
      `workspace: ${root}`,
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
      'base_image: null',
      'hooks:',
      '  pre_build:',
      `    - 'printf "1-pre\\n" >> "${logPath}"'`,
      `    - 'printf "2-pre\\n" >> "${logPath}"'`,
      '  post_build:',
      "    - 'exit 7'",
      `    - 'printf "2-post\\n" >> "${logPath}"'`,
      '  pre_deploy:',
      "    - 'exit 9'",
      '  post_deploy: []',
      '  post_verify: []',
      '  learned:',
      "    - name: learned-pre",
      '      trigger: pre_build',
      `      command: 'printf "3-learned-pre\\n" >> "${logPath}"'`,
      "    - name: learned-post",
      '      trigger: post_build',
      `      command: 'printf "3-learned-post\\n" >> "${logPath}"'`,
    ].join('\n') + '\n'
  );

  return { root, logPath };
}

function readLog(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

function testHooksOrderAndLearnedTriggerFilter() {
  const { root, logPath } = createWorkspace();
  const result = runCli(root, ['hooks', 'run', '--feature', 'feat-a', '--phase', 'pre_build']);

  assert.strictEqual(result.phase, 'pre_build');
  assert.strictEqual(result.blocking, true);
  assert.strictEqual(result.hook_count, 3);
  assert.strictEqual(result.succeeded_count, 3);
  assert.strictEqual(result.failed_count, 0);
  assert.deepStrictEqual(readLog(logPath), ['1-pre', '2-pre', '3-learned-pre']);
  assert.deepStrictEqual(
    result.hooks.map(item => item.source),
    ['pre_build', 'pre_build', 'learned']
  );
}

function testBlockingPhaseFailsOnHookFailure() {
  const { root } = createWorkspace();
  const failed = runCliError(root, ['hooks', 'run', '--feature', 'feat-a', '--phase', 'pre_deploy']);
  assert.notStrictEqual(failed.status, 0);
  assert.match(failed.stderr, /Blocking hook failed for phase 'pre_deploy'/i);
}

function testNonBlockingPhaseWarnsAndContinues() {
  const { root, logPath } = createWorkspace();
  const result = runCli(root, ['hooks', 'run', '--feature', 'feat-a', '--phase', 'post_build']);

  assert.strictEqual(result.phase, 'post_build');
  assert.strictEqual(result.blocking, false);
  assert.strictEqual(result.hook_count, 3);
  assert.strictEqual(result.failed_count, 1);
  assert.strictEqual(result.succeeded_count, 2);
  assert.strictEqual(result.warnings.length, 1);
  assert.deepStrictEqual(readLog(logPath), ['2-post', '3-learned-post']);
}

function testAgentsCallUnifiedHooksRunner() {
  const repoRoot = path.resolve(__dirname, '..');
  const builder = fs.readFileSync(path.join(repoRoot, 'agents', 'builder.md'), 'utf8');
  const shipper = fs.readFileSync(path.join(repoRoot, 'agents', 'shipper.md'), 'utf8');
  const verifier = fs.readFileSync(path.join(repoRoot, 'agents', 'verifier.md'), 'utf8');

  assert.match(builder, /hooks run --feature "\$FEATURE" --phase pre_build/);
  assert.match(builder, /hooks run --feature "\$FEATURE" --phase post_build/);
  assert.match(shipper, /hooks run --feature "\$FEATURE" --phase pre_deploy/);
  assert.match(shipper, /hooks run --feature "\$FEATURE" --phase post_deploy/);
  assert.match(verifier, /hooks run --feature "\$FEATURE" --phase post_verify/);

  assert.doesNotMatch(shipper, /POST_HOOK=/);
  assert.doesNotMatch(verifier, /POST_VERIFY_HOOK=/);
}

function main() {
  testHooksOrderAndLearnedTriggerFilter();
  testBlockingPhaseFailsOnHookFailure();
  testNonBlockingPhaseWarnsAndContinues();
  testAgentsCallUnifiedHooksRunner();
  console.log('week6-hooks-runner: ok');
}

main();
