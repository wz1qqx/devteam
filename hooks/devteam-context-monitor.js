#!/usr/bin/env node
// devteam Context Monitor — PostToolUse hook
// Monitors context window usage and injects warnings when running low.
//
// Thresholds:
//   WARNING  (remaining <= 35%): Wrap up current task, consider pausing
//   CRITICAL (remaining <= 25%): Stop immediately, run /devteam:pause
//
// Debounce: 5 tool uses between warnings to avoid spam
// Severity escalation (WARNING→CRITICAL) bypasses debounce

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const WARNING_THRESHOLD = 35;
const CRITICAL_THRESHOLD = 25;
const DEBOUNCE_CALLS = 5;

let input = '';
const stdinTimeout = setTimeout(() => process.exit(0), 5000);

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = JSON.parse(input);
    const sessionId = data.session_id;
    if (!sessionId) process.exit(0);

    const remaining = data.context_window?.remaining_percentage;
    if (remaining == null) process.exit(0);

    // Normalize: subtract autocompact buffer (~16.5%)
    const BUFFER = 16.5;
    const usableRemaining = Math.max(0, ((remaining - BUFFER) / (100 - BUFFER)) * 100);
    const usedPct = Math.round(100 - usableRemaining);

    // Track state in temp file for debounce
    const statePath = path.join(os.tmpdir(), `devteam-ctx-${sessionId}.json`);
    let state = { callsSinceWarning: 0, lastSeverity: 'none' };
    try {
      if (fs.existsSync(statePath)) {
        state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      }
    } catch (e) { /* ignore */ }

    state.callsSinceWarning++;

    // Determine severity
    let severity = 'none';
    if (usableRemaining <= CRITICAL_THRESHOLD) severity = 'critical';
    else if (usableRemaining <= WARNING_THRESHOLD) severity = 'warning';

    // Check debounce (escalation bypasses)
    const isEscalation = severity === 'critical' && state.lastSeverity !== 'critical';
    const debounced = state.callsSinceWarning < DEBOUNCE_CALLS && !isEscalation;

    if (severity !== 'none' && !debounced) {
      state.callsSinceWarning = 0;
      state.lastSeverity = severity;

      const result = { hookSpecificOutput: {} };

      if (severity === 'critical') {
        result.hookSpecificOutput.additionalContext =
          `🚨 CRITICAL: Context window ${usedPct}% used (${Math.round(usableRemaining)}% remaining). ` +
          `Quality WILL degrade. Run /devteam:pause to save state, then start a new session with /devteam:resume. ` +
          `Do NOT start complex new tasks.`;
      } else {
        result.hookSpecificOutput.additionalContext =
          `⚠️ WARNING: Context window ${usedPct}% used (${Math.round(usableRemaining)}% remaining). ` +
          `Consider wrapping up the current task. If more work is needed, run /devteam:pause then resume in a new session.`;
      }

      process.stdout.write(JSON.stringify(result));
    }

    // Save state
    try {
      fs.writeFileSync(statePath, JSON.stringify(state));
    } catch (e) { /* ignore */ }

  } catch (e) {
    // Silent fail — never break the tool pipeline
  }
  process.exit(0);
});
