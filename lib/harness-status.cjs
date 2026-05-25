'use strict';

const os = require('os');
const path = require('path');

const { output, parseArgs } = require('./core.cjs');
const { loadWorkspaceConfig } = require('./workspace-config.cjs');
const { buildRuntimeContext, readRuntimeBinding } = require('./runtime-context.cjs');
const { getSyncStatus } = require('./sync-plan.cjs');
const { getWorkspaceStatus } = require('./workspace-inventory.cjs');
const { listPresence } = require('./presence.cjs');
const { repoStatus } = require('./repo-manager.cjs');
const { sessionList } = require('./session-manager.cjs');
const { envBootstrapPlan } = require('./env-profile.cjs');
const { readSelectionBinding } = require('./track-profile.cjs');

function shortPath(value) {
  const text = String(value || '');
  if (!text) return '';
  const home = os.homedir();
  return text.startsWith(home) ? `~${text.slice(home.length)}` : text;
}

function hasProxy(runtime) {
  const env = runtime && runtime.env ? runtime.env : {};
  return Boolean(env.HTTP_PROXY || env.HTTPS_PROXY || env.ALL_PROXY || env.http_proxy || env.https_proxy || env.all_proxy);
}

function compactLatestRun(list) {
  const run = list && Array.isArray(list.runs) && list.runs.length ? list.runs[0] : null;
  if (!run) return null;
  return {
    run_id: run.run_id,
    track: run.track || run.workspace_set || null,
    feat: run.feat || null,
    lifecycle: run.lifecycle || null,
    phase: run.phase || null,
    created_at: run.created_at || null,
    evidence: run.evidence || null,
  };
}

function buildNextActions(status) {
  const root = status.workspace;
  const cli = path.join(__dirname, 'devteam.cjs');
  const scope = [
    status.workspace_set ? `--set ${JSON.stringify(status.workspace_set)}` : null,
    status.feat ? `--feat ${JSON.stringify(status.feat)}` : null,
  ].filter(Boolean).join(' ');
  const scoped = suffix => [scope, suffix].filter(Boolean).join(' ');
  const actions = [];

  if ((status.repos.totals.behind_upstream || 0) > 0 || (status.repos.totals.upstream_unknown || 0) > 0) {
    actions.push(`node ${JSON.stringify(cli)} repo status --root ${JSON.stringify(root)} ${scoped('--text')}`.trim());
  }
  if ((status.worktrees.totals.missing || 0) > 0) {
    actions.push(`node ${JSON.stringify(cli)} ws materialize --root ${JSON.stringify(root)} ${scope}`.trim());
  }
  if ((status.worktrees.totals.dirty || 0) > 0) {
    actions.push(`node ${JSON.stringify(cli)} ws status --root ${JSON.stringify(root)} ${scoped('--text --full')}`.trim());
  }
  if (status.selection_binding && status.selection_binding.exists) {
    actions.push(status.selection_binding.source);
  }
  if (status.runtime && status.runtime.binding && status.runtime.binding.exists && status.runtime.binding.current) {
    actions.push(status.runtime.binding.source);
  } else if (status.runtime && status.runtime.binding && status.runtime.binding.exists && !status.runtime.binding.current) {
    actions.push(status.runtime.bind_command || `node ${JSON.stringify(cli)} env bind --root ${JSON.stringify(root)} ${scoped('--text')}`.trim());
    actions.push(status.runtime.binding.source);
  } else if (status.runtime && status.runtime.bind_command) {
    actions.push(status.runtime.bind_command);
  } else if (status.runtime && status.runtime.shell && status.runtime.shell.source) {
    actions.push(status.runtime.shell.source);
  }
  if (!actions.length) {
    actions.push('No harness-managed workspace action is required.');
  }
  return actions;
}

function harnessStatus(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const worktrees = getWorkspaceStatus({
    root: config.root,
    set: options.set || null,
    feat: options.feat || null,
  });
  const repos = repoStatus({
    root: config.root,
    set: options.set || null,
    feat: options.feat || null,
  });
  const runtime = buildRuntimeContext({
    config,
    set: options.set || null,
    feat: options.feat || null,
  });
  const selectionBinding = readSelectionBinding({
    config,
    scope: options.scope || options.selectionScope || 'session',
  });
  const bootstrap = runtime.profile
    ? envBootstrapPlan({
      root: config.root,
      set: options.set || null,
      feat: options.feat || null,
      profile: runtime.profile,
    })
    : null;
  const runtimeBinding = readRuntimeBinding({
    config,
    context: runtime,
  });
  const bindScope = [
    runtime.track ? `--set ${JSON.stringify(runtime.track)}` : null,
    runtime.feat ? `--feat ${JSON.stringify(runtime.feat)}` : null,
    runtime.profile ? `--profile ${JSON.stringify(runtime.profile)}` : null,
    runtime.sync_profile ? `--sync ${JSON.stringify(runtime.sync_profile)}` : null,
    runtime.environment ? `--env ${JSON.stringify(runtime.environment)}` : null,
  ].filter(Boolean).join(' ');
  const runtimeBindCommand = `node ${JSON.stringify(path.join(__dirname, 'devteam.cjs'))} env bind --root ${JSON.stringify(config.root)} ${bindScope} --text`.trim();
  const syncStatus = runtime.sync_profile
    ? getSyncStatus({
      root: config.root,
      profile: runtime.sync_profile,
    })
    : null;
  const presence = worktrees.track
    ? listPresence({
      root: config.root,
      set: worktrees.track,
      feat: worktrees.feat || null,
    })
    : listPresence({
      root: config.root,
    });
  const recentRuns = sessionList({
    root: config.root,
    set: worktrees.track || null,
    feat: worktrees.feat || null,
    limit: 3,
    unreadable: false,
  });

  const payload = {
    action: 'harness_status',
    workspace: config.root,
    config_path: config.config_path,
    track: worktrees.track || null,
    feat: worktrees.feat || null,
    workspace_set: worktrees.workspace_set || null,
    workspace_set_source: worktrees.workspace_set_source || null,
    selection: worktrees.selection,
    selection_binding: selectionBinding,
    worktrees: {
      totals: worktrees.totals,
      entries: worktrees.worktrees,
    },
    repos: {
      totals: repos.totals,
      entries: repos.repos,
    },
    environment: {
      profile: runtime.profile || null,
      sync_profile: runtime.sync_profile || null,
      environment: runtime.environment || null,
      type: runtime.type || null,
      proxy_configured: hasProxy(runtime),
      profile_effective: runtime.profile_effective || null,
      bootstrap: bootstrap ? {
        status: bootstrap.status,
        recipe: bootstrap.recipe,
        command_count: bootstrap.commands.length,
        missing: bootstrap.missing,
        next_action: bootstrap.next_action,
      } : null,
    },
    runtime: {
      shell: runtime.shell,
      env_keys: Object.keys(runtime.env || {}).sort(),
      worktrees: runtime.worktrees || [],
      binding: runtimeBinding,
      bind_command: runtimeBindCommand,
    },
    sync: {
      profile: syncStatus ? syncStatus.profile : null,
      state_path: syncStatus ? syncStatus.state_path : null,
      exists: syncStatus ? syncStatus.exists : false,
      last_sync: syncStatus ? syncStatus.last_sync : null,
    },
    presence: {
      totals: presence.totals,
      entries: presence.entries,
    },
    recent_runs: {
      totals: recentRuns.totals,
      latest: compactLatestRun(recentRuns),
      runs: recentRuns.runs,
    },
  };
  payload.next_actions = buildNextActions(payload);
  return payload;
}

function renderHarnessStatusText(status) {
  const wt = status.worktrees.totals || {};
  const repo = status.repos.totals || {};
  const env = status.environment || {};
  const presence = status.presence.totals || {};
  const latest = status.recent_runs.latest || null;
  const lines = [
    'Devteam Harness',
    `Workspace: ${shortPath(status.workspace)}`,
    `Track: ${status.workspace_set || '(none)'}`,
    status.feat ? `Feature: ${status.feat}` : null,
    status.selection_binding && status.selection_binding.exists ? `Selection source: ${status.selection_binding.source} track=${status.selection_binding.track || '-'}${status.selection_binding.feat ? ` feat=${status.selection_binding.feat}` : ''}` : null,
    `Worktrees: ${wt.present || 0}/${wt.worktrees || 0} present, ${wt.dirty || 0} dirty, ${wt.missing || 0} missing`,
    `Repos: ${repo.repos || 0} configured, ${repo.behind_upstream || 0} behind, ${repo.upstream_unknown || 0} upstream unknown`,
    `Environment: ${env.profile || '-'} (${env.type || '-'}) env=${env.environment || '-'} proxy=${env.proxy_configured ? 'yes' : 'no'}`,
    env.bootstrap ? `Env bootstrap: ${env.bootstrap.status}${env.bootstrap.recipe ? ` recipe=${shortPath(env.bootstrap.recipe.abs_path || env.bootstrap.recipe.path)}` : ''} commands=${env.bootstrap.command_count || 0}` : null,
    `Runtime: ${status.runtime.env_keys.length} exports, ${status.runtime.worktrees.length} worktree bindings, binding=${status.runtime.binding && status.runtime.binding.exists ? (status.runtime.binding.current ? 'current' : 'stale') : 'none'}`,
    status.runtime.binding && status.runtime.binding.exists ? `Runtime source: ${status.runtime.binding.source}` : `Runtime bind: ${status.runtime.bind_command}`,
    `Sync: ${status.sync.profile || '-'} last=${status.sync.exists && status.sync.last_sync ? (status.sync.last_sync.applied_at || 'recorded') : 'none'}`,
    `Presence: ${presence.active || 0} active`,
    `Latest run: ${latest ? latest.run_id : '-'}${latest && latest.phase ? ` (${latest.phase.name}/${latest.phase.status})` : ''}`,
    '',
    'Repo Worktrees:',
  ].filter(Boolean);

  const repoEntries = status.repos.entries || [];
  if (!repoEntries.length) {
    lines.push('  (none)');
  } else {
    for (const entry of repoEntries) {
      lines.push(`  ${entry.name}  present:${entry.totals.present}/${entry.totals.worktrees} dirty:${entry.totals.dirty} behind:${entry.totals.behind_upstream} unknown:${entry.totals.upstream_unknown}`);
      for (const worktree of entry.worktrees || []) {
        const behind = worktree.commits_behind_upstream == null ? '?' : worktree.commits_behind_upstream;
        const ahead = worktree.commits_ahead_upstream == null ? '?' : worktree.commits_ahead_upstream;
        lines.push(`    ${worktree.id}  ${worktree.branch || worktree.desired_branch || '-'}  ${worktree.head || '-'}  ${worktree.exists ? 'present' : 'missing'} ${worktree.dirty ? 'dirty' : 'clean'} ahead:${ahead} behind:${behind}`);
      }
    }
  }

  lines.push('', 'Next actions:');
  for (const action of status.next_actions || []) {
    lines.push(`  ${action}`);
  }
  return lines.join('\n');
}

function handleHarnessStatus(args) {
  const parsed = parseArgs(args || []);
  if (parsed.session === true || parsed.run || parsed.id) {
    const { handleStatusOverview } = require('./session-manager.cjs');
    handleStatusOverview(args || []);
    return;
  }
  const status = harnessStatus({
    root: parsed.root || null,
    set: parsed.set || null,
    feat: parsed.feat || null,
    scope: parsed.scope || parsed.session || null,
  });
  if (parsed.json === true) {
    output(status);
  } else {
    process.stdout.write(renderHarnessStatusText(status) + '\n');
  }
}

module.exports = {
  handleHarnessStatus,
  harnessStatus,
  renderHarnessStatusText,
};
