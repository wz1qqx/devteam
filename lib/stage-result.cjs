'use strict';

const fs = require('fs');
const path = require('path');
const { output, error, parseArgs } = require('./core.cjs');
const { STAGE_RESULT_STAGES } = require('./stage-constants.cjs');

const REQUIRED_KEYS = ['stage', 'status', 'verdict', 'artifacts', 'next_action', 'retryable', 'metrics'];
const VALID_STAGES = new Set(STAGE_RESULT_STAGES);
const VALID_STATUSES = new Set(['completed', 'failed', 'needs_input']);
const VALID_VERDICTS = new Set(['PASS', 'PASS_WITH_WARNINGS', 'FAIL', 'NEEDS_INPUT']);

function readStageResultInput(inputPath) {
  if (inputPath && inputPath !== '-') {
    return fs.readFileSync(inputPath, 'utf8');
  }

  let content = '';
  try {
    content = fs.readFileSync(0, 'utf8');
  } catch (_) {
    content = '';
  }

  if (!content.trim()) {
    error('No stage-result input provided. Pass a file path or pipe the agent message on stdin.');
  }
  return content;
}

function extractStageResultSections(message) {
  if (typeof message !== 'string' || !message.trim()) {
    error('Stage-result message is empty.');
  }

  const marker = /^## STAGE_RESULT\s*$/m;
  const markerMatch = marker.exec(message);
  if (!markerMatch) {
    error('STAGE_RESULT heading not found.');
  }

  const report = message.slice(0, markerMatch.index).trimEnd();
  const trailing = message.slice(markerMatch.index + markerMatch[0].length);
  const jsonFence = /^\s*```json\s*\n([\s\S]*?)\n```\s*$/;
  const fenceMatch = trailing.match(jsonFence);

  if (!fenceMatch) {
    error('STAGE_RESULT JSON block must be the final content in the message.');
  }

  return {
    report,
    jsonText: fenceMatch[1],
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateStageResult(result, expectedStage) {
  if (!isPlainObject(result)) {
    error('STAGE_RESULT must be a JSON object.');
  }

  for (const key of REQUIRED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(result, key)) {
      error(`STAGE_RESULT missing required key '${key}'.`);
    }
  }

  if (typeof result.stage !== 'string' || !result.stage.trim()) {
    error('STAGE_RESULT.stage must be a non-empty string.');
  }
  if (!VALID_STAGES.has(result.stage)) {
    error(`Invalid STAGE_RESULT.stage '${result.stage}'. Valid: ${Array.from(VALID_STAGES).join(', ')}`);
  }
  if (expectedStage && result.stage !== expectedStage) {
    error(`STAGE_RESULT.stage mismatch: expected '${expectedStage}', got '${result.stage}'.`);
  }

  if (!VALID_STATUSES.has(result.status)) {
    error(`Invalid STAGE_RESULT.status '${result.status}'. Valid: ${Array.from(VALID_STATUSES).join(', ')}`);
  }
  if (!VALID_VERDICTS.has(result.verdict)) {
    error(`Invalid STAGE_RESULT.verdict '${result.verdict}'. Valid: ${Array.from(VALID_VERDICTS).join(', ')}`);
  }

  if (!Array.isArray(result.artifacts)) {
    error('STAGE_RESULT.artifacts must be an array.');
  }
  if (typeof result.next_action !== 'string' || !result.next_action.trim()) {
    error('STAGE_RESULT.next_action must be a non-empty string.');
  }
  if (typeof result.retryable !== 'boolean') {
    error('STAGE_RESULT.retryable must be a boolean.');
  }
  if (!isPlainObject(result.metrics)) {
    error('STAGE_RESULT.metrics must be a JSON object.');
  }

  if (Object.prototype.hasOwnProperty.call(result, 'remediation_items') && !Array.isArray(result.remediation_items)) {
    error('STAGE_RESULT.remediation_items must be an array when present.');
  }
  if (Object.prototype.hasOwnProperty.call(result, 'blocking_reason') && typeof result.blocking_reason !== 'string') {
    error('STAGE_RESULT.blocking_reason must be a string when present.');
  }

  return result;
}

function parseStageResultMessage(message, options = {}) {
  const { expectedStage = null } = options;
  const { report, jsonText } = extractStageResultSections(message);

  let result;
  try {
    result = JSON.parse(jsonText);
  } catch (err) {
    error(`Invalid STAGE_RESULT JSON: ${err.message}`);
  }

  return {
    report,
    result: validateStageResult(result, expectedStage),
    json: jsonText,
  };
}

function writeStageReport(report, reportPath) {
  if (!reportPath) return null;
  const absolutePath = path.resolve(reportPath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, report, 'utf8');
  return absolutePath;
}

function handleStageResult(subcommand, args) {
  if (subcommand === 'accept') {
    const { handleStageAcceptance } = require('./stage-acceptance.cjs');
    handleStageAcceptance(args);
    return;
  }

  if (subcommand === 'decide') {
    const { handleStageDecision } = require('./stage-decision.cjs');
    handleStageDecision(args);
    return;
  }

  if (subcommand !== 'parse') {
    error(`Unknown stage-result subcommand: '${subcommand}'. Use: parse, accept, decide`);
  }

  const parsedArgs = parseArgs(args);
  const inputPath = parsedArgs._[0] || null;
  const message = readStageResultInput(inputPath);
  const parsed = parseStageResultMessage(message, {
    expectedStage: parsedArgs.stage || null,
  });

  const reportPath = writeStageReport(parsed.report, parsedArgs['report-path'] || null);
  output({
    report: parsed.report,
    report_path: reportPath,
    result: parsed.result,
  });
}

module.exports = {
  VALID_STAGES,
  readStageResultInput,
  extractStageResultSections,
  parseStageResultMessage,
  validateStageResult,
  writeStageReport,
  handleStageResult,
};
