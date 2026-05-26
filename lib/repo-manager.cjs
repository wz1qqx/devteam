'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const { output, error, parseArgs } = require('./core.cjs');
const { loadWorkspaceConfig } = require('./workspace-config.cjs');
const { resolveTrackSelection, worktreeIdsForSelection } = require('./track-resolver.cjs');

function shortPath(value) {
  const text = String(value || '');
  if (!text) return '';
  const home = os.homedir();
  return text.startsWith(home) ? `~${text.slice(home.length)}` : text;
}

function git(worktreePath, args) {
  try {
    return execFileSync('git', ['-C', worktreePath, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (_) {
    return null;
  }
}

function gitOk(worktreePath, args) {
  try {
    execFileSync('git', ['-C', worktreePath, ...args], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch (_) {
    return false;
  }
}

function gitRemote(worktreePath, name) {
  return git(worktreePath, ['remote', 'get-url', name]);
}

function gitCount(worktreePath, range) {
  const value = git(worktreePath, ['rev-list', '--count', range]);
  return value == null || value === '' ? null : Number(value);
}

function resolveWorktreeIds(config, options = {}) {
  const selection = resolveTrackSelection(config, {
    set: options.set || null,
    feat: options.feat || null,
  });
  const ids = selection.track
    ? worktreeIdsForSelection(config, selection)
    : Object.keys(config.worktrees || {});
  return { selection, ids };
}

function configuredRepoEntries(config, selectedIds = null, options = {}) {
  const includeConfiguredWithoutWorktrees = options.includeConfiguredWithoutWorktrees === true;
  const ids = selectedIds || Object.keys(config.worktrees || {});
  const byRepo = {};
  for (const id of ids) {
    const worktree = config.worktrees[id];
    if (!worktree) continue;
    if (!byRepo[worktree.repo]) byRepo[worktree.repo] = [];
    byRepo[worktree.repo].push(worktree);
  }
  if (includeConfiguredWithoutWorktrees) {
    const repos = Object.keys(config.repos || {});
    for (const repo of repos) {
      if (!byRepo[repo]) byRepo[repo] = [];
    }
  }
  return Object.entries(byRepo)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, worktrees]) => ({
      name,
      config: config.repos && config.repos[name] ? config.repos[name] : {},
      worktrees,
    }));
}

function guessRepoPaths(config, repoName) {
  const candidates = [
    path.join(config.root, 'repos', repoName),
    path.join(config.root, repoName),
  ];
  const seen = new Set();
  return candidates.filter(candidate => {
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    return true;
  });
}

function inspectGitPath(repoName, repoConfig, worktree) {
  const localPath = worktree.abs_path;
  const exists = fs.existsSync(localPath);
  const isGit = exists && gitOk(localPath, ['rev-parse', '--is-inside-work-tree']);
  const remoteName = worktree.publish && worktree.publish.remote
    ? worktree.publish.remote
    : 'origin';
  const baseRef = worktree.base_ref || null;
  const upstreamRef = baseRef || (git(localPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']) || null);
  const status = exists ? git(localPath, ['status', '--porcelain']) : null;
  const remoteUrl = isGit ? gitRemote(localPath, remoteName) : null;
  const originUrl = isGit ? gitRemote(localPath, 'origin') : null;
  const upstreamUrl = isGit ? gitRemote(localPath, 'upstream') : null;
  const head = isGit ? git(localPath, ['rev-parse', '--short', 'HEAD']) : null;
  const branch = isGit ? git(localPath, ['rev-parse', '--abbrev-ref', 'HEAD']) : null;
  const upstreamExists = Boolean(isGit && upstreamRef && gitOk(localPath, ['rev-parse', '--verify', upstreamRef]));
  const ahead = upstreamExists ? gitCount(localPath, `${upstreamRef}..HEAD`) : null;
  const behind = upstreamExists ? gitCount(localPath, `HEAD..${upstreamRef}`) : null;

  return {
    id: worktree.id,
    repo: repoName,
    kind: 'worktree',
    path: worktree.path,
    local_path: localPath,
    exists,
    is_git: isGit,
    desired_branch: worktree.branch || null,
    branch,
    head,
    dirty: Boolean(status && status.trim()),
    dirty_file_count: status && status.trim() ? status.trim().split('\n').length : 0,
    base_ref: baseRef,
    upstream_ref: upstreamRef,
    upstream_ref_exists: upstreamExists,
    commits_ahead_upstream: ahead,
    commits_behind_upstream: behind,
    remote: remoteName,
    remote_url: remoteUrl,
    origin_url: originUrl,
    upstream_url: upstreamUrl,
    configured_remote: repoConfig.remote || null,
    configured_upstream: repoConfig.upstream || null,
  };
}

function inspectRepoEntry(config, entry) {
  const fallbackPaths = entry.worktrees.length
    ? []
    : guessRepoPaths(config, entry.name).map(candidate => ({
      id: entry.name,
      repo: entry.name,
      path: path.relative(config.root, candidate),
      abs_path: candidate,
      branch: null,
      base_ref: null,
      publish: {},
    }));
  const worktrees = (entry.worktrees.length ? entry.worktrees : fallbackPaths)
    .map(worktree => inspectGitPath(entry.name, entry.config, worktree));
  return {
    name: entry.name,
    remote: entry.config.remote || null,
    upstream: entry.config.upstream || null,
    worktrees,
    totals: {
      worktrees: worktrees.length,
      present: worktrees.filter(item => item.exists).length,
      missing: worktrees.filter(item => !item.exists).length,
      git: worktrees.filter(item => item.is_git).length,
      dirty: worktrees.filter(item => item.dirty).length,
      behind_upstream: worktrees.filter(item => (item.commits_behind_upstream || 0) > 0).length,
      upstream_unknown: worktrees.filter(item => item.exists && item.commits_behind_upstream == null).length,
    },
  };
}

function repoStatus(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const { selection, ids } = resolveWorktreeIds(config, options);
  const repos = configuredRepoEntries(config, ids, {
    includeConfiguredWithoutWorktrees: !selection.track,
  }).map(entry => inspectRepoEntry(config, entry));
  const worktrees = repos.flatMap(repo => repo.worktrees);
  return {
    action: 'repo_status',
    workspace: config.root,
    track: selection.track || null,
    feat: selection.feat || null,
    workspace_set: selection.track || null,
    workspace_set_source: selection.track_source,
    selection,
    totals: {
      repos: repos.length,
      worktrees: worktrees.length,
      present: worktrees.filter(item => item.exists).length,
      missing: worktrees.filter(item => !item.exists).length,
      git: worktrees.filter(item => item.is_git).length,
      dirty: worktrees.filter(item => item.dirty).length,
      behind_upstream: worktrees.filter(item => (item.commits_behind_upstream || 0) > 0).length,
      upstream_unknown: worktrees.filter(item => item.exists && item.commits_behind_upstream == null).length,
    },
    repos,
  };
}

function repoList(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const { selection, ids } = resolveWorktreeIds(config, options);
  const repos = configuredRepoEntries(config, ids, {
    includeConfiguredWithoutWorktrees: !selection.track,
  }).map(entry => ({
    name: entry.name,
    remote: entry.config.remote || null,
    upstream: entry.config.upstream || null,
    worktrees: entry.worktrees.map(worktree => ({
      id: worktree.id,
      path: worktree.path,
      branch: worktree.branch || null,
      base_ref: worktree.base_ref || null,
    })),
  }));
  return {
    action: 'repo_list',
    workspace: config.root,
    track: selection.track || null,
    feat: selection.feat || null,
    workspace_set: selection.track || null,
    workspace_set_source: selection.track_source,
    repos,
    totals: {
      repos: repos.length,
      worktrees: repos.reduce((sum, repo) => sum + repo.worktrees.length, 0),
    },
  };
}

function fetchWorktree(item, options = {}) {
  if (!item.exists || !item.is_git) {
    return {
      id: item.id,
      repo: item.repo,
      status: 'skipped',
      reason: item.exists ? 'not_a_git_worktree' : 'worktree_missing',
    };
  }
  const remotes = new Set();
  if (item.origin_url) remotes.add('origin');
  if (item.upstream_url) remotes.add('upstream');
  if (item.remote && item.remote_url) remotes.add(item.remote);
  const results = [];
  for (const remote of remotes) {
    const started = Date.now();
    const result = spawnSync('git', ['-C', item.local_path, 'fetch', remote, '--prune'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeoutMs || 120000,
    });
    results.push({
      remote,
      status: result.status === 0 ? 'passed' : 'failed',
      exit_code: typeof result.status === 'number' ? result.status : 1,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      duration_ms: Date.now() - started,
    });
    if (result.status !== 0 && options.continueOnError !== true) break;
  }
  return {
    id: item.id,
    repo: item.repo,
    status: results.some(result => result.status === 'failed') ? 'failed' : 'passed',
    results,
  };
}

function repoFetch(options = {}) {
  const before = repoStatus(options);
  const results = before.repos.flatMap(repo => repo.worktrees.map(item => fetchWorktree(item, options)));
  const failed = results.filter(item => item.status === 'failed').length;
  const fetched = results.filter(item => item.status === 'passed').length;
  return {
    action: 'repo_fetch',
    workspace: before.workspace,
    track: before.track,
    feat: before.feat,
    workspace_set: before.workspace_set,
    status: failed > 0 ? 'failed' : 'passed',
    totals: {
      entries: results.length,
      fetched,
      failed,
      skipped: results.filter(item => item.status === 'skipped').length,
    },
    results,
    after: repoStatus(options),
  };
}

function repoUpdatePlan(options = {}) {
  const status = repoStatus(options);
  const entries = status.repos.flatMap(repo => repo.worktrees.map(item => {
    const blockedBy = [];
    if (!item.exists) blockedBy.push('worktree_missing');
    if (!item.is_git) blockedBy.push('not_a_git_worktree');
    if (item.dirty) blockedBy.push('worktree_dirty');
    if (!item.upstream_ref) blockedBy.push('upstream_ref_missing');
    if (item.commits_behind_upstream == null) blockedBy.push('upstream_unknown');
    const needsUpdate = (item.commits_behind_upstream || 0) > 0;
    return {
      id: item.id,
      repo: item.repo,
      branch: item.branch,
      upstream_ref: item.upstream_ref,
      commits_behind_upstream: item.commits_behind_upstream,
      commits_ahead_upstream: item.commits_ahead_upstream,
      action: blockedBy.length
        ? 'blocked'
        : (needsUpdate ? 'fast_forward_or_rebase' : 'up_to_date'),
      blocked_by: blockedBy,
      commands: blockedBy.length || !needsUpdate ? [] : [
        `git -C ${JSON.stringify(item.local_path)} fetch --all --prune`,
        `git -C ${JSON.stringify(item.local_path)} rebase ${JSON.stringify(item.upstream_ref)}`,
      ],
    };
  }));
  return {
    action: 'repo_update_plan',
    workspace: status.workspace,
    track: status.track,
    feat: status.feat,
    workspace_set: status.workspace_set,
    entries,
    totals: {
      entries: entries.length,
      update: entries.filter(item => item.action === 'fast_forward_or_rebase').length,
      blocked: entries.filter(item => item.action === 'blocked').length,
      up_to_date: entries.filter(item => item.action === 'up_to_date').length,
    },
    next_action: 'Review commands, fetch first, and update one clean worktree at a time.',
  };
}

function renderRepoStatusText(status) {
  const lines = [
    `Workspace: ${shortPath(status.workspace)}`,
    `Track: ${status.workspace_set || '(none)'}`,
    status.feat ? `Feature: ${status.feat}` : null,
    `Repos: ${status.totals.repos}, worktrees: ${status.totals.present}/${status.totals.worktrees} present, ${status.totals.dirty} dirty, ${status.totals.behind_upstream} behind, ${status.totals.upstream_unknown} upstream unknown`,
    '',
    'Repos:',
  ].filter(Boolean);
  for (const repo of status.repos || []) {
    lines.push(`  ${repo.name}  worktrees:${repo.totals.present}/${repo.totals.worktrees} dirty:${repo.totals.dirty} behind:${repo.totals.behind_upstream}`);
    if (repo.remote) lines.push(`    remote: ${repo.remote}`);
    if (repo.upstream) lines.push(`    upstream: ${repo.upstream}`);
    for (const item of repo.worktrees) {
      const flags = [
        item.exists ? 'present' : 'missing',
        item.is_git ? 'git' : 'not-git',
        item.dirty ? `dirty:${item.dirty_file_count}` : 'clean',
        item.commits_behind_upstream == null ? 'behind:?' : `behind:${item.commits_behind_upstream}`,
        item.commits_ahead_upstream == null ? 'ahead:?' : `ahead:${item.commits_ahead_upstream}`,
      ].join(', ');
      lines.push(`    ${item.id}  ${item.branch || item.desired_branch || '-'}  ${item.head || '-'}  ${flags}`);
      lines.push(`      path: ${shortPath(item.local_path)}`);
      if (item.upstream_ref) lines.push(`      upstream ref: ${item.upstream_ref}`);
    }
  }
  return lines.join('\n');
}

function handleRepo(subcommand, args) {
  const parsed = parseArgs(args || []);
  if (!subcommand || subcommand === 'status') {
    const status = repoStatus({
      root: parsed.root || null,
      set: parsed.set || null,
      feat: parsed.feat || null,
    });
    if (parsed.text === true) {
      process.stdout.write(renderRepoStatusText(status) + '\n');
    } else {
      output(status);
    }
    return;
  }
  if (subcommand === 'list') {
    output(repoList({
      root: parsed.root || null,
      set: parsed.set || null,
      feat: parsed.feat || null,
    }));
    return;
  }
  if (subcommand === 'fetch') {
    output(repoFetch({
      root: parsed.root || null,
      set: parsed.set || null,
      feat: parsed.feat || null,
      continueOnError: parsed['continue-on-error'] === true,
    }));
    return;
  }
  if (subcommand === 'update-plan' || subcommand === 'update') {
    output(repoUpdatePlan({
      root: parsed.root || null,
      set: parsed.set || null,
      feat: parsed.feat || null,
    }));
    return;
  }
  error(`Unknown repo subcommand: '${subcommand}'. Use: list, status, fetch, update-plan`);
}

module.exports = {
  handleRepo,
  repoFetch,
  repoList,
  repoStatus,
  repoUpdatePlan,
  renderRepoStatusText,
};
