'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const { output, error, parseArgs } = require('./core.cjs');
const { ensureWorkspaceDirs, loadWorkspaceConfig, normalizeStringList } = require('./workspace-config.cjs');
const {
  effectiveEnvProfile,
  envRemoteStatus,
  remoteStatusHasBlockingDrift,
} = require('./env-profile.cjs');
const { selectedWorktreeIds } = require('./workspace-inventory.cjs');
const { inferTrackProfile, resolveTrackSelection } = require('./track-resolver.cjs');

const DEFAULT_EXCLUDES = ['.git/', '__pycache__/', '.venv/', 'node_modules/', 'build/', 'dist/'];
const DEFAULT_ASSETS = ['.devteam', 'artifacts', 'scripts', 'deploy', 'docs', 'guides', 'hooks'];
const PATCH_MODES = new Set(['branch-patch', 'dirty-only']);

function splitSsh(sshCommand, hostFallback) {
  if (!sshCommand) return { remote_shell: 'ssh', host: hostFallback || null };
  const parts = String(sshCommand).trim().split(/\s+/);
  const host = hostFallback || parts[parts.length - 1] || null;
  const remoteShell = host ? parts.slice(0, -1).join(' ') || 'ssh' : sshCommand;
  return { remote_shell: remoteShell, host };
}

function shellQuote(value) {
  const text = String(value);
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function remoteShellCommand(profile, command) {
  if (!profile.ssh) return null;
  return `${profile.ssh} ${shellQuote(command)}`;
}

function countChangedFiles(worktree) {
  if (!fs.existsSync(worktree.abs_path)) return null;
  try {
    const { execFileSync } = require('child_process');
    const status = execFileSync('git', ['-C', worktree.abs_path, 'status', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return status ? status.split('\n').filter(Boolean).length : 0;
  } catch (_) {
    return null;
  }
}

function localGitValue(worktreePath, args) {
  if (!worktreePath || !fs.existsSync(worktreePath)) return null;
  const result = spawnSync('git', ['-C', worktreePath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 ? String(result.stdout || '').trim() : null;
}

function localGitDirty(worktreePath) {
  const status = localGitValue(worktreePath, ['status', '--porcelain=v1']);
  return status == null ? null : status.length > 0;
}

function localGitRaw(worktreePath, args) {
  if (!worktreePath || !fs.existsSync(worktreePath)) return null;
  const result = spawnSync('git', ['-C', worktreePath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 ? String(result.stdout || '').replace(/\r?\n$/, '') : null;
}

function localDirtySignature(worktreePath) {
  const status = localGitRaw(worktreePath, ['status', '--porcelain=v1', '-z']);
  if (!status) return null;
  const diff = localGitRaw(worktreePath, ['diff', '--binary', 'HEAD', '--']) || '';
  const untrackedRaw = localGitRaw(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z']) || '';
  const untracked = [];
  for (const relPath of untrackedRaw.split('\0').filter(Boolean).sort()) {
    const absPath = path.join(worktreePath, relPath);
    try {
      const stat = fs.lstatSync(absPath);
      if (stat.isFile()) {
        untracked.push(`${relPath}\0file\0${crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex')}`);
      } else if (stat.isSymbolicLink()) {
        untracked.push(`${relPath}\0symlink\0${crypto.createHash('sha256').update(fs.readlinkSync(absPath)).digest('hex')}`);
      } else {
        untracked.push(`${relPath}\0other\0${stat.mode}`);
      }
    } catch (_) {
      untracked.push(`${relPath}\0missing\0`);
    }
  }
  return crypto
    .createHash('sha256')
    .update(status)
    .update('\0')
    .update(diff)
    .update('\0')
    .update(untracked.join('\0'))
    .digest('hex');
}

function gitList(worktreePath, args) {
  try {
    return spawnSync('git', ['-C', worktreePath, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).stdout.trim();
  } catch (_) {
    return '';
  }
}

function gitPathspecArgs(paths) {
  const list = normalizeStringList(paths);
  return list.length > 0 ? ['--', ...list] : [];
}

function normalizePatchMode(value, fallback = 'branch-patch') {
  const mode = value ? String(value).trim() : fallback;
  if (PATCH_MODES.has(mode)) return mode;
  error(`Unknown patch mode '${mode}'. Use: branch-patch, dirty-only`);
}

function patchModeFromStrategy(strategy) {
  if (strategy === 'rsync-relative-dirty-only') return 'dirty-only';
  if (strategy === 'rsync-relative-branch-patch') return 'branch-patch';
  return null;
}

function relativePatchStrategy(strategy) {
  return [
    'rsync-relative-patch-files',
    'rsync-relative-branch-patch',
    'rsync-relative-dirty-only',
  ].includes(strategy);
}

function collectPatchFiles(worktree, options = {}) {
  if (!fs.existsSync(worktree.abs_path)) return [];
  const mode = normalizePatchMode(options.patchMode || null);
  const includePaths = normalizeStringList(worktree.sync.include_paths);
  const pathspec = gitPathspecArgs(includePaths);
  const files = new Set();

  const addLines = (text) => {
    for (const line of String(text || '').split('\n')) {
      const value = line.trim();
      if (value) files.add(value);
    }
  };

  if (mode === 'branch-patch' && worktree.base_ref) {
    addLines(gitList(worktree.abs_path, [
      'diff',
      `${worktree.base_ref}..HEAD`,
      '--name-only',
      '--diff-filter=AM',
      ...pathspec,
    ]));
  }
  addLines(gitList(worktree.abs_path, [
    'diff',
    '--name-only',
    '--diff-filter=AM',
    ...pathspec,
  ]));
  addLines(gitList(worktree.abs_path, [
    'diff',
    '--cached',
    '--name-only',
    '--diff-filter=AM',
    ...pathspec,
  ]));
  addLines(gitList(worktree.abs_path, [
    'ls-files',
    '--others',
    '--exclude-standard',
    ...pathspec,
  ]));

  return Array.from(files).sort();
}

function rsyncCommand(worktree, profile, remotePath) {
  const excludes = Array.from(new Set([
    ...DEFAULT_EXCLUDES,
    ...normalizeStringList(profile.exclude),
  ]));
  const { remote_shell: remoteShell, host } = splitSsh(profile.ssh, profile.host);
  const excludeArgs = excludes.map(item => `--exclude '${item}'`).join(' ');
  const local = path.join(worktree.abs_path, path.sep);
  const remote = `${host}:${remotePath.replace(/\/+$/, '')}/`;
  return `rsync -az --delete --no-owner --no-group -e "${remoteShell}" ${excludeArgs} "${local}" "${remote}"`;
}

function rsyncRelativePatchCommand(worktree, profile, remotePath, files) {
  const { remote_shell: remoteShell, host } = splitSsh(profile.ssh, profile.host);
  const remote = `${host}:${remotePath.replace(/\/+$/, '')}/`;
  if (!files.length) return null;
  return [
    `cd ${shellQuote(worktree.abs_path)}`,
    '&&',
    'rsync -av --relative --no-owner --no-group',
    `-e ${shellQuote(remoteShell)}`,
    ...files.map(shellQuote),
    shellQuote(remote),
  ].join(' ');
}

function syncBindingCommand(binding, profile, remotePath) {
  const payload = JSON.stringify(binding);
  const command = [
    `mkdir -p ${shellQuote(remotePath)}`,
    `printf %s ${shellQuote(payload)} > ${shellQuote(`${remotePath.replace(/\/+$/, '')}/.devteam-sync-binding.json`)}`,
  ].join(' && ');
  return remoteShellCommand(profile, command);
}

function assetSyncCommand(asset, profile) {
  const excludes = Array.from(new Set([
    ...DEFAULT_EXCLUDES,
    ...normalizeStringList(profile.exclude),
  ]));
  const { remote_shell: remoteShell, host } = splitSsh(profile.ssh, profile.host);
  const excludeArgs = excludes.map(item => `--exclude '${item}'`).join(' ');
  const source = asset.type === 'directory'
    ? path.join(asset.local_path, path.sep)
    : asset.local_path;
  const remote = asset.type === 'directory'
    ? `${host}:${asset.remote_path.replace(/\/+$/, '')}/`
    : `${host}:${asset.remote_path}`;
  return `rsync -az --delete --no-owner --no-group -e "${remoteShell}" ${excludeArgs} "${source}" "${remote}"`;
}

function collectAssetEntries(config, profile) {
  if (!profile.work_dir) return [];
  const rootEntries = fs.readdirSync(config.root);
  const names = rootEntries
    .filter(name => DEFAULT_ASSETS.includes(name) || /^Dockerfile(\.|$)/.test(name))
    .sort();

  return names.map(name => {
    const localPath = path.join(config.root, name);
    const stat = fs.statSync(localPath);
    const type = stat.isDirectory() ? 'directory' : 'file';
    const remotePath = `${String(profile.work_dir).replace(/\/+$/, '')}/${name}`;
    const asset = {
      id: `asset__${name}`,
      repo: null,
      kind: 'asset',
      local_path: localPath,
      remote_path: remotePath,
      exists: true,
      changed_files: null,
      strategy: 'rsync',
      action: 'sync',
      reason: null,
      type,
    };
    return {
      ...asset,
      command: assetSyncCommand(asset, profile),
    };
  });
}

function buildSyncPlan(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const selection = resolveTrackSelection(config, {
    set: options.set || null,
    feat: options.feat || null,
  });
  const trackProfile = selection.track
    ? inferTrackProfile(config, selection.track, { activeTrack: selection.track, feat: selection.feat || null })
    : null;
  const profileName = options.profile ||
    (trackProfile ? trackProfile.sync : null) ||
    config.defaults.sync ||
    config.defaults.env;
  if (!profileName) error('No sync profile specified. Pass --profile <name> or set defaults.sync.');
  if (!config.env_profiles[profileName]) {
    error(`Unknown sync profile '${profileName}'. Available: ${Object.keys(config.env_profiles).join(', ') || '(none)'}`);
  }
  const profile = effectiveEnvProfile(config, profileName);

  const ids = selectedWorktreeIds(config, options.set || null, options.feat || null);
  const entries = [];
  for (const id of ids) {
    const worktree = config.worktrees[id];
    if (!worktree) {
      entries.push({ id, action: 'error', reason: 'undefined worktree' });
      continue;
    }
    if (worktree.sync.profile && worktree.sync.profile !== profileName) continue;

    const remotePath = worktree.sync.remote_path ||
      (profile.work_dir ? `${String(profile.work_dir).replace(/\/+$/, '')}/${worktree.path}` : null);
    const exists = fs.existsSync(worktree.abs_path);
    const strategy = worktree.sync.strategy || profile.strategy || 'rsync';
    const isRelativePatch = relativePatchStrategy(strategy);
    const patchMode = isRelativePatch
      ? normalizePatchMode(
        options.patchMode ||
          patchModeFromStrategy(strategy) ||
          worktree.sync.patch_mode ||
          profile.patch_mode ||
          null
      )
      : null;
    const patchFiles = isRelativePatch
      ? collectPatchFiles(worktree, { patchMode })
      : [];
    const command = exists && remotePath
      ? (isRelativePatch
        ? rsyncRelativePatchCommand(worktree, profile, remotePath, patchFiles)
        : rsyncCommand(worktree, profile, remotePath))
      : null;
    entries.push({
      id: worktree.id,
      repo: worktree.repo,
      local_path: worktree.abs_path,
      remote_path: remotePath,
      exists,
      changed_files: countChangedFiles(worktree),
      patch_files: patchFiles,
      patch_file_count: patchFiles.length,
      strategy,
      patch_mode: patchMode,
      action: exists && remotePath && command ? 'sync' : (exists && remotePath ? 'noop' : 'missing'),
      reason: exists
        ? (remotePath
          ? (isRelativePatch && !command ? `no ${patchMode} files to sync` : null)
          : 'remote_path missing')
        : 'local worktree missing',
      command,
      binding_command: exists && remotePath && command ? syncBindingCommand({
        track: selection.track || null,
        feat: selection.feat || null,
        profile: profileName,
        worktree_id: worktree.id,
        repo: worktree.repo,
        local_path: worktree.abs_path,
        remote_path: remotePath,
        branch: worktree.branch || null,
        source_head: localGitValue(worktree.abs_path, ['rev-parse', 'HEAD']),
        source_dirty: localGitDirty(worktree.abs_path),
        source_dirty_signature: localDirtySignature(worktree.abs_path),
      }, profile, remotePath) : null,
    });
  }
  if (options.includeAssets === true) {
    entries.push(...collectAssetEntries(config, profile));
  }

  return {
    workspace: config.root,
    profile: profileName,
    track: selection.track || null,
    feat: selection.feat || null,
    workspace_set: selection.track || null,
    workspace_set_source: selection.track_source,
    selection,
    entries,
    totals: {
      entries: entries.length,
      syncable: entries.filter(entry => entry.action === 'sync').length,
      noop: entries.filter(entry => entry.action === 'noop').length,
      missing: entries.filter(entry => entry.action === 'missing').length,
    },
  };
}

function syncStatePath(config, profileName) {
  return path.join(config.root, '.devteam', 'state', `sync-${profileName}.json`);
}

function getSyncStatus(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const profileName = options.profile || config.defaults.sync || config.defaults.env;
  if (!profileName) error('No sync profile specified. Pass --profile <name> or set defaults.sync.');
  const statePath = syncStatePath(config, profileName);
  if (!fs.existsSync(statePath)) {
    return {
      profile: profileName,
      state_path: statePath,
      exists: false,
      last_sync: null,
    };
  }
  return {
    profile: profileName,
    state_path: statePath,
    exists: true,
    last_sync: JSON.parse(fs.readFileSync(statePath, 'utf8')),
  };
}

function executeCommand(command) {
  const started = Date.now();
  const result = spawnSync(command, {
    shell: true,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status === 0 ? 'passed' : 'failed',
    exit_code: typeof result.status === 'number' ? result.status : 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    duration_ms: Date.now() - started,
  };
}

function applySyncPlan(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const plan = buildSyncPlan({
    root: config.root,
    profile: options.profile || null,
    set: options.set || null,
    feat: options.feat || null,
    includeAssets: options.includeAssets === true,
    patchMode: options.patchMode || null,
  });
  const execute = options.yes === true;
  const results = [];
  let remote_guard = null;

  if (execute && options.allowRemoteDrift !== true) {
    remote_guard = envRemoteStatus({
      config,
      profile: plan.profile,
      syncProfile: plan.profile,
      set: plan.workspace_set || null,
      feat: plan.feat || null,
      dirtyLimit: 10,
      includeVenv: false,
    });
    const blocking = remoteStatusHasBlockingDrift(remote_guard, {
      allowedProblems: options.allowedRemoteProblems || ['head_mismatch', 'branch_mismatch'],
    });
    if (blocking.length) {
      return {
        profile: plan.profile,
        workspace: config.root,
        workspace_set: plan.workspace_set,
        feat: plan.feat || null,
        dry_run: false,
        applied_at: new Date().toISOString(),
        status: 'blocked',
        reason: 'remote_source_drift',
        remote_guard: {
          status: remote_guard.status,
          totals: remote_guard.totals,
          blocking,
        },
        totals: {
          entries: plan.entries.length,
          synced: 0,
          skipped: plan.entries.length,
          planned: 0,
          failed: 0,
        },
        results: plan.entries.map(entry => ({
          id: entry.id,
          repo: entry.repo,
          action: entry.action,
          status: 'skipped',
          reason: 'remote source drift guard blocked sync apply',
          command: entry.command,
        })),
        next_action: 'Review env remote-status, then rebuild/clean the remote source mirror or rerun with --allow-remote-drift only when you intentionally want to overwrite it.',
      };
    }
  }

  for (const entry of plan.entries) {
    if (entry.action !== 'sync') {
      results.push({
        id: entry.id,
        repo: entry.repo,
        action: entry.action,
        status: 'skipped',
        reason: entry.reason || 'not syncable',
        command: entry.command,
      });
      continue;
    }

    if (!execute) {
      results.push({
        id: entry.id,
        repo: entry.repo,
        action: 'dry_run',
        status: 'planned',
        command: entry.command,
      });
      continue;
    }

    const commandResult = executeCommand(entry.command);
    const bindingResult = commandResult.status === 'passed' && entry.binding_command
      ? executeCommand(entry.binding_command)
      : null;
    const finalStatus = bindingResult && bindingResult.status !== 'passed'
      ? 'failed'
      : commandResult.status;
    results.push({
      id: entry.id,
      repo: entry.repo,
      action: 'sync',
      command: entry.command,
      ...commandResult,
      status: finalStatus,
      binding_command: entry.binding_command || null,
      binding_result: bindingResult,
    });
    if (finalStatus !== 'passed' && options.continueOnError !== true) {
      break;
    }
  }

  const failed = results.filter(item => item.status === 'failed').length;
  const synced = results.filter(item => item.status === 'passed' && item.action === 'sync').length;
  const skipped = results.filter(item => item.status === 'skipped').length;
  const planned = results.filter(item => item.status === 'planned').length;
  const appliedAt = new Date().toISOString();
  const profileName = plan.profile;

  const payload = {
    profile: profileName,
    workspace: config.root,
    workspace_set: plan.workspace_set,
    dry_run: !execute,
    applied_at: appliedAt,
    status: failed === 0 ? (execute ? 'applied' : 'planned') : 'failed',
    remote_guard: remote_guard ? {
      status: remote_guard.status,
      totals: remote_guard.totals,
    } : null,
    totals: {
      entries: results.length,
      synced,
      skipped,
      planned,
      failed,
    },
    results,
  };

  if (execute) {
    ensureWorkspaceDirs(config.root);
    fs.writeFileSync(syncStatePath(config, profileName), JSON.stringify(payload, null, 2) + '\n', 'utf8');
    if (options.run) {
      const { recordSessionEvent } = require('./session-manager.cjs');
      payload.record = recordSessionEvent({
        root: config.root,
        run: options.run,
        set: options.set || plan.workspace_set || null,
        feat: options.feat || plan.feat || null,
        allowCrossTrack: options.allowCrossTrack === true,
        allowStaleHead: options.allowStaleHead === true,
        kind: 'sync',
        status: payload.status === 'applied' ? 'passed' : 'failed',
        summary: `sync apply ${payload.status}: ${synced} synced, ${failed} failed, ${skipped} skipped`,
        command: [
          'devteam sync apply',
          `--profile ${profileName}`,
          plan.workspace_set ? `--set ${plan.workspace_set}` : null,
          plan.feat ? `--feat ${plan.feat}` : null,
          options.patchMode ? `--patch-mode ${options.patchMode}` : null,
          '--yes',
        ].filter(Boolean).join(' '),
        artifact: syncStatePath(config, profileName),
      });
    }
  }

  return payload;
}

function handleSyncPlan(subcommand, args) {
  const parsed = parseArgs(args || []);
  if (!subcommand || subcommand === 'plan') {
    output(buildSyncPlan({
      root: parsed.root || null,
      profile: parsed.profile || null,
      set: parsed.set || null,
      feat: parsed.feat || null,
      includeAssets: parsed['include-assets'] === true || parsed.assets === true,
      patchMode: parsed['dirty-only'] === true
        ? 'dirty-only'
        : (parsed['branch-patch'] === true ? 'branch-patch' : (parsed['patch-mode'] || null)),
    }));
    return;
  }
  if (subcommand === 'apply') {
    output(applySyncPlan({
      root: parsed.root || null,
      profile: parsed.profile || null,
      set: parsed.set || null,
      feat: parsed.feat || null,
      yes: parsed.yes === true,
      includeAssets: parsed['include-assets'] === true || parsed.assets === true,
      patchMode: parsed['dirty-only'] === true
        ? 'dirty-only'
        : (parsed['branch-patch'] === true ? 'branch-patch' : (parsed['patch-mode'] || null)),
      continueOnError: parsed['continue-on-error'] === true,
      run: parsed.run || null,
      allowCrossTrack: parsed['allow-cross-track'] === true,
      allowStaleHead: parsed['allow-stale-head'] === true,
      allowRemoteDrift: parsed['allow-remote-drift'] === true,
    }));
    return;
  }
  if (subcommand === 'status') {
    output(getSyncStatus({
      root: parsed.root || null,
      profile: parsed.profile || null,
    }));
    return;
  }
  error(`Unknown sync subcommand: '${subcommand}'. Use: plan, apply, status`);
}

module.exports = {
  applySyncPlan,
  buildSyncPlan,
  collectPatchFiles,
  getSyncStatus,
  handleSyncPlan,
  normalizePatchMode,
};
