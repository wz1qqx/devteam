'use strict';

const { error } = require('./core.cjs');

function unique(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function trackEnv() {
  return process.env.DEVTEAM_TRACK || null;
}

function featEnv() {
  return process.env.DEVTEAM_FEAT || process.env.DEVTEAM_FEATURE || null;
}

function normalizeTrackToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function compactTrackToken(value) {
  return normalizeTrackToken(value).replace(/[^a-z0-9]/g, '');
}

function aliasTokens(alias) {
  const normalized = normalizeTrackToken(alias);
  const compact = compactTrackToken(alias);
  const tokens = [normalized, compact];
  if (/^v\d+$/.test(compact)) tokens.push(compact.slice(1));
  return unique(tokens);
}

function trackMap(config) {
  return config.tracks || {};
}

function trackAliases(config, trackName) {
  const entry = trackMap(config)[trackName] || {};
  return unique([
    trackName,
    ...(Array.isArray(entry.aliases) ? entry.aliases : []),
  ]).map(value => String(value));
}

function featureAliases(featureName, feature) {
  return unique([
    featureName,
    ...(feature && Array.isArray(feature.aliases) ? feature.aliases : []),
  ]).map(value => String(value));
}

function candidateNames(entries, value, aliasesFor) {
  const raw = String(value || '').trim();
  if (!raw) return [];
  const normalized = normalizeTrackToken(raw);
  const compact = compactTrackToken(raw);
  const exact = [];
  const aliasExact = [];
  const fuzzy = [];

  for (const [name, entry] of Object.entries(entries || {})) {
    const aliases = aliasesFor(name, entry);
    const normalizedAliases = aliases.map(alias => normalizeTrackToken(alias));
    const compactAliases = aliases.map(alias => compactTrackToken(alias));
    const exactAliasTokens = unique(aliases.flatMap(alias => aliasTokens(alias)));
    if (name === raw || normalizeTrackToken(name) === normalized) {
      exact.push(name);
      continue;
    }
    if (exactAliasTokens.includes(normalized) || exactAliasTokens.includes(compact)) {
      aliasExact.push(name);
      continue;
    }
    if (
      normalizedAliases.some(alias => alias.includes(normalized) || normalized.includes(alias)) ||
      compactAliases.some(alias => alias.includes(compact) || compact.includes(alias))
    ) {
      fuzzy.push(name);
    }
  }

  if (exact.length) return unique(exact);
  if (aliasExact.length) return unique(aliasExact);
  return unique(fuzzy);
}

function candidateTracks(config, value) {
  return candidateNames(trackMap(config), value, name => trackAliases(config, name));
}

function resolveTrackName(config, value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const matches = candidateTracks(config, raw);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) error(`Ambiguous track '${raw}'. Matches: ${matches.join(', ')}`);
  error(`Unknown track '${raw}'. Available: ${Object.keys(trackMap(config)).join(', ') || '(none)'}`);
}

function resolveTrack(config, explicitValue, options = {}) {
  const useDefault = options.default !== false;
  const rawValue = explicitValue ||
    trackEnv() ||
    (useDefault && config.defaults ? config.defaults.track : null) ||
    null;
  const source = explicitValue
    ? 'explicit'
    : (trackEnv()
      ? 'env'
      : (useDefault && config.defaults && config.defaults.track ? 'default' : 'none'));
  if (!rawValue) {
    if (options.required === true) {
      error(`${options.label || 'track'} requires --set <track>, DEVTEAM_TRACK, or defaults.track.`);
    }
    return { value: null, source };
  }
  const value = resolveTrackName(config, rawValue);
  return {
    value,
    source,
    input: String(rawValue),
    resolved: value,
    alias: String(rawValue) !== value,
  };
}

function resolveWorkspaceSet(config, explicitValue, options = {}) {
  return resolveTrack(config, explicitValue, options);
}

function sameTrack(config, left, right) {
  try {
    return resolveTrackName(config, left) === resolveTrackName(config, right);
  } catch (_) {
    return false;
  }
}

function resolveFeatureName(config, trackName, value, options = {}) {
  const track = trackName ? trackMap(config)[resolveTrackName(config, trackName)] : null;
  const features = track && track.features ? track.features : {};
  const defaultFeat = options.default !== false
    ? ((config.defaults && config.defaults.feat ? config.defaults.feat : null) || (track ? track.default_feat : null))
    : null;
  const raw = value || featEnv() || defaultFeat || null;
  const source = value
    ? 'explicit'
    : (featEnv() ? 'env' : (raw ? 'default' : 'none'));
  if (!raw) {
    if (options.required === true) {
      error(`${options.label || 'feature'} requires --feat <name> or DEVTEAM_FEAT.`);
    }
    return { value: null, source };
  }
  const matches = candidateNames(features, raw, featureAliases);
  if (matches.length === 1) {
    return {
      value: matches[0],
      source,
      input: String(raw),
      resolved: matches[0],
      alias: String(raw) !== matches[0],
    };
  }
  if (matches.length > 1) error(`Ambiguous feature '${raw}'. Matches: ${matches.join(', ')}`);
  error(`Unknown feature '${raw}' for track '${trackName}'. Available: ${Object.keys(features).join(', ') || '(none)'}`);
}

function resolveTrackSelection(config, options = {}) {
  const track = resolveTrack(config, options.set || options.track || null, {
    required: options.required === true,
    default: options.default,
    label: options.label || 'track',
  });
  const feat = track.value
    ? resolveFeatureName(config, track.value, options.feat || options.feature || null, {
      required: options.featRequired === true,
      default: options.featDefault,
    })
    : { value: null, source: 'none' };
  return {
    track: track.value,
    track_source: track.source,
    track_input: track.input || null,
    feat: feat.value,
    feat_source: feat.source,
    feat_input: feat.input || null,
    value: track.value,
    source: track.source,
  };
}

function trackEntry(config, track) {
  const resolved = resolveTrackName(config, track);
  const entry = trackMap(config)[resolved];
  if (!entry) error(`Unknown track '${track}'. Available: ${Object.keys(trackMap(config)).join(', ') || '(none)'}`);
  return { name: resolved, entry };
}

function worktreeIdsForSelection(config, selection = {}) {
  const track = selection.track || selection.set || selection.value || null;
  if (!track) return Object.keys(config.worktrees || {});
  const { name, entry } = trackEntry(config, track);
  const base = Array.isArray(entry.worktrees) ? entry.worktrees : [];
  const featName = selection.feat || selection.feature || null;
  if (!featName) return base;
  const resolvedFeat = resolveFeatureName(config, name, featName).value;
  const feature = entry.features && entry.features[resolvedFeat] ? entry.features[resolvedFeat] : {};
  return Array.isArray(feature.worktrees) ? feature.worktrees : [];
}

function worktreeIdsForTrack(config, track, options = {}) {
  return worktreeIdsForSelection(config, { track, feat: options.feat || null });
}

function worktreesForTrack(config, track, options = {}) {
  return worktreeIdsForTrack(config, track, options).map(id => config.worktrees[id]).filter(Boolean);
}

function findProfile(config, kind, trackName) {
  const { entry } = trackEntry(config, trackName);
  if (entry[kind]) return entry[kind];
  const profiles = config[`${kind}_profiles`] || {};
  if (profiles[trackName]) return trackName;
  const suffix = kind === 'build' ? 'image' : kind;
  const exact = `${trackName}-${suffix}`;
  if (profiles[exact]) return exact;
  for (const [name, profile] of Object.entries(profiles)) {
    if (profile && (profile.track === trackName || profile.workspace_set === trackName)) return name;
  }
  return null;
}

function findDeployFlow(config, trackName) {
  const { entry } = trackEntry(config, trackName);
  if (entry.deploy_flow) return entry.deploy_flow;
  const exact = `${trackName}-preprod`;
  if (config.deploy_flows[exact]) return exact;
  for (const [name, flow] of Object.entries(config.deploy_flows || {})) {
    if (flow && (flow.track === trackName || flow.workspace_set === trackName || name === trackName || name.startsWith(`${trackName}-`))) {
      return name;
    }
  }
  return null;
}

function inferTrackProfile(config, track, options = {}) {
  const { name, entry } = trackEntry(config, track);
  const activeTrack = options.activeTrack || (config.defaults ? config.defaults.track : null);
  const feat = options.feat || null;
  const resolvedFeat = feat ? resolveFeatureName(config, name, feat).value : null;
  const feature = resolvedFeat && entry.features && entry.features[resolvedFeat]
    ? entry.features[resolvedFeat]
    : null;
  const worktrees = worktreesForTrack(config, name, { feat });
  const validationName = (feature && feature.validation) || entry.validation || findProfile(config, 'validation', name);
  const validation = validationName ? (config.validation_profiles[validationName] || {}) : null;
  const buildName = (feature && feature.build) || entry.build || findProfile(config, 'build', name);
  const deployFlowName = (feature && feature.deploy_flow) || findDeployFlow(config, name);
  const deployFlow = deployFlowName ? (config.deploy_flows[deployFlowName] || {}) : null;
  const preferredEnv = (feature && feature.env) || entry.env || (validation && validation.env ? String(validation.env) : null);
  const syncProfiles = unique(worktrees.map(item => item.sync && item.sync.profile));
  const env = preferredEnv || syncProfiles[0] || (config.defaults ? config.defaults.env : null) || null;
  const sync = (feature && feature.sync) || entry.sync || (syncProfiles.length === 1 ? syncProfiles[0] : (env || (config.defaults ? config.defaults.sync : null) || null));

  return {
    name,
    track: name,
    feat,
    description: entry.description || '',
    aliases: trackAliases(config, name).filter(alias => alias !== name),
    status: entry.status || null,
    policy: entry.policy || null,
    reference_tracks: entry.reference_tracks || [],
    reference_policy: entry.reference_policy || [],
    build_chain_doc: entry.build_chain_doc || null,
    k8s_dev: entry.k8s_dev || {},
    active: activeTrack ? sameTrack(config, activeTrack, name) : false,
    worktrees: worktrees.length,
    repos: unique(worktrees.map(item => item.repo)),
    env,
    sync,
    build: buildName,
    deploy: (feature && feature.deploy) || entry.deploy || (deployFlow && deployFlow.profile ? String(deployFlow.profile) : null),
    deploy_flow: deployFlowName,
    validation: validationName,
    server_test: (feature && feature.server_test) || entry.server_test || null,
    features: entry.features || {},
    default_feat: entry.default_feat || null,
  };
}

module.exports = {
  candidateTracks,
  inferTrackProfile,
  resolveFeatureName,
  resolveTrack,
  resolveTrackName,
  resolveTrackSelection,
  resolveWorkspaceSet,
  sameTrack,
  trackAliases,
  unique,
  worktreeIdsForSelection,
  worktreeIdsForTrack,
  worktreesForTrack,
};
