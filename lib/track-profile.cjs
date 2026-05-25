'use strict';

const fs = require('fs');
const path = require('path');

const { output, error, parseArgs } = require('./core.cjs');
const { loadWorkspaceConfig } = require('./workspace-config.cjs');
const { getWorkspaceStatus } = require('./workspace-inventory.cjs');
const { sessionList } = require('./session-manager.cjs');
const { listPresenceEntries } = require('./presence.cjs');
const {
  inferTrackProfile,
  resolveTrackName,
  resolveTrackSelection,
  worktreeIdsForTrack,
} = require('./track-resolver.cjs');
const yaml = require('./yaml.cjs');

const DEFAULT_KEY_ORDER = [
  'track',
  'feat',
  'workspace_set',
  'env',
  'sync',
  'build',
  'deploy',
  'deploy_flow',
  'validation',
  'server_test',
];

function shortPath(value) {
  const text = String(value || '');
  if (!text) return '';
  const home = require('os').homedir();
  return text.startsWith(home) ? `~${text.slice(home.length)}` : text;
}

function compactList(values, max = 3) {
  const list = Array.isArray(values) ? values.filter(Boolean) : [];
  if (!list.length) return '-';
  const shown = list.slice(0, max).join(',');
  return list.length > max ? `${shown},+${list.length - max}` : shown;
}

function shellArg(value) {
  return JSON.stringify(String(value));
}

function commandFor(config, parts) {
  return [
    'node',
    shellArg(path.join(__dirname, 'devteam.cjs')),
    ...parts,
  ].join(' ');
}

function scopeArgs(profile) {
  return [
    '--set', shellArg(profile.name),
    profile.feat ? '--feat' : null,
    profile.feat ? shellArg(profile.feat) : null,
  ].filter(Boolean);
}

function trackNextActions(config, profile, workspace, dirtyWorktrees, latestRun) {
  const scope = scopeArgs(profile);
  if (workspace.totals.missing > 0) {
    return [
      {
        kind: 'materialize',
        summary: 'Materialize missing local worktrees before syncing or testing.',
        command: commandFor(config, [
          'ws', 'materialize',
          '--root', shellArg(config.root),
          ...scope,
        ]),
      },
    ];
  }
  if (dirtyWorktrees.length > 0) {
    return [
      {
        kind: 'inspect-dirty',
        summary: 'Review dirty files before syncing, publishing, or building.',
        command: commandFor(config, [
          'ws', 'status',
          '--root', shellArg(config.root),
          ...scope,
          '--text',
        ]),
      },
    ];
  }
  if (latestRun && latestRun.next_action) {
    return [
      {
        kind: 'continue-run',
        summary: 'Continue from the latest run next action.',
        command: latestRun.next_action,
      },
    ];
  }
  return [
    {
      kind: 'start-run',
      summary: 'Start a fresh remote validation run for this track.',
      command: commandFor(config, [
        'remote-loop', 'start',
        '--root', shellArg(config.root),
        ...scope,
      ]),
    },
  ];
}

function enrichTrackRuntime(config, profile) {
  const workspace = getWorkspaceStatus({
    root: config.root,
    set: profile.name,
    feat: profile.feat || null,
  });
  const runs = sessionList({
    root: config.root,
    set: profile.name,
    feat: profile.feat || null,
    limit: 1,
    unreadable: false,
  });
  const runHistory = trackRunHistory(config, profile, runs);
  const latestRun = runs.runs && runs.runs.length ? runs.runs[0] : null;
  const dirtyWorktrees = (workspace.worktrees || [])
    .filter(item => item.dirty)
    .map(item => ({
      id: item.id,
      repo: item.repo,
      branch: item.branch || item.desired_branch || null,
      head: item.head || null,
      dirty_file_count: item.dirty_file_count || 0,
      dirty_summary: item.dirty_summary || { staged: 0, unstaged: 0, untracked: 0 },
    }));

  const nextActions = trackNextActions(config, profile, workspace, dirtyWorktrees, latestRun);
  const presence = listPresenceEntries(config)
    .filter(entry => entry.active && entry.track === profile.name && (!profile.feat || entry.feat === profile.feat))
    .slice(0, 5)
    .map(entry => ({
      session_id: entry.session_id,
      status: entry.status || null,
      feat: entry.feat || null,
      run_id: entry.run_id || null,
      purpose: entry.purpose || null,
      last_seen_at: entry.last_seen_at || null,
      age_seconds: entry.age_seconds,
      tool: entry.tool || null,
    }));

  return {
    workspace: workspace.totals,
    dirty_worktrees: dirtyWorktrees,
    latest_run: latestRun ? {
      run_id: latestRun.run_id,
      phase: latestRun.phase || null,
      evidence: latestRun.evidence || null,
      image: latestRun.image || null,
      next_action: latestRun.next_action || null,
    } : null,
    presence,
    presence_count: presence.length,
    run_history: runHistory,
    next_actions: nextActions,
    next_action: nextActions[0] ? nextActions[0].command : null,
  };
}

function enrichTrack(config, profile) {
  return {
    ...profile,
    runtime: enrichTrackRuntime(config, profile),
  };
}

function hasOpenRun(track) {
  const latest = track.runtime && track.runtime.latest_run ? track.runtime.latest_run : null;
  if (!latest || !latest.phase) return false;
  const status = latest.phase.status || '';
  const name = latest.phase.name || '';
  return !['complete', 'ready'].includes(status) && !['complete'].includes(name);
}

function trackVisibleByDefault(track, config) {
  const status = track.status || 'active';
  const runtime = track.runtime || {};
  const workspace = runtime.workspace || {};
  if (track.active) return true;
  if (track.name === config.defaults.track) return true;
  if (status === 'active') return true;
  if ((workspace.dirty || 0) > 0 || (workspace.missing || 0) > 0) return true;
  if ((runtime.presence_count || 0) > 0) return true;
  if (hasOpenRun(track)) return true;
  return false;
}

function listTracks(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const includeRuntime = options.runtime !== false;
  const active = resolveTrackSelection(config, {
    set: options.set || null,
    feat: options.feat || null,
    required: false,
  });
  const allTracks = Object.keys(config.tracks || {}).map(name => {
    const feat = active.track === name ? active.feat || null : null;
    const profile = inferTrackProfile(config, name, { activeTrack: active.track || null, feat });
    return includeRuntime ? enrichTrack(config, profile) : profile;
  });
  const filter = options.filter || 'all';
  const tracks = filter === 'active'
    ? allTracks.filter(track => trackVisibleByDefault(track, config))
    : allTracks;
  return {
    action: 'track_list',
    workspace: config.root,
    active_track: active.track || null,
    active_feat: active.feat || null,
    active_source: active.track_source,
    active_feat_source: active.feat_source,
    default_track: config.defaults.track || null,
    default_feat: config.defaults.feat || null,
    filter,
    totals: {
      tracks: allTracks.length,
      shown: tracks.length,
      hidden: allTracks.length - tracks.length,
    },
    tracks,
  };
}

function trackStatus(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const active = resolveTrackSelection(config, {
    set: options.set || null,
    feat: options.feat || null,
    required: false,
  });
  const activeTrack = active.track || null;
  const activeFeat = active.feat || null;
  const profile = activeTrack ? inferTrackProfile(config, activeTrack, { activeTrack, feat: activeFeat }) : null;
  const includeRuntime = options.runtime !== false;
  return {
    action: 'track_status',
    workspace: config.root,
    active_track: activeTrack,
    active_feat: activeFeat,
    active_source: active.track_source,
    active_feat_source: active.feat_source,
    default_track: config.defaults.track || null,
    default_feat: config.defaults.feat || null,
    defaults: config.defaults,
    track: profile && includeRuntime ? enrichTrack(config, profile) : profile,
  };
}

function phaseText(run) {
  if (!run || !run.phase) return 'no-run';
  return `${run.phase.name || '-'}:${run.phase.status || '-'}`;
}

function runLifecycleLabel(run) {
  const lifecycle = run && run.lifecycle ? run.lifecycle : {};
  return lifecycle.status || 'open';
}

function trackRunHistory(config, profile, openRuns) {
  const allRuns = sessionList({
    root: config.root,
    set: profile.name,
    feat: profile.feat || null,
    limit: 200,
    unreadable: false,
    includeClosed: true,
  });
  const totals = {
    all: allRuns.totals ? allRuns.totals.matched || 0 : 0,
    open: 0,
    closed: 0,
    superseded: 0,
    archived: 0,
    other: 0,
    unreadable: allRuns.totals ? allRuns.totals.unreadable || 0 : 0,
  };
  for (const run of allRuns.runs || []) {
    const label = runLifecycleLabel(run);
    if (label === 'open') totals.open += 1;
    else if (label === 'closed') totals.closed += 1;
    else if (label === 'superseded') totals.superseded += 1;
    else if (label === 'archived') totals.archived += 1;
    else totals.other += 1;
  }
  return {
    totals,
    latest_open_run_id: openRuns && openRuns.runs && openRuns.runs[0] ? openRuns.runs[0].run_id : null,
    latest_any_run_id: allRuns.runs && allRuns.runs[0] ? allRuns.runs[0].run_id : null,
  };
}

function runHistoryText(history) {
  const totals = history && history.totals ? history.totals : {};
  const parts = [`open:${totals.open || 0}`];
  if (totals.closed) parts.push(`closed:${totals.closed}`);
  if (totals.superseded) parts.push(`superseded:${totals.superseded}`);
  if (totals.archived) parts.push(`archived:${totals.archived}`);
  if (totals.other) parts.push(`other:${totals.other}`);
  if (totals.unreadable) parts.push(`unreadable:${totals.unreadable}`);
  return parts.join(' ');
}

function renderTrackListText(list) {
  const lines = [
    `Workspace: ${shortPath(list.workspace)}`,
    `Selected track: ${list.active_track || '(none)'} (${list.active_source || 'none'})`,
    list.active_feat ? `Selected feature: ${list.active_feat} (${list.active_feat_source || 'none'})` : null,
    `Workspace default: ${list.default_track || '(none)'}`,
    `Filter: ${list.filter || 'all'}${list.totals && list.totals.hidden ? ` (${list.totals.hidden} hidden)` : ''}`,
    '',
    'Tracks:',
  ].filter(Boolean);
  if (!list.tracks.length) {
    lines.push('  (none)');
    return lines.join('\n');
  }
  for (const track of list.tracks) {
    const active = track.active ? '*' : ' ';
    const runtime = track.runtime || {};
    const totals = runtime.workspace || {};
    const latest = runtime.latest_run || null;
    const dirty = runtime.dirty_worktrees || [];
    const runHistory = runHistoryText(runtime.run_history);
    const status = track.status || 'active';
    const feat = track.feat ? ` feat:${track.feat}` : '';
    lines.push(
      `${active} ${track.name}${feat}  status:${status}  worktrees:${totals.present || 0}/${totals.worktrees || track.worktrees || 0}` +
      ` dirty:${totals.dirty || 0}  run:${latest ? latest.run_id : '-'}  phase:${phaseText(latest)}  runs:${runHistory}`
    );
    lines.push(
      `    env:${track.env || '-'} sync:${track.sync || '-'} build:${track.build || '-'} ` +
      `deploy:${track.deploy || '-'} validation:${track.validation || '-'}`
    );
    if (dirty.length) {
      const dirtyText = dirty
        .slice(0, 3)
        .map(item => `${item.id}:${item.dirty_file_count}`)
        .join(', ');
      lines.push(`    dirty: ${dirtyText}${dirty.length > 3 ? `,+${dirty.length - 3}` : ''}`);
    }
    if (runtime.presence_count) {
      const presenceText = (runtime.presence || [])
        .slice(0, 3)
        .map(item => `${item.session_id}${item.purpose ? `:${item.purpose}` : ''}`)
        .join(', ');
      lines.push(`    presence: ${runtime.presence_count} active${presenceText ? ` (${presenceText})` : ''}`);
    }
    if (runtime.next_actions && runtime.next_actions[0]) {
      lines.push(`    next: ${runtime.next_actions[0].command}`);
    }
  }
  return lines.join('\n');
}

function renderTrackStatusText(status) {
  const track = status.track || null;
  const lines = [
    `Workspace: ${shortPath(status.workspace)}`,
    `Selected track: ${status.active_track || '(none)'} (${status.active_source || 'none'})`,
    status.active_feat ? `Selected feature: ${status.active_feat} (${status.active_feat_source || 'none'})` : null,
    `Workspace default: ${status.default_track || '(none)'}`,
  ].filter(Boolean);
  if (!track) {
    lines.push('Track: (none)');
    return lines.join('\n');
  }
  const runtime = track.runtime || {};
  const totals = runtime.workspace || {};
  const latest = runtime.latest_run || null;
  const runHistory = runHistoryText(runtime.run_history);
  lines.push(
    `Track: ${track.name}  ${track.description || ''}`.trim(),
    track.feat ? `Feature: ${track.feat}` : null,
    `Profiles: env=${track.env || '-'} sync=${track.sync || '-'} build=${track.build || '-'} deploy=${track.deploy || '-'} validation=${track.validation || '-'}`,
    `Worktrees: ${totals.present || 0}/${totals.worktrees || track.worktrees || 0} present, ${totals.dirty || 0} dirty, ${totals.missing || 0} missing`,
    `Repos: ${compactList(track.repos)}`,
    `Latest run: ${latest ? latest.run_id : '-'}  phase=${phaseText(latest)}`,
    `Run history: ${runHistory}`,
  );
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i] == null) lines.splice(i, 1);
  }
  if (latest && latest.evidence) {
    lines.push(`Evidence: passed=${compactList(latest.evidence.passed)} missing=${compactList(latest.evidence.missing)}`);
  }
  if (latest && latest.image && latest.image.image) {
    lines.push(`Image: ${latest.image.image}`);
  }
  const dirty = runtime.dirty_worktrees || [];
  if (dirty.length) {
    lines.push('Dirty worktrees:');
    for (const item of dirty.slice(0, 5)) {
      lines.push(`  ${item.id} ${item.branch || '-'} @ ${item.head || '-'} files=${item.dirty_file_count}`);
    }
  }
  if (runtime.presence_count) {
    lines.push('Active sessions:');
    for (const item of (runtime.presence || []).slice(0, 5)) {
      const age = item.age_seconds == null ? '-' : `${item.age_seconds}s`;
      lines.push(`  ${item.session_id} age=${age}${item.run_id ? ` run=${item.run_id}` : ''}${item.purpose ? ` purpose=${item.purpose}` : ''}`);
    }
  }
  const nextActions = runtime.next_actions || [];
  if (nextActions.length) {
    lines.push('Next:');
    for (const action of nextActions.slice(0, 3)) {
      lines.push(`  ${action.summary}`);
      if (action.command) lines.push(`  ${action.command}`);
    }
  } else {
    lines.push('Next: No immediate action.');
  }
  return lines.join('\n');
}

function trackContext(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const active = resolveTrackSelection(config, {
    set: options.set || null,
    feat: options.feat || null,
    required: true,
    label: 'track context',
  });
  const trackName = active.track;
  const feat = active.feat || null;
  const status = trackStatus({
    root: config.root,
    set: trackName,
    feat,
    runtime: true,
  });
  const track = status.track;
  const worktrees = worktreeIdsForTrack(config, trackName, { feat }).map(id => {
    const configured = config.worktrees[id] || {};
    return {
      id,
      repo: configured.repo || null,
      path: configured.path || null,
      abs_path: configured.abs_path || null,
      branch: configured.branch || null,
      base_ref: configured.base_ref || null,
      roles: configured.roles || [],
      publish_after_validation: configured.publish_after_validation === true,
      sync: configured.sync || {},
    };
  });
  const workspaceStatus = getWorkspaceStatus({
    root: config.root,
    set: trackName,
    feat,
  });
  const byId = new Map((workspaceStatus.worktrees || []).map(item => [item.id, item]));
  const env = track.env && config.env_profiles[track.env]
    ? { name: track.env, ...config.env_profiles[track.env] }
    : null;
  const build = track.build && config.build_profiles[track.build]
    ? { name: track.build, ...config.build_profiles[track.build] }
    : null;
  const deploy = track.deploy && config.deploy_profiles[track.deploy]
    ? { name: track.deploy, ...config.deploy_profiles[track.deploy] }
    : null;
  const latest = track.runtime && track.runtime.latest_run ? track.runtime.latest_run : null;
  const validationInstances = Object.entries(config.validation_instances || {})
    .filter(([_name, instance]) => instance && instance.track === trackName && (!feat || (instance.feat || null) === feat))
    .map(([name, instance]) => ({
      name,
      capability: instance.capability || null,
      environment: instance.environment || null,
      maturity: instance.maturity || null,
      production_gate: instance.production_gate === true,
    }));
  const deployInstances = Object.entries(config.deploy_instances || {})
    .filter(([_name, instance]) => instance && instance.track === trackName && (!feat || (instance.feat || null) === feat))
    .map(([name, instance]) => ({
      name,
      capability: instance.capability || null,
      environment: instance.environment || null,
      maturity: instance.maturity || null,
    }));
  return {
    action: 'track_context',
    workspace: config.root,
    track: {
      name: track.name,
      aliases: track.aliases || [],
      feat,
      status: track.status || 'active',
      description: track.description || '',
      source: active.track_source,
      feat_source: active.feat_source,
      active: track.active,
      policy: track.policy || null,
      reference_tracks: track.reference_tracks || [],
      reference_policy: track.reference_policy || [],
      build_chain_doc: track.build_chain_doc || null,
      k8s_dev: track.k8s_dev || {},
    },
    policy: {
      selection: 'Use --set <track> plus optional --feat <feature> for this session; avoid mutating workspace defaults in parallel sessions.',
      mutation: 'Do not sync, publish, build, deploy, or mutate remote state without explicit user intent.',
      evidence: 'Record evidence after validation/build/deploy; start a new run when current HEAD differs from run evidence.',
      tests: 'Concrete test commands are inferred per code change and track context.',
    },
    worktrees: worktrees.map(item => {
      const runtime = byId.get(item.id) || {};
      return {
        ...item,
        exists: runtime.exists === true,
        dirty: runtime.dirty === true,
        head: runtime.head || null,
        current_branch: runtime.branch || null,
        dirty_file_count: runtime.dirty_file_count || 0,
        commits_ahead: runtime.commits_ahead == null ? null : runtime.commits_ahead,
      };
    }),
    profiles: {
      env: env ? {
        name: env.name,
        type: env.type || null,
        ssh: env.ssh || null,
        host: env.host || null,
        source_dir: env.source_dir || null,
        venv: env.venv || null,
        python: env.python || null,
        status: env.status || null,
      } : null,
      sync: track.sync || null,
      build: build ? {
        name: build.name,
        mode: build.mode || null,
        builder: build.builder || null,
        track: build.track || build.workspace_set || null,
        workspace_set: build.workspace_set || build.track || null,
      } : null,
      deploy: deploy ? {
        name: deploy.name,
        type: deploy.type || null,
        env: deploy.env || null,
        namespace: deploy.namespace || null,
      } : null,
      deploy_flow: track.deploy_flow || null,
      validation: track.validation || null,
    },
    validation_instances: validationInstances,
    deploy_instances: deployInstances,
    workspace_status: workspaceStatus.totals,
    latest_run: latest,
    run_history: track.runtime ? track.runtime.run_history || null : null,
    presence: track.runtime ? track.runtime.presence || [] : [],
    next_actions: track.runtime ? track.runtime.next_actions || [] : [],
    next_action: track.runtime ? track.runtime.next_action || null : null,
  };
}

function renderTrackContextText(context) {
  const track = context.track || {};
  const lines = [
    'Track Context',
    '',
    `Workspace: ${shortPath(context.workspace)}`,
    `Track: ${track.name || '-'}  status:${track.status || '-'}`,
    track.feat ? `Feature: ${track.feat}` : null,
  ];
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i] == null) lines.splice(i, 1);
  }
  if (track.aliases && track.aliases.length) {
    lines.push(`Aliases: ${track.aliases.join(', ')}`);
  }
  if (track.description) {
    lines.push(`Purpose: ${track.description}`);
  }
  if (track.policy) {
    lines.push(`Lane policy: ${track.policy}`);
  }
  if (track.reference_tracks && track.reference_tracks.length) {
    lines.push(`References: ${track.reference_tracks.join(', ')}`);
  }
  if (track.build_chain_doc) {
    lines.push(`Build chain doc: ${track.build_chain_doc}`);
  }
  if (track.k8s_dev && Object.keys(track.k8s_dev).length) {
    const k8s = track.k8s_dev;
    lines.push('K8s dev:');
    if (k8s.mode) lines.push(`  mode: ${k8s.mode}`);
    if (k8s.namespace) lines.push(`  namespace: ${k8s.namespace}`);
    if (k8s.node) lines.push(`  node: ${k8s.node}`);
    if (k8s.pod) lines.push(`  pod: ${k8s.pod}`);
    if (k8s.source_path) lines.push(`  source: ${k8s.source_path}`);
    if (k8s.venv_path) lines.push(`  venv: ${k8s.venv_path}`);
  }
  lines.push(
    '',
    'Policy:',
    `  ${context.policy.selection}`,
    `  ${context.policy.mutation}`,
    `  ${context.policy.evidence}`,
    '',
    'Worktrees:',
  );
  if (!context.worktrees.length) {
    lines.push('  (none)');
  } else {
    for (const item of context.worktrees) {
      const branch = item.current_branch || item.branch || '-';
      const flags = [
        item.exists ? 'present' : 'missing',
        item.dirty ? 'dirty' : 'clean',
        item.dirty_file_count ? `files:${item.dirty_file_count}` : null,
        item.commits_ahead == null ? null : `ahead:${item.commits_ahead}`,
      ].filter(Boolean).join(', ');
      lines.push(`  ${item.id}  ${item.repo || '-'}  ${branch}  ${item.head || '-'}  ${flags}`);
      lines.push(`    path: ${shortPath(item.abs_path || item.path)}`);
      if (item.sync && (item.sync.profile || item.sync.remote_path)) {
        lines.push(`    sync: ${item.sync.profile || '-'} -> ${item.sync.remote_path || '-'}`);
      }
    }
  }
  const env = context.profiles.env;
  lines.push('', 'Remote/env:');
  if (env) {
    lines.push(`  profile: ${env.name} (${env.type || '-'})`);
    if (env.ssh) lines.push(`  ssh: ${env.ssh}`);
    if (env.source_dir) lines.push(`  source_dir: ${env.source_dir}`);
    if (env.venv) lines.push(`  venv: ${env.venv}`);
    if (env.python) lines.push(`  python: ${env.python}`);
  } else {
    lines.push('  (none)');
  }
  lines.push('', 'Build/deploy:');
  lines.push(`  build: ${context.profiles.build ? `${context.profiles.build.name}${context.profiles.build.mode ? ` (${context.profiles.build.mode})` : ''}` : '-'}`);
  lines.push(`  deploy: ${context.profiles.deploy ? context.profiles.deploy.name : '-'}`);
  if (context.profiles.deploy_flow) lines.push(`  deploy_flow: ${context.profiles.deploy_flow}`);
  lines.push('', 'Validation instances:');
  if (context.validation_instances && context.validation_instances.length) {
    for (const item of context.validation_instances) {
      lines.push(`  ${item.name}  capability:${item.capability || '-'} env:${item.environment || '-'} maturity:${item.maturity || '-'}`);
    }
  } else {
    lines.push('  (none)');
  }
  if (context.deploy_instances && context.deploy_instances.length) {
    lines.push('', 'Deploy instances:');
    for (const item of context.deploy_instances) {
      lines.push(`  ${item.name}  capability:${item.capability || '-'} env:${item.environment || '-'} maturity:${item.maturity || '-'}`);
    }
  }

  const latest = context.latest_run;
  lines.push('', 'Latest run:');
  if (latest) {
    lines.push(`  id: ${latest.run_id || '-'}`);
    lines.push(`  phase: ${phaseText(latest)}`);
    if (latest.evidence) {
      lines.push(`  evidence: passed=${compactList(latest.evidence.passed)} missing=${compactList(latest.evidence.missing)}`);
    }
  } else {
    lines.push('  (none)');
  }
  if (context.presence && context.presence.length) {
    lines.push('', 'Active sessions:');
    for (const item of context.presence.slice(0, 5)) {
      lines.push(`  ${item.session_id}${item.run_id ? ` run=${item.run_id}` : ''}${item.purpose ? ` purpose=${item.purpose}` : ''}`);
    }
  }
  lines.push('', 'Next:');
  if (context.next_actions && context.next_actions.length) {
    for (const action of context.next_actions.slice(0, 3)) {
      lines.push(`  ${action.summary}`);
      if (action.command) lines.push(`  ${action.command}`);
    }
  } else {
    lines.push('  No immediate action.');
  }
  return lines.join('\n');
}

function yamlScalar(value) {
  if (value == null || value === '') return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return JSON.stringify(String(value));
}

function renderDefaultsBlock(defaults) {
  const keys = [
    ...DEFAULT_KEY_ORDER.filter(key => Object.prototype.hasOwnProperty.call(defaults, key)),
    ...Object.keys(defaults).filter(key => !DEFAULT_KEY_ORDER.includes(key)).sort(),
  ];
  return [
    'defaults:',
    ...keys.map(key => `  ${key}: ${yamlScalar(defaults[key])}`),
  ].join('\n');
}

function replaceDefaultsBlock(text, defaults) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => /^defaults:\s*(#.*)?$/.test(line));
  const block = renderDefaultsBlock(defaults).split('\n');
  if (start === -1) {
    const suffix = text.endsWith('\n') ? '' : '\n';
    return `${text}${suffix}\n${block.join('\n')}\n`;
  }

  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (/^\S/.test(line) && line.trim() !== '') break;
    end++;
  }
  const next = [
    ...lines.slice(0, start),
    ...block,
    ...(end < lines.length ? [''] : []),
    ...lines.slice(end),
  ].join('\n');
  return next.endsWith('\n') ? next : `${next}\n`;
}

function stripLegacyWorkspaceSetBlocks(text) {
  const lines = text.split(/\r?\n/);
  const outputLines = [];
  for (let index = 0; index < lines.length;) {
    if (/^workspace_sets:\s*(#.*)?$/.test(lines[index])) {
      index += 1;
      while (index < lines.length) {
        const line = lines[index];
        if (/^\S/.test(line) && line.trim() !== '') break;
        index += 1;
      }
      if (outputLines.length && outputLines[outputLines.length - 1] !== '') {
        outputLines.push('');
      }
      continue;
    }
    outputLines.push(lines[index]);
    index += 1;
  }
  return outputLines.join('\n');
}

function readRawConfig(configPath) {
  try {
    return yaml.parse(fs.readFileSync(configPath, 'utf8')) || {};
  } catch (err) {
    error(`Failed to parse ${configPath}: ${err.message}`);
  }
}

function useTrack(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const trackInput = options.track || null;
  if (!trackInput) error('track use requires <track>.');
  const track = resolveTrackName(config, trackInput);
  const profile = inferTrackProfile(config, track);
  const raw = readRawConfig(config.config_path);
  const currentDefaults = raw.defaults && typeof raw.defaults === 'object' && !Array.isArray(raw.defaults)
    ? raw.defaults
    : {};
  const nextDefaults = {
    ...currentDefaults,
    track,
    feat: null,
    workspace_set: null,
    env: profile.env,
    sync: profile.sync,
    build: profile.build,
    deploy: profile.deploy,
    deploy_flow: profile.deploy_flow,
    validation: profile.validation,
  };

  const before = fs.readFileSync(config.config_path, 'utf8');
  const after = replaceDefaultsBlock(stripLegacyWorkspaceSetBlocks(before), nextDefaults);
  const changed = before !== after;
  if (options.dryRun !== true && changed) {
    fs.writeFileSync(config.config_path, after, 'utf8');
  }

  return {
    action: 'track_use',
    workspace: config.root,
    config_path: config.config_path,
    track,
    dry_run: options.dryRun === true,
    changed,
    previous_defaults: config.defaults,
    next_defaults: {
      track,
      feat: null,
      workspace_set: null,
      env: profile.env,
      sync: profile.sync,
      build: profile.build,
      deploy: profile.deploy,
      deploy_flow: profile.deploy_flow,
      validation: profile.validation,
      server_test: currentDefaults.server_test ? String(currentDefaults.server_test) : null,
    },
    track_profile: {
      ...profile,
      active: true,
    },
  };
}

function bindTrack(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const trackInput = options.track || null;
  if (!trackInput) error('track bind requires <track>.');
  const track = resolveTrackName(config, trackInput);
  const profile = inferTrackProfile(config, track, { activeTrack: track });
  return {
    action: 'track_bind',
    workspace: config.root,
    track,
    profile,
    exports: {
      DEVTEAM_TRACK: track,
    },
    command: `export DEVTEAM_TRACK=${shellArg(track)}`,
    dt_function: `dt() { node ${shellArg(path.join(__dirname, 'devteam.cjs'))} "$@" --root ${shellArg(config.root)}; }`,
    next_action: 'Run the export command in this terminal/session, or pass --set explicitly. This does not modify .devteam/config.yaml.',
  };
}

function handleTrack(subcommand, args) {
  const parsed = parseArgs(args || []);
  if (!subcommand || subcommand === 'list') {
    const result = listTracks({
      root: parsed.root || null,
      set: parsed.set || null,
      feat: parsed.feat || null,
      runtime: parsed['no-runtime'] === true ? false : true,
      filter: parsed['active-only'] === true ? 'active' : 'all',
    });
    if (parsed.text === true) {
      process.stdout.write(renderTrackListText(result) + '\n');
    } else {
      output(result);
    }
    return;
  }
  if (subcommand === 'status') {
    const result = trackStatus({
      root: parsed.root || null,
      set: parsed.set || null,
      feat: parsed.feat || null,
      runtime: parsed['no-runtime'] === true ? false : true,
    });
    if (parsed.text === true) {
      process.stdout.write(renderTrackStatusText(result) + '\n');
    } else {
      output(result);
    }
    return;
  }
  if (subcommand === 'context') {
    const result = trackContext({
      root: parsed.root || null,
      set: parsed.set || parsed.track || parsed._[0] || null,
      feat: parsed.feat || null,
    });
    if (parsed.text === true) {
      process.stdout.write(renderTrackContextText(result) + '\n');
    } else {
      output(result);
    }
    return;
  }
  if (subcommand === 'use') {
    output(useTrack({
      root: parsed.root || null,
      track: parsed._[0] || parsed.track || null,
      dryRun: parsed['dry-run'] === true,
    }));
    return;
  }
  if (subcommand === 'bind') {
    const result = bindTrack({
      root: parsed.root || null,
      track: parsed._[0] || parsed.track || parsed.set || null,
    });
    if (parsed.text === true) {
      process.stdout.write([
        `Workspace: ${shortPath(result.workspace)}`,
        `Track: ${result.track}`,
        `Command: ${result.command}`,
        `dt: ${result.dt_function}`,
        `Next: ${result.next_action}`,
      ].join('\n') + '\n');
    } else {
      output(result);
    }
    return;
  }
  error(`Unknown track subcommand: '${subcommand}'. Use: list, status, context, use, bind`);
}

module.exports = {
  handleTrack,
  bindTrack,
  inferTrackProfile,
  listTracks,
  renderTrackContextText,
  renderTrackListText,
  renderTrackStatusText,
  trackContext,
  trackStatus,
  useTrack,
};
