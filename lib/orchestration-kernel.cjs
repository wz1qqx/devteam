'use strict';

const { output, error, parseArgs, findWorkspaceRoot } = require('./core.cjs');
const { loadConfig, requireFeature } = require('./config.cjs');
const { readStageResultInput, parseStageResultMessage, writeStageReport } = require('./stage-result.cjs');
const { decideStageResult } = require('./stage-decision.cjs');
const { acceptStageResult } = require('./stage-acceptance.cjs');

function parseInteger(value, flag) {
  if (value == null || value === '') return null;
  const normalized = String(value);
  if (!/^\d+$/.test(normalized)) {
    error(`Invalid ${flag} '${value}'. Expected a non-negative integer.`);
  }
  return Number(normalized);
}

function validateReviewCycleOptions(reviewCycle, maxReviewCycles) {
  if (maxReviewCycles != null && maxReviewCycles === 0) {
    error('Invalid --max-review-cycles \'0\'. Expected an integer >= 1.');
  }
  if (
    reviewCycle != null &&
    maxReviewCycles != null &&
    reviewCycle > maxReviewCycles
  ) {
    error(
      `Invalid review loop settings: --review-cycle (${reviewCycle}) cannot exceed --max-review-cycles (${maxReviewCycles}).`
    );
  }
}

function resolveRootAndFeature(parsedArgs) {
  const root = parsedArgs.root
    ? findWorkspaceRoot(parsedArgs.root)
    : findWorkspaceRoot();
  if (!root) error('workspace.yaml not found');

  const config = loadConfig(root);
  const feature = requireFeature(config, parsedArgs.feature || null);

  return { root, featureName: feature.name };
}

function resolveStage(root, featureName, message, options = {}) {
  const parsedMessage = parseStageResultMessage(message, {
    expectedStage: options.expectedStage || null,
  });
  const reportPath = options.reportPath
    ? writeStageReport(parsedMessage.report, options.reportPath)
    : null;

  const decision = decideStageResult(parsedMessage.result, {
    reviewCycle: options.reviewCycle == null ? 0 : options.reviewCycle,
    maxReviewCycles: options.maxReviewCycles == null ? 2 : options.maxReviewCycles,
    optimizationEnabled: options.optimizationEnabled !== false,
  });

  let acceptance = null;
  if (decision.should_accept) {
    acceptance = acceptStageResult(root, featureName, parsedMessage, {
      reportPath: reportPath || options.reportPath || null,
      summary: options.summary || null,
      action: options.action || null,
      result: options.result || null,
      tag: options.tag || null,
      phase: options.phase || null,
    });
  }

  return {
    feature: featureName,
    report: parsedMessage.report,
    report_path: reportPath,
    result: parsedMessage.result,
    decision,
    acceptance,
  };
}

function handleOrchestration(subcommand, args) {
  if (subcommand !== 'resolve-stage') {
    error(`Unknown orchestration subcommand: '${subcommand}'. Use: resolve-stage`);
  }

  const parsedArgs = parseArgs(args || []);
  const { root, featureName } = resolveRootAndFeature(parsedArgs);
  const inputPath = parsedArgs._[0] || null;
  const message = readStageResultInput(inputPath);
  const reviewCycle = parseInteger(parsedArgs['review-cycle'], '--review-cycle');
  const maxReviewCycles = parseInteger(parsedArgs['max-review-cycles'], '--max-review-cycles');
  validateReviewCycleOptions(reviewCycle, maxReviewCycles);

  const resolved = resolveStage(root, featureName, message, {
    expectedStage: parsedArgs.stage || null,
    reportPath: parsedArgs['report-path'] || null,
    reviewCycle,
    maxReviewCycles,
    optimizationEnabled: parsedArgs['disable-optimization-loop'] ? false : true,
    summary: parsedArgs.summary || null,
    action: parsedArgs.action || null,
    result: parsedArgs.result || null,
    tag: parsedArgs.tag || null,
    phase: parsedArgs.phase || null,
  });

  output(resolved);
}

module.exports = {
  validateReviewCycleOptions,
  resolveStage,
  handleOrchestration,
};
