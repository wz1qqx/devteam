#!/usr/bin/env node
// devteam Persistent Mode — Stop hook
// When active, prevents session from ending and re-injects continuation prompt.
//
// Safety valves:
//   - Context limit stops: always allow (can't continue meaningfully)
//   - Max iterations reached: stop and report
//   - User abort signals: always allow
//   - Rate limit errors: always allow
//
// State file: $TMPDIR/devteam-persistent-<ppid>.json

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_FILE = path.join(os.tmpdir(), `devteam-persistent-${process.ppid}.json`);

function readState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function main() {
  // Read hook input from stdin
  let input = '';
  try {
    input = fs.readFileSync('/dev/stdin', 'utf8');
  } catch (_) { /* no stdin */ }

  const state = readState();
  if (!state || !state.active) {
    // No persistent mode active, allow normal stop
    process.exit(0);
  }

  // Safety valves: parse stop reason from environment or input
  const stopReason = process.env.CLAUDE_STOP_REASON || '';
  const safetyStopReasons = ['context_limit', 'user_abort', 'rate_limit', 'auth_error', 'max_tokens'];

  if (safetyStopReasons.includes(stopReason)) {
    // Deactivate and allow stop
    state.active = false;
    state.stopped_reason = stopReason;
    writeState(state);
    process.exit(0);
  }

  // Check max iterations
  state.iteration = (state.iteration || 0) + 1;
  const maxIterations = state.max_iterations || 10;

  if (state.iteration > maxIterations) {
    state.active = false;
    state.stopped_reason = 'max_iterations';
    writeState(state);

    // Output a message to inform the user
    const result = JSON.stringify({
      result: 'stop',
      reason: `Persistent mode reached max iterations (${maxIterations}). Stopping.`,
    });
    process.stdout.write(result);
    process.exit(0);
  }

  // Continue: re-inject the continuation prompt
  writeState(state);

  const continuation = JSON.stringify({
    result: 'block',
    reason: `[persistent ${state.iteration}/${maxIterations}] Continuing: ${state.prompt || 'execute remaining tasks'}`,
  });
  process.stdout.write(continuation);
  process.exit(0);
}

main();
