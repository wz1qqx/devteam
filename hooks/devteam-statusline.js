#!/usr/bin/env node
// devteam StatusLine - displays model, context usage, workspace, track, and latest run.

'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('../lib/yaml.cjs');

function findWorkspaceRoot(startDir) {
  let dir = startDir || process.cwd();
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(path.join(dir, '.devteam', 'config.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readYamlFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return yaml.parse(content) || null;
  } catch (_) {
    return null;
  }
}

function readJsonFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function contextBar(usedPct) {
  const total = 10;
  const filled = Math.max(0, Math.min(total, Math.round((usedPct / 100) * total)));
  const empty = total - filled;
  return '[' + '='.repeat(filled) + ' '.repeat(empty) + ']';
}

function latestRun(root, track, feat = null) {
  const runsDir = path.join(root, '.devteam', 'runs');
  if (!fs.existsSync(runsDir) || !fs.statSync(runsDir).isDirectory()) return null;
  const runs = fs.readdirSync(runsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const runDir = path.join(runsDir, entry.name);
      const session = readJsonFile(path.join(runDir, 'session.json'));
      if (!session) return null;
      const status = session.lifecycle && session.lifecycle.status
        ? session.lifecycle.status
        : 'open';
      if (status !== 'open') return null;
      const runTrack = session.track || session.workspace_set || null;
      const runFeat = session.feat || null;
      if (track && runTrack && runTrack !== track) return null;
      if (feat && runFeat !== feat) return null;
      return {
        id: session.run_id || entry.name,
        track: runTrack,
        feat: runFeat,
        updated_at: session.updated_at || session.created_at || '',
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  return runs[0] || null;
}

function resolveWorkspaceState(cwd) {
  const root = findWorkspaceRoot(cwd);
  if (!root) return null;

  const config = readYamlFile(path.join(root, '.devteam', 'config.yaml')) || {};
  const defaults = config.defaults || {};
  const workspaceName = config.name || path.basename(root);
  const track = process.env.DEVTEAM_TRACK || defaults.track || '';
  const feat = process.env.DEVTEAM_FEAT || process.env.DEVTEAM_FEATURE || defaults.feat || '';
  const run = latestRun(root, track, feat);

  return {
    root,
    workspaceName,
    track,
    feat,
    run: run ? run.id : '',
  };
}

function renderStatusline(data) {
  const parts = [];
  const model = data?.model?.display_name || data?.model?.id || '';
  const usedPct = data?.context_window?.used_percentage;
  const cwd = data?.workspace?.project_dir || data?.cwd || process.cwd();

  if (model) parts.push(model);
  if (usedPct != null) {
    parts.push(`ctx ${contextBar(Math.round(usedPct))} ${Math.round(usedPct)}%`);
  }

  const workspaceState = resolveWorkspaceState(cwd);
  if (workspaceState) {
    parts.push(workspaceState.workspaceName);
    if (workspaceState.track) parts.push(`track:${workspaceState.track}`);
    if (workspaceState.feat) parts.push(`feat:${workspaceState.feat}`);
    if (workspaceState.run) parts.push(`run:${workspaceState.run}`);
  }

  return parts.length > 0 ? parts.join(' | ') : 'devteam';
}

function main() {
  let input = '';
  const timeout = setTimeout(() => run(null), 3000);

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => {
    clearTimeout(timeout);
    let data = null;
    try { data = JSON.parse(input); } catch (_) { /* ignore */ }
    run(data);
  });
}

function run(data) {
  process.stdout.write(renderStatusline(data));
  process.exit(0);
}

module.exports = {
  main,
  renderStatusline,
  resolveWorkspaceState,
};

if (require.main === module) {
  main();
}
