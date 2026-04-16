'use strict';

const fs = require('fs');
const path = require('path');
const { output, error, findWorkspaceRoot, parseArgs } = require('./core.cjs');
const { loadConfig, requireFeature, getFeatureConfigPath, getWorkspaceConfigPath, getWorkspaceRoot } = require('./config.cjs');
const { FEATURE_PHASES } = require('./stage-constants.cjs');

function loadState(featureName, root) {
  const r = root || findWorkspaceRoot();
  if (!r) error('workspace.yaml not found');
  const devDir = path.join(r, '.dev');
  const state = { specs: [], plans: [], reviews: [], verifies: [], optimizations: [] };

  // Check per-feature artifacts (current schema: .dev/features/<name>/)
  if (featureName) {
    const featureDir = path.join(devDir, 'features', featureName);
    if (fs.existsSync(featureDir)) {
      if (fs.existsSync(path.join(featureDir, 'spec.md'))) state.specs.push(featureName);
      if (fs.existsSync(path.join(featureDir, 'plan.md'))) state.plans.push(featureName);
      if (fs.existsSync(path.join(featureDir, 'review.md'))) state.reviews.push(featureName);
      if (fs.existsSync(path.join(featureDir, 'verify.md'))) state.verifies.push(featureName);
      if (fs.existsSync(path.join(featureDir, 'optimization-guidance.md'))) state.optimizations.push(featureName);
    }
  }

  // Also scan features/ directory for all features
  const featuresDir = path.join(devDir, 'features');
  if (fs.existsSync(featuresDir)) {
    for (const name of fs.readdirSync(featuresDir)) {
      const fDir = path.join(featuresDir, name);
      if (!fs.statSync(fDir).isDirectory()) continue;
      if (fs.existsSync(path.join(fDir, 'spec.md')) && !state.specs.includes(name)) state.specs.push(name);
      if (fs.existsSync(path.join(fDir, 'plan.md')) && !state.plans.includes(name)) state.plans.push(name);
      if (fs.existsSync(path.join(fDir, 'review.md')) && !state.reviews.includes(name)) state.reviews.push(name);
      if (fs.existsSync(path.join(fDir, 'verify.md')) && !state.verifies.includes(name)) state.verifies.push(name);
      if (fs.existsSync(path.join(fDir, 'optimization-guidance.md')) && !state.optimizations.includes(name)) state.optimizations.push(name);
    }
  }
  return state;
}

/**
 * Get phase for a feature.
 */
function getPhase(config, featureName) {
  const feature = requireFeature(config, featureName);
  return feature.phase;
}

/**
 * Return the path to a feature's config.yaml.
 */
function getFeaturePath(config, featureName) {
  return getFeatureConfigPath(config, featureName);
}

/**
 * Internal: replace a top-level scalar field in a flat config.yaml.
 * Used for split format where feature config is a flat file (no nesting).
 */
function replaceTopLevelField(content, field, value) {
  const lines = content.split('\n');
  const quoteIfNeeded = v => (typeof v === 'string' && (v.includes(':') || v.includes('#') || v.includes('"'))) ? JSON.stringify(v) : v;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([\w_-]+):\s*(.*)/);
    if (m && m[1] === field) {
      lines[i] = `${field}: ${quoteIfNeeded(value)}`;
      return lines.join('\n');
    }
  }
  error(`Field '${field}' not found in feature config.yaml`);
}

/**
 * Update phase in a feature's config.yaml.
 */
function updatePhase(config, featureName, phase) {
  const validPhases = FEATURE_PHASES;
  if (!validPhases.includes(phase)) {
    error(`Invalid phase '${phase}'. Valid: ${validPhases.join(', ')}`);
  }
  const feature = requireFeature(config, featureName);
  const name = feature.name;

  const featPath = getFeaturePath(config, name);
  let content = fs.readFileSync(featPath, 'utf8');
  content = replaceTopLevelField(content, 'phase', phase);
  fs.writeFileSync(featPath, content, 'utf8');
  return { feature: name, phase };
}

/**
 * Update a scalar field within a feature's config.yaml.
 */
function updateFeatureField(config, featureName, field, value) {
  const featPath = getFeaturePath(config, featureName);
  let content = fs.readFileSync(featPath, 'utf8');
  content = replaceTopLevelField(content, field, value);
  fs.writeFileSync(featPath, content, 'utf8');
  return { feature: featureName, field, value };
}

/**
 * Delete a feature: remove from defaults.features list + delete .dev/features/<name>/.
 */
function deleteFeature(config, featureName) {
  if (!config.features[featureName]) {
    error(`Feature '${featureName}' not found. Available: ${Object.keys(config.features).join(', ')}`);
  }

  const wsPath = getWorkspaceConfigPath(config);
  const lines  = fs.readFileSync(wsPath, 'utf8').split('\n');
  const idx    = lines.findIndex(l => l.trim() === `- ${featureName}`);
  if (idx !== -1) lines.splice(idx, 1);
  fs.writeFileSync(wsPath, lines.join('\n'), 'utf8');

  const root       = getWorkspaceRoot(config) || findWorkspaceRoot();
  const featureDir = path.join(root, '.dev', 'features', featureName);
  if (fs.existsSync(featureDir)) fs.rmSync(featureDir, { recursive: true, force: true });
  return { deleted: featureName };
}

function handleState(subcommand, args) {
  const config = loadConfig();
  const parsed = parseArgs(args || []);
  const field = parsed._[0];
  const value = parsed._[1];
  const featureArg = parsed.feature || null;
  if (subcommand === 'get') {
    if (!field) {
      const feature = requireFeature(config, featureArg);
      const state = loadState(feature.name, getWorkspaceRoot(config) || findWorkspaceRoot());
      output({
        feature: feature.name,
        phase: feature.phase,
        current_tag: feature.current_tag,
        artifacts: state,
      });
    } else if (field === 'phase') {
      output({ phase: getPhase(config, featureArg) });
    } else if (field === 'tag') {
      const feature = requireFeature(config, featureArg);
      output({ current_tag: feature.current_tag });
    } else {
      error(`Unknown state field: ${field}. Use: phase, tag, or omit for full state. Optional flag: --feature <name>`);
    }
  } else if (subcommand === 'update') {
    if (!field || parsed._.length < 2) error('Usage: state update <field> <value> [--feature <name>]');
    if (field === 'phase') {
      const result = updatePhase(config, featureArg, value);
      output(result);
    } else if (['feature_stage', 'pipeline_stages', 'completed_stages', 'pipeline_loop_count', 'plan_progress', 'last_activity'].includes(field)) {
      // Update STATE.md frontmatter field
      const { updateStateMd } = require('./session.cjs');
      const feature = requireFeature(config, featureArg);
      const featureName = feature.name;
      const root = getWorkspaceRoot(config) || findWorkspaceRoot();
      const result = updateStateMd(root, { frontmatter: { [field]: value } }, featureName);
      output({ field, value, ...result });
    } else {
      error(`Cannot update field '${field}' via CLI. Supported: phase, feature_stage, pipeline_stages, completed_stages, pipeline_loop_count, plan_progress, last_activity`);
    }
  } else {
    error(`Unknown state subcommand: ${subcommand}. Use: get, update`);
  }
}

/**
 * Append a build history entry to a feature's config.yaml.
 * build_history: is a top-level key; newest entry is inserted first.
 */
function appendBuildHistory(config, featureName, entry) {
  const featPath = getFeaturePath(config, featureName);
  let content = fs.readFileSync(featPath, 'utf8');
  const lines = content.split('\n');
  const formatYamlValue = (value) => {
    if (value == null) return 'null';
    if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
      return JSON.stringify(value);
    }
    if (typeof value === 'string') {
      if (value === '') return '""';
      if (value.includes(':') || value.includes('#') || value.includes('"') || value.includes('\n')) {
        return JSON.stringify(value);
      }
      return value;
    }
    return String(value);
  };

  const parentImage = entry.parent_image || entry.base || null;
  const fallbackBaseImage = entry.fallback_base_image || null;
  const resultingTag = entry.resulting_tag || entry.tag;
  const resultingImage = entry.resulting_image || null;
  const sourceRefs = Array.isArray(entry.source_refs) ? entry.source_refs : [];
  const sourceRepos = Array.isArray(entry.source_repos) ? entry.source_repos : [];

  // Detect list item indent from existing entries (default: 2 spaces, matching migration output)
  let itemIndent = 2;
  for (const line of lines) {
    const m = line.match(/^(\s+)- tag:/);
    if (m) { itemIndent = m[1].length; break; }
  }
  const p1 = ' '.repeat(itemIndent);
  const p2 = ' '.repeat(itemIndent + 2);

  const newEntry = [
    `${p1}- tag: ${entry.tag}`,
    `${p2}date: ${entry.date}`,
    `${p2}changes: ${formatYamlValue(entry.changes)}`,
    `${p2}parent_image: ${formatYamlValue(parentImage)}`,
    `${p2}fallback_base_image: ${formatYamlValue(fallbackBaseImage)}`,
    `${p2}resulting_tag: ${formatYamlValue(resultingTag)}`,
    `${p2}resulting_image: ${formatYamlValue(resultingImage)}`,
    `${p2}base: ${formatYamlValue(parentImage)}`,
    `${p2}source_refs: ${formatYamlValue(sourceRefs)}`,
    `${p2}source_repos: ${formatYamlValue(sourceRepos)}`,
    ...(entry.run_id ? [`${p2}run_id: ${formatYamlValue(entry.run_id)}`] : []),
    ...(entry.mode    ? [`${p2}mode: ${entry.mode}`]              : []),
    ...(entry.cluster ? [`${p2}cluster: ${entry.cluster}`]        : []),
    ...(entry.note    ? [`${p2}note: ${formatYamlValue(entry.note)}`] : []),
  ];

  // Find top-level build_history: line
  let historyLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^build_history:\s*$/.test(lines[i])) { historyLine = i; break; }
  }

  if (historyLine === -1) {
    lines.push('build_history:');
    lines.push(...newEntry);
  } else {
    // Insert immediately after build_history: → newest first
    lines.splice(historyLine + 1, 0, ...newEntry);
  }

  fs.writeFileSync(featPath, lines.join('\n'), 'utf8');
  return { feature: featureName, tag: entry.tag, appended: true };
}

/**
 * Write/append one row to .dev/features/<name>/build-manifest.md.
 * This is the permanent, never-truncated build chain record.
 */
function writeBuildManifest(root, featureName, entry) {
  const dir = path.join(root, '.dev', 'features', featureName);
  fs.mkdirSync(dir, { recursive: true });
  const manifestPath = path.join(dir, 'build-manifest.md');

  const normalizeCell = (value) => {
    if (value == null) return '-';
    if (Array.isArray(value)) {
      if (value.length === 0) return '-';
      return value.join(', ').replace(/\|/g, '/');
    }
    return String(value).replace(/\|/g, '/').replace(/\n/g, ' ');
  };

  const parentImage = entry.parent_image || entry.base || null;
  const fallbackBaseImage = entry.fallback_base_image || null;
  const resultingImage = entry.resulting_image || null;
  const sourceRefs = Array.isArray(entry.source_refs) ? entry.source_refs : [];

  const row = [
    `| ${normalizeCell(entry.tag)}`,
    `${normalizeCell(entry.date)}`,
    `${normalizeCell(parentImage)}`,
    `${normalizeCell(fallbackBaseImage)}`,
    `${normalizeCell(resultingImage)}`,
    `${normalizeCell(sourceRefs)}`,
    `${normalizeCell(entry.changes)}`,
    `${normalizeCell(entry.mode)}`,
    `${normalizeCell(entry.cluster)} |`,
  ].join(' | ');

  if (!fs.existsSync(manifestPath)) {
    const header = [
      `# Build Manifest: ${featureName}`,
      '',
      '| Tag | Date | Parent Image | Fallback Base | Result Image | Source Refs | Changes | Mode | Cluster |',
      '|-----|------|--------------|---------------|--------------|-------------|---------|------|---------|',
      row,
      '',
    ].join('\n');
    fs.writeFileSync(manifestPath, header, 'utf8');
  } else {
    const existing = fs.readFileSync(manifestPath, 'utf8');
    fs.writeFileSync(manifestPath, existing.trimEnd() + '\n' + row + '\n', 'utf8');
  }
  return manifestPath;
}

module.exports = {
  loadState, getPhase, updatePhase, handleState,
  updateFeatureField, appendBuildHistory, writeBuildManifest,
  deleteFeature,
};
