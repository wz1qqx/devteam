'use strict';

const fs = require('fs');
const path = require('path');
const { output, error, findWorkspaceRoot, expandHome, DevteamError } = require('./core.cjs');
const { FEATURE_PHASES } = require('./stage-constants.cjs');
const yaml = require('./yaml.cjs');

const SUPPORTED_SHIP_STRATEGIES = new Set(['k8s', 'bare_metal']);
const SUPPORTED_BARE_METAL_BUILD_MODES = new Set(['skip', 'sync_only', 'source_install', 'docker']);
const CONFIG_META = Symbol('config_meta');
const DEFAULT_FEATURE_PHASE = 'spec';
const DEFAULT_TUNING = Object.freeze({
  regression_threshold: 20,
  max_task_retries: 2,
  max_optimization_loops: 3,
  deploy_timeout: 300,
  deploy_poll_interval: 15,
  build_history_limit: 5,
  commit_format: 'feat({feature}): {title}',
});

const DEFAULT_REPO_REMOTES = Object.freeze({
  official: null,
  corp: null,
  personal: null,
});

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
  } catch (e) {
    if (e instanceof DevteamError) throw e;
    error(`Failed to parse workspace.yaml: ${e.message}`);
  }

  ws = normalizeWorkspaceConfig(ws);

  // Load per-feature config.yaml files
  ws.features = {};
  const featureConfigPaths = {};
  const featureNames = ws.defaults.features;
  for (const name of featureNames) {
    const featPath = path.join(root, '.dev', 'features', name, 'config.yaml');
    if (!fs.existsSync(featPath)) {
      error(`Feature '${name}' is declared in defaults.features but .dev/features/${name}/config.yaml is missing.`);
    }
    try {
      const feat = yaml.parse(fs.readFileSync(featPath, 'utf8')) || {};
      ws.features[name] = normalizeFeatureConfig(feat, name);
      featureConfigPaths[name] = featPath;
    } catch (e) {
      if (e instanceof DevteamError) throw e;
      error(`Failed to parse .dev/features/${name}/config.yaml: ${e.message}`);
    }
  }
  return attachConfigMeta(ws, {
    root,
    workspaceConfigPath: wsPath,
    featureConfigPaths,
  });
}

function attachConfigMeta(config, meta) {
  Object.defineProperty(config, CONFIG_META, {
    value: Object.freeze({
      root: meta.root,
      workspaceConfigPath: meta.workspaceConfigPath,
      featureConfigPaths: Object.freeze({ ...meta.featureConfigPaths }),
    }),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return config;
}

function getConfigMeta(config) {
  const meta = config && config[CONFIG_META];
  if (!meta) {
    error('Config metadata missing. Load config via loadConfig().');
  }
  return meta;
}

function getWorkspaceRoot(config) {
  return getConfigMeta(config).root;
}

function getWorkspaceConfigPath(config) {
  return getConfigMeta(config).workspaceConfigPath;
}

function getFeatureConfigPath(config, featureName) {
  const featPath = getConfigMeta(config).featureConfigPaths[featureName];
  if (!featPath) {
    error(`Feature '${featureName}' config.yaml not found. Run /devteam init feature first.`);
  }
  return featPath;
}

function normalizeWorkspaceConfig(ws) {
  if (!ws || typeof ws !== 'object' || Array.isArray(ws)) {
    error('workspace.yaml is invalid.');
  }
  if (ws.schema_version !== 2) {
    error('Unsupported schema_version. Only v2 is supported.');
  }

  const defaults = ws.defaults || {};
  if (ws.defaults != null && (typeof ws.defaults !== 'object' || Array.isArray(ws.defaults))) {
    error('workspace.yaml defaults must be a mapping.');
  }

  const featureNames = defaults.features || [];
  if (!Array.isArray(featureNames)) {
    error('workspace.yaml defaults.features must be a list.');
  }
  for (const name of featureNames) {
    if (typeof name !== 'string' || name.trim() === '') {
      error('workspace.yaml defaults.features must contain only non-empty strings.');
    }
  }

  const tuning = defaults.tuning || {};
  if (defaults.tuning != null && (typeof defaults.tuning !== 'object' || Array.isArray(defaults.tuning))) {
    error('workspace.yaml defaults.tuning must be a mapping.');
  }

  const repos = normalizeOptionalMapping(ws.repos, 'workspace.yaml repos');
  const clusters = normalizeOptionalMapping(ws.clusters, 'workspace.yaml clusters');
  const buildServer = normalizeOptionalMapping(ws.build_server, 'workspace.yaml build_server');
  const devlog = normalizeOptionalMapping(ws.devlog, 'workspace.yaml devlog');
  const observability = normalizeOptionalMapping(ws.observability, 'workspace.yaml observability');

  const normalizedRepos = {};
  for (const [repoName, repo] of Object.entries(repos)) {
    if (!repo || typeof repo !== 'object' || Array.isArray(repo)) {
      error(`workspace.yaml repo '${repoName}' must be a mapping.`);
    }
    const remotes = normalizeRepoRemotes(repo, repoName);
    normalizedRepos[repoName] = {
      ...repo,
      upstream: remotes.official || null,
      remotes,
      baselines: normalizeRepoBaselines(repo.baselines, repoName),
      dev_slots: normalizeRepoDevSlots(repo.dev_slots, repoName),
    };
  }

  const normalizedClusters = {};
  for (const [clusterName, cluster] of Object.entries(clusters)) {
    if (!cluster || typeof cluster !== 'object' || Array.isArray(cluster)) {
      error(`workspace.yaml cluster '${clusterName}' must be a mapping.`);
    }
    normalizedClusters[clusterName] = {
      ...cluster,
      hardware: normalizeOptionalMapping(cluster.hardware, `workspace.yaml clusters.${clusterName}.hardware`),
      network: normalizeOptionalMapping(cluster.network, `workspace.yaml clusters.${clusterName}.network`),
    };
  }

  return {
    ...ws,
    defaults: {
      ...defaults,
      active_cluster: defaults.active_cluster || null,
      features: [...featureNames],
      tuning: { ...DEFAULT_TUNING, ...tuning },
    },
    repos: normalizedRepos,
    clusters: normalizedClusters,
    build_server: buildServer,
    devlog,
    observability,
  };
}

function normalizeRepoRemotes(repo, repoName) {
  const label = `workspace.yaml repos.${repoName}.remotes`;
  const remotes = normalizeOptionalMapping(repo.remotes, label);
  const normalized = { ...DEFAULT_REPO_REMOTES };

  for (const [remoteName, remoteUrl] of Object.entries(remotes)) {
    if (remoteUrl != null && typeof remoteUrl !== 'string') {
      error(`${label}.${remoteName} must be a string or null.`);
    }
    normalized[remoteName] = remoteUrl || null;
  }

  const legacyUpstream = repo.upstream || null;
  if (!normalized.official && legacyUpstream) {
    normalized.official = legacyUpstream;
  }
  return normalized;
}

function normalizeRepoBaselines(value, repoName) {
  const label = `workspace.yaml repos.${repoName}.baselines`;
  const baselines = normalizeOptionalMapping(value, label);
  const normalized = {};

  for (const [baselineKey, baselineEntry] of Object.entries(baselines)) {
    if (typeof baselineEntry === 'string') {
      normalized[baselineKey] = {
        id: baselineKey,
        ref: baselineKey,
        worktree: baselineEntry,
        read_only: true,
      };
      continue;
    }
    if (!baselineEntry || typeof baselineEntry !== 'object' || Array.isArray(baselineEntry)) {
      error(`${label}.${baselineKey} must be a string or mapping.`);
    }

    const baselineId = baselineEntry.id || baselineKey;
    const baselineRef = baselineEntry.ref || baselineKey;
    const baselineWorktree = baselineEntry.worktree || baselineEntry.path || null;
    if (!baselineWorktree || typeof baselineWorktree !== 'string') {
      error(`${label}.${baselineKey}.worktree must be a non-empty string.`);
    }
    const readOnly = baselineEntry.read_only == null ? true : Boolean(baselineEntry.read_only);

    if (normalized[baselineId]) {
      error(`${label} has duplicate baseline id '${baselineId}'.`);
    }
    normalized[baselineId] = {
      ...baselineEntry,
      id: baselineId,
      ref: baselineRef,
      worktree: baselineWorktree,
      read_only: readOnly,
    };
  }

  return normalized;
}

function normalizeRepoDevSlots(value, repoName) {
  const label = `workspace.yaml repos.${repoName}.dev_slots`;
  const devSlots = normalizeOptionalMapping(value, label);
  const normalized = {};

  for (const [slotKey, slotEntry] of Object.entries(devSlots)) {
    if (!slotEntry || typeof slotEntry !== 'object' || Array.isArray(slotEntry)) {
      error(`${label}.${slotKey} must be a mapping.`);
    }
    const worktree = slotEntry.worktree || slotEntry.path || slotEntry.dev_worktree || null;
    if (!worktree || typeof worktree !== 'string') {
      error(`${label}.${slotKey}.worktree must be a non-empty string.`);
    }

    const ownerFeatures = normalizeOwnerFeatures(slotEntry.owner_features, slotEntry.owner_feature, `${label}.${slotKey}`);
    normalized[slotKey] = {
      ...slotEntry,
      id: slotEntry.id || slotKey,
      repo: slotEntry.repo || repoName,
      worktree,
      baseline_id: slotEntry.baseline_id || slotEntry.baseline || null,
      baseline_ref: slotEntry.baseline_ref || null,
      sharing_mode: slotEntry.sharing_mode || null,
      owner_features: ownerFeatures,
    };
  }

  return normalized;
}

function normalizeOwnerFeatures(ownerFeatures, ownerFeature, label) {
  if (ownerFeatures == null && ownerFeature == null) return [];
  if (ownerFeatures != null) {
    if (!Array.isArray(ownerFeatures)) {
      error(`${label}.owner_features must be a list.`);
    }
    for (const featureName of ownerFeatures) {
      if (typeof featureName !== 'string' || featureName.trim() === '') {
        error(`${label}.owner_features must contain non-empty strings.`);
      }
    }
    return [...ownerFeatures];
  }
  if (typeof ownerFeature !== 'string' || ownerFeature.trim() === '') {
    error(`${label}.owner_feature must be a non-empty string.`);
  }
  return [ownerFeature];
}


function resolveFeatureName(config, featureOverride) {
  const features = config.features;
  const featureNames = Object.keys(features);

  if (featureOverride) {
    return featureOverride;
  }
  if (featureNames.length === 1) {
    return featureNames[0];
  }
  return null;
}

function resolveFeature(config, featureOverride) {
  const features = config.features;
  const featureNames = Object.keys(features);
  const name = resolveFeatureName(config, featureOverride);

  if (!name) return null;

  const feature = features[name];
  if (!feature) {
    const available = featureNames.join(', ');
    error(`Feature '${name}' not found in features. Available: ${available}`);
  }
  return { name, ...feature };
}

function requireFeature(config, featureOverride) {
  const feature = resolveFeature(config, featureOverride);
  if (feature) return feature;

  const featureNames = Object.keys(config.features);
  if (featureNames.length === 0) {
    error('No features configured. Run /devteam init feature <name> first.');
  }
  error(`No feature specified. Use --feature <name>. Available: ${featureNames.join(', ')}`);
}

function normalizeShipMetal(metal, featureName) {
  if (metal == null) return null;
  if (typeof metal !== 'object' || Array.isArray(metal)) {
    error(`Feature '${featureName}' ship.metal must be a mapping.`);
  }
  if (metal.build_mode != null && typeof metal.build_mode !== 'string') {
    error(`Feature '${featureName}' ship.metal.build_mode must be a string.`);
  }
  const buildMode = metal.build_mode || null;
  if (buildMode && !SUPPORTED_BARE_METAL_BUILD_MODES.has(buildMode)) {
    error(
      `Feature '${featureName}' ship.metal.build_mode '${buildMode}' is invalid. ` +
      `Valid values: ${Array.from(SUPPORTED_BARE_METAL_BUILD_MODES).join(', ')}`
    );
  }
  const logPaths = metal.log_paths || null;
  if (logPaths != null && (typeof logPaths !== 'object' || Array.isArray(logPaths))) {
    error(`Feature '${featureName}' ship.metal.log_paths must be a mapping.`);
  }
  return {
    host: metal.host || null,
    venv: metal.venv || null,
    code_dir: metal.code_dir || null,
    profile: metal.profile || null,
    config: metal.config || null,
    build_mode: buildMode,
    sync_script: metal.sync_script || null,
    start_script: metal.start_script || null,
    setup_script: metal.setup_script || null,
    service_url: metal.service_url || null,
    log_paths: logPaths ? {
      decode: logPaths.decode || null,
      prefill: logPaths.prefill || null,
      ...logPaths,
    } : null,
  };
}

function normalizeFeatureConfig(feature, featureName) {
  if (!feature || typeof feature !== 'object' || Array.isArray(feature)) {
    error(`Feature '${featureName}' config.yaml must be a mapping.`);
  }

  const phase = feature.phase;
  if (phase && !FEATURE_PHASES.includes(phase)) {
    error(
      `Feature '${featureName}' uses unsupported phase '${phase}'. ` +
      `Valid phases: ${FEATURE_PHASES.join(', ')}`
    );
  }

  const scope = normalizeOptionalMapping(feature.scope, `Feature '${featureName}' scope`);
  const normalizedScope = {};
  for (const [repoName, scopeEntry] of Object.entries(scope)) {
    if (!scopeEntry || typeof scopeEntry !== 'object' || Array.isArray(scopeEntry)) {
      error(
        `Feature '${featureName}' has invalid scope entry for repo '${repoName}'. ` +
        'Expected a mapping.'
      );
    }
    const devSlot = scopeEntry.dev_slot || scopeEntry.dev_slot_id || null;
    if (!devSlot && scopeEntry.dev_worktree) {
      error(
        `Feature '${featureName}' scope.${repoName} uses removed 'dev_worktree'. ` +
        `Migrate: define a dev_slot in repos.${repoName}.dev_slots and reference it via scope.${repoName}.dev_slot.`
      );
    }

    if (devSlot != null && typeof devSlot !== 'string') {
      error(`Feature '${featureName}' scope.${repoName}.dev_slot must be a string.`);
    }

    const { shared_with: _removed1, dev_worktree: _removed2, ...scopeRest } = scopeEntry;
    normalizedScope[repoName] = {
      ...scopeRest,
      dev_slot: devSlot,
      base_ref: scopeEntry.base_ref || null,
      base_worktree: scopeEntry.base_worktree || null,
    };
  }

  const ship = normalizeOptionalMapping(feature.ship, `Feature '${featureName}' ship`);
  const shipStrategy = ship.strategy || null;
  if (shipStrategy && !SUPPORTED_SHIP_STRATEGIES.has(shipStrategy)) {
    error(
      `Feature '${featureName}' uses unsupported ship.strategy '${shipStrategy}'. ` +
      `Current implementation supports only: ${Array.from(SUPPORTED_SHIP_STRATEGIES).join(', ')}`
    );
  }
  ship.strategy = shipStrategy;
  ship.metal = normalizeShipMetal(ship.metal, featureName);
  if (shipStrategy === 'bare_metal' && !ship.metal) {
    error(`Feature '${featureName}' ship.metal is required when ship.strategy is bare_metal.`);
  }
  if (shipStrategy === 'bare_metal' && !ship.metal.host) {
    error(`Feature '${featureName}' ship.metal.host is required when ship.strategy is bare_metal.`);
  }
  if (shipStrategy === 'bare_metal' && !ship.metal.build_mode) {
    ship.metal.build_mode = 'sync_only';
  }

  const buildHistory = feature.build_history || [];
  if (!Array.isArray(buildHistory)) {
    error(`Feature '${featureName}' build_history must be a list.`);
  }

  return {
    ...feature,
    description: feature.description || '',
    created: feature.created || null,
    scope: normalizedScope,
    phase: phase || DEFAULT_FEATURE_PHASE,
    current_tag: feature.current_tag || null,
    base_image: feature.base_image || null,
    cluster: feature.cluster || null,
    invariants: normalizeOptionalMapping(feature.invariants, `Feature '${featureName}' invariants`),
    hooks: normalizeHooks(feature.hooks || {}),
    ship,
    build: normalizeOptionalMapping(feature.build, `Feature '${featureName}' build`),
    deploy: normalizeOptionalMapping(feature.deploy, `Feature '${featureName}' deploy`),
    benchmark: normalizeOptionalMapping(feature.benchmark, `Feature '${featureName}' benchmark`),
    verify: normalizeOptionalMapping(feature.verify, `Feature '${featureName}' verify`),
    build_history: [...buildHistory],
  };
}

function normalizeOptionalMapping(value, label) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    error(`${label} must be a mapping.`);
  }
  return { ...value };
}

function normalizeHooks(hooks) {
  if (hooks == null) return defaultHooks();
  if (typeof hooks !== 'object' || Array.isArray(hooks)) {
    error('Feature hooks must be a mapping.');
  }

  const normalized = defaultHooks();
  for (const key of ['pre_build', 'post_build', 'pre_deploy', 'post_deploy', 'post_verify', 'learned']) {
    const value = hooks[key];
    if (value == null) continue;
    if (!Array.isArray(value)) {
      error(`Feature hooks.${key} must be a list.`);
    }
    normalized[key] = [...value];
  }
  return normalized;
}

function defaultHooks() {
  return {
    pre_build: [],
    post_build: [],
    pre_deploy: [],
    post_deploy: [],
    post_verify: [],
    learned: [],
  };
}

/**
 * List available feature names from config.
 */
function listFeatureNames(config) {
  return Object.keys(config.features);
}

/**
 * Get a specific feature by name from config.
 */
function getFeatureByName(config, featureName) {
  return resolveFeature(config, featureName);
}

/**
 * Resolve a feature with merged repo metadata.
 * Returns { name, description, phase, repos: { repoName: { upstream, remotes, base_ref, dev_slot, ... } }, ... }.
 * @param {object} config
 * @param {string} [featureOverride] - Optional feature name override
 */
function resolveFeatureWithRepos(config, featureOverride) {
  const feature = resolveFeature(config, featureOverride);
  if (!feature) return null;
  const repos = getFeatureRepos(config, feature.name);

  const reposMap = {};
  for (const entry of repos) {
    reposMap[entry.repo] = {
      upstream: entry.upstream,
      remotes: entry.remotes || { ...DEFAULT_REPO_REMOTES, official: entry.upstream || null },
      base_ref: entry.base_ref,
      base_worktree: entry.base_worktree,
      dev_worktree: entry.dev_worktree,
      dev_slot: entry.dev_slot || null,
      baseline_id: entry.baseline_id || null,
      sharing_mode: entry.sharing_mode || null,
      build_type: entry.build_type || null,
    };
  }

  return {
    name: feature.name,
    description: feature.description,
    phase: feature.phase,
    current_tag: feature.current_tag,
    base_image: feature.base_image,
    invariants: feature.invariants,
    hooks: feature.hooks,
    ship: feature.ship,
    deploy: feature.deploy,
    build: feature.build,
    benchmark: feature.benchmark,
    verify: feature.verify,
    build_history: feature.build_history,
    cluster: feature.cluster,
    repos: reposMap,
  };
}

/**
 * Get merged repo info for a feature's scope entries.
 * Returns array of { repo, upstream, remotes, base_ref, base_worktree, dev_worktree, dev_slot, baseline_id, build_type }.
 */
function getFeatureRepos(config, featureName) {
  const feature = config.features[featureName];
  if (!feature) {
    error(`Feature '${featureName}' not found`);
  }
  const workspaceRepos = config.repos;
  const workspace = expandHome(config.workspace) || getWorkspaceRoot(config);
  const result = [];

  for (const [repoName, scopeEntry] of Object.entries(feature.scope)) {
    const wsRepo = workspaceRepos[repoName] || { upstream: null, remotes: { ...DEFAULT_REPO_REMOTES }, baselines: {}, dev_slots: {} };
    const remotes = wsRepo.remotes || { ...DEFAULT_REPO_REMOTES, official: wsRepo.upstream || null };
    const devSlotId = scopeEntry.dev_slot || null;
    const devSlot = resolveRepoDevSlot(wsRepo, repoName, devSlotId, featureName);
    const baseline = resolveScopeBaseline(wsRepo, scopeEntry, devSlot);

    let baseRef = scopeEntry.base_ref || null;
    if (!baseRef && baseline && baseline.ref) baseRef = baseline.ref;
    if (!baseRef && devSlot && devSlot.baseline_ref) baseRef = devSlot.baseline_ref;

    const baseWorktreePath = baseline && baseline.worktree
      ? baseline.worktree
      : (scopeEntry.base_worktree || null);
    const devWorktreePath = devSlot ? devSlot.worktree : null;

    const baseWorktree = baseWorktreePath ? path.resolve(workspace, baseWorktreePath) : null;
    const devWorktree = devWorktreePath ? path.resolve(workspace, devWorktreePath) : null;

    result.push({
      repo: repoName,
      upstream: wsRepo.upstream || remotes.official || null,
      remotes,
      base_ref: baseRef,
      base_worktree: baseWorktree,
      dev_worktree: devWorktree,
      dev_slot: devSlotId,
      baseline_id: baseline ? baseline.id : null,
      sharing_mode: devSlot ? (devSlot.sharing_mode || null) : null,
      build_type: scopeEntry.build_type || null,
    });
  }

  return result;
}

function resolveRepoDevSlot(wsRepo, repoName, slotId, featureName) {
  if (!slotId) return null;
  const slots = wsRepo.dev_slots || {};
  const slot = slots[slotId];
  if (!slot) {
    error(`Feature '${featureName}' scope.${repoName}.dev_slot '${slotId}' not found in repos.${repoName}.dev_slots.`);
  }
  return slot;
}

function resolveScopeBaseline(wsRepo, scopeEntry, devSlot) {
  const baselines = wsRepo.baselines || {};
  const candidates = [
    scopeEntry.baseline_id || null,
    scopeEntry.base_ref || null,
    scopeEntry.baseline_ref || null,
    devSlot ? (devSlot.baseline_id || null) : null,
    devSlot ? (devSlot.baseline_ref || null) : null,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const baseline = baselines[candidate];
    if (baseline) return baseline;
    const byRef = Object.values(baselines).find(entry => entry && entry.ref === candidate);
    if (byRef) return byRef;
  }
  return null;
}

/**
 * List all features with summary info.
 */
function listFeatures(config) {
  const features = config.features;

  return Object.entries(features).map(([name, feature]) => ({
    name,
    description: feature.description,
    phase: feature.phase,
    scope: Object.keys(feature.scope),
    created: feature.created,
  }));
}

function getActiveCluster(config, featureOverride) {
  const feature = resolveFeature(config, featureOverride);
  const clusterName = (feature && feature.cluster)
    || config.defaults.active_cluster;
  if (!clusterName) {
    return null;
  }
  const cluster = config.clusters[clusterName];
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
  DEFAULT_FEATURE_PHASE,
  DEFAULT_TUNING,
  loadConfig,
  getConfigMeta,
  getWorkspaceRoot,
  getWorkspaceConfigPath,
  getFeatureConfigPath,
  normalizeWorkspaceConfig,
  normalizeFeatureConfig,
  resolveFeatureName,
  resolveFeature,
  requireFeature,
  resolveFeatureWithRepos,
  getFeatureByName,
  getActiveCluster,
  getFeatureRepos,
  listFeatures,
  listFeatureNames,
  handleConfig,
};
