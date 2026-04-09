'use strict';

const fs = require('fs');
const path = require('path');
const { output, error, findWorkspaceRoot } = require('./core.cjs');
const { loadConfig, getActiveFeature } = require('./config.cjs');

function loadState(featureName, root) {
  const r = root || findWorkspaceRoot();
  if (!r) error('.dev.yaml not found');
  const devDir = path.join(r, '.dev');
  const state = { specs: [], plans: [], reviews: [] };

  // Check per-feature artifacts (current schema: .dev/features/<name>/)
  if (featureName) {
    const featureDir = path.join(devDir, 'features', featureName);
    if (fs.existsSync(featureDir)) {
      if (fs.existsSync(path.join(featureDir, 'spec.md'))) state.specs.push(featureName);
      if (fs.existsSync(path.join(featureDir, 'plan.md'))) state.plans.push(featureName);
      if (fs.existsSync(path.join(featureDir, 'review.md'))) state.reviews.push(featureName);
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
    }
  }
  return state;
}

// TODO: remove after v3 migration period — users may have multiple projects
// that won't all resume on the same day.
const PHASE_MIGRATION = {
  'init':     'spec',
  'discuss':  'spec',
  'exec':     'code',
  'deploy':   'ship',
  'observe':  'ship',
  'rollback': 'ship',
  'build':    'ship',    // old "build" = container build → now "ship"
  'verify':   'test',
};

/**
 * Get phase for a feature. Auto-migrates legacy phase values.
 */
function getPhase(config, featureName) {
  const name = featureName || (config.defaults && config.defaults.active_feature);
  if (!name) error('No feature specified');
  const feature = config.features && config.features[name];
  if (!feature) error(`Feature '${name}' not found`);
  const raw = feature.phase || 'spec';

  // Auto-migrate legacy phases
  if (PHASE_MIGRATION[raw]) {
    const migrated = PHASE_MIGRATION[raw];
    process.stderr.write(`[devflow] Phase '${raw}' migrated to '${migrated}' (v2 pipeline)\n`);
    try { updatePhase(config, name, migrated); } catch (_) { /* best effort */ }
    return migrated;
  }
  return raw;
}

/**
 * Update phase in .dev.yaml for a feature.
 */
function updatePhase(config, featureName, phase) {
  const validPhases = [
    'spec', 'plan', 'code', 'test', 'review',
    'ship', 'debug', 'dev', 'team', 'completed',
  ];
  if (!validPhases.includes(phase)) {
    error(`Invalid phase '${phase}'. Valid: ${validPhases.join(', ')}`);
  }

  const name = featureName || (config.defaults && config.defaults.active_feature);
  if (!name) error('No feature specified for phase update');

  const yamlPath = config._path;
  let content = fs.readFileSync(yamlPath, 'utf8');
  content = replaceFeatureField(content, name, 'phase', phase);
  fs.writeFileSync(yamlPath, content, 'utf8');
  return { feature: name, phase };
}

/**
 * Update a scalar field within a feature block in .dev.yaml.
 */
function updateFeatureField(config, featureName, field, value) {
  const yamlPath = config._path;
  let content = fs.readFileSync(yamlPath, 'utf8');
  content = replaceFeatureField(content, featureName, field, value);
  fs.writeFileSync(yamlPath, content, 'utf8');
  return { feature: featureName, field, value };
}

/**
 * Internal: replace a scalar field value within a feature block in raw YAML text.
 */
function replaceFeatureField(content, featureName, field, value) {
  const lines = content.split('\n');
  let featureStart = -1;
  let featureIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimEnd();
    const match = trimmed.match(/^(\s+)(\S+):$/) || trimmed.match(/^(\s+)(\S+):\s/);
    if (match && match[2] === featureName) {
      featureStart = i;
      featureIndent = match[1].length;
      break;
    }
  }

  if (featureStart === -1) {
    error(`Feature '${featureName}' not found in YAML`);
  }

  for (let i = featureStart + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const lineIndent = (line.match(/^(\s*)/) || ['', ''])[1].length;
    if (lineIndent <= featureIndent && line.trim() !== '') break;

    const fieldMatch = line.match(/^(\s+)([\w_]+):\s*(.*)/);
    if (fieldMatch && fieldMatch[2] === field) {
      let formatted = value;
      if (typeof value === 'string' && (value.includes(':') || value.includes('#') || value.includes('"'))) {
        formatted = `"${value}"`;
      }
      lines[i] = `${fieldMatch[1]}${field}: ${formatted}`;
      return lines.join('\n');
    }
  }

  error(`Field '${field}' not found in feature '${featureName}'`);
}

/**
 * Switch active feature in .dev.yaml defaults.
 */
function switchActiveFeature(config, featureName) {
  if (!config.features || !config.features[featureName]) {
    error(`Feature '${featureName}' not found. Available: ${Object.keys(config.features || {}).join(', ')}`);
  }
  const yamlPath = config._path;
  let content = fs.readFileSync(yamlPath, 'utf8');

  const regex = /^(\s*active_feature:\s*)\S+/m;
  if (regex.test(content)) {
    content = content.replace(regex, `$1${featureName}`);
  } else {
    error('active_feature field not found in defaults');
  }

  fs.writeFileSync(yamlPath, content, 'utf8');
  return { active_feature: featureName };
}

function handleState(subcommand, args) {
  const config = loadConfig();
  if (subcommand === 'get') {
    const field = args[0];
    if (!field) {
      const feature = getActiveFeature(config);
      const state = loadState(feature.name);
      output({
        feature: feature.name,
        phase: feature.phase || 'init',
        current_tag: feature.current_tag || null,
        artifacts: state,
      });
    } else if (field === 'phase') {
      output({ phase: getPhase(config) });
    } else if (field === 'tag') {
      const feature = getActiveFeature(config);
      output({ current_tag: feature.current_tag || null });
    } else {
      error(`Unknown state field: ${field}. Use: phase, tag, or omit for full state`);
    }
  } else if (subcommand === 'update') {
    const field = args[0];
    const value = args[1];
    if (!field || !value) error('Usage: state update <field> <value>');
    if (field === 'phase') {
      const result = updatePhase(config, null, value);
      output(result);
    } else {
      error(`Cannot update field '${field}' via CLI. Only 'phase' is supported.`);
    }
  } else {
    error(`Unknown state subcommand: ${subcommand}. Use: get, update`);
  }
}

module.exports = {
  loadState, getPhase, updatePhase, handleState,
  updateFeatureField, switchActiveFeature,
};
