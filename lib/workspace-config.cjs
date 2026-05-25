'use strict';

const fs = require('fs');
const path = require('path');

const { error, expandHome } = require('./core.cjs');
const yaml = require('./yaml.cjs');

const WORKSPACE_DIR = '.devteam';
const WORKSPACE_CONFIG = 'config.yaml';

function findWorkspaceConfigRoot(startDir) {
  let dir = startDir || process.cwd();
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, WORKSPACE_DIR, WORKSPACE_CONFIG))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

function resolveWorkspaceConfigRoot(rootArg) {
  if (rootArg) {
    const absolute = path.resolve(expandHome(rootArg));
    if (fs.existsSync(path.join(absolute, WORKSPACE_DIR, WORKSPACE_CONFIG))) return absolute;
    error(`.devteam/config.yaml not found under '${absolute}'`);
  }

  const workspaceRoot = findWorkspaceConfigRoot();
  if (workspaceRoot) return workspaceRoot;

  error('.devteam/config.yaml not found');
}

function configPath(root) {
  return path.join(root, WORKSPACE_DIR, WORKSPACE_CONFIG);
}

function normalizeMap(value, label) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    error(`${label} must be a mapping.`);
  }
  return value;
}

function mergeMapping(target, source, label, sourcePath) {
  const entries = normalizeMap(source, label);
  for (const [key, value] of Object.entries(entries)) {
    if (Object.prototype.hasOwnProperty.call(target, key)) {
      error(`${label}.${key} is defined more than once while loading ${sourcePath}`);
    }
    target[key] = value;
  }
}

function normalizeIncludeList(value) {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.map(item => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object' && !Array.isArray(item) && item.path) return String(item.path);
      error('includes entries must be strings or mappings with path.');
    });
  }
  if (typeof value === 'string') return [value];
  error('includes must be a list of config fragment paths.');
}

function expandIncludePattern(root, pattern) {
  const text = String(pattern || '').trim();
  if (!text) return [];
  const absolutePattern = resolvePath(root, text);
  if (!absolutePattern.includes('*')) return [absolutePattern];

  const marker = absolutePattern.indexOf('*');
  const slash = absolutePattern.lastIndexOf(path.sep, marker);
  const dir = slash >= 0 ? absolutePattern.slice(0, slash) : root;
  const basenamePattern = slash >= 0 ? absolutePattern.slice(slash + 1) : absolutePattern;
  const escaped = basenamePattern
    .split('*')
    .map(part => part.replace(/[|\\{}()[\]^$+?.]/g, '\\$&'))
    .join('.*');
  const regex = new RegExp(`^${escaped}$`);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(name => regex.test(name))
    .sort()
    .map(name => path.join(dir, name));
}

function loadConfigFragments(root, raw, basePath) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { raw, fragments: [] };
  }
  const seen = new Set([basePath]);
  const merged = { ...raw };
  delete merged.includes;
  delete merged.include;
  const queue = [
    ...normalizeIncludeList(raw.includes),
    ...normalizeIncludeList(raw.include),
  ].flatMap(pattern => expandIncludePattern(root, pattern));
  const mergeableMaps = [
    'repos',
    'worktrees',
    'tracks',
    'env_profiles',
    'builders',
    'deploy_profiles',
    'build_profiles',
    'deploy_flows',
    'validation_profiles',
    'server_test_profiles',
    'environments',
    'capability_definitions',
    'build_instances',
    'validation_instances',
    'deploy_instances',
  ];

  for (const fragmentPath of queue) {
    if (seen.has(fragmentPath)) {
      error(`Config fragment included more than once: ${fragmentPath}`);
    }
    seen.add(fragmentPath);
    let fragment;
    try {
      fragment = yaml.parse(fs.readFileSync(fragmentPath, 'utf8'));
    } catch (err) {
      error(`Failed to parse ${fragmentPath}: ${err.message}`);
    }
    if (!fragment || typeof fragment !== 'object' || Array.isArray(fragment)) {
      error(`Config fragment ${fragmentPath} must be a mapping.`);
    }
    if (fragment.includes || fragment.include) {
      error(`Config fragment ${fragmentPath} cannot include other fragments.`);
    }
    for (const [key, value] of Object.entries(fragment)) {
      if (key === 'version') continue;
      if (mergeableMaps.includes(key)) {
        if (!merged[key]) merged[key] = {};
        mergeMapping(merged[key], value, key, fragmentPath);
        continue;
      }
      if (key === 'defaults' || key === 'agent_onboarding' || key === 'knowledge') {
        if (!merged[key]) merged[key] = {};
        for (const [childKey, childValue] of Object.entries(normalizeMap(value, key))) {
          if (Object.prototype.hasOwnProperty.call(merged[key], childKey)) {
            error(`${key}.${childKey} is defined more than once while loading ${fragmentPath}`);
          }
          merged[key][childKey] = childValue;
        }
        continue;
      }
      error(`Unsupported top-level key '${key}' in config fragment ${fragmentPath}`);
    }
  }
  return { raw: merged, fragments: queue };
}

function normalizeStringList(value) {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.map(item => String(item || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return [];
    if (text.startsWith('[') && text.endsWith(']')) {
      return text.slice(1, -1).split(',').map(item => item.trim()).filter(Boolean);
    }
    return [text];
  }
  return [];
}

function normalizeBoolean(value, fallback = false) {
  if (value == null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (['true', 'yes', '1', 'on'].includes(text)) return true;
    if (['false', 'no', '0', 'off'].includes(text)) return false;
  }
  return fallback;
}

function resolvePath(root, value) {
  if (!value) return null;
  const expanded = expandHome(String(value));
  return path.isAbsolute(expanded) ? expanded : path.resolve(root, expanded);
}

function normalizeWorktree(id, raw, root) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    error(`worktrees.${id} must be a mapping.`);
  }
  if (!raw.repo) error(`worktrees.${id}.repo is required.`);
  if (!raw.path) error(`worktrees.${id}.path is required.`);

  const sync = normalizeMap(raw.sync, `worktrees.${id}.sync`);
  const publish = normalizeMap(raw.publish, `worktrees.${id}.publish`);
  const publishAfterValidation = normalizeBoolean(
    publish.after_validation,
    normalizeBoolean(raw.publish_after_validation, false)
  );
  return {
    id,
    repo: String(raw.repo),
    path: String(raw.path),
    abs_path: resolvePath(root, raw.path),
    source_path: raw.source_path ? String(raw.source_path) : null,
    abs_source_path: resolvePath(root, raw.source_path),
    base_ref: raw.base_ref ? String(raw.base_ref) : null,
    branch: raw.branch ? String(raw.branch) : null,
    roles: normalizeStringList(raw.roles),
    publish_after_validation: publishAfterValidation,
    publish: {
      after_validation: publishAfterValidation,
      remote: publish.remote ? String(publish.remote) : null,
      branch: publish.branch ? String(publish.branch) : null,
      status: publish.status ? String(publish.status) : null,
      notes: publish.notes ? String(publish.notes) : null,
    },
    sync: {
      profile: sync.profile ? String(sync.profile) : null,
      remote_path: sync.remote_path ? String(sync.remote_path) : null,
      strategy: sync.strategy ? String(sync.strategy) : null,
      patch_mode: sync.patch_mode ? String(sync.patch_mode) : null,
      include_paths: normalizeStringList(sync.include_paths),
    },
  };
}

function normalizeFeature(name, raw, label) {
  const entry = normalizeMap(raw, label);
  return {
    name,
    description: entry.description ? String(entry.description) : '',
    aliases: normalizeStringList(entry.aliases),
    status: entry.status ? String(entry.status) : null,
    worktrees: normalizeStringList(entry.worktrees),
    base_ref: entry.base_ref ? String(entry.base_ref) : null,
  };
}

function profileField(entry, profiles, name) {
  return entry[name] ? String(entry[name]) : (profiles[name] ? String(profiles[name]) : null);
}

function normalizeTrack(name, raw, label) {
  const entry = normalizeMap(raw, label);
  const profiles = normalizeMap(entry.profiles, `${label}.profiles`);
  const featuresRaw = normalizeMap(entry.features, `${label}.features`);
  const features = {};
  for (const [featureName, featureRaw] of Object.entries(featuresRaw)) {
    features[featureName] = normalizeFeature(featureName, featureRaw, `${label}.features.${featureName}`);
  }
  return {
    name,
    description: entry.description ? String(entry.description) : '',
    aliases: normalizeStringList(entry.aliases),
    status: entry.status ? String(entry.status) : null,
    worktrees: normalizeStringList(entry.worktrees),
    default_feat: entry.default_feat ? String(entry.default_feat) : (entry.default_feature ? String(entry.default_feature) : null),
    features,
    env: profileField(entry, profiles, 'env'),
    sync: profileField(entry, profiles, 'sync'),
    build: profileField(entry, profiles, 'build'),
    deploy: profileField(entry, profiles, 'deploy'),
    deploy_flow: profileField(entry, profiles, 'deploy_flow'),
    validation: profileField(entry, profiles, 'validation'),
    server_test: profileField(entry, profiles, 'server_test'),
    policy: entry.policy ? String(entry.policy) : null,
    reference_tracks: normalizeStringList(entry.reference_tracks),
    reference_policy: normalizeStringList(entry.reference_policy),
    build_chain_doc: entry.build_chain_doc ? String(entry.build_chain_doc) : null,
    k8s_dev: normalizeMap(entry.k8s_dev, `${label}.k8s_dev`),
  };
}

function normalizeWorkspaceConfig(raw, root, cfgPath) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    error('.devteam/config.yaml is invalid.');
  }

  const repos = normalizeMap(raw.repos, 'repos');
  const worktreesRaw = normalizeMap(raw.worktrees, 'worktrees');
  const worktrees = {};
  for (const [id, entry] of Object.entries(worktreesRaw)) {
    worktrees[id] = normalizeWorktree(id, entry, root);
  }

  const tracksRaw = normalizeMap(raw.tracks, 'tracks');
  const tracks = {};
  for (const [name, entry] of Object.entries(tracksRaw)) {
    tracks[name] = normalizeTrack(name, entry, `tracks.${name}`);
  }

  const envProfiles = normalizeMap(raw.env_profiles, 'env_profiles');
  const builders = normalizeMap(raw.builders, 'builders');
  const deployProfiles = normalizeMap(raw.deploy_profiles, 'deploy_profiles');
  const buildProfiles = normalizeMap(raw.build_profiles, 'build_profiles');
  const deployFlows = normalizeMap(raw.deploy_flows, 'deploy_flows');
  const validationProfiles = normalizeMap(raw.validation_profiles, 'validation_profiles');
  const serverTestProfiles = normalizeMap(raw.server_test_profiles, 'server_test_profiles');
  const environments = normalizeMap(raw.environments, 'environments');
  const capabilityDefinitions = normalizeMap(raw.capability_definitions, 'capability_definitions');
  const buildInstances = normalizeMap(raw.build_instances, 'build_instances');
  const validationInstances = normalizeMap(raw.validation_instances, 'validation_instances');
  const deployInstances = normalizeMap(raw.deploy_instances, 'deploy_instances');
  const defaults = normalizeMap(raw.defaults, 'defaults');
  const knowledge = normalizeMap(raw.knowledge, 'knowledge');
  const defaultTrack = defaults.track
    ? String(defaults.track)
    : null;
  const defaultFeat = defaults.feat
    ? String(defaults.feat)
    : (defaults.feature ? String(defaults.feature) : null);

  return {
    version: raw.version || 1,
    name: raw.name ? String(raw.name) : path.basename(root),
    workspace: raw.workspace ? String(raw.workspace) : root,
    root,
    config_path: cfgPath,
    defaults: {
      track: defaultTrack,
      feat: defaultFeat,
      workspace_set: defaultTrack,
      env: defaults.env ? String(defaults.env) : null,
      sync: defaults.sync ? String(defaults.sync) : null,
      deploy: defaults.deploy ? String(defaults.deploy) : null,
      build: defaults.build ? String(defaults.build) : null,
      deploy_flow: defaults.deploy_flow ? String(defaults.deploy_flow) : null,
      validation: defaults.validation ? String(defaults.validation) : null,
      server_test: defaults.server_test ? String(defaults.server_test) : null,
    },
    repos,
    worktrees,
    tracks,
    workspace_sets: tracks,
    env_profiles: envProfiles,
    builders,
    deploy_profiles: deployProfiles,
    build_profiles: buildProfiles,
    deploy_flows: deployFlows,
    validation_profiles: validationProfiles,
    server_test_profiles: serverTestProfiles,
    environments,
    capability_definitions: capabilityDefinitions,
    build_instances: buildInstances,
    validation_instances: validationInstances,
    deploy_instances: deployInstances,
    k8s_dev: normalizeMap(raw.k8s_dev, 'k8s_dev'),
    workflow: normalizeMap(raw.workflow, 'workflow'),
    knowledge,
    agent_onboarding: normalizeMap(raw.agent_onboarding, 'agent_onboarding'),
  };
}

function loadWorkspaceConfig(rootArg) {
  const root = resolveWorkspaceConfigRoot(rootArg);
  const cfgPath = configPath(root);
  let parsed;
  try {
    parsed = yaml.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (err) {
    error(`Failed to parse ${cfgPath}: ${err.message}`);
  }
  const loaded = loadConfigFragments(root, parsed, cfgPath);
  const config = normalizeWorkspaceConfig(loaded.raw, root, cfgPath);
  config.config_fragments = loaded.fragments;
  return config;
}

function ensureWorkspaceDirs(root) {
  fs.mkdirSync(path.join(root, WORKSPACE_DIR), { recursive: true });
  fs.mkdirSync(path.join(root, WORKSPACE_DIR, 'state'), { recursive: true });
  fs.mkdirSync(path.join(root, WORKSPACE_DIR, 'profiles'), { recursive: true });
  fs.mkdirSync(path.join(root, WORKSPACE_DIR, 'flows'), { recursive: true });
  fs.mkdirSync(path.join(root, WORKSPACE_DIR, 'registry'), { recursive: true });
  fs.mkdirSync(path.join(root, WORKSPACE_DIR, 'lanes'), { recursive: true });
  fs.mkdirSync(path.join(root, WORKSPACE_DIR, 'recipes'), { recursive: true });
  fs.mkdirSync(path.join(root, WORKSPACE_DIR, 'wiki'), { recursive: true });
  fs.mkdirSync(path.join(root, WORKSPACE_DIR, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(root, WORKSPACE_DIR, 'runs'), { recursive: true });
}

module.exports = {
  WORKSPACE_DIR,
  WORKSPACE_CONFIG,
  configPath,
  ensureWorkspaceDirs,
  findWorkspaceConfigRoot,
  loadWorkspaceConfig,
  normalizeStringList,
  resolvePath,
};
