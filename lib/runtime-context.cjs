'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { output, error, parseArgs } = require('./core.cjs');
const { WORKSPACE_DIR, ensureWorkspaceDirs, loadWorkspaceConfig } = require('./workspace-config.cjs');
const {
  inferTrackProfile,
  resolveTrackSelection,
  worktreeIdsForSelection,
} = require('./track-resolver.cjs');

function mergeProxy(base, override) {
  const hasBase = base && typeof base === 'object' && !Array.isArray(base);
  const hasOverride = override && typeof override === 'object' && !Array.isArray(override);
  if (!hasBase && !hasOverride) return null;
  return {
    ...(hasBase ? base : {}),
    ...(hasOverride ? override : {}),
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function commandQuote(value) {
  return shellQuote(value);
}

function valuePresent(value) {
  return value != null && String(value) !== '';
}

function putEnv(target, key, value) {
  if (!valuePresent(value)) return;
  target[key] = String(value);
}

function proxyToEnv(proxy) {
  const result = {};
  if (!proxy || typeof proxy !== 'object' || Array.isArray(proxy)) return result;

  const allProxy = proxy.all_proxy || proxy.ALL_PROXY || null;
  const httpProxy = proxy.http_proxy || proxy.HTTP_PROXY || null;
  const httpsProxy = proxy.https_proxy || proxy.HTTPS_PROXY || httpProxy;
  const noProxy = proxy.no_proxy || proxy.NO_PROXY || null;
  putEnv(result, 'ALL_PROXY', allProxy);
  putEnv(result, 'all_proxy', allProxy);
  putEnv(result, 'HTTP_PROXY', httpProxy);
  putEnv(result, 'http_proxy', httpProxy);
  putEnv(result, 'HTTPS_PROXY', httpsProxy);
  putEnv(result, 'https_proxy', httpsProxy);
  putEnv(result, 'NO_PROXY', noProxy);
  putEnv(result, 'no_proxy', noProxy);
  putEnv(result, 'UV_LINK_MODE', proxy.uv_link_mode || proxy.UV_LINK_MODE || null);
  putEnv(result, 'UV_HTTP_TIMEOUT', proxy.uv_http_timeout_seconds || proxy.uv_http_timeout || proxy.UV_HTTP_TIMEOUT || null);
  return result;
}

function safeEnvToken(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'WORKTREE';
}

function safeFileToken(value, fallback) {
  const raw = String(value || '').trim();
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  if (slug) return slug;
  if (!raw) return fallback;
  const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 8);
  return `${fallback}-${hash}`;
}

function remoteJoin(root, child) {
  if (!root) return null;
  const base = String(root).replace(/\/+$/, '');
  const suffix = String(child || '').replace(/^\/+/, '');
  return suffix ? `${base}/${suffix}` : base;
}

function resolveEnvironment(config, name) {
  if (!name) return null;
  const environment = config.environments && config.environments[name]
    ? config.environments[name]
    : null;
  if (!environment) {
    error(`Unknown environment '${name}'. Available: ${Object.keys(config.environments || {}).join(', ') || '(none)'}`);
  }
  return environment;
}

function effectiveRuntimeProfile(config, profileName, environmentName) {
  const { effectiveEnvProfile } = require('./env-profile.cjs');
  const profile = profileName ? effectiveEnvProfile(config, profileName) : null;
  const environment = resolveEnvironment(config, environmentName || null);
  if (!profile && !environment) return null;

  if (profile && (!environment || profile.environment === environmentName)) {
    return profile;
  }

  if (!profile) {
    return {
      ...environment,
      name: null,
      type: environment.type || environment.kind || 'environment',
      environment: environmentName,
      environment_profile: environment,
    };
  }

  const proxy = mergeProxy(environment.proxy, profile.proxy);
  return {
    ...environment,
    ...profile,
    proxy: proxy || undefined,
    name: profile.name || profileName,
    environment: environmentName,
    environment_profile: environment,
  };
}

function runtimeExports(config, selection, profileName, syncProfile, profile, environmentName) {
  const env = {};
  putEnv(env, 'DEVTEAM_ROOT', config.root);
  putEnv(env, 'DEVTEAM_TRACK', selection.track || null);
  putEnv(env, 'DEVTEAM_FEAT', selection.feat || null);
  putEnv(env, 'DEVTEAM_ENV_PROFILE', profileName || null);
  putEnv(env, 'DEVTEAM_SYNC_PROFILE', syncProfile || profileName || null);
  putEnv(env, 'DEVTEAM_ENVIRONMENT', environmentName || (profile ? profile.environment : null));
  if (profile) {
    putEnv(env, 'DEVTEAM_HOST', profile.host || null);
    putEnv(env, 'DEVTEAM_SSH', profile.ssh || profile.entry_ssh || null);
    putEnv(env, 'DEVTEAM_WORK_DIR', profile.work_dir || profile.work_root || null);
    putEnv(env, 'DEVTEAM_SOURCE_DIR', profile.source_dir || profile.source_root || null);
    putEnv(env, 'DEVTEAM_VENV', profile.venv || profile.venv_path || null);
    putEnv(env, 'DEVTEAM_PYTHON', profile.python || null);
    putEnv(env, 'DEVTEAM_SITE_PACKAGES', profile.site_packages || null);
    putEnv(env, 'DEVTEAM_REGISTRY', profile.registry || null);
    putEnv(env, 'K8S_NAMESPACE', profile.namespace || null);
    putEnv(env, 'KUBECONFIG', profile.kubeconfig || null);
    putEnv(env, 'DEVTEAM_KUBE_CONTEXT', profile.context || profile.kube_context || null);
    Object.assign(env, proxyToEnv(profile.proxy));
  }
  return env;
}

function selectedWorktrees(config, selection) {
  const ids = selection.track
    ? worktreeIdsForSelection(config, selection)
    : Object.keys(config.worktrees || {});
  return ids.map(id => config.worktrees[id]).filter(Boolean);
}

function runtimeWorktrees(config, selection, profile) {
  return selectedWorktrees(config, selection).map(worktree => {
    const remotePath = worktree.sync && worktree.sync.remote_path
      ? worktree.sync.remote_path
      : (profile && profile.work_dir ? remoteJoin(profile.work_dir, worktree.path) : null);
    const token = safeEnvToken(worktree.id);
    return {
      id: worktree.id,
      repo: worktree.repo || null,
      path: worktree.path || null,
      local_path: worktree.abs_path || null,
      branch: worktree.branch || null,
      base_ref: worktree.base_ref || null,
      sync_profile: worktree.sync && worktree.sync.profile ? worktree.sync.profile : null,
      remote_path: remotePath,
      env: {
        [`DEVTEAM_WORKTREE_${token}_LOCAL_PATH`]: worktree.abs_path || null,
        [`DEVTEAM_WORKTREE_${token}_REMOTE_PATH`]: remotePath,
      },
    };
  });
}

function buildRuntimeContext(options = {}) {
  const config = options.config || loadWorkspaceConfig(options.root || null);
  const selection = resolveTrackSelection(config, {
    set: options.set || null,
    feat: options.feat || null,
    required: options.required === true,
    default: options.default,
    featDefault: options.featDefault,
    label: options.label || 'runtime track',
  });
  const trackProfile = selection.track
    ? inferTrackProfile(config, selection.track, { activeTrack: selection.track, feat: selection.feat || null })
    : null;
  const profileName = options.profile || options.envProfile ||
    (trackProfile ? trackProfile.env : null) ||
    config.defaults.env ||
    null;
  const syncProfile = options.syncProfile ||
    (trackProfile ? trackProfile.sync : null) ||
    config.defaults.sync ||
    profileName ||
    null;
  const environmentName = options.environment || options.env || null;
  const profile = effectiveRuntimeProfile(config, profileName, environmentName);
  const worktrees = runtimeWorktrees(config, selection, profile);
  const env = runtimeExports(config, selection, profileName, syncProfile, profile, environmentName);
  for (const worktree of worktrees) {
    for (const [key, value] of Object.entries(worktree.env || {})) {
      putEnv(env, key, value);
    }
  }
  const cli = path.join(__dirname, 'devteam.cjs');
  const sourceParts = [
    'node',
    commandQuote(cli),
    'env runtime',
    '--root',
    commandQuote(config.root),
    selection.track ? '--set' : null,
    selection.track ? commandQuote(selection.track) : null,
    selection.feat ? '--feat' : null,
    selection.feat ? commandQuote(selection.feat) : null,
    profileName ? '--profile' : null,
    profileName ? commandQuote(profileName) : null,
    syncProfile ? '--sync' : null,
    syncProfile ? commandQuote(syncProfile) : null,
    environmentName ? '--env' : null,
    environmentName ? commandQuote(environmentName) : null,
    '--shell',
  ].filter(Boolean);
  const sourceCommand = `eval "$(${sourceParts.join(' ')})"`;

  return {
    action: 'runtime_context',
    workspace: config.root,
    track: selection.track || null,
    feat: selection.feat || null,
    profile: profileName || null,
    sync_profile: syncProfile || null,
    environment: environmentName || (profile ? profile.environment : null),
    type: profile ? profile.type || 'unknown' : 'none',
    env,
    proxy: profile && profile.proxy ? profile.proxy : null,
    profile_effective: profile ? {
      name: profile.name || profileName || null,
      environment: profile.environment || null,
      type: profile.type || profile.kind || null,
      ssh: profile.ssh || profile.entry_ssh || null,
      host: profile.host || null,
      work_dir: profile.work_dir || null,
      source_dir: profile.source_dir || null,
      venv: profile.venv || profile.venv_path || null,
      python: profile.python || null,
      site_packages: profile.site_packages || null,
      namespace: profile.namespace || null,
      kubeconfig: profile.kubeconfig || null,
      registry: profile.registry || null,
    } : null,
    worktrees,
    shell: {
      source: sourceCommand,
      exports: Object.entries(env).map(([key, value]) => `export ${key}=${shellQuote(value)}`),
    },
    next_action: Object.keys(env).length
      ? 'Source the runtime shell file before running remote or K8s helper commands for this session.'
      : 'No runtime environment variables were inferred for this selection.',
  };
}

function renderRuntimeShell(context) {
  const lines = [
    '#!/usr/bin/env bash',
    '# Generated by devteam. Source this before remote or K8s helper commands.',
    '',
  ];
  for (const [key, value] of Object.entries(context.env || {})) {
    lines.push(`export ${key}=${shellQuote(value)}`);
  }
  return `${lines.join('\n')}\n`;
}

function writeRuntimeShell(context, filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, renderRuntimeShell(context), 'utf8');
  context.shell = {
    ...(context.shell || {}),
    command_source: context.shell ? context.shell.source : null,
    source: `. ${shellQuote(filePath)}`,
  };
  return filePath;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((acc, key) => {
    acc[key] = stableValue(value[key]);
    return acc;
  }, {});
}

function runtimeBindingSnapshot(context) {
  return stableValue({
    workspace: context.workspace || null,
    track: context.track || null,
    feat: context.feat || null,
    profile: context.profile || null,
    sync_profile: context.sync_profile || null,
    environment: context.environment || null,
    type: context.type || null,
    env: context.env || {},
    proxy: context.proxy || null,
    profile_effective: context.profile_effective || null,
    worktrees: (context.worktrees || []).map(worktree => ({
      id: worktree.id || null,
      repo: worktree.repo || null,
      path: worktree.path || null,
      local_path: worktree.local_path || null,
      branch: worktree.branch || null,
      base_ref: worktree.base_ref || null,
      sync_profile: worktree.sync_profile || null,
      remote_path: worktree.remote_path || null,
      env: worktree.env || {},
    })),
  });
}

function runtimeBindingDigest(context) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(runtimeBindingSnapshot(context)))
    .digest('hex');
}

function runtimeBindingScope(context) {
  const parts = [
    context.track ? safeFileToken(context.track, 'track') : 'workspace',
  ];
  if (context.feat) {
    parts.push(`feat-${safeFileToken(context.feat, 'feature')}`);
  }
  if (context.profile) {
    parts.push(`profile-${safeFileToken(context.profile, 'profile')}`);
  }
  if (context.environment) {
    parts.push(`env-${safeFileToken(context.environment, 'environment')}`);
  }
  if (context.sync_profile && context.sync_profile !== context.profile) {
    parts.push(`sync-${safeFileToken(context.sync_profile, 'sync')}`);
  }
  return parts.join('__');
}

function runtimeBindingPaths(configOrRoot, context) {
  const root = typeof configOrRoot === 'string'
    ? configOrRoot
    : configOrRoot.root;
  const scope = runtimeBindingScope(context);
  const stateDir = path.join(root, WORKSPACE_DIR, 'state');
  return {
    scope,
    shell_path: path.join(stateDir, `runtime-${scope}.sh`),
    json_path: path.join(stateDir, `runtime-${scope}.json`),
  };
}

function runtimeBindingSource(shellPath) {
  return `. ${shellQuote(shellPath)}`;
}

function buildRuntimeOptions(parsed) {
  return {
    root: parsed.root || null,
    set: parsed.set || null,
    feat: parsed.feat || null,
    profile: parsed.profile || null,
    syncProfile: parsed.sync || null,
    environment: parsed.env || parsed.environment || null,
    required: parsed.set != null || parsed.feat != null,
  };
}

function bindRuntimeContext(options = {}) {
  const config = options.config || loadWorkspaceConfig(options.root || null);
  const context = buildRuntimeContext({
    config,
    set: options.set || null,
    feat: options.feat || null,
    profile: options.profile || null,
    syncProfile: options.syncProfile || null,
    environment: options.environment || null,
    required: options.required === true,
  });
  ensureWorkspaceDirs(config.root);
  const paths = runtimeBindingPaths(config, context);
  writeRuntimeShell(context, paths.shell_path);
  const record = {
    action: 'runtime_bind',
    workspace: config.root,
    scope: paths.scope,
    shell_path: paths.shell_path,
    json_path: paths.json_path,
    source: context.shell ? context.shell.source : runtimeBindingSource(paths.shell_path),
    bound_at: new Date().toISOString(),
    digest: runtimeBindingDigest(context),
    context,
  };
  fs.writeFileSync(paths.json_path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return record;
}

function readRuntimeBinding(options = {}) {
  const config = options.config || loadWorkspaceConfig(options.root || null);
  const context = options.context || buildRuntimeContext({
    config,
    set: options.set || null,
    feat: options.feat || null,
    profile: options.profile || null,
    syncProfile: options.syncProfile || null,
    environment: options.environment || null,
    required: options.required === true,
  });
  const paths = runtimeBindingPaths(config, context);
  const shellExists = fs.existsSync(paths.shell_path);
  const jsonExists = fs.existsSync(paths.json_path);
  const summary = {
    exists: shellExists,
    current: false,
    scope: paths.scope,
    shell_path: paths.shell_path,
    json_path: paths.json_path,
    source: runtimeBindingSource(paths.shell_path),
    shell_exists: shellExists,
    json_exists: jsonExists,
    bound_at: null,
    digest: null,
    error: null,
  };
  if (!jsonExists) return summary;
  try {
    const record = JSON.parse(fs.readFileSync(paths.json_path, 'utf8'));
    const digest = runtimeBindingDigest(context);
    summary.bound_at = record.bound_at || null;
    summary.digest = record.digest || null;
    summary.current = shellExists && record.digest === digest;
  } catch (err) {
    summary.error = err.message;
  }
  return summary;
}

function renderRuntimeBindText(binding) {
  const context = binding.context || {};
  const env = context.env || {};
  const worktrees = context.worktrees || [];
  return [
    'Runtime Binding',
    '',
    `Workspace: ${binding.workspace || context.workspace || '-'}`,
    `Track: ${context.track || '-'}`,
    context.feat ? `Feature: ${context.feat}` : null,
    `Profile: ${context.profile || '-'}`,
    `Environment: ${context.environment || '-'}`,
    `Shell: ${binding.shell_path}`,
    `JSON: ${binding.json_path}`,
    `Source: ${binding.source}`,
    `Exports: ${Object.keys(env).length}`,
    `Worktrees: ${worktrees.length}`,
    `Bound at: ${binding.bound_at || '-'}`,
    '',
    'Next:',
    `  ${binding.source}`,
  ].filter(Boolean).join('\n');
}

function handleRuntimeBind(args) {
  const parsed = parseArgs(args || []);
  const binding = bindRuntimeContext(buildRuntimeOptions(parsed));
  if (parsed.text === true) {
    process.stdout.write(renderRuntimeBindText(binding) + '\n');
  } else {
    output(binding);
  }
}

function renderRuntimeText(context) {
  const lines = [
    'Runtime Context',
    '',
    `Workspace: ${context.workspace}`,
    `Track: ${context.track || '-'}`,
    context.feat ? `Feature: ${context.feat}` : null,
    `Profile: ${context.profile || '-'}`,
    `Environment: ${context.environment || '-'}`,
    `Type: ${context.type || '-'}`,
    '',
    'Exports:',
  ].filter(Boolean);
  const env = context.env || {};
  const keys = Object.keys(env).sort();
  if (!keys.length) {
    lines.push('  (none)');
  } else {
    for (const key of keys) {
      lines.push(`  export ${key}=${shellQuote(env[key])}`);
    }
  }
  lines.push('', 'Worktrees:');
  if (!context.worktrees || !context.worktrees.length) {
    lines.push('  (none)');
  } else {
    for (const worktree of context.worktrees) {
      lines.push(`  ${worktree.id}  local=${worktree.local_path || '-'}  remote=${worktree.remote_path || '-'}`);
    }
  }
  return lines.join('\n');
}

function handleRuntimeContext(args) {
  const parsed = parseArgs(args || []);
  const context = buildRuntimeContext(buildRuntimeOptions(parsed));
  if (parsed.output) {
    writeRuntimeShell(context, path.resolve(parsed.output));
  }
  if (parsed.shell === true) {
    process.stdout.write(renderRuntimeShell(context));
    return;
  }
  if (parsed.text === true) {
    process.stdout.write(renderRuntimeText(context) + '\n');
  } else {
    output(context);
  }
}

module.exports = {
  bindRuntimeContext,
  buildRuntimeContext,
  handleRuntimeBind,
  handleRuntimeContext,
  proxyToEnv,
  readRuntimeBinding,
  renderRuntimeBindText,
  renderRuntimeShell,
  renderRuntimeText,
  runtimeBindingPaths,
  writeRuntimeShell,
};
