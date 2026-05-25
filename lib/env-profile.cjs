'use strict';

const { spawnSync } = require('child_process');

const { output, error, parseArgs } = require('./core.cjs');
const { loadWorkspaceConfig, normalizeStringList } = require('./workspace-config.cjs');
const {
  environmentList,
  environmentShow,
} = require('./capability-registry.cjs');

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
  error(`Unknown env subcommand: '${subcommand}'. Use: bind, doctor, list, show, environments, runtime, refresh`);
}

module.exports = {
  doctorProfile,
  effectiveEnvProfile,
  handleEnvProfile,
  remoteChecksForProfile,
  buildVllmRefreshCommand,
  refreshEnvProfile,
};
