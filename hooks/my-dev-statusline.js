#!/usr/bin/env node
// devflow Statusline — displays model, context usage, project/feature/phase
//
// Receives rich JSON on stdin from Claude Code statusLine system:
//   model.display_name, context_window.used_percentage, cwd, etc.
// Output: plain text for the status bar.

'use strict';

const fs = require('fs');
const path = require('path');

function findWorkspaceYaml(startDir) {
  let dir = startDir;
  for (let i = 0; i < 20; i++) {
    const candidate = path.join(dir, 'workspace.yaml');
    if (fs.existsSync(candidate)) return { file: candidate, root: dir };
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function parseYamlValue(content, key) {
  const re = new RegExp(`^${key}:\\s*(.+)$`, 'm');
  const m = content.match(re);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}

function parseStateFrontmatter(content) {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return {};
  const result = {};
  for (const line of fmMatch[1].split('\n')) {
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (m) result[m[1]] = m[2].trim();
  }
  return result;
}

function contextBar(usedPct) {
  const total = 10;
  const filled = Math.round((usedPct / 100) * total);
  const empty = total - filled;
  return '[' + '='.repeat(filled) + ' '.repeat(empty) + ']';
}

let input = '';
const timeout = setTimeout(() => {
  // No stdin — fallback to file-only mode
  run(null);
}, 3000);

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  clearTimeout(timeout);
  let data = null;
  try { data = JSON.parse(input); } catch (_) { /* ignore */ }
  run(data);
});

function run(data) {
  const parts = [];

  // Model name
  const model = data?.model?.display_name || data?.model?.id || '';
  if (model) parts.push(model);

  // Context usage
  const usedPct = data?.context_window?.used_percentage;
  if (usedPct != null) {
    const bar = contextBar(Math.round(usedPct));
    parts.push(`ctx ${bar} ${Math.round(usedPct)}%`);
  }

  // Project / feature / phase from workspace.yaml + feature config.yaml
  const cwd = data?.cwd || process.cwd();
  const found = findWorkspaceYaml(cwd);

  if (found) {
    const { file, root } = found;
    let projectName = path.basename(root);
    let feature = '';
    let phase = '';

    try {
      const wsYaml = fs.readFileSync(file, 'utf8');
      // project name from devlog.group
      projectName = parseYamlValue(wsYaml, 'group') || projectName;
      // active feature from defaults.active_feature
      feature = parseYamlValue(wsYaml, 'active_feature') || '';
    } catch (_) { /* ignore */ }

    if (feature) {
      // phase from .dev/features/<name>/config.yaml
      try {
        const configPath = path.join(root, '.dev', 'features', feature, 'config.yaml');
        if (fs.existsSync(configPath)) {
          const configYaml = fs.readFileSync(configPath, 'utf8');
          phase = parseYamlValue(configYaml, 'phase') || '';
        }
      } catch (_) { /* ignore */ }

      // Fallback: try STATE.md for phase
      if (!phase) {
        const statePath = path.join(root, '.dev', 'STATE.md');
        try {
          if (fs.existsSync(statePath)) {
            const fm = parseStateFrontmatter(fs.readFileSync(statePath, 'utf8'));
            phase = fm.feature_stage || fm.phase || '';
          }
        } catch (_) { /* ignore */ }
      }
    }

    parts.push(projectName);
    if (feature) parts.push(feature);
    if (phase) parts.push(`[${phase}]`);
  }

  process.stdout.write(parts.length > 0 ? parts.join(' | ') : 'devteam');
  process.exit(0);
}
