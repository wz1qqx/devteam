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
  if (!repoSnapshot.start_head) {
    repoSnapshot.status_summary = ['not_git_worktree', 'start_head_missing'];
    return repoSnapshot;
  }
  if (!repoSnapshot.start_branch) {
    repoSnapshot.status_summary = ['start_branch_missing'];
  }

  const status = runGitCommand(devWorktree, ['status', '--porcelain']);
  repoSnapshot.has_uncommitted = Boolean(status && status.trim());
  const statusSummary = summarizeStatus(status);
  repoSnapshot.status_summary = [
    ...repoSnapshot.status_summary,
    ...statusSummary,
  ];
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
  const invalidExecutionRepos = collectInvalidExecutionRepos(runState);
  const requiresExecutionIdentityFix = invalidExecutionRepos.length > 0;
  const readyForPipeline = !requiresExecutionIdentityFix && (!hasDirty || decision === 'continue');
  return {
    requiresDirtyDecision,
    requiresExecutionIdentityFix,
    invalidExecutionRepos,
    readyForPipeline,
  };
}

function collectInvalidExecutionRepos(runState) {
  if (!runState || !Array.isArray(runState.repos)) return [];

  const invalid = [];
  for (const repo of runState.repos) {
    if (!repo || !repo.repo) continue;

    const statusSummary = Array.isArray(repo.status_summary) ? repo.status_summary : [];
    const reasonSet = new Set();

    if (!repo.dev_worktree) reasonSet.add('dev_worktree_missing');
    if (statusSummary.includes('dev_worktree_missing')) reasonSet.add('dev_worktree_missing');
    if (statusSummary.includes('not_git_worktree')) reasonSet.add('not_git_worktree');
    if (!repo.start_head) reasonSet.add('start_head_missing');
    if (!repo.start_branch) reasonSet.add('start_branch_missing');

    if (reasonSet.size > 0) {
      invalid.push({
        repo: repo.repo,
        reasons: Array.from(reasonSet),
      });
    }
  }
  return invalid;
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
      requires_execution_identity_fix: gate.requiresExecutionIdentityFix,
      invalid_execution_repos: gate.invalidExecutionRepos,
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
    requires_execution_identity_fix: gate.requiresExecutionIdentityFix,
    invalid_execution_repos: gate.invalidExecutionRepos,
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
    requires_execution_identity_fix: gate.requiresExecutionIdentityFix,
    invalid_execution_repos: gate.invalidExecutionRepos,
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

// ---------------------------------------------------------------------------
// Active-run detection and slot conflict helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a filesystem path: resolve symlinks if the path exists,
 * otherwise do a plain path.resolve. Prevents prefix-bypass attacks
 * like /a/bad vs /a/b by resolving the canonical form.
 */
function normalizeFsPath(p) {
  if (!p) return '';
  const absolute = path.resolve(p);
  try {
    return fs.realpathSync(absolute);
  } catch (_) {
    // Path may not exist yet (e.g. planned file writes). Resolve the nearest
    // existing ancestor to canonical form, then append missing segments.
    const missing = [];
    let cursor = absolute;
    while (!fs.existsSync(cursor)) {
      missing.unshift(path.basename(cursor));
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }

    let resolvedBase = cursor;
    try {
      resolvedBase = fs.realpathSync(cursor);
    } catch (_) {
      resolvedBase = cursor;
    }
    return path.resolve(resolvedBase, ...missing);
  }
}

/**
 * Collect all features that have an active (non-completed) pipeline run,
 * excluding the given current feature.
 *
 * "Active" is defined as: RUN.json exists AND STATE.md does not have
 * feature_stage == completed.
 *
 * @param {string} root - Workspace root
 * @param {string} currentFeatureName - Feature to exclude from the scan
 * @returns {Array<{feature: string, run: object}>}
 */
function collectActiveRuns(root, currentFeatureName) {
  const featuresDir = path.join(root, '.dev', 'features');
  if (!fs.existsSync(featuresDir)) return [];

  // Lazy-require to avoid potential circular-dependency issues at module load.
  const { loadStateMd } = require('./session.cjs');

  const active = [];
  let entries;
  try {
    entries = fs.readdirSync(featuresDir);
  } catch (_) {
    return [];
  }

  for (const name of entries) {
    if (name === currentFeatureName) continue;
    const fDir = path.join(featuresDir, name);
    try {
      if (!fs.statSync(fDir).isDirectory()) continue;
    } catch (_) {
      continue;
    }

    const runPath = path.join(fDir, 'RUN.json');
    if (!fs.existsSync(runPath)) continue;

    let runState;
    try {
      runState = JSON.parse(fs.readFileSync(runPath, 'utf8'));
    } catch (_) {
      continue;
    }

    const stateMd = loadStateMd(root, name);
    const featureStage = stateMd && stateMd.frontmatter && stateMd.frontmatter.feature_stage;
    if (featureStage === 'completed') continue;
    const gate = evaluateRunGate(runState);
    if (!gate.readyForPipeline) continue;

    active.push({ feature: name, run: runState });
  }
  return active;
}

/**
 * Check whether a dev worktree is exempt from slot conflict enforcement
 * because the slot has sharing_mode: shared and both features are listed
 * in owner_features.
 *
 * @param {string} root - Workspace root
 * @param {object|null} config - Loaded config (may be null → no exemption possible)
 * @param {string} devWorktreeResolved - Canonically resolved worktree path
 * @param {string} currentFeature
 * @param {string} otherFeature
 * @returns {boolean}
 */
function isSlotSharingExempted(root, config, devWorktreeResolved, currentFeature, otherFeature) {
  if (!config || !config.repos) return false;
  const workspace = expandHome(config.workspace) || root;

  for (const repoConfig of Object.values(config.repos)) {
    const slots = (repoConfig && repoConfig.dev_slots) || {};
    for (const slot of Object.values(slots)) {
      if (!slot || slot.sharing_mode !== 'shared') continue;
      const slotWorktreePath = slot.worktree || null;
      if (!slotWorktreePath) continue;
      const resolved = normalizeFsPath(path.resolve(workspace, slotWorktreePath));
      if (resolved !== devWorktreeResolved) continue;
      const owners = Array.isArray(slot.owner_features) ? slot.owner_features : [];
      if (owners.includes(currentFeature) && owners.includes(otherFeature)) return true;
    }
  }
  return false;
}

/**
 * Detect dev-slot conflicts: active runs by other features that share a
 * dev_worktree with the current feature's run snapshot.
 *
 * Returns an array of conflict objects:
 *   { dev_worktree, conflicting_feature, repo, exempted }
 *
 * @param {string} root
 * @param {string} currentFeatureName
 * @param {object} currentRunState - The current feature's RUN.json content
 * @param {object|null} config - Loaded workspace config (for exemption check)
 * @returns {Array<{dev_worktree:string, conflicting_feature:string, repo:string|null, exempted:boolean}>}
 */
function detectSlotConflicts(root, currentFeatureName, currentRunState, config) {
  if (!currentRunState || !Array.isArray(currentRunState.repos)) return [];

  const currentWorktrees = currentRunState.repos
    .filter(r => r && r.dev_worktree)
    .map(r => normalizeFsPath(r.dev_worktree));

  if (currentWorktrees.length === 0) return [];

  const activeRuns = collectActiveRuns(root, currentFeatureName);
  const conflicts = [];

  for (const { feature: otherFeature, run: otherRun } of activeRuns) {
    if (!otherRun || !Array.isArray(otherRun.repos)) continue;
    for (const repo of otherRun.repos) {
      if (!repo || !repo.dev_worktree) continue;
      const otherWorktree = normalizeFsPath(repo.dev_worktree);
      if (!currentWorktrees.includes(otherWorktree)) continue;
      const exempted = isSlotSharingExempted(
        root, config, otherWorktree, currentFeatureName, otherFeature
      );
      conflicts.push({
        dev_worktree: otherWorktree,
        conflicting_feature: otherFeature,
        repo: repo.repo || null,
        exempted,
      });
    }
  }
  return conflicts;
}

// ---------------------------------------------------------------------------
// Write-scope validation (source_restriction enforcement)
// ---------------------------------------------------------------------------

/**
 * Return the set of resolved dev_worktree paths that are legal write targets
 * for the given run snapshot.
 *
 * @param {object} runState - RUN.json content
 * @returns {string[]} Array of canonical absolute paths
 */
function resolveWriteScope(runState) {
  if (!runState || !Array.isArray(runState.repos)) return [];
  return runState.repos
    .filter(r => r && r.dev_worktree)
    .map(r => r.dev_worktree);
}

/**
 * Check whether a given file path is within the legal write scope of a
 * feature's run snapshot.
 *
 * Uses real-path normalization to prevent prefix-bypass and symlink
 * traversal (e.g. /a/bad would not match /a/b).
 *
 * @param {string} root - Workspace root
 * @param {string} featureName
 * @param {string} pathToCheck - The file or directory path to validate
 * @returns {object} { allowed, matched_repo?, dev_worktree?, path, relative_path?, reason?, write_scope?, detail? }
 */
function checkPath(root, featureName, pathToCheck) {
  const runState = readRunState(root, featureName);
  if (!runState) {
    return {
      allowed: false,
      reason: 'no_run_snapshot',
      path: pathToCheck,
      detail: `RUN.json not found for feature '${featureName}'. Run 'run init' first.`,
    };
  }

  const writeScope = resolveWriteScope(runState);
  if (writeScope.length === 0) {
    return {
      allowed: false,
      reason: 'no_dev_worktrees',
      path: pathToCheck,
      detail: `No dev worktrees recorded in RUN snapshot for feature '${featureName}'.`,
    };
  }

  const normalizedCheck = normalizeFsPath(pathToCheck);

  for (const devWorktree of writeScope) {
    const normalizedWorktree = normalizeFsPath(devWorktree);
    const rel = path.relative(normalizedWorktree, normalizedCheck);
    // Safe if the relative path does not escape the worktree (no leading '..')
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      const matchedRepo = runState.repos.find(r => {
        return normalizeFsPath(r.dev_worktree || '') === normalizedWorktree;
      });
      return {
        allowed: true,
        matched_repo: matchedRepo ? matchedRepo.repo : null,
        dev_worktree: normalizedWorktree,
        path: normalizedCheck,
        relative_path: rel || '.',
      };
    }
  }

  return {
    allowed: false,
    reason: 'outside_write_scope',
    path: normalizedCheck,
    write_scope: writeScope.map(normalizeFsPath),
    detail: `Path is outside all registered dev worktrees for feature '${featureName}'.`,
  };
}

// ---------------------------------------------------------------------------
// CLI handler
// ---------------------------------------------------------------------------

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
    case 'check-path': {
      const pathToCheck = parsed.path || parsed._[0] || null;
      if (!pathToCheck) {
        error('Usage: run check-path --feature <name> --path <file_path>');
      }
      result = checkPath(root, featureName, pathToCheck);
      output(result);
      if (!result.allowed) process.exit(1);
      return;
    }
    default:
      error(`Unknown run subcommand: '${subcommand}'. Use: init, get, reset, check-path`);
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
  collectInvalidExecutionRepos,
  evaluateRunGate,
  normalizeFsPath,
  collectActiveRuns,
  detectSlotConflicts,
  resolveWriteScope,
  checkPath,
  handleRunState,
};
