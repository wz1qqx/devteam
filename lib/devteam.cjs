#!/usr/bin/env node
'use strict';

const { error } = require('./core.cjs');

const args = process.argv.slice(2);
const command = args[0];
const subcommand = args[1];
const rest = args.slice(2);
const ERROR_PREFIX = '[devteam] ERROR:';
const USAGE_MESSAGE = 'Usage: node lib/devteam.cjs <command> [subcommand] [args...]\n\nPrimary commands:\n  workspace scaffold|onboard|context      Create .devteam layout and agent onboarding/context\n  track list|status|context|bind|use      Inspect or bind session-local workspace tracks\n  repo list|status|fetch|update-plan      Inspect repo/upstream state and plan local updates\n  presence list|touch|clear               Session presence and soft-lock hints\n  session start|snapshot|record|status|handoff|list|lint|archive-plan|archive|supersede-plan|supersede-stale|close|supersede|reopen\n                                           Optional run artifact creation, evidence, lifecycle, and handoff\n  status [args]                            Workspace harness status overview\n  doctor [agent-onboarding] [args]         Workspace/env/sync and onboarding checks\n  ws status|materialize|publish-plan|publish\n                                           Workspace inventory and publish planning\n  env doctor|list|runtime|refresh [args]   Environment profile checks and runtime exports\n  capability list|show [args]              Capability definitions and compatible environments\n  validate list|plan [args]                Validation capability instance planning\n  sync plan|apply|status [args]            Local-to-remote sync plan\n  remote-loop <subcommand>                 Track-scoped remote validation loop\n  image plan|prepare|record [args]         Image build plan, context preparation, and evidence\n  deploy list|plan|record|verify-record [args]\n                                           k8s deployment instance planning and preprod evidence\n  skill list|status|lint|install [args]    Codex skill discovery, validation, and installation\n  knowledge list|search|lint|capture       Workspace recipes/wiki/skills operations';

try {
  if (!command) {
    error(USAGE_MESSAGE);
  }
  switch (command) {
    case 'workspace': {
      const { handleWorkspaceScaffold } = require('./workspace-scaffold.cjs');
      handleWorkspaceScaffold(subcommand, rest);
      break;
    }
    case 'ws': {
      const { handleWorkspaceInventory } = require('./workspace-inventory.cjs');
      handleWorkspaceInventory(subcommand, rest);
      break;
    }
    case 'env': {
      const { handleEnvProfile } = require('./env-profile.cjs');
      handleEnvProfile(subcommand, rest);
      break;
    }
    case 'capability': {
      const { handleCapability } = require('./capability-registry.cjs');
      handleCapability(subcommand, rest);
      break;
    }
    case 'validate': {
      const { handleValidate } = require('./capability-registry.cjs');
      handleValidate(subcommand, rest);
      break;
    }
    case 'sync': {
      const { handleSyncPlan } = require('./sync-plan.cjs');
      handleSyncPlan(subcommand, rest);
      break;
    }
    case 'track': {
      const { handleTrack } = require('./track-profile.cjs');
      handleTrack(subcommand, rest);
      break;
    }
    case 'repo': {
      const { handleRepo } = require('./repo-manager.cjs');
      handleRepo(subcommand, rest);
      break;
    }
    case 'remote-loop': {
      const { handleRemoteLoop } = require('./remote-loop.cjs');
      handleRemoteLoop(subcommand, rest);
      break;
    }
    case 'doctor': {
      const { handleWorkspaceDoctor } = require('./workspace-doctor.cjs');
      handleWorkspaceDoctor(args.slice(1));
      break;
    }
    case 'status': {
      const { handleHarnessStatus } = require('./harness-status.cjs');
      handleHarnessStatus(args.slice(1));
      break;
    }
    case 'image': {
      const { handleImagePlan } = require('./action-plan.cjs');
      handleImagePlan(subcommand, rest);
      break;
    }
    case 'deploy': {
      const { handleDeployPlan } = require('./action-plan.cjs');
      handleDeployPlan(subcommand, rest);
      break;
    }
    case 'session': {
      const { handleSession } = require('./session-manager.cjs');
      handleSession(subcommand, rest);
      break;
    }
    case 'presence': {
      const { handlePresence } = require('./presence.cjs');
      handlePresence(subcommand, rest);
      break;
    }
    case 'knowledge': {
      const { handleKnowledge } = require('./knowledge-manager.cjs');
      handleKnowledge(subcommand, rest);
      break;
    }
    case 'skill': {
      const { handleSkill } = require('./skill-manager.cjs');
      handleSkill(subcommand, rest);
      break;
    }
    default:
      error(`Unknown command: ${command}`);
  }
} catch (err) {
  const message = err.message;
  process.stderr.write(`${ERROR_PREFIX} ${message}\n`);
  process.exit(1);
}
