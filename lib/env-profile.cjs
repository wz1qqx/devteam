'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { output, error, parseArgs } = require('./core.cjs');
const { loadWorkspaceConfig, normalizeStringList, resolvePath } = require('./workspace-config.cjs');
const {
  environmentList,
  environmentShow,
} = require('./capability-registry.cjs');
const {
  inferTrackProfile,
  resolveTrackSelection,
  worktreeIdsForSelection,
} = require('./track-resolver.cjs');

function mergeProxy(base, override) {
  const hasBase = base && typeof base === 'object' && !Array.isArray(base);
  const hasOverride = override && typeof override === 'object' && !Array.isArray(override);
  if (!hasBase && !hasOverride) return undefined;
  return {
    ...(hasBase ? base : {}),
    ...(hasOverride ? override : {}),
  };
}

function resolveEnvironment(config, profile) {
  const name = profile && profile.environment ? String(profile.environment) : null;
  if (!name) return { name: null, environment: null };
  const environment = config.environments && config.environments[name]
    ? config.environments[name]
    : null;
  return { name, environment };
}

function effectiveEnvProfile(config, profileName) {
  const name = profileName || config.defaults.env || config.defaults.deploy;
  if (!name) {
    error('No env profile specified. Pass --profile <name> or set defaults.env.');
  }
  const profile = config.env_profiles[name];
  if (!profile) {
    error(`Unknown env profile '${name}'. Available: ${Object.keys(config.env_profiles).join(', ') || '(none)'}`);
  }
  const { name: environmentName, environment } = resolveEnvironment(config, profile);
  if (environmentName && !environment) {
    error(`env_profiles.${name}.environment references unknown environment '${environmentName}'.`);
  }
  const merged = {
    ...(environment || {}),
    ...profile,
  };
  const proxy = mergeProxy(environment ? environment.proxy : null, profile.proxy);
  if (proxy) merged.proxy = proxy;
  merged.name = name;
  merged.environment = environmentName || null;
  merged.environment_profile = environment || null;
  return merged;
}

function commandExists(command) {
  const result = spawnSync('sh', ['-lc', `command -v ${command}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result.status === 0;
}

function inferRequiredCommands(profile) {
  const required = new Set();
  if (profile.type === 'remote_dev') {
    required.add('ssh');
    required.add('rsync');
  } else if (profile.type === 'k8s') {
    if (profile.ssh) required.add('ssh');
    required.add('kubectl');
  }
  for (const cmd of normalizeStringList(profile.local_commands)) required.add(cmd);
  return Array.from(required);
}

function remoteCommand(sshCommand, command, options = {}) {
  if (!sshCommand) {
    return {
      status: 'failed',
      exit_code: 1,
      stdout: '',
      stderr: 'ssh command is missing',
      duration_ms: 0,
    };
  }
  const started = Date.now();
  const result = spawnSync(`${sshCommand} ${shellQuote(command)}`, {
    shell: true,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeoutMs || 30000,
  });
  return {
    status: result.status === 0 ? 'passed' : 'failed',
    exit_code: typeof result.status === 'number' ? result.status : 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    duration_ms: Date.now() - started,
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function jsonArg(value) {
  return JSON.stringify(String(value));
}

function remoteDirname(value) {
  const text = String(value || '').replace(/\/+$/, '');
  if (!text || text === '/') return null;
  const index = text.lastIndexOf('/');
  if (index <= 0) return '/';
  return text.slice(0, index);
}

function remoteJoin(root, child) {
  if (!root) return null;
  const base = String(root).replace(/\/+$/, '');
  const suffix = String(child || '').replace(/^\/+/, '');
  return suffix ? `${base}/${suffix}` : base;
}

function uniqueList(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function sshCommand(profile, command) {
  const ssh = profile.ssh || profile.entry_ssh || null;
  return ssh ? `${ssh} ${shellQuote(command)}` : command;
}

function bootstrapObject(profile) {
  return profile && profile.bootstrap && typeof profile.bootstrap === 'object' && !Array.isArray(profile.bootstrap)
    ? profile.bootstrap
    : {};
}

function bootstrapRecipe(config, profile) {
  const spec = bootstrapObject(profile);
  const value = typeof profile.bootstrap === 'string'
    ? profile.bootstrap
    : (profile.bootstrap_recipe || spec.recipe || spec.path || null);
  if (!value) return null;
  const absolute = resolvePath(config.root, value);
  return {
    path: value,
    abs_path: absolute,
    exists: fs.existsSync(absolute),
  };
}

function bootstrapCommands(profile) {
  const spec = bootstrapObject(profile);
  return uniqueList([
    ...normalizeStringList(profile.bootstrap_commands),
    ...normalizeStringList(profile.setup_commands),
    ...normalizeStringList(spec.commands),
  ]);
}

function proxyPrefixLines(profile) {
  const lines = proxyExportLines(profile.proxy);
  return lines.length ? lines : [];
}

function selectedRemoteWorktrees(config, selection, profile) {
  const profileName = profile ? profile.name : null;
  const ids = selection.track
    ? worktreeIdsForSelection(config, selection)
    : Object.keys(config.worktrees || {});
  return ids.map(id => config.worktrees[id]).filter(Boolean).map(worktree => ({
    id: worktree.id,
    repo: worktree.repo || null,
    local_path: worktree.abs_path || null,
    remote_path: worktree.sync && worktree.sync.remote_path
      ? worktree.sync.remote_path
      : remoteJoin(profile ? profile.work_dir : null, worktree.path),
    sync_profile: worktree.sync && worktree.sync.profile ? worktree.sync.profile : null,
  })).filter(worktree => !worktree.sync_profile || !profileName || worktree.sync_profile === profileName);
}

function looksLikeVllmProfile(profile) {
  const fields = [
    profile.source_dir,
    profile.venv,
    profile.python,
    profile.site_packages,
  ].filter(Boolean).join(' ');
  return /\bvllm\b|vllm[-_]?int/i.test(fields);
}

function vllmImportCheckCommand(profile) {
  const sourceDir = String(profile.source_dir || '');
  const python = String(profile.python || '');
  if (!sourceDir || !python) return null;

  const script = [
    'import importlib.metadata as metadata',
    'import inspect',
    'import site',
    'import sys',
    'import vllm',
    'print("python", sys.version.split()[0])',
    'print("prefix", sys.prefix)',
    'print("site_packages", site.getsitepackages()[0])',
    'print("vllm_version", metadata.version("vllm"))',
    'print("vllm_file", inspect.getfile(vllm))',
  ].join('; ');

  return [
    `cd ${shellQuote(sourceDir)}`,
    '&&',
    `${shellQuote(python)} -c ${shellQuote(script)}`,
  ].join(' ');
}

function proxyExportLines(proxy) {
  if (!proxy || typeof proxy !== 'object' || Array.isArray(proxy)) return [];
  const lines = [];
  if (proxy.all_proxy) {
    lines.push(`export ALL_PROXY=${shellQuote(proxy.all_proxy)} all_proxy=${shellQuote(proxy.all_proxy)}`);
  }
  if (proxy.http_proxy) {
    lines.push(`export HTTP_PROXY=${shellQuote(proxy.http_proxy)} HTTPS_PROXY=${shellQuote(proxy.http_proxy)}`);
    lines.push(`export http_proxy=${shellQuote(proxy.http_proxy)} https_proxy=${shellQuote(proxy.http_proxy)}`);
  }
  if (proxy.no_proxy) {
    lines.push(`export NO_PROXY=${shellQuote(proxy.no_proxy)} no_proxy=${shellQuote(proxy.no_proxy)}`);
  }
  if (proxy.uv_link_mode) {
    lines.push(`export UV_LINK_MODE=${shellQuote(proxy.uv_link_mode)}`);
  }
  if (proxy.uv_http_timeout_seconds) {
    lines.push(`export UV_HTTP_TIMEOUT=${shellQuote(proxy.uv_http_timeout_seconds)}`);
  }
  return lines;
}

function buildVllmRefreshCommand(profile) {
  const sourceDir = profile.source_dir ? String(profile.source_dir) : '';
  const venv = profile.venv ? String(profile.venv) : '';
  const python = profile.python ? String(profile.python) : '';
  const uv = profile.uv ? String(profile.uv) : '/root/.local/bin/uv';
  const importCheck = vllmImportCheckCommand(profile);

  if (!sourceDir || !venv || !python) {
    error('env refresh requires source_dir, venv, and python in the env profile.');
  }
  if (!looksLikeVllmProfile(profile)) {
    error('env refresh currently supports vLLM-like remote_dev profiles only.');
  }
  if (!importCheck) {
    error('env refresh could not build vLLM import check command.');
  }

  const installMode = profile.install_mode ? String(profile.install_mode) : 'editable-precompiled';
  if (installMode !== 'editable-precompiled') {
    error(`env refresh currently supports install_mode=editable-precompiled, got '${installMode}'.`);
  }

  const lines = [
    'set -euo pipefail',
    `cd ${shellQuote(sourceDir)}`,
    'test -d .git',
    'git status --short --branch',
    '(test -z "$(git status --porcelain)" || { git status --short; echo source_mirror_dirty >&2; exit 2; })',
    'git rev-parse HEAD',
    "git describe --tags --match 'v*' --always",
    `test -d ${shellQuote(venv)}`,
    `test -x ${shellQuote(python)}`,
    ...proxyExportLines(profile.proxy),
    `VIRTUAL_ENV=${shellQuote(venv)} VLLM_USE_PRECOMPILED=1 ${shellQuote(uv)} pip install --python ${shellQuote(python)} -e . --torch-backend=auto`,
    importCheck,
  ];
  return lines.join(' && ');
}

function remoteChecksForProfile(profile) {
  if (profile.remote_checks && Array.isArray(profile.remote_checks)) {
    return profile.remote_checks.map(item => String(item || '').trim()).filter(Boolean);
  }
  if (profile.type === 'remote_dev') {
    const workDir = profile.work_dir ? String(profile.work_dir) : '';
    const sourceDir = profile.source_dir ? String(profile.source_dir) : '';
    const venv = profile.venv ? String(profile.venv) : '';
    const python = profile.python ? String(profile.python) : '';
    const sitePackages = profile.site_packages ? String(profile.site_packages) : '';
    const checks = [
      'uname -a',
      sourceDir
        ? `test -d ${shellQuote(sourceDir)} && echo source_dir_ok`
        : (workDir ? `test -d ${shellQuote(workDir)} && echo work_dir_ok` : 'pwd'),
      sourceDir
        ? `cd ${shellQuote(sourceDir)} && git status --short --branch && git rev-parse HEAD && git describe --tags --match 'v*' --always`
        : null,
      venv ? `test -d ${shellQuote(venv)} && echo venv_ok` : null,
      python ? `test -x ${shellQuote(python)} && ${shellQuote(python)} --version` : null,
      sitePackages ? `test -d ${shellQuote(sitePackages)} && echo site_packages_ok` : null,
      'command -v docker || true',
      'command -v python3 || true',
      'nvidia-smi -L || true',
    ];
    const importCheck = looksLikeVllmProfile(profile)
      ? vllmImportCheckCommand(profile)
      : null;
    if (importCheck) checks.push(importCheck);
    return checks.filter(Boolean);
  }
  if (profile.type === 'k8s') {
    const namespace = profile.namespace ? String(profile.namespace) : 'default';
    return [
      'command -v kubectl || true',
      `kubectl get namespace ${JSON.stringify(namespace)} --ignore-not-found`,
    ];
  }
  return ['uname -a'];
}

function doctorProfile(config, profileName, options = {}) {
  const profile = effectiveEnvProfile(config, profileName);
  const name = profile.name;

  const checks = [];
  for (const command of inferRequiredCommands(profile)) {
    checks.push({
      kind: 'local_command',
      name: command,
      ok: commandExists(command),
    });
  }

  if (profile.type === 'remote_dev') {
    checks.push({ kind: 'config', name: 'ssh', ok: Boolean(profile.ssh), value: profile.ssh || null });
    checks.push({ kind: 'config', name: 'host', ok: Boolean(profile.host), value: profile.host || null });
    checks.push({
      kind: 'config',
      name: 'work_dir_or_source_dir',
      ok: Boolean(profile.work_dir || profile.source_dir),
      value: profile.work_dir || profile.source_dir || null,
    });
  }

  if (profile.type === 'k8s') {
    checks.push({ kind: 'config', name: 'namespace', ok: Boolean(profile.namespace), value: profile.namespace || null });
  }

  const remote_checks = [];
  if (options.remote === true) {
    for (const command of remoteChecksForProfile(profile)) {
      remote_checks.push({
        command,
        ...remoteCommand(profile.ssh, command),
      });
    }
  }

  const failed = checks.filter(check => !check.ok);
  const remoteFailed = remote_checks.filter(check => check.status !== 'passed');
  const payload = {
    profile: name,
    environment: profile.environment || null,
    type: profile.type || 'unknown',
    status: failed.length === 0 && remoteFailed.length === 0 ? 'pass' : 'fail',
    checks,
    remote_checks,
    next_action: failed.length === 0
      ? (options.remote === true
        ? 'Remote read-only checks completed. Review stdout/stderr before running sync or deploy.'
        : 'Environment profile is locally configured. Remote checks are intentionally not executed unless --remote is passed.')
      : 'Install missing local tools or fill missing profile fields before running sync/deploy.',
  };

  if (options.run) {
    const { recordSessionEvent } = require('./session-manager.cjs');
    const mode = options.remote === true ? 'remote' : 'local';
    const failedNames = [
      ...failed.map(check => check.name || check.kind || 'local_check'),
      ...remoteFailed.map(check => check.command || 'remote_check'),
    ];
    payload.record = recordSessionEvent({
      root: config.root,
      run: options.run,
      set: options.set || null,
      feat: options.feat || null,
      allowCrossTrack: options.allowCrossTrack === true,
      kind: 'env-doctor',
      status: payload.status === 'pass' ? 'passed' : 'failed',
      summary: failedNames.length
        ? `env doctor ${payload.status} for ${name} (${mode}); failed: ${failedNames.join(', ')}`
        : `env doctor ${payload.status} for ${name} (${mode}); ${checks.length} local checks, ${remote_checks.length} remote checks`,
      command: `devteam env doctor --profile ${name}${options.remote === true ? ' --remote' : ''}`,
    });
  }

  return payload;
}

function buildBootstrapPreflightCommands(profile, worktrees) {
  const commands = [];
  const dirs = uniqueList([
    profile.work_dir || null,
    profile.source_dir ? remoteDirname(profile.source_dir) : null,
    profile.source_dir || null,
    profile.venv ? remoteDirname(profile.venv) : null,
    ...(worktrees || []).map(worktree => worktree.remote_path ? remoteDirname(worktree.remote_path) : null),
  ]);
  if (dirs.length) {
    commands.push(`mkdir -p ${dirs.map(shellQuote).join(' ')}`);
  }
  if (profile.source_dir) {
    commands.push(`(test -d ${shellQuote(profile.source_dir)} || echo source_dir_missing:${shellQuote(profile.source_dir)})`);
  }
  if (profile.venv) {
    commands.push(`(test -d ${shellQuote(profile.venv)} || echo venv_missing:${shellQuote(profile.venv)})`);
  }
  if (profile.python) {
    commands.push(`(test -x ${shellQuote(profile.python)} || echo python_missing:${shellQuote(profile.python)})`);
  }
  return commands;
}

function envBootstrapPlan(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const selection = resolveTrackSelection(config, {
    set: options.set || null,
    feat: options.feat || null,
    required: options.set != null || options.feat != null,
    default: options.default,
    featDefault: options.featDefault,
    label: 'bootstrap track',
  });
  const trackProfile = selection.track
    ? inferTrackProfile(config, selection.track, { activeTrack: selection.track, feat: selection.feat || null })
    : null;
  const profileName = options.profile ||
    (trackProfile ? trackProfile.env : null) ||
    config.defaults.env ||
    null;
  const profile = effectiveEnvProfile(config, profileName);
  const worktrees = selectedRemoteWorktrees(config, selection, profile);
  const recipe = bootstrapRecipe(config, profile);
  const configuredCommands = bootstrapCommands(profile);
  const preflightCommands = buildBootstrapPreflightCommands(profile, worktrees);
  const commandGroups = [];
  if (profile.type === 'remote_dev') {
    const remotePreflight = [
      'set -euo pipefail',
      ...proxyPrefixLines(profile),
      ...preflightCommands,
    ];
    if (remotePreflight.length > 1) {
      commandGroups.push({
        kind: 'remote_preflight',
        mode: 'manual',
        command: sshCommand(profile, remotePreflight.join(' && ')),
      });
    }
    for (const command of configuredCommands) {
      commandGroups.push({
        kind: 'configured',
        mode: 'manual',
        command: sshCommand(profile, command),
      });
    }
  } else if (profile.type === 'k8s') {
    const namespace = profile.namespace || (profile.environment_profile && Array.isArray(profile.environment_profile.namespace_defaults)
      ? profile.environment_profile.namespace_defaults[0]
      : null);
    const kubeconfig = profile.kubeconfig || (profile.environment_profile ? profile.environment_profile.kubeconfig : null);
    const prefix = [
      kubeconfig ? `export KUBECONFIG=${shellQuote(kubeconfig)}` : null,
      ...proxyPrefixLines(profile),
    ].filter(Boolean).join(' && ');
    const nsCommand = namespace ? `kubectl get namespace ${jsonArg(namespace)} --ignore-not-found` : 'kubectl config current-context';
    commandGroups.push({
      kind: 'k8s_preflight',
      mode: 'manual',
      command: [prefix, nsCommand].filter(Boolean).join(' && '),
    });
    for (const command of configuredCommands) {
      commandGroups.push({
        kind: 'configured',
        mode: 'manual',
        command: [prefix, command].filter(Boolean).join(' && '),
      });
    }
  } else {
    for (const command of configuredCommands) {
      commandGroups.push({
        kind: 'configured',
        mode: 'manual',
        command,
      });
    }
  }

  const missing = [];
  if (profile.type === 'remote_dev' && !(profile.ssh || profile.entry_ssh)) missing.push('ssh');
  if (profile.type === 'remote_dev' && !(profile.work_dir || profile.source_dir)) missing.push('work_dir_or_source_dir');
  if (profile.type === 'k8s' && !profile.namespace) missing.push('namespace');
  if (recipe && !recipe.exists) missing.push('bootstrap_recipe');

  return {
    action: 'env_bootstrap_plan',
    workspace: config.root,
    track: selection.track || null,
    feat: selection.feat || null,
    profile: profile.name,
    environment: profile.environment || null,
    type: profile.type || 'unknown',
    dry_run: true,
    status: missing.length ? 'blocked' : 'planned',
    missing,
    recipe,
    worktrees,
    directories: {
      work_dir: profile.work_dir || null,
      source_dir: profile.source_dir || null,
      venv: profile.venv || null,
      site_packages: profile.site_packages || null,
    },
    runtime: {
      bind_command: [
        'node',
        shellQuote(path.join(__dirname, 'devteam.cjs')),
        'env bind',
        '--root',
        shellQuote(config.root),
        selection.track ? '--set' : null,
        selection.track ? shellQuote(selection.track) : null,
        selection.feat ? '--feat' : null,
        selection.feat ? shellQuote(selection.feat) : null,
        '--profile',
        shellQuote(profile.name),
        profile.environment ? '--env' : null,
        profile.environment ? shellQuote(profile.environment) : null,
        '--text',
      ].filter(Boolean).join(' '),
    },
    commands: commandGroups,
    next_action: missing.length
      ? `Fill missing bootstrap fields: ${missing.join(', ')}.`
      : (recipe
        ? `Review ${recipe.path}, run the preflight command manually, then execute the recipe only when you intend to initialize the environment.`
        : 'Run the preflight command manually before initializing this environment. Add bootstrap_commands or bootstrap recipe for richer setup.'),
  };
}

function renderEnvBootstrapText(plan) {
  const lines = [
    'Env Bootstrap Plan',
    '',
    `Workspace: ${plan.workspace}`,
    `Track: ${plan.track || '-'}`,
    plan.feat ? `Feature: ${plan.feat}` : null,
    `Profile: ${plan.profile}`,
    `Environment: ${plan.environment || '-'}`,
    `Type: ${plan.type || '-'}`,
    `Status: ${plan.status}`,
    '',
    'Runtime:',
    `  ${plan.runtime.bind_command}`,
    '',
    'Directories:',
  ].filter(Boolean);
  const dirs = plan.directories || {};
  for (const key of ['work_dir', 'source_dir', 'venv', 'site_packages']) {
    lines.push(`  ${key}: ${dirs[key] || '-'}`);
  }
  lines.push('', 'Bootstrap Recipe:');
  if (plan.recipe) {
    lines.push(`  ${plan.recipe.path} (${plan.recipe.exists ? 'present' : 'missing'})`);
  } else {
    lines.push('  (none)');
  }
  lines.push('', 'Commands:');
  if (!plan.commands || !plan.commands.length) {
    lines.push('  (none)');
  } else {
    for (const item of plan.commands) {
      lines.push(`  # ${item.kind}`);
      lines.push(`  ${item.command}`);
    }
  }
  lines.push('', `Next: ${plan.next_action}`);
  return lines.join('\n');
}

function refreshEnvProfile(config, profileName, options = {}) {
  const profile = effectiveEnvProfile(config, profileName);
  const name = profile.name;
  if (profile.type !== 'remote_dev') {
    error(`env refresh requires a remote_dev profile, got '${profile.type || 'unknown'}'.`);
  }
  if (!profile.ssh) {
    error(`env refresh requires env_profiles.${name}.ssh.`);
  }

  const command = buildVllmRefreshCommand(profile);
  const execute = options.yes === true;
  const payload = {
    action: 'env_refresh',
    profile: name,
    environment: profile.environment || null,
    type: profile.type,
    dry_run: !execute,
    install_mode: profile.install_mode || 'editable-precompiled',
    source_dir: profile.source_dir || null,
    venv: profile.venv || null,
    python: profile.python || null,
    command,
    status: execute ? 'running' : 'planned',
    next_action: execute
      ? 'Review stdout/stderr. Run env doctor --remote if you need an independent post-refresh check.'
      : 'Pass --yes to refresh the remote editable install metadata.',
  };

  if (!execute) return payload;

  const result = remoteCommand(profile.ssh, command, {
    timeoutMs: options.timeoutMs || 600000,
  });
  const refreshed = {
    ...payload,
    status: result.status,
    dry_run: false,
    result,
  };
  if (options.run) {
    const { recordSessionEvent } = require('./session-manager.cjs');
    const versionLine = String(result.stdout || '').split('\n')
      .find(line => line.startsWith('vllm_version '));
    refreshed.record = recordSessionEvent({
      root: config.root,
      run: options.run,
      set: options.set || null,
      feat: options.feat || null,
      allowCrossTrack: options.allowCrossTrack === true,
      kind: 'env-refresh',
      status: result.status,
      summary: versionLine
        ? `env refresh ${result.status}: ${versionLine}`
        : `env refresh ${result.status} for ${name}`,
      command: `devteam env refresh --profile ${name} --yes`,
      notes: result.status === 'passed' ? null : String(result.stderr || '').trim().slice(0, 1000) || null,
    });
  }
  return refreshed;
}

function handleEnvProfile(subcommand, args) {
  const parsed = parseArgs(args || []);
  if (subcommand === 'runtime') {
    const { handleRuntimeContext } = require('./runtime-context.cjs');
    handleRuntimeContext(args || []);
    return;
  }
  if (subcommand === 'bind') {
    const { handleRuntimeBind } = require('./runtime-context.cjs');
    handleRuntimeBind(args || []);
    return;
  }
  const config = loadWorkspaceConfig(parsed.root || null);
  if (!subcommand || subcommand === 'doctor') {
    output(doctorProfile(config, parsed.profile || null, {
      remote: parsed.remote === true,
      run: parsed.run || null,
      set: parsed.set || null,
      feat: parsed.feat || null,
      allowCrossTrack: parsed['allow-cross-track'] === true,
    }));
    return;
  }
  if (subcommand === 'list') {
    output({
      profiles: Object.entries(config.env_profiles).map(([name, profile]) => ({
        name,
        type: profile.type || 'unknown',
      })),
      environments: Object.entries(config.environments || {}).map(([name, environment]) => ({
        name,
        kind: environment.kind || 'unknown',
        status: environment.status || null,
      })),
    });
    return;
  }
  if (subcommand === 'show') {
    output(environmentShow({
      root: parsed.root || null,
      name: parsed.env || parsed.environment || parsed._[0] || null,
    }));
    return;
  }
  if (subcommand === 'environments') {
    output(environmentList({
      root: parsed.root || null,
    }));
    return;
  }
  if (subcommand === 'bootstrap') {
    const plan = envBootstrapPlan({
      root: parsed.root || null,
      set: parsed.set || null,
      feat: parsed.feat || null,
      profile: parsed.profile || null,
    });
    if (parsed.text === true) {
      process.stdout.write(renderEnvBootstrapText(plan) + '\n');
    } else {
      output(plan);
    }
    return;
  }
  if (subcommand === 'refresh') {
    output(refreshEnvProfile(config, parsed.profile || null, {
      yes: parsed.yes === true,
      timeoutMs: parsed['timeout-ms'] ? Number(parsed['timeout-ms']) : null,
      run: parsed.run || null,
      set: parsed.set || null,
      feat: parsed.feat || null,
      allowCrossTrack: parsed['allow-cross-track'] === true,
    }));
    return;
  }
  error(`Unknown env subcommand: '${subcommand}'. Use: bind, bootstrap, doctor, list, show, environments, runtime, refresh`);
}

module.exports = {
  doctorProfile,
  effectiveEnvProfile,
  envBootstrapPlan,
  handleEnvProfile,
  remoteChecksForProfile,
  buildVllmRefreshCommand,
  renderEnvBootstrapText,
  refreshEnvProfile,
};
