#!/usr/bin/env node
// devflow Statusline — displays model, context usage, project/feature/phase
//
// Receives rich JSON on stdin from Claude Code statusLine system:
//   model.display_name, context_window.used_percentage, cwd, etc.
// Output: plain text for the status bar.

'use strict';

const fs = require('fs');
const path = require('path');

function findDevYaml(startDir) {
  let dir = startDir;
  for (let i = 0; i < 20; i++) {
    const candidate = path.join(dir, '.dev.yaml');
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

  // Project / feature / phase from .dev.yaml + STATE.md
  const cwd = data?.cwd || process.cwd();
  const found = findDevYaml(cwd);

  if (found) {
    const { file, root } = found;
    let projectName = 'devflow';
    try {
      const yaml = fs.readFileSync(file, 'utf8');
      projectName = parseYamlValue(yaml, 'project') || path.basename(root);
    } catch (_) {
      projectName = path.basename(root);
    }
    parts.push(projectName);

    let feature = '';
    let phase = '';
    const statePath = path.join(root, '.dev', 'STATE.md');
    try {
      if (fs.existsSync(statePath)) {
        const stateContent = fs.readFileSync(statePath, 'utf8');
        const fm = parseStateFrontmatter(stateContent);
        feature = fm.current_feature || '';
        phase = fm.feature_stage || fm.phase || '';
      }
    } catch (_) { /* ignore */ }

    if (!feature) {
      const featDir = path.join(root, '.dev', 'features');
      try {
        if (fs.existsSync(featDir)) {
          const dirs = fs.readdirSync(featDir).filter(d =>
            fs.statSync(path.join(featDir, d)).isDirectory()
          );
          if (dirs.length === 1) feature = dirs[0];
        }
      } catch (_) { /* ignore */ }
    }

    if (feature) parts.push(feature);
    if (phase) parts.push(`[${phase}]`);
  }

  process.stdout.write(parts.length > 0 ? parts.join(' | ') : 'devteam');
  process.exit(0);
}
