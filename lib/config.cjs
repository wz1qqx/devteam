'use strict';

const fs = require('fs');
const path = require('path');
const { output, error, findWorkspaceRoot, expandHome } = require('./core.cjs');
const yaml = require('./yaml.cjs');

function loadConfig(workspaceRoot) {
  const root = workspaceRoot || findWorkspaceRoot();
  if (!root) error('workspace.yaml not found in any parent directory');

  const wsPath = path.join(root, 'workspace.yaml');
  if (!fs.existsSync(wsPath)) error('workspace.yaml not found. Run /devteam init workspace to initialize.');
  return loadSplitConfig(root, wsPath);
}

function loadSplitConfig(root, wsPath) {
  const wsContent = fs.readFileSync(wsPath, 'utf8');
  if (!wsContent.trim()) error('workspace.yaml is empty.');
  let ws;
  try {
    ws = yaml.parse(wsContent);
    if (!ws || typeof ws !== 'object') error('workspace.yaml is invalid.');
  } catch (e) { error(`Failed to parse workspace.yaml: ${e.message}`); }

  ws._root = root;
  ws._path = wsPath;      // write ops use _path (workspace.yaml)
  ws._ws_path = wsPath;   // explicit semantic alias

  if (ws.schema_version !== 2) {
    error('Unsupported schema_version. Only v2 is supported.');
  }

  // Load per-feature config.yaml files
  ws.features = {};
  const featureNames = (ws.defaults && ws.defaults.features) || [];
  for (const name of featureNames) {
    const featPath = path.join(root, '.dev', 'features', name, 'config.yaml');
    if (fs.existsSync(featPath)) {
      try {
        const feat = yaml.parse(fs.readFileSync(featPath, 'utf8')) || {};
        feat._path = featPath;  // write ops route here
        feat.name = name;
        ws.features[name] = feat;
      } catch (e) { error(`Failed to parse .dev/features/${name}/config.yaml: ${e.message}`); }
    }
  }
  return ws;
}


/**
 * Get the active feature from config.
 * @param {object} config - Loaded config
 * @param {string} [featureOverride] - Optional feature name override (from --feature flag)
 */
function getActiveFeature(config, featureOverride) {
  const features = config.features || {};
  const featureNames = Object.keys(features);

  // 1. Explicit override wins
  // 2. If only one feature exists, auto-select it
  // 3. Fall back to defaults.active_feature
  // 4. Return null if none resolved (caller handles prompting)
  const name = featureOverride
    || (featureNames.length === 1 ? featureNames[0] : null)
    || (config.defaults && config.defaults.active_feature)
    || null;

  if (!name) return null;

  const feature = features[name];
  if (!feature) {
    const available = featureNames.join(', ');
    error(`Feature '${name}' not found in features. Available: ${available}`);
  }
  return { name, ...feature };
}

/**
 * List available feature names from config.
 */
function listFeatureNames(config) {
  return Object.keys(config.features || {});
}

/**
 * Get a specific feature by name from config.
 */
function getFeatureByName(config, featureName) {
  return getActiveFeature(config, featureName);
}

/**
 * Get active feature with resolved repos map.
 * Returns { name, description, phase, repos: { repoName: { upstream, base_ref, ... } }, ... }.
 * @param {object} config
 * @param {string} [featureOverride] - Optional feature name override
 */
function getActiveFeatureWithRepos(config, featureOverride) {
  const feature = getActiveFeature(config, featureOverride);
  if (!feature) return null;
  const repos = getFeatureRepos(config, feature.name);

  const reposMap = {};
  for (const entry of repos) {
    reposMap[entry.repo] = {
      upstream: entry.upstream,
      base_ref: entry.base_ref,
      base_worktree: entry.base_worktree,
      dev_worktree: entry.dev_worktree,
      build_type: entry.build_type || null,
    };
  }

  return {
    name: feature.name,
    description: feature.description || '',
    phase: feature.phase || 'init',
    current_tag: feature.current_tag || null,
    base_image: feature.base_image || null,
    invariants: feature.invariants || {},
    hooks: feature.hooks || {},
    deploy: feature.deploy || null,
    build: feature.build || null,
    benchmark: feature.benchmark || null,
    verify: feature.verify || null,
    build_history: feature.build_history || [],
    cluster: feature.cluster || null,
    repos: reposMap,
  };
}

/**
 * Get merged repo info for a feature's scope entries.
 * Returns array of { repo, upstream, base_ref, base_worktree, dev_worktree, build_type }.
 */
function getFeatureRepos(config, featureName) {
  const feature = config.features && config.features[featureName];
  if (!feature) {
    error(`Feature '${featureName}' not found`);
  }
  const workspaceRepos = config.repos || {};
  const workspace = expandHome(config.workspace) || config._root;
  const result = [];

  for (const [repoName, scopeEntry] of Object.entries(feature.scope || {})) {
    const wsRepo = workspaceRepos[repoName] || {};
    const baseRef = scopeEntry.base_ref || null;

    let baseWorktree = null;
    if (baseRef && wsRepo.baselines && wsRepo.baselines[baseRef]) {
      baseWorktree = path.resolve(workspace, wsRepo.baselines[baseRef]);
    }

    let devWorktree = null;
    if (scopeEntry.dev_worktree) {
      devWorktree = path.resolve(workspace, scopeEntry.dev_worktree);
    }

    result.push({
      repo: repoName,
      upstream: wsRepo.upstream || null,
      base_ref: baseRef,
      base_worktree: baseWorktree,
      dev_worktree: devWorktree,
      build_type: scopeEntry.build_type || null,
    });
  }

  return result;
}

/**
 * List all features with summary info.
 */
function listFeatures(config) {
  const features = config.features || {};
  const activeFeature = config.defaults && config.defaults.active_feature;

  return Object.entries(features).map(([name, feature]) => ({
    name,
    description: feature.description || '',
    phase: feature.phase || 'init',
    scope: Object.keys(feature.scope || {}),
    created: feature.created || null,
    active: name === activeFeature,
  }));
}

function getActiveCluster(config, featureOverride) {
  const feature = getActiveFeature(config, featureOverride);
  const clusterName = (feature && feature.cluster)
    || (config.defaults && config.defaults.active_cluster);
  if (!clusterName) {
    return null;
  }
  const cluster = config.clusters && config.clusters[clusterName];
  if (!cluster) {
    error(`Cluster '${clusterName}' not found in clusters`);
  }
  return { name: clusterName, ...cluster };
}

function getNestedValue(obj, keyPath) {
  const keys = keyPath.split('.');
  let current = obj;
  for (const k of keys) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[k];
  }
  return current;
}

function handleConfig(subcommand, args) {
  if (subcommand === 'load') {
    const config = loadConfig();
    output(config);
  } else if (subcommand === 'get') {
    const key = args[0];
    if (!key) error('Usage: config get <dotted.key.path>');
    const config = loadConfig();
    const value = getNestedValue(config, key);
    if (value === undefined) {
      error(`Key '${key}' not found in config`);
    }
    output({ key, value });
  } else {
    error(`Unknown config subcommand: ${subcommand}. Use: load, get`);
  }
}

module.exports = {
  loadConfig,
  getActiveFeatureWithRepos,
  getActiveFeature,
  getFeatureByName,
  getActiveCluster,
  getFeatureRepos,
  listFeatures,
  listFeatureNames,
  handleConfig,
};
