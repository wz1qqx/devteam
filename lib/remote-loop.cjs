'use strict';

const fs = require('fs');
const path = require('path');

const { output, error, parseArgs } = require('./core.cjs');
const { loadWorkspaceConfig } = require('./workspace-config.cjs');
const { doctorProfile, refreshEnvProfile } = require('./env-profile.cjs');
const { applySyncPlan, buildSyncPlan } = require('./sync-plan.cjs');
const {
  recordSessionEvent,
  renderSessionStatusText,
  sessionList,
  sessionStatus,
  snapshotSession,
} = require('./session-manager.cjs');
const {
  inferTrackProfile,
  resolveTrackSelection,
} = require('./track-resolver.cjs');

function cliPath() {
  return path.join(__dirname, 'devteam.cjs');
}

function commandLine(parts) {
  return parts.filter(Boolean).join(' ');
}

function commandScopeParts(track, feat = null) {
  return [
    track ? '--set' : null,
    track ? JSON.stringify(track) : null,
    feat ? '--feat' : null,
    feat ? JSON.stringify(feat) : null,
  ].filter(Boolean);
}

function shortPath(value) {
  const text = String(value || '');
  if (!text) return '';
  const home = require('os').homedir();
  return text.startsWith(home) ? `~${text.slice(home.length)}` : text;
}

function displayCommand(command, root) {
  let value = String(command || '');
  if (!value) return '-';
  const cli = cliPath();
  const cliPattern = cli.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rootPattern = String(root || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  value = value.replace(new RegExp(`^node "${cliPattern}"\\s+`), 'dt ');
  value = value.replace(new RegExp(`^node '${cliPattern}'\\s+`), 'dt ');
  value = value.replace(new RegExp(`^node ${cliPattern}\\s+`), 'dt ');
  if (rootPattern) {
    value = value.replace(new RegExp(`\\s+--root "${rootPattern}"`, 'g'), '');
    value = value.replace(new RegExp(`\\s+--root '${rootPattern}'`, 'g'), '');
    value = value.replace(new RegExp(`\\s+--root ${rootPattern}`, 'g'), '');
  }
  return value;
}

function resolvePatchMode(options = {}) {
  if (options.patchMode) return options.patchMode;
  if (options.branchPatch === true) return 'branch-patch';
  return 'dirty-only';
}

function activeProfiles(config, options = {}) {
  const selection = resolveTrackSelection(config, {
    set: options.set || null,
    feat: options.feat || null,
    required: true,
    label: 'remote-loop track',
  });
  const track = selection.track;
  const feat = selection.feat || null;
  const profile = inferTrackProfile(config, track, { activeTrack: track, feat });
  const env = options.env || profile.env || config.defaults.env || config.defaults.sync || null;
  const sync = options.sync || profile.sync || config.defaults.sync || env || null;
  if (!env) error('No env profile. Run track use <track> or pass --env <profile>.');
  if (!sync) error('No sync profile. Run track use <track> or pass --sync <profile>.');
  return { track, feat, env, sync };
}

function latestRunForTrack(config, track, feat = null) {
  const list = sessionList({
    root: config.root,
    set: track,
    feat,
    limit: 1,
    unreadable: false,
  });
  return list.runs && list.runs.length ? list.runs[0] : null;
}

function isStaleRun(run) {
  return run &&
    run.phase &&
    run.phase.status === 'needs_attention' &&
    String(run.phase.reason || '').includes('worktree_head_changed');
}

function resolveLatestOpenRun(config, track, feat, runValue, label) {
  if (runValue) return String(runValue);
  const latest = latestRunForTrack(config, track, feat);
  if (!latest) {
    error(`${label} requires --run <id>; no existing run found for ${feat ? `track '${track}' feature '${feat}'` : `track '${track}'`}.`);
  }
  return latest.run_id;
}

function resolveWritableRun(config, track, feat, runValue, label) {
  if (runValue) return String(runValue);
  const latest = latestRunForTrack(config, track, feat);
  if (!latest) {
    error(`${label} requires --run <id>; no existing run found for ${feat ? `track '${track}' feature '${feat}'` : `track '${track}'`}.`);
  }
  if (isStaleRun(latest)) {
    error(
      `${label} refused to use stale latest run '${latest.run_id}' for ${feat ? `track '${track}' feature '${feat}'` : `track '${track}'`}. ` +
      'Start a fresh run with remote-loop start, then pass --run <fresh-run-id>.'
    );
  }
  return latest.run_id;
}

function remoteLoopPlan(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const { track, feat, env, sync } = activeProfiles(config, options);
  const latest = latestRunForTrack(config, track, feat);
  const stale = isStaleRun(latest);
  const run = options.run || (latest ? latest.run_id : '<run-id>');
  const cli = cliPath();
  const writableRun = latest && !stale ? run : '<fresh-run-id>';
  const scope = commandScopeParts(track, feat);
  return {
    action: 'remote_loop_plan',
    workspace: config.root,
    track,
    feat,
    env,
    sync,
    latest_run: latest,
    latest_run_state: latest ? (stale ? 'stale' : 'open') : 'none',
    commands: {
      start: commandLine([
        'node', JSON.stringify(cli), 'remote-loop start',
        '--root', JSON.stringify(config.root),
        ...scope,
      ]),
      doctor: commandLine([
        'node', JSON.stringify(cli), 'remote-loop doctor',
        '--root', JSON.stringify(config.root),
        ...scope,
        '--run', JSON.stringify(writableRun),
      ]),
      refresh_plan: commandLine([
        'node', JSON.stringify(cli), 'remote-loop refresh',
        '--root', JSON.stringify(config.root),
        ...scope,
        '--run', JSON.stringify(writableRun),
      ]),
      sync_plan: commandLine([
        'node', JSON.stringify(cli), 'remote-loop sync',
        '--root', JSON.stringify(config.root),
        ...scope,
        '--run', JSON.stringify(writableRun),
      ]),
      sync_branch_patch_plan: commandLine([
        'node', JSON.stringify(cli), 'remote-loop sync',
        '--root', JSON.stringify(config.root),
        ...scope,
        '--run', JSON.stringify(writableRun),
        '--branch-patch',
      ]),
      sync_apply: commandLine([
        'node', JSON.stringify(cli), 'remote-loop sync',
        '--root', JSON.stringify(config.root),
        ...scope,
        '--run', JSON.stringify(writableRun),
        '--yes',
      ]),
      record_test: commandLine([
        'node', JSON.stringify(cli), 'remote-loop record-test',
        '--root', JSON.stringify(config.root),
        ...scope,
        '--run', JSON.stringify(writableRun),
        '--remote-pytest-log', '/remote/path/pytest.log',
        '--command', JSON.stringify('python -m pytest ...'),
      ]),
      status: commandLine([
        'node', JSON.stringify(cli), 'remote-loop status',
        '--root', JSON.stringify(config.root),
        ...scope,
        latest ? '' : '--run <run-id>',
      ]),
    },
    next_action: stale
      ? 'Latest open run is stale for the current worktree HEAD. Start a fresh run before recording evidence.'
      : (latest
        ? 'Use doctor/sync/record-test/status for the current remote validation run.'
        : 'Start a remote-loop run before recording evidence.'),
  };
}

function phaseText(run) {
  if (!run || !run.phase) return 'no-run';
  return `${run.phase.name || '-'}:${run.phase.status || '-'}`;
}

function renderRemoteLoopPlanText(plan) {
  const latest = plan.latest_run || null;
  const commands = plan.commands || {};
  const lines = [
    `Workspace: ${shortPath(plan.workspace)}`,
    `Track: ${plan.track || '-'}`,
    plan.feat ? `Feature: ${plan.feat}` : null,
    `Env: ${plan.env || '-'}`,
    `Sync: ${plan.sync || '-'}`,
    `Latest open run: ${latest ? latest.run_id : '-'} (${plan.latest_run_state || 'none'})`,
    `Phase: ${phaseText(latest)}`,
    `Next: ${plan.next_action || '-'}`,
    '',
    'Commands:',
    `  start: ${displayCommand(commands.start, plan.workspace)}`,
  ].filter(Boolean);

  if (plan.latest_run_state === 'stale') {
    lines.push(
      '  note: latest open run is stale; use start first, then replace <fresh-run-id> below with the new run id.',
    );
  } else if (plan.latest_run_state === 'none') {
    lines.push(
      '  note: no open run exists yet; use start first, then replace <fresh-run-id>/<run-id> below with the new run id.',
    );
  }

  lines.push(
    `  status: ${displayCommand(commands.status, plan.workspace)}`,
    `  doctor: ${displayCommand(commands.doctor, plan.workspace)}`,
    `  sync plan: ${displayCommand(commands.sync_plan, plan.workspace)}`,
    `  sync apply: ${displayCommand(commands.sync_apply, plan.workspace)}`,
    `  record test: ${displayCommand(commands.record_test, plan.workspace)}`,
  );
  if (commands.sync_branch_patch_plan) {
    lines.push(`  branch patch plan: ${displayCommand(commands.sync_branch_patch_plan, plan.workspace)}`);
  }
  return lines.join('\n');
}

function remoteLoopCommandsForRun(config, track, feat, run, env, sync) {
  const cli = cliPath();
  const scope = commandScopeParts(track, feat);
  return {
    status: commandLine([
      'node', JSON.stringify(cli), 'remote-loop status',
      '--root', JSON.stringify(config.root),
      ...scope,
      '--run', JSON.stringify(run),
    ]),
    doctor: commandLine([
      'node', JSON.stringify(cli), 'remote-loop doctor',
      '--root', JSON.stringify(config.root),
      ...scope,
      '--run', JSON.stringify(run),
    ]),
    refresh_plan: commandLine([
      'node', JSON.stringify(cli), 'remote-loop refresh',
      '--root', JSON.stringify(config.root),
      ...scope,
      '--run', JSON.stringify(run),
    ]),
    sync_plan: commandLine([
      'node', JSON.stringify(cli), 'remote-loop sync',
      '--root', JSON.stringify(config.root),
      ...scope,
      '--run', JSON.stringify(run),
    ]),
    sync_apply: commandLine([
      'node', JSON.stringify(cli), 'remote-loop sync',
      '--root', JSON.stringify(config.root),
      ...scope,
      '--run', JSON.stringify(run),
      '--yes',
    ]),
    sync_branch_patch_plan: commandLine([
      'node', JSON.stringify(cli), 'remote-loop sync',
      '--root', JSON.stringify(config.root),
      ...scope,
      '--run', JSON.stringify(run),
      '--branch-patch',
    ]),
    record_test: commandLine([
      'node', JSON.stringify(cli), 'remote-loop record-test',
      '--root', JSON.stringify(config.root),
      ...scope,
      '--run', JSON.stringify(run),
      '--remote-pytest-log', '/remote/path/pytest.log',
      '--command', JSON.stringify('python -m pytest ...'),
    ]),
  };
}

function renderRemoteLoopStartText(result) {
  const commands = remoteLoopCommandsForRun(
    { root: result.workspace },
    result.track || result.workspace_set,
    result.feat || null,
    result.run_id,
    result.profiles ? result.profiles.env : null,
    result.profiles ? result.profiles.sync : null,
  );
  return [
    'Remote Loop Started',
    `Workspace: ${shortPath(result.workspace)}`,
    `Track: ${result.workspace_set || '-'}`,
    result.feat ? `Feature: ${result.feat}` : null,
    `Run: ${result.run_id}`,
    `Env: ${result.profiles && result.profiles.env ? result.profiles.env : '-'}`,
    `Sync: ${result.profiles && result.profiles.sync ? result.profiles.sync : '-'}`,
    `Run dir: ${shortPath(result.run_dir)}`,
    '',
    'Next:',
    `  status: ${displayCommand(commands.status, result.workspace)}`,
    `  doctor: ${displayCommand(commands.doctor, result.workspace)}`,
    `  sync plan: ${displayCommand(commands.sync_plan, result.workspace)}`,
    `  sync apply: ${displayCommand(commands.sync_apply, result.workspace)}`,
    '  test: run the relevant remote pytest manually',
    `  record test: ${displayCommand(commands.record_test, result.workspace)}`,
    `  branch patch plan: ${displayCommand(commands.sync_branch_patch_plan, result.workspace)}`,
  ].filter(Boolean).join('\n');
}

function startRemoteLoop(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const { track, feat, env, sync } = activeProfiles(config, options);
  return snapshotSession({
    root: config.root,
    set: track,
    feat,
    syncProfile: sync,
    envProfile: env,
    includeBuild: options.includeBuild === true,
    includeDeploy: options.includeDeploy === true,
    id: options.id || null,
    writeReadme: true,
    note: options.note || `remote-loop ${feat ? `${track}/${feat}` : track}`,
    action: 'remote_loop_start',
  });
}

function doctorRemoteLoop(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const { track, feat, env } = activeProfiles(config, options);
  const run = resolveWritableRun(config, track, feat, options.run || null, 'remote-loop doctor');
  return doctorProfile(config, env, {
    remote: true,
    run,
    set: track,
    feat,
  });
}

function refreshRemoteLoop(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const { track, feat, env } = activeProfiles(config, options);
  const execute = options.yes === true;
  const run = execute
    ? resolveWritableRun(config, track, feat, options.run || null, 'remote-loop refresh --yes')
    : (options.run || null);
  return refreshEnvProfile(config, env, {
    yes: execute,
    run,
    set: track,
    feat,
    timeoutMs: options.timeoutMs || null,
  });
}

function syncRemoteLoop(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const { track, feat, sync } = activeProfiles(config, options);
  const execute = options.yes === true;
  const patchMode = resolvePatchMode(options);
  const run = execute
    ? resolveWritableRun(config, track, feat, options.run || null, 'remote-loop sync --yes')
    : (options.run || null);
  if (!execute) {
    return {
      action: 'remote_loop_sync_plan',
      execute: false,
      plan: buildSyncPlan({
        root: config.root,
        set: track,
        feat,
        profile: sync,
        includeAssets: options.includeAssets === true,
        patchMode,
      }),
      patch_mode: patchMode,
      next_action: patchMode === 'dirty-only'
        ? 'Pass --yes to sync only dirty/staged/untracked files and record the result to the run. Use --branch-patch to sync the full branch patch.'
        : 'Pass --yes to sync the full branch patch and record the result to the run.',
    };
  }
  return applySyncPlan({
    root: config.root,
    set: track,
    feat,
    profile: sync,
    yes: true,
    includeAssets: options.includeAssets === true,
    patchMode,
    continueOnError: options.continueOnError === true,
    run,
    set: track,
  });
}

function recordRemoteLoopTest(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const { track, feat, env } = activeProfiles(config, options);
  const run = resolveWritableRun(config, track, feat, options.run || null, 'remote-loop record-test');
  if (!options.pytestLog && !options.remotePytestLog) {
    error('remote-loop record-test requires --pytest-log <path> or --remote-pytest-log <remote-path>.');
  }
  return recordSessionEvent({
    root: config.root,
    run,
    command: options.command || null,
    pytestLog: options.pytestLog || null,
    remotePytestLog: options.remotePytestLog || null,
    profile: options.profile || env,
    set: track,
    feat,
    allowCrossTrack: options.allowCrossTrack === true,
    allowStaleHead: options.allowStaleHead === true,
  });
}

function statusRemoteLoop(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const { track, feat } = activeProfiles(config, options);
  const run = options.run || resolveLatestOpenRun(config, track, feat, null, 'remote-loop status');
  return sessionStatus({
    root: config.root,
    run,
  });
}

function handleRemoteLoop(subcommand, args) {
  const parsed = parseArgs(args || []);
  const common = {
    root: parsed.root || null,
    set: parsed.set || null,
    feat: parsed.feat || null,
    env: parsed.env || null,
    sync: parsed.sync || null,
    run: parsed.run || parsed.id || null,
  };
  if (!subcommand || subcommand === 'plan') {
    const plan = remoteLoopPlan(common);
    if (parsed.text === true) {
      process.stdout.write(renderRemoteLoopPlanText(plan) + '\n');
    } else {
      output(plan);
    }
    return;
  }
  if (subcommand === 'start') {
    const result = startRemoteLoop({
      ...common,
      id: parsed.id || null,
      note: parsed.note || null,
      includeBuild: parsed['include-build'] === true,
      includeDeploy: parsed['include-deploy'] === true,
    });
    if (parsed.text === true) {
      process.stdout.write(renderRemoteLoopStartText(result) + '\n');
    } else {
      output(result);
    }
    return;
  }
  if (subcommand === 'doctor') {
    output(doctorRemoteLoop(common));
    return;
  }
  if (subcommand === 'refresh') {
    output(refreshRemoteLoop({
      ...common,
      yes: parsed.yes === true,
      timeoutMs: parsed['timeout-ms'] ? Number(parsed['timeout-ms']) : null,
    }));
    return;
  }
  if (subcommand === 'sync') {
    output(syncRemoteLoop({
      ...common,
      yes: parsed.yes === true,
      includeAssets: parsed['include-assets'] === true || parsed.assets === true,
      patchMode: parsed['dirty-only'] === true
        ? 'dirty-only'
        : (parsed['patch-mode'] || null),
      branchPatch: parsed['branch-patch'] === true,
      continueOnError: parsed['continue-on-error'] === true,
    }));
    return;
  }
  if (subcommand === 'record-test') {
    output(recordRemoteLoopTest({
      ...common,
      profile: parsed.profile || null,
      pytestLog: parsed['pytest-log'] || parsed['from-pytest-log'] || null,
      remotePytestLog: parsed['remote-pytest-log'] || null,
      command: parsed.command || null,
      allowCrossTrack: parsed['allow-cross-track'] === true,
      allowStaleHead: parsed['allow-stale-head'] === true,
    }));
    return;
  }
  if (subcommand === 'status') {
    const status = statusRemoteLoop(common);
    if (parsed.json === true) {
      output(status);
    } else {
      process.stdout.write(renderSessionStatusText(status) + '\n');
    }
    return;
  }
  error(`Unknown remote-loop subcommand: '${subcommand}'. Use: plan, start, doctor, refresh, sync, record-test, status`);
}

module.exports = {
  doctorRemoteLoop,
  handleRemoteLoop,
  recordRemoteLoopTest,
  renderRemoteLoopPlanText,
  renderRemoteLoopStartText,
  refreshRemoteLoop,
  remoteLoopPlan,
  startRemoteLoop,
  statusRemoteLoop,
  syncRemoteLoop,
};
