'use strict';

const path = require('path');

const { output, parseArgs } = require('./core.cjs');
const { loadWorkspaceConfig } = require('./workspace-config.cjs');
const { doctorProfile } = require('./env-profile.cjs');
const { getWorkspaceStatus } = require('./workspace-inventory.cjs');
const { buildSyncPlan } = require('./sync-plan.cjs');
const { sessionLint } = require('./session-manager.cjs');
const { agentOnboardingDoctor, renderAgentOnboardingDoctorText } = require('./workspace-onboarding.cjs');

function runWorkspaceDoctor(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const workspaceStatus = getWorkspaceStatus({
    root: config.root,
    set: options.set || null,
    feat: options.feat || null,
  });
  const env = doctorProfile(config, options.profile || config.defaults.env || null);
  const sync = buildSyncPlan({
    root: config.root,
    profile: options.profile || config.defaults.sync || config.defaults.env || null,
    set: options.set || null,
    feat: options.feat || null,
  });
  const history = sessionLint({
    root: config.root,
    set: options.set || null,
    feat: options.feat || null,
  });

  const problems = [];
  if (workspaceStatus.totals.missing > 0) {
    problems.push(`${workspaceStatus.totals.missing} worktree(s) are missing locally`);
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
  handleWorkspaceDoctor,
  runWorkspaceDoctor,
};
