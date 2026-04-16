'use strict';

const { output, error, parseArgs, findWorkspaceRoot } = require('./core.cjs');
const { loadConfig, requireFeature } = require('./config.cjs');
const { loadStateMd, updateStateMd } = require('./session.cjs');
const { updatePhase } = require('./state.cjs');
const { writeCheckpoint } = require('./checkpoint.cjs');
const { PIPELINE_STAGES } = require('./stage-constants.cjs');
const { readRunState, getRunPath, collectInvalidExecutionRepos, detectSlotConflicts } = require('./run-state.cjs');

const VALID_PIPELINE_STAGES = new Set(PIPELINE_STAGES);

function resolveWorkspaceRoot(rootArg) {
  const root = rootArg ? findWorkspaceRoot(rootArg) : findWorkspaceRoot();
  if (!root) error('workspace.yaml not found');
  return root;
}

function resolveFeatureName(root, featureArg) {
  const config = loadConfig(root);
  const feature = requireFeature(config, featureArg);
  return { config, featureName: feature.name };
}

function normalizeStages(stageCsv) {
  if (!stageCsv) error('--stages is required');
  const stages = String(stageCsv)
    .split(',')
    .map(stage => stage.trim())
    .filter(Boolean);

  if (stages.length === 0) error('--stages must include at least one stage');
  for (const stage of stages) {
    if (!VALID_PIPELINE_STAGES.has(stage)) {
      error(`Invalid pipeline stage '${stage}'. Valid: ${Array.from(VALID_PIPELINE_STAGES).join(', ')}`);
    }
  }
  return stages.join(',');
}

function writePipelineState(root, featureName, frontmatter) {
  return updateStateMd(root, {
    frontmatter: {
      ...frontmatter,
      last_activity: new Date().toISOString(),
    },
  }, featureName);
}

function normalizeRunStages(runState) {
  if (!runState || !Array.isArray(runState.pipeline_stages)) return '';
  return runState.pipeline_stages
    .map(stage => String(stage || '').trim())
    .filter(Boolean)
    .join(',');
}

/**
 * Check for dev-slot conflicts with other active pipelines.
 *
 * Conflict exemption rules (single path, no hidden overrides):
 *   1. --allow-slot-conflict flag → all conflicts bypassed explicitly
 *   2. slot has sharing_mode: shared AND both features in owner_features → that slot exempt
 *
 * Any non-exempted conflict is a hard error at pipeline init time.
 *
 * @param {string} root
 * @param {string} featureName
 * @param {object} runState
 * @param {object|null} config - Loaded workspace config for exemption lookup
 * @param {boolean} allowConflict - Whether --allow-slot-conflict was passed
 * @returns {Array} All detected conflicts (including exempted ones)
 */
function checkSlotConflicts(root, featureName, runState, config, allowConflict) {
  const conflicts = detectSlotConflicts(root, featureName, runState, config);
  if (conflicts.length === 0) return conflicts;

  const blocking = conflicts.filter(c => !c.exempted);
  if (blocking.length > 0 && !allowConflict) {
    const formatted = blocking
      .map(c => `${c.dev_worktree} (held by '${c.conflicting_feature}')`)
      .join(', ');
    error(
      `Pipeline slot conflict for feature '${featureName}': ${formatted}. ` +
      "Another feature's active pipeline is using the same dev worktree(s). " +
      'Use --allow-slot-conflict to override or wait for the other pipeline to complete.'
    );
  }
  return conflicts;
}

function ensureRunGate(root, featureName, normalizedStages, options) {
  const opts = options || {};
  const runState = readRunState(root, featureName);
  if (!runState) {
    return {
      run_state: null,
      run_path: getRunPath(root, featureName),
      run_id: null,
    };
  }

  const dirtyPolicy = runState.dirty_policy || {};
  if (dirtyPolicy.has_dirty_repos && dirtyPolicy.decision === 'pending') {
    error(
      `RUN.json dirty-worktree gate is unresolved for feature '${featureName}'. ` +
      'Ask user whether to continue or abort, then re-run `run init --restart --dirty-decision ...`.'
    );
  }
  if (dirtyPolicy.has_dirty_repos && dirtyPolicy.decision === 'abort') {
    error(
      `RUN.json marks dirty-worktree decision as abort for feature '${featureName}'. ` +
      'Reset or restart run snapshot before starting pipeline.'
    );
  }

  const invalidExecutionRepos = collectInvalidExecutionRepos(runState);
  if (invalidExecutionRepos.length > 0) {
    const formatted = invalidExecutionRepos
      .map(item => `${item.repo}(${item.reasons.join('|')})`)
      .join(', ');
    error(
      `RUN.json execution identity is invalid for feature '${featureName}': ${formatted}. ` +
      'Fix worktree/repo identity and restart run snapshot before starting pipeline.'
    );
  }

  // Slot conflict gate: must come after identity check so we only flag valid runs.
  checkSlotConflicts(root, featureName, runState, opts.config || null, Boolean(opts.allowSlotConflict));

  const runStages = normalizeRunStages(runState);
  if (runStages && runStages !== normalizedStages) {
    error(
      `Pipeline stages '${normalizedStages}' do not match RUN.json snapshot '${runStages}'. ` +
      'Restart run snapshot if stage selection changed.'
    );
  }

  return {
    run_state: runState,
    run_path: getRunPath(root, featureName),
    run_id: runState.run_id || null,
  };
}

function initPipeline(root, featureName, stages, options) {
  const opts = options || {};
  const normalizedStages = normalizeStages(stages);
  const runGate = ensureRunGate(root, featureName, normalizedStages, opts);
  const state = writePipelineState(root, featureName, {
    pipeline_stages: normalizedStages,
    completed_stages: '',
    pipeline_loop_count: '0',
    run_id: runGate.run_id || '',
  });

  return {
    action: 'init',
    feature: featureName,
    pipeline_stages: normalizedStages,
    completed_stages: '',
    pipeline_loop_count: '0',
    run_path: runGate.run_path,
    run_id: runGate.run_id,
    state,
  };
}

function updateLoopCount(root, featureName, count) {
  if (count == null || count === '') error('--count is required');
  const normalizedCount = String(count);
  if (!/^\d+$/.test(normalizedCount)) {
    error(`Invalid loop count '${count}'. Expected a non-negative integer.`);
  }

  const state = writePipelineState(root, featureName, {
    pipeline_loop_count: normalizedCount,
  });

  return {
    action: 'loop',
    feature: featureName,
    pipeline_loop_count: normalizedCount,
    state,
  };
}

function resetPipeline(root, featureName, options = {}) {
  const frontmatter = {
    completed_stages: '',
    pipeline_loop_count: '0',
    feature_stage: '',
    run_id: '',
  };
  if (options.clearStages) {
    frontmatter.pipeline_stages = '';
  }

  const state = writePipelineState(root, featureName, frontmatter);
  return {
    action: 'reset',
    feature: featureName,
    completed_stages: '',
    pipeline_loop_count: '0',
    feature_stage: '',
    pipeline_stages: options.clearStages ? '' : undefined,
    state,
  };
}

function completePipeline(root, config, featureName, options = {}) {
  const stateMd = loadStateMd(root, featureName);
  const completedStages = options.stages
    ? normalizeStages(options.stages)
    : ((stateMd && stateMd.frontmatter && (stateMd.frontmatter.pipeline_stages || stateMd.frontmatter.completed_stages)) || '');

  if (!completedStages) {
    error('Cannot complete pipeline without known stages. Pass --stages or initialize pipeline_stages first.');
  }

  const state = writePipelineState(root, featureName, {
    completed_stages: completedStages,
    feature_stage: 'completed',
  });
  const phase = updatePhase(config, featureName, 'completed');
  const checkpoint = writeCheckpoint(
    null,
    [
      '--action', options.action || 'team-complete',
      '--summary', options.summary || `Pipeline complete for ${featureName}`,
      '--feature', featureName,
    ],
    { root, silent: true }
  );

  return {
    action: 'complete',
    feature: featureName,
    completed_stages: completedStages,
    feature_stage: 'completed',
    phase,
    state,
    checkpoint,
  };
}

function handlePipelineState(subcommand, args) {
  const parsed = parseArgs(args || []);
  const root = resolveWorkspaceRoot(parsed.root || null);
  const { config, featureName } = resolveFeatureName(root, parsed.feature || null);

  let result;
  switch (subcommand) {
    case 'init':
      result = initPipeline(root, featureName, parsed.stages, {
        config,
        allowSlotConflict: Boolean(parsed['allow-slot-conflict']),
      });
      break;
    case 'loop':
      result = updateLoopCount(root, featureName, parsed.count);
      break;
    case 'reset':
      result = resetPipeline(root, featureName, {
        clearStages: Boolean(parsed['clear-stages']),
      });
      break;
    case 'complete':
      result = completePipeline(root, config, featureName, {
        stages: parsed.stages || null,
        summary: parsed.summary || null,
        action: parsed.action || null,
      });
      break;
    default:
      error(`Unknown pipeline subcommand: '${subcommand}'. Use: init, loop, reset, complete`);
  }

  output(result);
}

module.exports = {
  VALID_PIPELINE_STAGES,
  normalizeStages,
  checkSlotConflicts,
  initPipeline,
  updateLoopCount,
  resetPipeline,
  completePipeline,
  handlePipelineState,
};
