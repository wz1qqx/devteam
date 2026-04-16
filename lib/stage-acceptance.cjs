'use strict';

const { error, output, parseArgs, findWorkspaceRoot } = require('./core.cjs');
const { loadConfig, requireFeature } = require('./config.cjs');
const { loadStateMd, updateStateMd } = require('./session.cjs');
const { updatePhase } = require('./state.cjs');
const { writeCheckpoint } = require('./checkpoint.cjs');
const { readStageResultInput, parseStageResultMessage, writeStageReport } = require('./stage-result.cjs');

const ACCEPTABLE_VERDICTS = new Set(['PASS', 'PASS_WITH_WARNINGS']);

function parseCsv(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function appendCompletedStage(existing, stage) {
  const stages = parseCsv(existing);
  if (!stages.includes(stage)) stages.push(stage);
  return stages.join(',');
}

function inferCheckpointResult(stageResult, override) {
  if (override) return override;
  return stageResult.verdict === 'PASS_WITH_WARNINGS' ? 'warning' : 'success';
}

function inferCheckpointTag(stageResult, override) {
  if (override) return override;
  const taggedArtifact = (stageResult.artifacts || []).find(artifact => artifact && typeof artifact.tag === 'string' && artifact.tag);
  return taggedArtifact ? taggedArtifact.tag : null;
}

function defaultSummary(featureName, stageResult) {
  return `${stageResult.stage} ${stageResult.verdict} for ${featureName}`;
}

function assertAcceptable(stageResult) {
  if (stageResult.status !== 'completed') {
    error(
      `Stage '${stageResult.stage}' cannot be accepted because status is '${stageResult.status}'. ` +
      `Only completed stage results can be accepted.`
    );
  }
  if (!ACCEPTABLE_VERDICTS.has(stageResult.verdict)) {
    error(
      `Stage '${stageResult.stage}' cannot be accepted because verdict is '${stageResult.verdict}'. ` +
      `Only PASS or PASS_WITH_WARNINGS are acceptable.`
    );
  }
}

function acceptStageResult(root, featureName, parsedMessage, options = {}) {
  const rootDir = root || findWorkspaceRoot();
  if (!rootDir) error('workspace.yaml not found');
  if (!featureName) error('Feature name is required to accept a stage result.');

  const stageResult = parsedMessage.result;
  assertAcceptable(stageResult);

  const reportPath = options.reportPath
    ? writeStageReport(parsedMessage.report, options.reportPath)
    : null;

  const state = loadStateMd(rootDir, featureName);
  const completedStages = appendCompletedStage(
    state && state.frontmatter ? state.frontmatter.completed_stages : '',
    stageResult.stage
  );
  const lastActivity = new Date().toISOString();

  const stateUpdate = updateStateMd(
    rootDir,
    {
      frontmatter: {
        completed_stages: completedStages,
        feature_stage: stageResult.stage,
        last_activity: lastActivity,
      },
    },
    featureName
  );

  let phaseUpdate = null;
  if (options.phase) {
    const config = loadConfig(rootDir);
    phaseUpdate = updatePhase(config, featureName, options.phase);
  }

  const checkpointArgs = [
    '--action', options.action || stageResult.stage,
    '--summary', options.summary || defaultSummary(featureName, stageResult),
    '--feature', featureName,
    '--result', inferCheckpointResult(stageResult, options.result),
  ];
  const tag = inferCheckpointTag(stageResult, options.tag);
  if (tag) checkpointArgs.push('--tag', tag);

  const checkpoint = writeCheckpoint(null, checkpointArgs, { root: rootDir, silent: true });

  return {
    accepted: true,
    feature: featureName,
    stage: stageResult.stage,
    verdict: stageResult.verdict,
    completed_stages: completedStages,
    report_path: reportPath,
    state: stateUpdate,
    phase: phaseUpdate,
    checkpoint,
    result: stageResult,
  };
}

function handleStageAcceptance(args) {
  const parsedArgs = parseArgs(args);
  const rootDir = parsedArgs.root
    ? findWorkspaceRoot(parsedArgs.root)
    : findWorkspaceRoot();
  if (!rootDir) error('workspace.yaml not found');

  const config = loadConfig(rootDir);
  const feature = requireFeature(config, parsedArgs.feature || null);

  const inputPath = parsedArgs._[0] || null;
  const message = readStageResultInput(inputPath);
  const parsedMessage = parseStageResultMessage(message, {
    expectedStage: parsedArgs.stage || null,
  });

  const accepted = acceptStageResult(rootDir, feature.name, parsedMessage, {
    reportPath: parsedArgs['report-path'] || null,
    summary: parsedArgs.summary || null,
    action: parsedArgs.action || null,
    result: parsedArgs.result || null,
    tag: parsedArgs.tag || null,
    phase: parsedArgs.phase || null,
  });

  output({
    report: parsedMessage.report,
    ...accepted,
  });
}

module.exports = {
  ACCEPTABLE_VERDICTS,
  appendCompletedStage,
  acceptStageResult,
  handleStageAcceptance,
};
