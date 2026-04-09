'use strict';

const fs = require('fs');
const path = require('path');
const { error, findWorkspaceRoot } = require('./core.cjs');

/**
 * Parse STATE.md frontmatter and body sections.
 * Returns { frontmatter, decisions, blockers, position, raw } or null.
 * @param {string} root - Workspace root
 * @param {string} [featureName] - If provided, look in .dev/features/<feature>/STATE.md first
 */
function loadStateMd(root, featureName) {
  const rootDir = root || findWorkspaceRoot();
  if (!rootDir) return null;

  // Try per-feature path first, fall back to global
  let statePath;
  if (featureName) {
    const featurePath = path.join(rootDir, '.dev', 'features', featureName, 'STATE.md');
    if (fs.existsSync(featurePath)) {
      statePath = featurePath;
    }
  }
  if (!statePath) {
    statePath = path.join(rootDir, '.dev', 'STATE.md');
  }
  if (!fs.existsSync(statePath)) return null;

  const content = fs.readFileSync(statePath, 'utf8');
  const result = { frontmatter: {}, decisions: [], blockers: [], position: {}, raw: content };

  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    for (const line of fmMatch[1].split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim();
        const val = line.slice(colonIdx + 1).trim().replace(/^"(.*)"$/, '$1');
        result.frontmatter[key] = val;
      }
    }
  }

  const decisionsMatch = content.match(/## Decisions\n\|[^\n]+\n\|[-| ]+\n([\s\S]*?)(?=\n## |\n$|$)/);
  if (decisionsMatch) {
    for (const row of decisionsMatch[1].trim().split('\n').filter(r => r.startsWith('|'))) {
      const cells = row.split('|').map(c => c.trim()).filter(c => c);
      if (cells.length >= 5) {
        result.decisions.push({
          id: cells[0], decision: cells[1], rationale: cells[2], date: cells[3], feature: cells[4],
        });
      }
    }
  }

  const blockersMatch = content.match(/## Blockers\n\|[^\n]+\n\|[-| ]+\n([\s\S]*?)(?=\n## |\n$|$)/);
  if (blockersMatch) {
    for (const row of blockersMatch[1].trim().split('\n').filter(r => r.startsWith('|'))) {
      const cells = row.split('|').map(c => c.trim()).filter(c => c);
      if (cells.length >= 5) {
        result.blockers.push({
          id: cells[0], blocker: cells[1], type: cells[2], status: cells[3], workaround: cells[4],
        });
      }
    }
  }

  const posMatch = content.match(/## Position\n([\s\S]*?)(?=\n## |\n$|$)/);
  if (posMatch) {
    const posText = posMatch[1].trim();
    const currentMatch = posText.match(/Currently working on:\s*(.*)/);
    const nextMatch = posText.match(/Next step:\s*(.*)/);
    if (currentMatch) result.position.current = currentMatch[1].trim();
    if (nextMatch) result.position.next = nextMatch[1].trim();
  }

  return result;
}

/**
 * Update fields in STATE.md frontmatter and/or position section.
 * @param {string} root - Workspace root
 * @param {object} updates - Fields to update
 * @param {string} [featureName] - If provided, write to .dev/features/<feature>/STATE.md
 */
function updateStateMd(root, updates, featureName) {
  const rootDir = root || findWorkspaceRoot();
  if (!rootDir) error('.dev.yaml not found');

  let statePath;
  if (featureName) {
    const featureDir = path.join(rootDir, '.dev', 'features', featureName);
    if (!fs.existsSync(featureDir)) fs.mkdirSync(featureDir, { recursive: true });
    statePath = path.join(featureDir, 'STATE.md');
  } else {
    statePath = path.join(rootDir, '.dev', 'STATE.md');
  }

  let content;
  if (fs.existsSync(statePath)) {
    content = fs.readFileSync(statePath, 'utf8');
  } else {
    const templatePath = path.join(__dirname, '..', '..', 'templates', 'state.md');
    if (fs.existsSync(templatePath)) {
      content = fs.readFileSync(templatePath, 'utf8');
    } else {
      content = '---\nfeature: unknown\nphase: init\nfeature_stage: null\nplan_progress: "0/0"\nlast_activity: "' + new Date().toISOString() + '"\n---\n\n## Position\nCurrently working on: N/A\nNext step: N/A\n\n## Decisions\n| ID | Decision | Rationale | Date | Feature |\n|----|----------|-----------|------|---------|\n\n## Blockers\n| ID | Blocker | Type | Status | Workaround |\n|----|---------|------|--------|------------|\n\n## Metrics\n| Feature | Spec | Plan | Exec | Review | Duration |\n|---------|------|------|------|--------|----------|\n';
    }
    const devDir = path.join(rootDir, '.dev');
    if (!fs.existsSync(devDir)) fs.mkdirSync(devDir, { recursive: true });
  }

  if (updates.frontmatter) {
    for (const [key, value] of Object.entries(updates.frontmatter)) {
      const regex = new RegExp(`^(${key}:\\s*).*$`, 'm');
      const quoted = typeof value === 'string' && value.includes(':') ? `"${value}"` : value;
      if (regex.test(content)) {
        content = content.replace(regex, `$1${quoted}`);
      }
    }
  }

  if (updates.position) {
    if (updates.position.current) {
      content = content.replace(/Currently working on:\s*.*/, `Currently working on: ${updates.position.current}`);
    }
    if (updates.position.next) {
      content = content.replace(/Next step:\s*.*/, `Next step: ${updates.position.next}`);
    }
  }

  fs.writeFileSync(statePath, content, 'utf8');
  return { path: statePath, updated: true };
}

function appendTableRow(statePath, sectionHeader, row) {
  let content = fs.readFileSync(statePath, 'utf8');
  const pattern = new RegExp(`${sectionHeader}\\n\\|[^\\n]+\\n\\|[-| ]+\\n([\\s\\S]*?)(?=\\n## |$)`);
  const insertPoint = content.match(pattern);
  if (insertPoint) {
    const matchEnd = content.indexOf(insertPoint[0]) + insertPoint[0].length;
    const nextSection = content.indexOf('\n## ', matchEnd);
    if (nextSection !== -1) {
      const beforeNext = content.lastIndexOf('\n', nextSection);
      content = content.slice(0, beforeNext) + '\n' + row + content.slice(beforeNext);
    } else {
      // Section is at end of file — append row before trailing whitespace
      const trimmed = content.trimEnd();
      content = trimmed + '\n' + row + '\n';
    }
  }
  fs.writeFileSync(statePath, content, 'utf8');
}

function addDecision(root, decision) {
  const rootDir = root || findWorkspaceRoot();
  if (!rootDir) error('.dev.yaml not found');
  const statePath = path.join(rootDir, '.dev', 'STATE.md');
  if (!fs.existsSync(statePath)) {
    updateStateMd(rootDir, { frontmatter: { last_activity: new Date().toISOString() } });
  }
  const row = `| ${decision.id} | ${decision.decision} | ${decision.rationale} | ${decision.date} | ${decision.feature} |`;
  appendTableRow(statePath, '## Decisions', row);
  return { added: decision.id };
}

function addBlocker(root, blocker) {
  const rootDir = root || findWorkspaceRoot();
  if (!rootDir) error('.dev.yaml not found');
  const statePath = path.join(rootDir, '.dev', 'STATE.md');
  if (!fs.existsSync(statePath)) {
    updateStateMd(rootDir, { frontmatter: { last_activity: new Date().toISOString() } });
  }
  const row = `| ${blocker.id} | ${blocker.blocker} | ${blocker.type} | ${blocker.status} | ${blocker.workaround} |`;
  appendTableRow(statePath, '## Blockers', row);
  return { added: blocker.id };
}

function resolveBlocker(root, blockerId) {
  const rootDir = root || findWorkspaceRoot();
  if (!rootDir) error('.dev.yaml not found');
  const statePath = path.join(rootDir, '.dev', 'STATE.md');
  if (!fs.existsSync(statePath)) return { resolved: false, reason: 'STATE.md not found' };

  let content = fs.readFileSync(statePath, 'utf8');
  const regex = new RegExp(`(\\| ${blockerId} \\|[^|]+\\|[^|]+\\|)\\s*active\\s*(\\|)`);
  if (regex.test(content)) {
    content = content.replace(regex, '$1 resolved $2');
    fs.writeFileSync(statePath, content, 'utf8');
    return { resolved: true, id: blockerId };
  }
  return { resolved: false, reason: `Blocker ${blockerId} not found or not active` };
}

/**
 * @param {string} root
 * @param {object} data
 * @param {string} [featureName] - If provided, write to per-feature dir
 */
function writeHandoff(root, data, featureName) {
  const rootDir = root || findWorkspaceRoot();
  if (!rootDir) error('.dev.yaml not found');

  let targetDir;
  if (featureName) {
    targetDir = path.join(rootDir, '.dev', 'features', featureName);
  } else {
    targetDir = path.join(rootDir, '.dev');
  }
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  const handoffPath = path.join(targetDir, 'HANDOFF.json');
  const payload = { version: '1.0', timestamp: new Date().toISOString(), ...data };
  fs.writeFileSync(handoffPath, JSON.stringify(payload, null, 2), 'utf8');
  return { path: handoffPath, written: true };
}

/**
 * @param {string} root
 * @param {string} [featureName] - If provided, read from per-feature dir first
 */
function readHandoff(root, featureName) {
  const rootDir = root || findWorkspaceRoot();
  if (!rootDir) return null;

  // Try per-feature path first, fall back to global
  if (featureName) {
    const featurePath = path.join(rootDir, '.dev', 'features', featureName, 'HANDOFF.json');
    if (fs.existsSync(featurePath)) {
      try { return JSON.parse(fs.readFileSync(featurePath, 'utf8')); } catch (_) { /* fall through */ }
    }
  }
  const handoffPath = path.join(rootDir, '.dev', 'HANDOFF.json');
  if (!fs.existsSync(handoffPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(handoffPath, 'utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * @param {string} root
 * @param {string} [featureName] - If provided, delete from per-feature dir
 */
function deleteHandoff(root, featureName) {
  const rootDir = root || findWorkspaceRoot();
  if (!rootDir) return false;

  if (featureName) {
    const featurePath = path.join(rootDir, '.dev', 'features', featureName, 'HANDOFF.json');
    if (fs.existsSync(featurePath)) { fs.unlinkSync(featurePath); return true; }
  }
  const handoffPath = path.join(rootDir, '.dev', 'HANDOFF.json');
  if (fs.existsSync(handoffPath)) {
    fs.unlinkSync(handoffPath);
    return true;
  }
  return false;
}

module.exports = {
  loadStateMd, updateStateMd,
  addDecision, addBlocker, resolveBlocker,
  writeHandoff, readHandoff, deleteHandoff,
};
