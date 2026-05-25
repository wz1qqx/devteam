'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const STATUSLINE = path.resolve(__dirname, '..', 'hooks', 'devteam-statusline.js');

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function runStatusline(input, env = {}) {
  return execFileSync('node', [STATUSLINE], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function createWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devteam-statusline-'));
  writeFile(path.join(root, '.devteam', 'config.yaml'), [
    'version: 2',
    'name: inference-platform',
    `workspace: ${root}`,
    'worktrees:',
    '  repo_a__feature:',
    '    repo: repo-a',
    '    path: repo-a-feature',
    '    branch: feature',
    'tracks:',
    '  feature-a:',
    '    worktrees: ["repo_a__feature"]',
    '  feature-b:',
    '    worktrees: ["repo_a__feature"]',
    'env_profiles:',
    '  local:',
    '    type: local',
    'defaults:',
    '  track: feature-a',
    '  env: local',
  ].join('\n') + '\n');
  return root;
}

function testReadsWorkspaceDefaults() {
  const root = createWorkspace();
  const output = runStatusline({
    cwd: root,
    model: { display_name: 'Claude Test' },
    context_window: { used_percentage: 42 },
  });

  assert.match(output, /^Claude Test \| ctx \[====      \] 42% \| inference-platform \| track:feature-a$/);
}

function testEnvTrackOverridesWorkspaceDefault() {
  const root = createWorkspace();
  const output = runStatusline({
    workspace: { project_dir: root },
    model: { id: 'claude-opus-4-6' },
    context_window: { used_percentage: 5 },
  }, { DEVTEAM_TRACK: 'feature-b' });

  assert.match(output, /^claude-opus-4-6 \| ctx \[=         \] 5% \| inference-platform \| track:feature-b$/);
}

function testShowsLatestOpenRunForTrack() {
  const root = createWorkspace();
  writeFile(path.join(root, '.devteam', 'runs', 'run-old', 'session.json'), JSON.stringify({
    run_id: 'run-old',
    workspace_set: 'feature-a',
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-01T00:00:00.000Z',
    lifecycle: { status: 'open' },
  }, null, 2));
  writeFile(path.join(root, '.devteam', 'runs', 'run-new', 'session.json'), JSON.stringify({
    run_id: 'run-new',
    workspace_set: 'feature-a',
    created_at: '2026-05-02T00:00:00.000Z',
    updated_at: '2026-05-02T00:00:00.000Z',
    lifecycle: { status: 'open' },
  }, null, 2));
  writeFile(path.join(root, '.devteam', 'runs', 'run-closed', 'session.json'), JSON.stringify({
    run_id: 'run-closed',
    workspace_set: 'feature-a',
    created_at: '2026-05-03T00:00:00.000Z',
    updated_at: '2026-05-03T00:00:00.000Z',
    lifecycle: { status: 'closed' },
  }, null, 2));

  const output = runStatusline({
    cwd: root,
    model: { display_name: 'Claude Test' },
  });

  assert.match(output, /^Claude Test \| inference-platform \| track:feature-a \| run:run-new$/);
}

function main() {
  testReadsWorkspaceDefaults();
  testEnvTrackOverridesWorkspaceDefault();
  testShowsLatestOpenRunForTrack();
  console.log('statusline: ok');
}

main();
