'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { output, error, parseArgs } = require('./core.cjs');
const { ensureWorkspaceDirs, loadWorkspaceConfig } = require('./workspace-config.cjs');
const {
  resolveTrackSelection,
} = require('./track-resolver.cjs');

const DEFAULT_TTL_SECONDS = 45 * 60;

function nowMs() {
  return Date.now();
}

function nowIso() {
  return new Date().toISOString();
}

function presenceDir(config) {
  return path.join(config.root, '.devteam', 'presence');
}

function safePresenceId(value) {
  return String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120);
}

function envValue(name) {
  const value = process.env[name];
  return value && String(value).trim() ? String(value).trim() : null;
}

function defaultPresenceIdentity() {
  const candidates = [
    ['devteam', envValue('DEVTEAM_SESSION_ID'), false],
    ['codex', envValue('CODEX_THREAD_ID'), true],
    ['codex', envValue('CODEX_SESSION_ID'), true],
    ['claude', envValue('CLAUDE_SESSION_ID'), true],
    ['terminal', envValue('STARSHIP_SESSION_KEY'), true],
    ['terminal', envValue('TERM_SESSION_ID'), true],
    ['tmux', envValue('TMUX_PANE'), true],
  ];
  for (const [source, value, prefix] of candidates) {
    if (!value) continue;
    return {
      source,
      session_id: safePresenceId(prefix ? `${source}-${value}` : value),
    };
  }
  return {
    source: 'process',
    session_id: safePresenceId(`${os.userInfo().username || 'user'}-${os.hostname()}-${process.ppid || process.pid}`),
  };
}

function defaultPresenceId() {
  return defaultPresenceIdentity().session_id;
}

function parseTtlMs(value, fallbackSeconds = DEFAULT_TTL_SECONDS) {
  const parsed = Number.parseInt(String(value || ''), 10);
  const seconds = Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackSeconds;
  return seconds * 1000;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return {
      session_id: path.basename(filePath, '.json'),
      status: 'unreadable',
      error: err.message,
      file: filePath,
    };
  }
}

function listPresenceEntries(config, options = {}) {
  const dir = presenceDir(config);
  const ttlMs = parseTtlMs(options.ttlSeconds, DEFAULT_TTL_SECONDS);
  const currentMs = nowMs();
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  return fs.readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .map(name => {
      const filePath = path.join(dir, name);
      const entry = readJson(filePath);
      const lastSeenMs = Date.parse(String(entry.last_seen_at || entry.started_at || ''));
      const ageMs = Number.isNaN(lastSeenMs) ? null : Math.max(0, currentMs - lastSeenMs);
      const expired = ageMs == null ? true : ageMs > ttlMs;
      return {
        ...entry,
        session_id: entry.session_id || path.basename(name, '.json'),
        file: filePath,
        age_seconds: ageMs == null ? null : Math.round(ageMs / 1000),
        expired,
        active: entry.status !== 'closed' && !expired,
      };
    })
    .sort((a, b) => {
      const aTime = Date.parse(String(a.last_seen_at || a.started_at || ''));
      const bTime = Date.parse(String(b.last_seen_at || b.started_at || ''));
      return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime) ||
        String(a.session_id || '').localeCompare(String(b.session_id || ''));
    });
}

function touchPresence(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const selection = resolveTrackSelection(config, {
    set: options.set || null,
    feat: options.feat || null,
    required: true,
    label: 'presence track',
  });
  const track = selection.track;
  const feat = selection.feat || null;
  ensureWorkspaceDirs(config.root);
  fs.mkdirSync(presenceDir(config), { recursive: true });

  const inferred = defaultPresenceIdentity();
  const sessionId = safePresenceId(options.sessionId || inferred.session_id);
  if (!sessionId) error('presence touch requires a session id.');
  const filePath = path.join(presenceDir(config), `${sessionId}.json`);
  const previous = fs.existsSync(filePath) ? readJson(filePath) : {};
  const startedAt = previous.started_at || nowIso();
  const payload = {
    version: 1,
    session_id: sessionId,
    session_source: options.sessionId ? 'explicit' : inferred.source,
    status: options.status || 'active',
    track,
    feat,
    run_id: options.run || previous.run_id || null,
    purpose: options.purpose || previous.purpose || null,
    cwd: options.cwd || process.cwd(),
    host: os.hostname(),
    pid: process.pid,
    started_at: startedAt,
    last_seen_at: nowIso(),
    tool: options.tool || 'devteam',
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return {
    action: 'presence_touch',
    workspace: config.root,
    track,
    feat,
    session_id: sessionId,
    path: filePath,
    presence: payload,
  };
}

function listPresence(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const selection = options.set || options.feat
    ? resolveTrackSelection(config, {
      set: options.set || null,
      feat: options.feat || null,
      required: Boolean(options.feat),
      default: false,
      label: 'presence list',
    })
    : { track: null, feat: null };
  const track = selection.track || null;
  const feat = selection.feat || null;
  const includeExpired = options.all === true;
  const entries = listPresenceEntries(config, {
    ttlSeconds: options.ttlSeconds || null,
  }).filter(entry => {
    if (!includeExpired && !entry.active) return false;
    if (track && entry.track !== track) return false;
    if (feat && entry.feat !== feat) return false;
    return true;
  });
  const byTrack = {};
  for (const entry of entries) {
    const key = entry.feat ? `${entry.track || '(none)'}/${entry.feat}` : (entry.track || '(none)');
    if (!byTrack[key]) byTrack[key] = [];
    byTrack[key].push(entry);
  }
  return {
    action: 'presence_list',
    workspace: config.root,
    track,
    feat,
    ttl_seconds: Number.parseInt(String(options.ttlSeconds || DEFAULT_TTL_SECONDS), 10),
    totals: {
      entries: entries.length,
      active: entries.filter(entry => entry.active).length,
      expired: entries.filter(entry => entry.expired).length,
    },
    by_track: byTrack,
    entries,
  };
}

function clearPresence(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const dir = presenceDir(config);
  const target = options.sessionId ? safePresenceId(options.sessionId) : null;
  const selection = options.set || options.feat
    ? resolveTrackSelection(config, {
      set: options.set || null,
      feat: options.feat || null,
      required: Boolean(options.feat),
      default: false,
      label: 'presence clear',
    })
    : { track: null, feat: null };
  const plan = listPresenceEntries(config, {
    ttlSeconds: options.ttlSeconds || null,
  }).filter(entry => {
    if (target && entry.session_id !== target) return false;
    if (options.expired === true && !entry.expired) return false;
    if (selection.track && entry.track !== selection.track) return false;
    if (selection.feat && entry.feat !== selection.feat) return false;
    return true;
  });
  if (options.yes !== true) {
    return {
      action: 'presence_clear',
      workspace: config.root,
      dry_run: true,
      candidates: plan.map(entry => entry.session_id),
      totals: { candidates: plan.length },
      next_action: 'Re-run with --yes to remove these presence entries.',
    };
  }
  let removed = 0;
  for (const entry of plan) {
    if (!entry.file || !entry.file.startsWith(dir)) continue;
    if (fs.existsSync(entry.file)) {
      fs.unlinkSync(entry.file);
      removed += 1;
    }
  }
  return {
    action: 'presence_clear',
    workspace: config.root,
    dry_run: false,
    removed,
    totals: { candidates: plan.length, removed },
  };
}

function renderPresenceText(payload) {
  const lines = [
    `Workspace: ${payload.workspace}`,
    `Presence: ${payload.totals.active} active, ${payload.totals.expired} expired`,
  ];
  const tracks = Object.keys(payload.by_track || {}).sort();
  if (!tracks.length) {
    lines.push('  (none)');
    return lines.join('\n');
  }
  for (const track of tracks) {
    lines.push(`Track: ${track}`);
    for (const entry of payload.by_track[track]) {
      const age = entry.age_seconds == null ? '-' : `${entry.age_seconds}s`;
      lines.push(
        `  ${entry.session_id}  ${entry.status || '-'}  age=${age}` +
        `${entry.run_id ? `  run=${entry.run_id}` : ''}` +
        `${entry.purpose ? `  purpose=${entry.purpose}` : ''}`
      );
    }
  }
  return lines.join('\n');
}

function handlePresence(subcommand, args) {
  const parsed = parseArgs(args || []);
  if (!subcommand || subcommand === 'list' || subcommand === 'ls') {
    const payload = listPresence({
      root: parsed.root || null,
      set: parsed.set || null,
      feat: parsed.feat || null,
      all: parsed.all === true,
      ttlSeconds: parsed['ttl-seconds'] || null,
    });
    if (parsed.text === true) {
      process.stdout.write(renderPresenceText(payload) + '\n');
    } else {
      output(payload);
    }
    return;
  }
  if (subcommand === 'touch' || subcommand === 'open') {
    output(touchPresence({
      root: parsed.root || null,
      set: parsed.set || null,
      feat: parsed.feat || null,
      run: parsed.run || parsed.id || null,
      purpose: parsed.purpose || null,
      sessionId: parsed['session-id'] || parsed.session || null,
      status: parsed.status || null,
      tool: parsed.tool || null,
    }));
    return;
  }
  if (subcommand === 'clear') {
    const payload = clearPresence({
      root: parsed.root || null,
      set: parsed.set || null,
      feat: parsed.feat || null,
      sessionId: parsed['session-id'] || parsed.session || null,
      expired: parsed.expired === true,
      ttlSeconds: parsed['ttl-seconds'] || null,
      yes: parsed.yes === true,
    });
    if (parsed.text === true) {
      if (payload.dry_run) {
        process.stdout.write([
          `Workspace: ${payload.workspace}`,
          `Candidates: ${payload.totals.candidates}`,
          ...payload.candidates.map(id => `  ${id}`),
          `Next: ${payload.next_action}`,
        ].join('\n') + '\n');
      } else {
        process.stdout.write(`Workspace: ${payload.workspace}\nRemoved: ${payload.removed}\n`);
      }
    } else {
      output(payload);
    }
    return;
  }
  error(`Unknown presence subcommand: '${subcommand}'. Use: list, touch, clear`);
}

module.exports = {
  DEFAULT_TTL_SECONDS,
  defaultPresenceId,
  defaultPresenceIdentity,
  handlePresence,
  listPresence,
  listPresenceEntries,
  presenceDir,
  renderPresenceText,
  touchPresence,
};
