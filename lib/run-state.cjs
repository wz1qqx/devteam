'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { randomUUID } = require('crypto');

const { output, error, parseArgs, findWorkspaceRoot, expandHome } = require('./core.cjs');
const { loadConfig, requireFeature, getFeatureRepos, getWorkspaceConfigPath } = require('./config.cjs');
const { PIPELINE_STAGES } = require('./stage-constants.cjs');

const RUN_VERSION = '1.0';
const DIRTY_DECISIONS = new Set(['continue', 'abort']);

function resolveWorkspaceRoot(rootArg) {
  const root = rootArg ? findWorkspaceRoot(rootArg) : findWorkspaceRoot();
  if (!root) error('workspace.yaml not found');
  return root;
}

function getRunPath(root, featureName) {
  return path.join(root, '.dev', 'features', featureName, 'RUN.json');
}

function readRunState(root, featureName) {
  const runPath = getRunPath(root, featureName);
  if (!fs.existsSync(runPath)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(runPath, 'utf8'));
  } catch (e) {
    error(`Failed to parse RUN.json for feature '${featureName}': ${e.message}`);
  }
  return parsed;
}

function writeRunState(root, featureName, runState) {
  const runPath = getRunPath(root, featureName);
  fs.mkdirSync(path.dirname(runPath), { recursive: true });
  fs.writeFileSync(runPath, JSON.stringify(runState, null, 2) + '\n', 'utf8');
  return runPath;
}

function normalizePipelineStages(stageCsv) {
  if (!stageCsv) return [...PIPELINE_STAGES];
  const stages = String(stageCsv)
    .split(',')
    .map(stage => stage.trim())
    .filter(Boolean);
  if (stages.length === 0) {
    error('--stages must include at least one stage when provided');
  }
  for (const stage of stages) {
    if (!PIPELINE_STAGES.includes(stage)) {
      error(`Invalid pipeline stage '${stage}'. Valid: ${PIPELINE_STAGES.join(', ')}`);
    }
  }
  return stages;
}

function runGitCommand(repoPath, gitArgs) {
  try {
    return execFileSync('git', ['-C', repoPath, ...gitArgs], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (_) {
    return null;
  }
}

function summarizeStatus(statusOutput) {
  if (!statusOutput) return [];
  return statusOutput
    .split('\n')
    .map(line => line.trimEnd())
    .filter(Boolean)
    .slice(0, 30);
}

function collectRepoSnapshot(entry) {
  const repoSnapshot = {
    repo: entry.repo,
    base_ref: entry.base_ref || null,
    base_worktree: entry.base_worktree || null,
    dev_worktree: entry.dev_worktree || null,
    start_head: null,
    start_branch: null,
    has_uncommitted: false,
    status_summary: [],
    build_type: entry.build_type || null,
  };

  const devWorktree = entry.dev_worktree;
  if (!devWorktree || !fs.existsSync(devWorktree)) {
    repoSnapshot.status_summary = ['dev_worktree_missing'];
    return repoSnapshot;
  }

  repoSnapshot.start_head = runGitCommand(devWorktree, ['rev-parse', 'HEAD']);
  repoSnapshot.start_branch = runGitCommand(devWorktree, ['rev-parse', '--abbrev-ref', 'HEAD']);

  const status = runGitCommand(devWorktree, ['status', '--porcelain']);
  repoSnapshot.has_uncommitted = Boolean(status && status.trim());
  repoSnapshot.status_summary = summarizeStatus(status);
  return repoSnapshot;
}

function resolveDirtyPolicy(repoSnapshots, dirtyDecision) {
  const dirtyRepos = repoSnapshots
    .filter(repo => repo.has_uncommitted)
    .map(repo => repo.repo);
  const hasDirtyRepos = dirtyRepos.length > 0;

  if (!hasDirtyRepos) {
    return {
      has_dirty_repos: false,
      dirty_repos: [],
      decision: 'clean',
      decided_at: new Date().toISOString(),
      note: 'All targeted dev worktrees are clean at run start.',
    };
  }

  if (!dirtyDecision) {
    return {
      has_dirty_repos: true,
      dirty_repos: dirtyRepos,
      decision: 'pending',
      decided_at: null,
      note: 'Dirty worktrees detected. Orchestrator must ask user whether to continue or abort.',
    };
  }

  if (!DIRTY_DECISIONS.has(dirtyDecision)) {
    error(`Invalid --dirty-decision '${dirtyDecision}'. Valid: continue, abort`);
  }

  return {
    has_dirty_repos: true,
    dirty_repos: dirtyRepos,
    decision: dirtyDecision,
    decided_at: new Date().toISOString(),
    note: dirtyDecision === 'continue'
      ? 'User approved continuing with dirty worktrees.'
      : 'User chose to abort due to dirty worktrees.',
  };
}

function buildRunSnapshot(root, config, featureName, options = {}) {
  const workspace = expandHome(config.workspace) || root;
  const repoEntries = getFeatureRepos(config, featureName);
  const repoSnapshots = repoEntries.map(collectRepoSnapshot);
  const dirtyPolicy = resolveDirtyPolicy(repoSnapshots, options.dirtyDecision || null);
  const pipelineStages = normalizePipelineStages(options.stages || null);

  return {
    version: RUN_VERSION,
    run_id: randomUUID(),
    feature: featureName,
    created_at: new Date().toISOString(),
    pipeline_stages: pipelineStages,
    repos: repoSnapshots,
    dirty_policy: dirtyPolicy,
    start_context: {
      workspace,
      root,
      config_path: getWorkspaceConfigPath(config),
      created_by: 'devteam run init',
    },
  };
}

function evaluateRunGate(runState) {
  const dirtyPolicy = runState && runState.dirty_policy ? runState.dirty_policy : null;
  const hasDirty = Boolean(dirtyPolicy && dirtyPolicy.has_dirty_repos);
  const decision = dirtyPolicy ? dirtyPolicy.decision : 'clean';
  const requiresDirtyDecision = hasDirty && decision === 'pending';
  const readyForPipeline = !hasDirty || decision === 'continue';
  return { requiresDirtyDecision, readyForPipeline };
}

function initRunState(root, featureName, options = {}) {
  const existing = readRunState(root, featureName);
  if (existing && !options.restart) {
    const gate = evaluateRunGate(existing);
    return {
      action: 'reuse',
      feature: featureName,
      run_path: getRunPath(root, featureName),
      run: existing,
      dirty_repos: existing.dirty_policy ? existing.dirty_policy.dirty_repos : [],
      requires_dirty_decision: gate.requiresDirtyDecision,
      ready_for_pipeline: gate.readyForPipeline,
    };
  }

  const config = loadConfig(root);
  requireFeature(config, featureName);
  const runState = buildRunSnapshot(root, config, featureName, options);
  const runPath = writeRunState(root, featureName, runState);
  const gate = evaluateRunGate(runState);

  return {
    action: existing ? 'restart' : 'init',
    feature: featureName,
    run_path: runPath,
    run: runState,
    dirty_repos: runState.dirty_policy.dirty_repos,
    requires_dirty_decision: gate.requiresDirtyDecision,
    ready_for_pipeline: gate.readyForPipeline,
  };
}

function getRunState(root, featureName) {
  const runState = readRunState(root, featureName);
  if (!runState) {
    return {
      feature: featureName,
      run_path: getRunPath(root, featureName),
      exists: false,
      run: null,
    };
  }
  const gate = evaluateRunGate(runState);
  return {
    feature: featureName,
    run_path: getRunPath(root, featureName),
    exists: true,
    run: runState,
    dirty_repos: runState.dirty_policy ? runState.dirty_policy.dirty_repos : [],
    requires_dirty_decision: gate.requiresDirtyDecision,
    ready_for_pipeline: gate.readyForPipeline,
  };
}

function resetRunState(root, featureName) {
  const runPath = getRunPath(root, featureName);
  const existed = fs.existsSync(runPath);
  if (existed) fs.unlinkSync(runPath);
  return {
    action: 'reset',
    feature: featureName,
    run_path: runPath,
    removed: existed,
  };
}

function reposMapFromRun(runState) {
  const result = {};
  if (!runState || !Array.isArray(runState.repos)) return result;
  for (const repo of runState.repos) {
    if (!repo || !repo.repo) continue;
    result[repo.repo] = {
      base_ref: repo.base_ref || null,
      base_worktree: repo.base_worktree || null,
      dev_worktree: repo.dev_worktree || null,
      start_head: repo.start_head || null,
      start_branch: repo.start_branch || null,
      has_uncommitted: Boolean(repo.has_uncommitted),
      status_summary: Array.isArray(repo.status_summary) ? repo.status_summary : [],
      build_type: repo.build_type || null,
    };
  }
  return result;
}

function resolveFeatureName(root, featureArg) {
  const config = loadConfig(root);
  const feature = requireFeature(config, featureArg || null);
  return feature.name;
}

function handleRunState(subcommand, args) {
  const parsed = parseArgs(args || []);
  const root = resolveWorkspaceRoot(parsed.root || null);
  const featureName = resolveFeatureName(root, parsed.feature || null);

  let result;
  switch (subcommand) {
    case 'init':
      result = initRunState(root, featureName, {
        restart: Boolean(parsed.restart),
        stages: parsed.stages || null,
        dirtyDecision: parsed['dirty-decision'] || null,
      });
      break;
    case 'get':
      result = getRunState(root, featureName);
      break;
    case 'reset':
      result = resetRunState(root, featureName);
      break;
    default:
      error(`Unknown run subcommand: '${subcommand}'. Use: init, get, reset`);
  }

  output(result);
}

module.exports = {
  RUN_VERSION,
  DIRTY_DECISIONS,
  getRunPath,
  readRunState,
  writeRunState,
  normalizePipelineStages,
  collectRepoSnapshot,
  resolveDirtyPolicy,
  buildRunSnapshot,
  initRunState,
  getRunState,
  resetRunState,
  reposMapFromRun,
  handleRunState,
};
