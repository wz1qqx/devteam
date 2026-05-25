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
const { buildRuntimeContext } = require('./runtime-context.cjs');

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

function gitLocal(worktreePath, args, options = {}) {
  const result = spawnSync('git', ['-C', worktreePath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeoutMs || 30000,
  });
  if (result.status !== 0) return null;
  return options.raw === true
    ? String(result.stdout || '').replace(/\r?\n$/, '')
    : String(result.stdout || '').trim();
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

function parseGitPorcelain(output, limit = 20) {
  const fileLimit = Number.isInteger(Number(limit)) && Number(limit) >= 0
    ? Number(limit)
    : 20;
  const lines = String(output || '').split(/\r?\n/).filter(line => line.length > 0);
  const summary = {
    total: lines.length,
    staged: 0,
    unstaged: 0,
    untracked: 0,
  };
  for (const line of lines) {
    if (line.startsWith('??')) {
      summary.untracked += 1;
      continue;
    }
    if (line[0] && line[0] !== ' ') summary.staged += 1;
    if (line[1] && line[1] !== ' ') summary.unstaged += 1;
  }
  return {
    summary,
    files: lines.slice(0, fileLimit),
    truncated: lines.length > fileLimit,
  };
}

function localGitSourceStatus(localPath, options = {}) {
  const limit = options.dirtyLimit == null ? 20 : Number(options.dirtyLimit);
  if (!localPath) {
    return {
      status: 'missing_path',
      exists: false,
      is_git: false,
      path: null,
      dirty: false,
    };
  }
  const source = {
    status: 'ok',
    path: localPath,
    exists: fs.existsSync(localPath),
    is_git: false,
    branch: null,
    head: null,
    short_head: null,
    describe: null,
    upstream: null,
    dirty: false,
    dirty_summary: { total: 0, staged: 0, unstaged: 0, untracked: 0 },
    dirty_files: [],
    dirty_truncated: false,
  };
  if (!source.exists) {
    source.status = 'missing';
    return source;
  }
  if (gitLocal(localPath, ['rev-parse', '--git-dir']) == null) {
    source.status = 'not_git';
    return source;
  }
  source.is_git = true;
  source.branch = gitLocal(localPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  source.head = gitLocal(localPath, ['rev-parse', 'HEAD']);
  source.short_head = gitLocal(localPath, ['rev-parse', '--short', 'HEAD']);
  source.describe = gitLocal(localPath, ['describe', '--tags', '--match', 'v*', '--always']);
  source.upstream = gitLocal(localPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  const porcelain = gitLocal(localPath, ['status', '--porcelain=v1'], { raw: true }) || '';
  const parsed = parseGitPorcelain(porcelain, limit);
  source.dirty_summary = parsed.summary;
  source.dirty_files = parsed.files;
  source.dirty_truncated = parsed.truncated;
  source.dirty = parsed.summary.total > 0;
  return source;
}

function remoteSourceStatusCommand(remotePath, dirtyLimit = 20) {
  const limit = Number.isInteger(Number(dirtyLimit)) && Number(dirtyLimit) >= 0
    ? Number(dirtyLimit)
    : 20;
  return [
    'set -u',
    `DIR=${shellQuote(remotePath)}`,
    'echo __DEVTEAM_REMOTE_STATUS_BEGIN__',
    'printf "path=%s\\n" "$DIR"',
    'if [ ! -d "$DIR" ]; then echo exists=0; echo __DEVTEAM_REMOTE_STATUS_END__; exit 0; fi',
    'echo exists=1',
    'cd "$DIR" || { echo cd_ok=0; echo __DEVTEAM_REMOTE_STATUS_END__; exit 0; }',
    'echo cd_ok=1',
    'if ! git rev-parse --git-dir >/dev/null 2>&1; then echo is_git=0; echo __DEVTEAM_REMOTE_STATUS_END__; exit 0; fi',
    'echo is_git=1',
    'printf "branch=%s\\n" "$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"',
    'printf "head=%s\\n" "$(git rev-parse HEAD 2>/dev/null || true)"',
    'printf "short_head=%s\\n" "$(git rev-parse --short HEAD 2>/dev/null || true)"',
    'printf "describe=%s\\n" "$(git describe --tags --match "v*" --always 2>/dev/null || true)"',
    'printf "upstream=%s\\n" "$(git rev-parse --abbrev-ref --symbolic-full-name "@{upstream}" 2>/dev/null || true)"',
    'printf "dirty_count=%s\\n" "$(git status --porcelain=v1 2>/dev/null | wc -l | tr -d " ")"',
    'echo __DEVTEAM_REMOTE_STATUS_PORCELAIN__',
    `if [ ${limit} -gt 0 ]; then git status --porcelain=v1 2>/dev/null | sed -n '1,${limit}p'; fi`,
    'echo __DEVTEAM_REMOTE_STATUS_END__',
  ].join(' && ');
}

function parseRemoteSourceStatus(stdout, dirtyLimit = 20) {
  const fields = {};
  const porcelain = [];
  let inPorcelain = false;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (line === '__DEVTEAM_REMOTE_STATUS_PORCELAIN__') {
      inPorcelain = true;
      continue;
    }
    if (line === '__DEVTEAM_REMOTE_STATUS_END__') {
      inPorcelain = false;
      continue;
    }
    if (!line || line === '__DEVTEAM_REMOTE_STATUS_BEGIN__') continue;
    if (inPorcelain) {
      porcelain.push(line);
      continue;
    }
    const index = line.indexOf('=');
    if (index >= 0) {
      fields[line.slice(0, index)] = line.slice(index + 1);
    }
  }
  const parsed = parseGitPorcelain(porcelain.join('\n'), dirtyLimit);
  const dirtyCount = fields.dirty_count == null || fields.dirty_count === ''
    ? parsed.summary.total
    : Number(fields.dirty_count);
  if (Number.isFinite(dirtyCount) && dirtyCount >= parsed.summary.total) {
    parsed.summary.total = dirtyCount;
    parsed.truncated = dirtyCount > porcelain.length;
  }
  const exists = fields.exists === '1';
  const isGit = fields.is_git === '1';
  return {
    status: !exists ? 'missing' : (!isGit ? 'not_git' : 'ok'),
    path: fields.path || null,
    exists,
    cd_ok: fields.cd_ok == null ? null : fields.cd_ok === '1',
    is_git: isGit,
    branch: fields.branch || null,
    head: fields.head || null,
    short_head: fields.short_head || null,
    describe: fields.describe || null,
    upstream: fields.upstream || null,
    dirty: parsed.summary.total > 0,
    dirty_summary: parsed.summary,
    dirty_files: parsed.files,
    dirty_truncated: parsed.truncated,
  };
}

function remoteGitSourceStatus(profile, remotePath, options = {}) {
  const limit = options.dirtyLimit == null ? 20 : Number(options.dirtyLimit);
  if (!remotePath) {
    return {
      status: 'missing_path',
      path: null,
      exists: false,
      is_git: false,
      dirty: false,
      dirty_summary: { total: 0, staged: 0, unstaged: 0, untracked: 0 },
      dirty_files: [],
      dirty_truncated: false,
      result: null,
      command: null,
    };
  }
  if (!profile.ssh) {
    return {
      status: 'unreachable',
      path: remotePath,
      exists: null,
      is_git: null,
      dirty: false,
      dirty_summary: { total: 0, staged: 0, unstaged: 0, untracked: 0 },
      dirty_files: [],
      dirty_truncated: false,
      result: {
        status: 'failed',
        exit_code: 1,
        stdout: '',
        stderr: 'ssh command is missing',
      },
      command: null,
    };
  }
  const command = remoteSourceStatusCommand(remotePath, limit);
  const result = remoteCommand(profile.ssh, command, {
    timeoutMs: options.timeoutMs || 30000,
  });
  if (result.status !== 'passed') {
    return {
      status: 'unreachable',
      path: remotePath,
      exists: null,
      is_git: null,
      dirty: false,
      dirty_summary: { total: 0, staged: 0, unstaged: 0, untracked: 0 },
      dirty_files: [],
      dirty_truncated: false,
      result,
      command,
    };
  }
  return {
    ...parseRemoteSourceStatus(result.stdout, limit),
    result,
    command,
  };
}

function sourceCompareProblems(local, remote) {
  const problems = [];
  if (!remote || remote.status === 'missing_path') problems.push('remote_path_missing');
  if (remote && remote.status === 'unreachable') problems.push('remote_unreachable');
  if (remote && remote.status === 'missing') problems.push('remote_missing');
  if (remote && remote.status === 'not_git') problems.push('remote_not_git');
  if (!local || local.status === 'missing_path') problems.push('local_path_missing');
  if (local && local.status === 'missing') problems.push('local_missing');
  if (local && local.status === 'not_git') problems.push('local_not_git');
  if (local && local.status === 'ok' && local.dirty) problems.push('local_dirty');
  if (remote && remote.status === 'ok' && remote.dirty) problems.push('remote_dirty');
  if (local && remote && local.status === 'ok' && remote.status === 'ok') {
    if (local.head && remote.head && local.head !== remote.head) problems.push('head_mismatch');
    if (local.branch && remote.branch && local.branch !== remote.branch) problems.push('branch_mismatch');
  }
  return problems;
}

function sourceCompareStatus(problems) {
  if (!problems.length) return 'match';
  if (problems.some(problem => [
    'remote_path_missing',
    'remote_unreachable',
    'remote_missing',
    'remote_not_git',
    'local_path_missing',
    'local_missing',
    'local_not_git',
  ].includes(problem))) {
    return 'blocked';
  }
  return 'drift';
}

function remoteStatusEntry(profile, worktree, options = {}) {
  const local = localGitSourceStatus(worktree.local_path || null, options);
  const remotePath = worktree.remote_path || (options.fallbackSourceDir || null);
  const remote = remoteGitSourceStatus(profile, remotePath, options);
  const problems = sourceCompareProblems(local, remote);
  const status = sourceCompareStatus(problems);
  return {
    id: worktree.id || 'source',
    repo: worktree.repo || null,
    status,
    problems,
    local,
    remote,
    next_action: status === 'match'
      ? 'Remote source matches the selected local worktree.'
      : (problems.includes('remote_dirty')
        ? 'Review the dirty remote source before syncing or refreshing the environment.'
        : (problems.includes('head_mismatch') || problems.includes('branch_mismatch')
          ? 'Sync the selected local worktree to this remote source only when you intend to update the environment.'
          : 'Fix the missing path or git configuration before relying on this environment source.')),
  };
}

function envRemoteStatus(options = {}) {
  const config = options.config || loadWorkspaceConfig(options.root || null);
  const runtime = buildRuntimeContext({
    config,
    set: options.set || null,
    feat: options.feat || null,
    profile: options.profile || null,
    syncProfile: options.syncProfile || null,
    environment: options.environment || null,
    required: options.set != null || options.feat != null,
    default: options.default,
    featDefault: options.featDefault,
  });
  const profile = runtime.profile_effective || {};
  if (runtime.type !== 'remote_dev') {
    return {
      action: 'env_remote_status',
      workspace: config.root,
      track: runtime.track || null,
      feat: runtime.feat || null,
      profile: runtime.profile || null,
      environment: runtime.environment || null,
      type: runtime.type || 'none',
      status: 'unsupported',
      totals: { sources: 0, match: 0, drift: 0, blocked: 0 },
      sources: [],
      next_action: 'env remote-status requires a remote_dev profile.',
    };
  }
  const runtimeWorktrees = Array.isArray(runtime.worktrees) ? runtime.worktrees : [];
  const worktrees = runtimeWorktrees.length ? runtimeWorktrees : [{
    id: 'source',
    repo: null,
    local_path: null,
    remote_path: profile.source_dir || null,
  }];
  const entries = worktrees.map((worktree, index) => remoteStatusEntry(profile, worktree, {
    dirtyLimit: options.dirtyLimit == null ? 20 : Number(options.dirtyLimit),
    timeoutMs: options.timeoutMs || null,
    fallbackSourceDir: worktrees.length === 1 || index === 0 ? profile.source_dir || null : null,
  }));
  const totals = entries.reduce((acc, entry) => {
    acc.sources += 1;
    acc[entry.status] = (acc[entry.status] || 0) + 1;
    if (entry.problems.includes('remote_dirty')) acc.remote_dirty += 1;
    if (entry.problems.includes('local_dirty')) acc.local_dirty += 1;
    if (entry.problems.includes('head_mismatch')) acc.head_mismatch += 1;
    if (entry.problems.includes('branch_mismatch')) acc.branch_mismatch += 1;
    return acc;
  }, {
    sources: 0,
    match: 0,
    drift: 0,
    blocked: 0,
    remote_dirty: 0,
    local_dirty: 0,
    head_mismatch: 0,
    branch_mismatch: 0,
  });
  const status = totals.blocked > 0
    ? 'blocked'
    : (totals.drift > 0 ? 'drift' : 'match');
  return {
    action: 'env_remote_status',
    workspace: config.root,
    track: runtime.track || null,
    feat: runtime.feat || null,
    profile: runtime.profile || null,
    environment: runtime.environment || null,
    type: runtime.type || null,
    status,
    totals,
    sources: entries,
    next_action: status === 'match'
      ? 'Remote source mirrors match the selected local worktree state.'
      : (totals.remote_dirty > 0
        ? 'Review the dirty remote source before syncing local code into the environment.'
        : 'Review drift details, then run the explicit sync/refresh flow only when you intend to update the environment.'),
  };
}

function renderEnvRemoteStatusText(status) {
  const lines = [
    'Env Remote Status',
    '',
    `Workspace: ${status.workspace}`,
    `Track: ${status.track || '-'}`,
    status.feat ? `Feature: ${status.feat}` : null,
    `Profile: ${status.profile || '-'}`,
    `Environment: ${status.environment || '-'}`,
    `Type: ${status.type || '-'}`,
    `Status: ${status.status}`,
    '',
    'Sources:',
  ].filter(Boolean);
  if (!status.sources || !status.sources.length) {
    lines.push('  (none)');
  } else {
    for (const source of status.sources) {
      const local = source.local || {};
      const remote = source.remote || {};
      lines.push(`  ${source.id}  ${source.status}${source.problems.length ? ` problems=${source.problems.join(',')}` : ''}`);
      lines.push(`    local:  ${local.path || '-'}  ${local.branch || '-'}  ${local.short_head || '-'}  ${local.dirty ? 'dirty' : 'clean'}`);
      lines.push(`    remote: ${remote.path || '-'}  ${remote.branch || '-'}  ${remote.short_head || '-'}  ${remote.dirty ? 'dirty' : 'clean'}`);
      if (remote.result && remote.result.status !== 'passed') {
        lines.push(`    remote_error: ${String(remote.result.stderr || remote.result.stdout || 'unknown').trim()}`);
      }
      lines.push(`    next: ${source.next_action}`);
    }
  }
  lines.push('', `Next: ${status.next_action}`);
  return lines.join('\n');
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
  if (subcommand === 'remote-status') {
    const status = envRemoteStatus({
      config,
      set: parsed.set || null,
      feat: parsed.feat || null,
      profile: parsed.profile || null,
      syncProfile: parsed.sync || null,
      environment: parsed.env || parsed.environment || null,
      dirtyLimit: parsed['dirty-limit'] == null ? null : Number(parsed['dirty-limit']),
      timeoutMs: parsed['timeout-ms'] ? Number(parsed['timeout-ms']) : null,
    });
    if (parsed.text === true) {
      process.stdout.write(renderEnvRemoteStatusText(status) + '\n');
    } else {
      output(status);
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
  error(`Unknown env subcommand: '${subcommand}'. Use: bind, bootstrap, doctor, list, show, environments, runtime, remote-status, refresh`);
}

module.exports = {
  doctorProfile,
  effectiveEnvProfile,
  envRemoteStatus,
  envBootstrapPlan,
  handleEnvProfile,
  remoteChecksForProfile,
  buildVllmRefreshCommand,
  renderEnvRemoteStatusText,
  renderEnvBootstrapText,
  refreshEnvProfile,
};
