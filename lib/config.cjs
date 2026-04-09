'use strict';

const fs = require('fs');
const path = require('path');
const { output, error, findWorkspaceRoot, expandHome } = require('./core.cjs');
const yaml = require('./yaml.cjs');

function loadConfig(workspaceRoot) {
  const root = workspaceRoot || findWorkspaceRoot();
  if (!root) {
    error('.dev.yaml not found in any parent directory');
  }
  const yamlPath = path.join(root, '.dev.yaml');
  if (!fs.existsSync(yamlPath)) {
    error(`.dev.yaml not found at ${yamlPath}`);
  }
  const yamlContent = fs.readFileSync(yamlPath, 'utf8');
  if (!yamlContent.trim()) {
    error('.dev.yaml is empty. Run /devflow:init workspace to initialize it.');
  }
  try {
    const raw = yaml.parse(yamlContent);
    if (!raw || typeof raw !== 'object') {
      error('.dev.yaml is empty or invalid. Run /devflow:init workspace to initialize it.');
    }
    const config = { _root: root, _path: yamlPath, ...raw };

    if (config.schema_version !== 2) {
      error('Unsupported schema_version. Only v2 is supported. Migrate with /devflow:init workspace.');
    }
    return config;
  } catch (err) {
    error(`Failed to parse .dev.yaml: ${err.message}`);
  }
}

/**
 * Get the active feature from config.
 * @param {object} config - Loaded config
 * @param {string} [featureOverride] - Optional feature name override (from --feature flag)
 */
function getActiveFeature(config, featureOverride) {
  const name = featureOverride || (config.defaults && config.defaults.active_feature);
  if (!name) {
    error('No active_feature set in defaults and no --feature override provided');
  }
  const feature = config.features && config.features[name];
  if (!feature) {
    const available = Object.keys(config.features || {}).join(', ');
    error(`Feature '${name}' not found in features. Available: ${available}`);
  }
  return { name, ...feature };
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
    build_history: feature.build_history || [],
    cluster: feature.cluster || (feature.deploy && feature.deploy.cluster) || null,
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
  const clusterName = feature.cluster
    || (feature.deploy && feature.deploy.cluster)
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
  handleConfig,
};
