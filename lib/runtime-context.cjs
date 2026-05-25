'use strict';

const fs = require('fs');
const path = require('path');

const { output, error, parseArgs } = require('./core.cjs');
const { loadWorkspaceConfig } = require('./workspace-config.cjs');
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
  const context = buildRuntimeContext({
    root: parsed.root || null,
    set: parsed.set || null,
    feat: parsed.feat || null,
    profile: parsed.profile || null,
    syncProfile: parsed.sync || null,
    environment: parsed.env || parsed.environment || null,
    required: parsed.set != null || parsed.feat != null,
  });
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
  buildRuntimeContext,
  handleRuntimeContext,
  proxyToEnv,
  renderRuntimeShell,
  renderRuntimeText,
  writeRuntimeShell,
};
