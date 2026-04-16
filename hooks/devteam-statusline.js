#!/usr/bin/env node
// devteam StatusLine — displays model, context usage, project/feature/phase

'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('../lib/yaml.cjs');

function findWorkspaceRoot(startDir) {
  let dir = startDir || process.cwd();
  for (let i = 0; i < 20; i++) {
    const candidate = path.join(dir, 'workspace.yaml');
    if (fs.existsSync(candidate)) return dir;
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

function parseStateFrontmatter(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return {};

    const result = {};
    for (const line of match[1].split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
        result[key] = value;
      }
    }
    return result;
  } catch (_) {
    return {};
  }
}

function contextBar(usedPct) {
  const total = 10;
  const filled = Math.max(0, Math.min(total, Math.round((usedPct / 100) * total)));
  const empty = total - filled;
  return '[' + '='.repeat(filled) + ' '.repeat(empty) + ']';
}

function resolveWorkspaceState(cwd) {
  const root = findWorkspaceRoot(cwd);
  if (!root) return null;

  const workspaceConfig = readYamlFile(path.join(root, 'workspace.yaml')) || {};
  const defaults = workspaceConfig.defaults || {};
  const configuredFeatures = Array.isArray(defaults.features) ? defaults.features : [];
  const selectedFeature = configuredFeatures.length === 1 ? configuredFeatures[0] : '';
  const projectName = (workspaceConfig.devlog && workspaceConfig.devlog.group) || path.basename(root);

  let phase = '';
  if (selectedFeature) {
    const featureConfig = readYamlFile(path.join(root, '.dev', 'features', selectedFeature, 'config.yaml')) || {};
    phase = featureConfig.phase || '';

    if (!phase) {
      const featureState = parseStateFrontmatter(path.join(root, '.dev', 'features', selectedFeature, 'STATE.md'));
      phase = featureState.feature_stage || featureState.phase || '';
    }
  }

  return { root, projectName, selectedFeature, phase };
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
    parts.push(workspaceState.projectName);
    if (workspaceState.selectedFeature) parts.push(workspaceState.selectedFeature);
    if (workspaceState.phase) parts.push(`[${workspaceState.phase}]`);
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
