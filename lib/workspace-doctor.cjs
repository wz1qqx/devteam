'use strict';

const path = require('path');

const { output, parseArgs } = require('./core.cjs');
const { loadWorkspaceConfig } = require('./workspace-config.cjs');
const { doctorProfile } = require('./env-profile.cjs');
const { getWorkspaceStatus } = require('./workspace-inventory.cjs');
const { buildSyncPlan } = require('./sync-plan.cjs');
const { sessionLint } = require('./session-manager.cjs');
const { agentOnboardingDoctor, renderAgentOnboardingDoctorText } = require('./workspace-onboarding.cjs');
const { inferTrackProfile, resolveTrackSelection } = require('./track-resolver.cjs');

function explicitShared(value) {
  return value === true || value === 'true' || value === 'yes' || value === 'shared';
}

function duplicateRemoteBindings(config) {
  const problems = [];
  const byRemotePath = new Map();
  for (const worktree of Object.values(config.worktrees || {})) {
    const remotePath = worktree.sync && worktree.sync.remote_path ? worktree.sync.remote_path : null;
    if (!remotePath) continue;
    if (!byRemotePath.has(remotePath)) byRemotePath.set(remotePath, []);
    byRemotePath.get(remotePath).push(worktree.id);
  }
  for (const [remotePath, ids] of byRemotePath.entries()) {
    if (ids.length > 1) {
      problems.push({
        kind: 'shared_remote_source',
        path: remotePath,
        owners: ids,
        message: `remote source '${remotePath}' is shared by worktrees: ${ids.join(', ')}`,
      });
    }
  }

  const bySourceDir = new Map();
  const byVenv = new Map();
  for (const [name, profile] of Object.entries(config.env_profiles || {})) {
    if (profile.type !== 'remote_dev') continue;
    if (explicitShared(profile.shared) || explicitShared(profile.shared_venv) || explicitShared(profile.shared_source)) continue;
    if (profile.source_dir) {
      if (!bySourceDir.has(profile.source_dir)) bySourceDir.set(profile.source_dir, []);
      bySourceDir.get(profile.source_dir).push(name);
    }
    if (profile.venv) {
      if (!byVenv.has(profile.venv)) byVenv.set(profile.venv, []);
      byVenv.get(profile.venv).push(name);
    }
  }
  for (const [sourceDir, profiles] of bySourceDir.entries()) {
    if (profiles.length > 1) {
      problems.push({
        kind: 'shared_env_source_dir',
        path: sourceDir,
        owners: profiles,
        message: `remote source_dir '${sourceDir}' is shared by env profiles: ${profiles.join(', ')}`,
      });
    }
  }
  for (const [venv, profiles] of byVenv.entries()) {
    if (profiles.length > 1) {
      problems.push({
        kind: 'shared_env_venv',
        path: venv,
        owners: profiles,
        message: `remote venv '${venv}' is shared by env profiles: ${profiles.join(', ')}`,
      });
    }
  }
  return problems;
}

function runWorkspaceDoctor(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const selection = resolveTrackSelection(config, {
    set: options.set || null,
    feat: options.feat || null,
    required: false,
    default: true,
    featDefault: true,
  });
  const trackProfile = selection.track
    ? inferTrackProfile(config, selection.track, {
      activeTrack: selection.track,
      feat: selection.feat || null,
    })
    : null;
  const envProfile = options.profile ||
    (trackProfile ? trackProfile.env : null) ||
    config.defaults.env ||
    null;
  const syncProfile = options.profile ||
    (trackProfile ? trackProfile.sync : null) ||
    config.defaults.sync ||
    config.defaults.env ||
    null;
  const historyScoped = Boolean(options.set || options.feat);
  const workspaceStatus = getWorkspaceStatus({
    root: config.root,
    set: selection.track || null,
    feat: selection.feat || null,
  });
  const env = doctorProfile(config, envProfile);
  const sync = buildSyncPlan({
    root: config.root,
    profile: syncProfile,
    set: selection.track || null,
    feat: selection.feat || null,
  });
  const history = sessionLint({
    root: config.root,
    set: historyScoped ? selection.track || null : null,
    feat: historyScoped ? selection.feat || null : null,
  });

  const problems = [];
  const bindingProblems = duplicateRemoteBindings(config);
  if (workspaceStatus.totals.missing > 0) {
    problems.push(`${workspaceStatus.totals.missing} worktree(s) are missing locally`);
  }
  for (const problem of bindingProblems) {
    problems.push(problem.message);
  }
  if (env.status !== 'pass') {
    problems.push(`env profile '${env.profile}' has failed local checks`);
  }
  if (sync.totals.missing > 0) {
    problems.push(`${sync.totals.missing} sync target(s) are not syncable`);
  }
  if (history.totals.errors > 0) {
    problems.push(`${history.totals.errors} invalid run-history issue(s) need archive review`);
  }

  const archivePlanCommand = history.totals.errors > 0
    ? `node ${JSON.stringify(path.join(__dirname, 'devteam.cjs'))} session archive-plan --root ${JSON.stringify(config.root)}${options.set ? ` --set ${JSON.stringify(options.set)}` : ''}${options.feat ? ` --feat ${JSON.stringify(options.feat)}` : ''} --text`
    : null;

  return {
    workspace: config.root,
    status: problems.length === 0 ? 'pass' : 'needs_attention',
    problems,
    workspace_status: workspaceStatus.totals,
    env: {
      profile: env.profile,
      status: env.status,
    },
    sync: sync.totals,
    bindings: {
      status: bindingProblems.length ? 'needs_attention' : 'pass',
      problems: bindingProblems,
    },
    history: {
      status: history.status,
      latest_run_id: history.latest_run_id,
      totals: history.totals,
    },
    next_action: problems.length === 0
      ? 'Fill concrete profiles when ready, then use ws/env/sync/image/deploy/session plans for the local-to-preprod loop.'
      : (archivePlanCommand || 'Fix missing local worktrees/profile fields before running the local-remote loop.'),
  };
}

function handleWorkspaceDoctor(args) {
  const parsed = parseArgs(args || []);
  const subcommand = parsed._ && parsed._[0] ? String(parsed._[0]) : null;
  if (subcommand === 'agent-onboarding' || subcommand === 'onboarding') {
    const result = agentOnboardingDoctor({
      root: parsed.root || null,
      target: parsed.target || null,
    });
    if (parsed.text === true) {
      process.stdout.write(renderAgentOnboardingDoctorText(result) + '\n');
    } else {
      output(result);
    }
    return;
  }
  output(runWorkspaceDoctor({
    root: parsed.root || null,
    profile: parsed.profile || null,
    set: parsed.set || null,
    feat: parsed.feat || null,
  }));
}

module.exports = {
  duplicateRemoteBindings,
  handleWorkspaceDoctor,
  runWorkspaceDoctor,
};
