'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');

const { output, error, parseArgs } = require('./core.cjs');
const { ensureWorkspaceDirs, loadWorkspaceConfig } = require('./workspace-config.cjs');
const { getWorkspaceStatus, publishPlan } = require('./workspace-inventory.cjs');
const { buildSyncPlan } = require('./sync-plan.cjs');
const { compareWorktreeHeads, deployPlan, gateFromRun, imagePlan, readRunEvents } = require('./action-plan.cjs');
const { buildRuntimeContext, writeRuntimeShell } = require('./runtime-context.cjs');
const {
  inferTrackProfile,
  resolveFeatureName,
  resolveTrackName,
  resolveTrackSelection,
  resolveWorkspaceSet,
} = require('./track-resolver.cjs');

function runId() {
  const stamp = new Date().toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '')
    .replace('T', '-');
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

function markdownEscape(value) {
  return String(value == null ? '' : value).replace(/\|/g, '\\|');
}

function inlineCode(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().replace(/`/g, '\\`');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function sessionTrack(session) {
  return session && (session.track || session.workspace_set)
    ? String(session.track || session.workspace_set)
    : null;
}

function sessionFeat(session) {
  return session && session.feat ? String(session.feat) : null;
}

function scopedLabel(track, feat) {
  if (!track) return 'all tracks';
  return feat ? `${track}/${feat}` : track;
}

function commandScopeArgs(track, feat) {
  return [
    track ? `--set ${JSON.stringify(track)}` : null,
    feat ? `--feat ${JSON.stringify(feat)}` : null,
  ].filter(Boolean).join(' ');
}

function commandScopeParts(track, feat) {
  return [
    track ? '--set' : null,
    track ? JSON.stringify(track) : null,
    feat ? '--feat' : null,
    feat ? JSON.stringify(feat) : null,
  ].filter(Boolean);
}

function sessionMatchesScope(session, trackFilter = null, featFilter = null, scopeExplicit = false) {
  if (!scopeExplicit) return true;
  const track = sessionTrack(session);
  const feat = sessionFeat(session);
  if (trackFilter && track !== trackFilter) return false;
  if (featFilter) return feat === featFilter;
  if (trackFilter) return !feat;
  return true;
}

function resolveSessionFilter(config, options = {}, label = 'session filter') {
  const explicitTrack = options.set || null;
  const explicitFeat = options.feat || null;
  const needsTrack = Boolean(explicitFeat);
  const selection = resolveTrackSelection(config, {
    set: explicitTrack,
    feat: explicitFeat,
    required: needsTrack,
    default: false,
    label,
  });
  return {
    track: selection.track ? String(selection.track) : null,
    feat: selection.feat ? String(selection.feat) : null,
    track_source: selection.track_source,
    feat_source: selection.feat_source,
    explicit: Boolean(selection.track || selection.feat),
    selection,
  };
}

function renderWorktreeRows(workspace) {
  const rows = (workspace.worktrees || []).map(item => [
    item.id,
    item.repo,
    item.path,
    item.branch || item.desired_branch || '',
    item.head || '',
    item.exists ? 'yes' : 'no',
    item.dirty ? 'yes' : 'no',
  ]);
  if (!rows.length) return '_No worktrees selected._\n';
  return [
    '| Worktree | Repo | Path | Branch | Head | Exists | Dirty |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(row => `| ${row.map(markdownEscape).join(' | ')} |`),
  ].join('\n') + '\n';
}

function renderSessionReadme(payload, status, note) {
  const cli = path.join(__dirname, 'devteam.cjs');
  const track = payload.track || payload.workspace_set || null;
  const feat = payload.feat || null;
  const scopeArgs = commandScopeArgs(track, feat);
  const scoped = suffix => [scopeArgs, suffix].filter(Boolean).join(' ');
  const runtime = payload.runtime || null;
  const runtimeSource = runtime && runtime.shell ? runtime.shell.source : null;
  const lines = [
    `# ${payload.run_id}`,
    '',
    '## Scope',
    '',
    `- Workspace: \`${payload.workspace}\``,
    `- Track: \`${track || ''}\``,
    `- Feature: \`${feat || ''}\``,
    `- Status: \`${status}\``,
    `- Created at: \`${payload.created_at}\``,
    `- Sync profile: \`${payload.profiles.sync || ''}\``,
    `- Env profile: \`${payload.profiles.env || ''}\``,
    `- Build profile: \`${payload.profiles.build || 'disabled'}\``,
    `- Deploy profile: \`${payload.profiles.deploy || 'disabled'}\``,
  ];
  if (runtimeSource) {
    lines.push(`- Runtime env: \`${runtimeSource}\``);
  }

  if (note) {
    lines.push(`- Note: ${note}`);
  }

  lines.push(
    '',
    '## Worktrees',
    '',
    renderWorktreeRows(payload.workspace_status).trimEnd(),
    '',
    '## Suggested Commands',
    '',
    '```bash',
  );
  if (runtimeSource) {
    lines.push(runtimeSource);
  }
  lines.push(`node ${JSON.stringify(cli)} ws status --root ${JSON.stringify(payload.workspace)} ${scopeArgs}`.trim());

  if (payload.profiles.env) {
    lines.push(
      `node ${JSON.stringify(cli)} env doctor --root ${JSON.stringify(payload.workspace)} --profile ${JSON.stringify(payload.profiles.env)} ${scoped('--remote --run ' + JSON.stringify(payload.run_id))}`,
      `node ${JSON.stringify(cli)} env refresh --root ${JSON.stringify(payload.workspace)} --profile ${JSON.stringify(payload.profiles.env)} ${scoped('--run ' + JSON.stringify(payload.run_id))}`
    );
  }

  if (payload.profiles.sync) {
    lines.push(
      `node ${JSON.stringify(cli)} sync plan --root ${JSON.stringify(payload.workspace)} ${scoped('--profile ' + JSON.stringify(payload.profiles.sync))}`,
      `node ${JSON.stringify(cli)} sync apply --root ${JSON.stringify(payload.workspace)} ${scoped('--profile ' + JSON.stringify(payload.profiles.sync) + ' --yes --run ' + JSON.stringify(payload.run_id))}`
    );
  }

  const hasPublishAfterValidation = (payload.workspace_status.worktrees || [])
    .some(item => item.publish_after_validation === true);
  if (hasPublishAfterValidation) {
    lines.push(
      `node ${JSON.stringify(cli)} ws publish-plan --root ${JSON.stringify(payload.workspace)} ${scoped('--run ' + JSON.stringify(payload.run_id))}`,
      `node ${JSON.stringify(cli)} ws publish --root ${JSON.stringify(payload.workspace)} ${scoped('--run ' + JSON.stringify(payload.run_id))}`
    );
  }

  if (payload.profiles.build) {
    lines.push(`node ${JSON.stringify(cli)} image plan --root ${JSON.stringify(payload.workspace)} ${scoped('--profile ' + JSON.stringify(payload.profiles.build))}`);
  }

  if (payload.profiles.deploy) {
    lines.push(
      `node ${JSON.stringify(cli)} deploy plan --root ${JSON.stringify(payload.workspace)} ${scoped('--profile ' + JSON.stringify(payload.profiles.deploy))}`,
      `node ${JSON.stringify(cli)} deploy record --root ${JSON.stringify(payload.workspace)} ${scoped('--run ' + JSON.stringify(payload.run_id) + ' --status passed --namespace "<namespace>" --image "<image>"')}`,
      `node ${JSON.stringify(cli)} deploy verify-record --root ${JSON.stringify(payload.workspace)} ${scoped('--run ' + JSON.stringify(payload.run_id) + ' --status passed --namespace "<namespace>" --summary "<preprod checks passed>"')}`
    );
  }

  lines.push(
    '```',
    '',
    '## Runtime Env',
    '',
  );
  if (runtime && runtime.env && Object.keys(runtime.env).length) {
    const visibleKeys = [
      'DEVTEAM_ROOT',
      'DEVTEAM_TRACK',
      'DEVTEAM_FEAT',
      'DEVTEAM_ENV_PROFILE',
      'DEVTEAM_SYNC_PROFILE',
      'DEVTEAM_WORK_DIR',
      'DEVTEAM_SOURCE_DIR',
      'DEVTEAM_VENV',
      'DEVTEAM_PYTHON',
      'K8S_NAMESPACE',
      'KUBECONFIG',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'NO_PROXY',
    ].filter(key => Object.prototype.hasOwnProperty.call(runtime.env, key));
    for (const key of visibleKeys) {
      lines.push(`- ${key}: \`${inlineCode(runtime.env[key])}\``);
    }
    if (runtime.worktrees && runtime.worktrees.length) {
      lines.push('', 'Runtime worktrees:');
      for (const worktree of runtime.worktrees) {
        lines.push(`- ${worktree.id}: \`${inlineCode(worktree.local_path || '')}\` -> \`${inlineCode(worktree.remote_path || '')}\``);
      }
    }
  } else {
    lines.push('_No runtime exports inferred._');
  }
  lines.push(
    '',
    '## Results',
    '',
    '- Sync: pending',
    '- Env doctor: pending',
    '- Env refresh: pending',
    '- Tests: pending',
  );
  if (hasPublishAfterValidation) lines.push('- Publish: pending');
  lines.push(
    `- Image build: ${payload.image_plan ? 'pending' : 'disabled'}`,
    `- Deploy: ${payload.deploy_plan ? 'pending' : 'disabled'}`,
    `- Deploy verify: ${payload.deploy_plan ? 'pending' : 'disabled'}`,
    '',
    'Keep concrete test commands and outputs in this run directory. Stable track configuration belongs in `.devteam/config.yaml`; per-run evidence belongs here.',
    ''
  );

  return lines.join('\n');
}

function resolveRunDir(config, runValue, label = 'session record') {
  const value = runValue ? String(runValue) : '';
  if (!value) error(`${label} requires --run <run-id-or-path>.`);
  const absolute = path.isAbsolute(value)
    ? value
    : path.join(config.root, '.devteam', 'runs', value);
  if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {
    return path.dirname(absolute);
  }
  return absolute;
}

function resolveLatestRunDir(config, setFilter = null, options = {}) {
  const includeClosed = options.includeClosed === true;
  const featFilter = options.feat || null;
  const scopeExplicit = options.scopeExplicit !== false && Boolean(setFilter || featFilter);
  for (const item of listRunDirs(config)) {
    let session = null;
    try {
      session = JSON.parse(fs.readFileSync(item.session_path, 'utf8'));
    } catch (_) {
      continue;
    }
    if (!includeSessionByLifecycle(session, includeClosed)) {
      continue;
    }
    if (!sessionMatchesScope(session, setFilter, featFilter, scopeExplicit)) {
      continue;
    }
    const errors = sessionConfigIssues(config, session)
      .filter(issue => issue.severity === 'error');
    if (errors.length === 0) return item.run_dir;
  }
  return null;
}

function sessionSortMs(sessionPath, stat) {
  try {
    const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    const created = Date.parse(String(session.created_at || ''));
    if (!Number.isNaN(created)) return created;
  } catch (_) {
    // Fall back to mtime for malformed session metadata.
  }
  return stat.mtimeMs;
}

function listRunDirs(config) {
  const runsDir = path.join(config.root, '.devteam', 'runs');
  if (!fs.existsSync(runsDir) || !fs.statSync(runsDir).isDirectory()) return [];
  return fs.readdirSync(runsDir)
    .map(name => {
      const runDir = path.join(runsDir, name);
      const sessionPath = path.join(runDir, 'session.json');
      if (!fs.existsSync(sessionPath)) return null;
      const stat = fs.statSync(sessionPath);
      return {
        run_id: name,
        run_dir: runDir,
        session_path: sessionPath,
        mtime_ms: stat.mtimeMs,
        sort_ms: sessionSortMs(sessionPath, stat),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.sort_ms - a.sort_ms || b.run_id.localeCompare(a.run_id));
}

function parseJsonFile(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    error(`Failed to parse ${filePath}: ${err.message}`);
  }
}

function normalizeLifecycleStatus(value) {
  const status = String(value || 'open').trim().toLowerCase();
  if (['open', 'closed', 'superseded'].includes(status)) return status;
  return 'open';
}

function sessionLifecycle(session) {
  const raw = session && session.lifecycle;
  if (typeof raw === 'string') {
    const status = normalizeLifecycleStatus(raw);
    return {
      status,
      closed: status !== 'open',
      reason: null,
      by_run: null,
      updated_at: null,
    };
  }
  const lifecycle = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw
    : {};
  const status = normalizeLifecycleStatus(lifecycle.status || 'open');
  return {
    status,
    closed: status !== 'open',
    reason: lifecycle.reason ? String(lifecycle.reason) : null,
    by_run: lifecycle.by_run || lifecycle.superseded_by || null,
    updated_at: lifecycle.updated_at || lifecycle.closed_at || null,
  };
}

function includeSessionByLifecycle(session, includeClosed = false) {
  return includeClosed || !sessionLifecycle(session).closed;
}

function sessionConfigIssues(config, session) {
  const issues = [];
  const workspaceSet = sessionTrack(session) ||
    (resolveWorkspaceSet(config, null, { required: false }).value || null);
  if (workspaceSet && !config.tracks[workspaceSet]) {
    issues.push({
      severity: 'error',
      kind: 'unknown_track',
      message: `track '${workspaceSet}' no longer exists in .devteam/config.yaml`,
      field: 'track',
      value: workspaceSet,
    });
  }
  const feat = sessionFeat(session);
  if (workspaceSet && feat && config.tracks[workspaceSet]) {
    try {
      resolveFeatureName(config, workspaceSet, feat, { default: false });
    } catch (err) {
      issues.push({
        severity: 'error',
        kind: 'unknown_feature',
        message: `feature '${feat}' no longer exists under track '${workspaceSet}' in .devteam/config.yaml`,
        field: 'feat',
        value: feat,
      });
    }
  }

  const profiles = session && session.profiles && typeof session.profiles === 'object'
    ? session.profiles
    : {};
  const checks = [
    ['env', 'env_profiles', 'env profile'],
    ['sync', 'env_profiles', 'sync profile'],
    ['build', 'build_profiles', 'build profile'],
    ['deploy', 'deploy_profiles', 'deploy profile'],
  ];
  for (const [field, mapName, label] of checks) {
    const value = profiles[field] ? String(profiles[field]) : null;
    if (value && !config[mapName][value]) {
      issues.push({
        severity: 'error',
        kind: `unknown_${field}_profile`,
        message: `${label} '${value}' no longer exists in .devteam/config.yaml`,
        field: `profiles.${field}`,
        value,
      });
    }
  }

  return issues;
}

function compactLatestEvents(events) {
  const latest = {};
  for (const event of events || []) {
    latest[event.kind] = event;
  }
  return latest;
}

function compactWorktreeHeads(workspace) {
  return (workspace.worktrees || []).map(item => ({
    id: item.id,
    repo: item.repo || null,
    path: item.path || null,
    branch: item.branch || item.desired_branch || null,
    head: item.head || null,
  }));
}

function compactEvent(kind, latest) {
  const event = latest[kind] || null;
  return {
    kind,
    status: event ? event.status : 'missing',
    ok: Boolean(event && event.status === 'passed'),
    summary: event ? event.summary : null,
    recorded_at: event ? event.recorded_at : null,
    command: event ? event.command : null,
    log: event ? event.log : null,
    artifact: event ? event.artifact : null,
    worktree_heads: event && Array.isArray(event.worktree_heads) ? event.worktree_heads : null,
  };
}

function nextUnpassed(evidence, names) {
  return names.find(name => !evidence[name] || evidence[name].status !== 'passed') || null;
}

function deriveSessionPhase(context) {
  const { workspace, evidence, image, deploy, publish, remoteValidationGate } = context;
  const buildEnabled = Boolean(image);
  const deployEnabled = Boolean(deploy);
  const publishReady = publish && publish.totals && publish.totals.ready > 0;
  const publishBlocked = publish && publish.totals && publish.totals.blocked > 0;
  const headChanged = remoteValidationGate &&
    remoteValidationGate.head_check &&
    remoteValidationGate.head_check.status === 'changed';

  if (workspace.totals.missing > 0) {
    return { name: 'local-workspace', status: 'blocked', reason: 'local worktrees are missing' };
  }
  if (workspace.totals.dirty > 0) {
    return { name: 'local-workspace', status: 'needs_attention', reason: 'local worktrees have uncommitted changes' };
  }
  if (headChanged) {
    return {
      name: 'remote-validation',
      status: 'needs_attention',
      reason: 'worktree_head_changed: run evidence was recorded for an older worktree HEAD',
    };
  }

  const missingRemoteEvidence = nextUnpassed(evidence, ['env-doctor', 'sync', 'test']);
  if (missingRemoteEvidence) {
    return {
      name: missingRemoteEvidence === 'test' ? 'remote-test' : missingRemoteEvidence,
      status: 'in_progress',
      reason: `${missingRemoteEvidence} evidence is ${evidence[missingRemoteEvidence].status}`,
    };
  }

  if (buildEnabled && evidence['image-build'].status !== 'passed') {
    if (!image.complete) {
      return { name: 'image-build', status: 'blocked', reason: 'build profile is incomplete' };
    }
    return { name: 'image-build', status: 'ready', reason: 'sync and test evidence passed' };
  }

  if (deployEnabled && evidence.deploy.status !== 'passed') {
    if (!deploy.complete) {
      return { name: 'preprod-deploy', status: 'blocked', reason: 'deploy profile is incomplete' };
    }
    return { name: 'preprod-deploy', status: 'ready', reason: 'image-build evidence passed' };
  }
  if (deployEnabled && evidence['deploy-verify'].status !== 'passed') {
    return { name: 'preprod-verify', status: 'ready', reason: 'deploy evidence passed' };
  }

  if (publishBlocked) {
    return { name: 'publish-local-branches', status: 'blocked', reason: 'one or more publish worktrees are blocked' };
  }
  if (publishReady) {
    if (evidence.publish && evidence.publish.status === 'passed') {
      return {
        name: deployEnabled ? 'preprod-validation-complete' : (buildEnabled ? 'image-validation-complete' : 'remote-validation-complete'),
        status: 'complete',
        reason: 'publish evidence passed',
      };
    }
    return { name: 'publish-local-branches', status: 'ready', reason: 'validation evidence passed' };
  }

  return {
    name: deployEnabled ? 'preprod-validation-complete' : (buildEnabled ? 'image-validation-complete' : 'remote-validation-complete'),
    status: 'complete',
    reason: 'all configured run stages have passing evidence',
  };
}

function compactPublishEntries(plan) {
  return (plan.entries || []).map(entry => ({
    id: entry.id,
    repo: entry.repo,
    branch: entry.branch,
    head: entry.head,
    dirty: entry.dirty,
    action: entry.action,
    target_branch: entry.target_branch,
    remote: entry.remote,
    remote_ref_exists: entry.remote_ref_exists,
    commits_ahead_base: entry.commits_ahead_base,
    commits_ahead_remote: entry.commits_ahead_remote,
    commits_behind_remote: entry.commits_behind_remote,
    blocked_by: entry.blocked_by,
    reason: entry.reason,
    command: entry.command,
  }));
}

function shortPath(value) {
  const text = String(value || '');
  if (!text) return '';
  const home = require('os').homedir();
  return text.startsWith(home) ? `~${text.slice(home.length)}` : text;
}

function shortSummary(value, max = 96) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function formatRecordedAt(value) {
  if (!value) return '';
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    return String(value).replace('T', ' ').replace(/\.\d+Z$/, 'Z');
  }
  const pad = number => String(number).padStart(2, '0');
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
  ].join(' ');
}

function evidenceLine(label, event) {
  const status = event && event.status ? event.status : 'missing';
  const detail = event && event.summary ? ` - ${shortSummary(event.summary, 90)}` : '';
  const recorded = event && event.recorded_at ? ` @ ${formatRecordedAt(event.recorded_at)}` : '';
  return `  ${label.padEnd(12)} ${status.padEnd(8)}${recorded}${detail}`;
}

function worktreeLine(item) {
  const branch = item.branch || '(no branch)';
  const head = item.head || '(no head)';
  const flags = [
    item.exists ? 'present' : 'missing',
    item.dirty ? 'dirty' : 'clean',
    item.dirty_file_count ? `files:${item.dirty_file_count}` : null,
    item.commits_ahead == null ? null : `ahead:${item.commits_ahead}`,
    item.publish_after_validation ? 'publish-after-validation' : null,
  ].filter(Boolean).join(', ');
  const dirtyFiles = (item.dirty_files || [])
    .slice(0, 5)
    .map(file => `${file.status} ${file.path}`)
    .join(', ');
  return `  ${item.repo || item.id}  ${branch}  ${head}  ${flags}${dirtyFiles ? `  [${dirtyFiles}]` : ''}`;
}

function gateLine(label, gate) {
  if (!gate) return `  ${label.padEnd(18)} disabled`;
  const required = (gate.required || [])
    .map(item => `${item.kind}:${item.head_status === 'stale' ? 'stale' : item.status}`)
    .join(', ');
  return `  ${label.padEnd(18)} ${gate.status}${required ? ` (${required})` : ''}`;
}

function renderSessionStatusText(status) {
  const lines = [
    `Workspace: ${shortPath(status.workspace)}`,
    `Track: ${status.workspace_set || '(none)'}`,
    status.feat ? `Feature: ${status.feat}` : null,
    `Run: ${status.run_id}`,
    `Phase: ${status.phase.name} (${status.phase.status}) - ${status.phase.reason}`,
    '',
    'Evidence:',
    evidenceLine('env-doctor', status.evidence['env-doctor']),
    evidenceLine('sync', status.evidence.sync),
    evidenceLine('test', status.evidence.test),
  ].filter(Boolean);

  if (status.evidence['env-refresh'] && status.evidence['env-refresh'].status !== 'missing') {
    lines.push(evidenceLine('env-refresh', status.evidence['env-refresh']));
  }
  if (status.image) lines.push(evidenceLine('image-build', status.evidence['image-build']));
  if (status.deploy) {
    lines.push(evidenceLine('deploy', status.evidence.deploy));
    lines.push(evidenceLine('deploy-verify', status.evidence['deploy-verify']));
  }
  if (status.publish && status.publish.totals && status.publish.totals.entries > 0) {
    lines.push(evidenceLine('publish', status.evidence.publish));
  }

  lines.push(
    '',
    'Worktrees:',
  );
  if (status.worktrees.length) {
    lines.push(...status.worktrees.map(worktreeLine));
  } else {
    lines.push('  (none)');
  }

  lines.push(
    '',
    `Workspace totals: ${status.workspace_status.present}/${status.workspace_status.worktrees} present, ${status.workspace_status.dirty} dirty, ${status.workspace_status.missing} missing`,
  );
  if (status.head_check && status.head_check.status !== 'not_checked') {
    lines.push(`Worktree head check: ${status.head_check.status}`);
  }

  if (status.sync) {
    lines.push(`Sync: ${status.sync.syncable} syncable, ${status.sync.noop} noop, ${status.sync.missing} missing`);
  }
  if (status.image) {
    lines.push(`Image: ${status.image.complete ? 'configured' : 'incomplete'}${status.image.image ? ` - ${status.image.image}` : ''}`);
  }
  if (status.deploy) {
    lines.push(`Deploy: ${status.deploy.complete ? 'configured' : 'incomplete'}${status.deploy.namespace ? ` - namespace ${status.deploy.namespace}` : ''}`);
  }

  lines.push('', 'Gates:');
  lines.push(gateLine('remote-validation', status.gates.remote_validation));
  if (status.gates.image_build) lines.push(gateLine('image-build', status.gates.image_build));
  if (status.gates.deploy) lines.push(gateLine('deploy', status.gates.deploy));
  if (status.gates.deploy_verify) lines.push(gateLine('deploy-verify', status.gates.deploy_verify));
  if (status.gates.publish) lines.push(gateLine('publish', status.gates.publish));

  if (status.publish && status.publish.totals && status.publish.totals.entries > 0) {
    lines.push(
      '',
      `Publish: ${status.publish.totals.ready} ready, ${status.publish.totals.blocked} blocked, ${status.publish.totals.create} create, ${status.publish.totals.update} update, ${status.publish.totals.already_published || 0} already published`,
    );
    for (const entry of status.publish.entries) {
      const target = `${entry.remote || 'origin'}/${entry.target_branch || entry.branch || ''}`;
      const blocked = entry.blocked_by && entry.blocked_by.length
        ? ` blocked:${entry.blocked_by.join(',')}`
        : '';
      lines.push(`  ${entry.repo}  ${entry.branch || ''} -> ${target}  ${entry.action}${blocked}`);
    }
  }

  lines.push('', 'Next actions:');
  for (const action of status.next_actions || []) {
    lines.push(`  ${action}`);
  }

  return lines.join('\n');
}

function compactEvidenceList(values, max = 4) {
  const list = Array.isArray(values) ? values : [];
  if (!list.length) return '-';
  const shown = list.slice(0, max).join(',');
  return list.length > max ? `${shown},+${list.length - max}` : shown;
}

function renderSessionListText(list) {
  const lines = [
    `Workspace: ${shortPath(list.workspace)}`,
    `Track filter: ${list.workspace_set || '(all)'}`,
    list.feat ? `Feature filter: ${list.feat}` : null,
    `Runs: ${list.totals.returned}/${list.totals.matched}${list.totals.unreadable ? `, unreadable:${list.totals.unreadable}` : ''}${list.totals.skipped_closed ? `, closed:${list.totals.skipped_closed}` : ''}`,
    '',
    'Recent runs:',
  ].filter(Boolean);

  if (!list.runs.length) {
    lines.push('  (none)');
  } else {
    for (const run of list.runs) {
      const phase = run.phase ? `${run.phase.name}/${run.phase.status}` : 'unknown';
      const created = formatRecordedAt(run.created_at || run.updated_at);
      const evidence = run.evidence || {};
      const lifecycle = run.lifecycle && run.lifecycle.status && run.lifecycle.status !== 'open'
        ? `  lifecycle:${run.lifecycle.status}`
        : '';
      const scope = run.feat ? `${run.workspace_set || '(none)'}/${run.feat}` : (run.workspace_set || '(none)');
      lines.push(`  ${run.run_id}  ${scope}  ${phase}  ${created}${lifecycle}`);
      lines.push(`    passed: ${compactEvidenceList(evidence.passed)}  failed: ${compactEvidenceList(evidence.failed)}  missing: ${compactEvidenceList(evidence.missing)}`);
      if (run.image && run.image.image) lines.push(`    image: ${run.image.image}`);
      if (run.deploy && run.deploy.namespace) lines.push(`    deploy: ${run.deploy.namespace}`);
      if (run.next_action) lines.push(`    next: ${shortSummary(run.next_action, 140)}`);
    }
  }

  if (list.unreadable && list.unreadable.length) {
    lines.push('', 'Unreadable runs:');
    for (const item of list.unreadable.slice(0, 5)) {
      lines.push(`  ${item.run_id}  ${shortSummary(item.error, 140)}`);
    }
  }

  return lines.join('\n');
}

function renderSessionLintText(lint) {
  const lines = [
    `Workspace: ${shortPath(lint.workspace)}`,
    `Track filter: ${lint.workspace_set || '(all)'}`,
    lint.feat ? `Feature filter: ${lint.feat}` : null,
    `Status: ${lint.status}`,
    `Runs checked: ${lint.totals.checked}/${lint.totals.runs}${lint.totals.skipped_by_set ? `, skipped:${lint.totals.skipped_by_set}` : ''}${lint.totals.skipped_closed ? `, closed:${lint.totals.skipped_closed}` : ''}`,
    `Issues: ${lint.totals.issues} (${lint.totals.errors} errors, ${lint.totals.warnings} warnings)`,
  ].filter(Boolean);

  if (lint.latest_run_id) {
    lines.push(`Latest readable run: ${lint.latest_run_id}`);
  }

  if (!lint.issues.length) {
    lines.push('', 'No session history issues found.');
    return lines.join('\n');
  }

  lines.push('', 'Issues:');
  for (const issue of lint.issues.slice(0, 20)) {
    lines.push(`  ${issue.severity}  ${issue.run_id}  ${issue.kind} - ${issue.message}`);
  }
  if (lint.issues.length > 20) {
    lines.push(`  +${lint.issues.length - 20} more issues`);
  }

  return lines.join('\n');
}

function renderSessionArchiveText(plan) {
  const lines = [
    `Workspace: ${shortPath(plan.workspace)}`,
    `Track filter: ${plan.workspace_set || '(all)'}`,
    plan.feat ? `Feature filter: ${plan.feat}` : null,
    `Archive root: ${shortPath(plan.archive_root)}`,
    `Dry run: ${plan.dry_run ? 'yes' : 'no'}`,
    `Candidates: ${plan.totals.candidates}, archiveable: ${plan.totals.archiveable}, blocked: ${plan.totals.blocked}`,
  ].filter(Boolean);

  if (typeof plan.totals.archived === 'number' || typeof plan.totals.failed === 'number') {
    lines.push(`Applied: archived=${plan.totals.archived || 0}, failed=${plan.totals.failed || 0}, skipped=${plan.totals.skipped || 0}`);
  }

  if (!plan.candidates.length) {
    lines.push('', 'No invalid run directories need archiving.');
  } else {
    lines.push('', 'Candidates:');
    for (const item of plan.candidates) {
      const reasons = (item.reasons || []).join(',');
      const result = item.result ? ` ${item.result}` : '';
      const blocked = item.blocked_by && item.blocked_by.length
        ? ` blocked:${item.blocked_by.join(',')}`
        : '';
      lines.push(`  ${item.run_id}  ${item.action}${result}${blocked}  ${reasons}`);
      lines.push(`    ${shortPath(item.run_dir)} -> ${shortPath(item.archive_dir)}`);
      if (item.error) lines.push(`    error: ${shortSummary(item.error, 140)}`);
    }
  }

  if (plan.next_action) {
    lines.push('', `Next: ${plan.next_action}`);
  }

  return lines.join('\n');
}

function renderSessionLifecycleText(result) {
  const lifecycle = result.lifecycle || {};
  const previous = result.previous_lifecycle || {};
  return [
    `Run: ${result.run_id}`,
    `Status: ${previous.status || 'open'} -> ${lifecycle.status || 'open'}`,
    `Reason: ${lifecycle.reason || '-'}`,
    lifecycle.by_run ? `Superseded by: ${lifecycle.by_run}` : null,
    `Session: ${shortPath(result.session_path)}`,
    `Next: ${result.next_action}`,
  ].filter(Boolean).join('\n');
}

function renderSessionHandoffText(handoff) {
  const phase = handoff.phase || {};
  const lines = [
    'Session Handoff',
    '',
    `Workspace: ${shortPath(handoff.workspace)}`,
    `Track: ${handoff.workspace_set || '-'}`,
    handoff.feat ? `Feature: ${handoff.feat}` : null,
    `Run: ${handoff.run_id || '-'}`,
    `Phase: ${phase.name || '-'} (${phase.status || '-'}) - ${phase.reason || '-'}`,
    `Lifecycle: ${handoff.lifecycle ? handoff.lifecycle.status || 'open' : 'open'}`,
    `Stale heads: ${handoff.stale_heads ? 'yes' : 'no'}`,
    '',
    'Profiles:',
    `  env: ${handoff.profiles.env || '-'}`,
    `  sync: ${handoff.profiles.sync || '-'}`,
    `  build: ${handoff.profiles.build || '-'}`,
    `  deploy: ${handoff.profiles.deploy || '-'}`,
    '',
    'Worktrees:',
  ].filter(Boolean);
  if (!handoff.worktrees.length) {
    lines.push('  (none)');
  } else {
    for (const item of handoff.worktrees) {
      const flags = [
        item.exists ? 'present' : 'missing',
        item.dirty ? 'dirty' : 'clean',
        item.dirty_file_count ? `files:${item.dirty_file_count}` : null,
      ].filter(Boolean).join(', ');
      lines.push(`  ${item.id}  ${item.repo || '-'}  ${item.branch || '-'}  ${item.head || '-'}  ${flags}`);
    }
  }
  lines.push('', 'Verified:');
  for (const item of handoff.verified) {
    lines.push(`  ${item.kind}: ${item.status}${item.summary ? ` - ${shortSummary(item.summary, 90)}` : ''}`);
  }
  lines.push('', 'Do not:');
  for (const item of handoff.do_not) {
    lines.push(`  - ${item}`);
  }
  lines.push('', 'Next:');
  if (handoff.next_actions.length) {
    for (const action of handoff.next_actions) {
      lines.push(`  ${action}`);
    }
  } else {
    lines.push('  No immediate action.');
  }
  return lines.join('\n');
}

function renderSessionSupersedePlanText(plan) {
  const lines = [
    `Workspace: ${shortPath(plan.workspace)}`,
    `Track filter: ${plan.workspace_set || '(all)'}`,
    plan.feat ? `Feature filter: ${plan.feat}` : null,
    `Dry run: ${plan.dry_run ? 'yes' : 'no'}`,
    `Candidates: ${plan.totals.candidates}, supersedeable: ${plan.totals.supersedeable}, blocked: ${plan.totals.blocked}`,
  ].filter(Boolean);
  if (typeof plan.totals.superseded === 'number' || typeof plan.totals.failed === 'number') {
    lines.push(`Applied: superseded=${plan.totals.superseded || 0}, failed=${plan.totals.failed || 0}, skipped=${plan.totals.skipped || 0}`);
  }
  if (!plan.candidates.length) {
    lines.push('', 'No stale historical runs can be superseded automatically.');
  } else {
    lines.push('', 'Candidates:');
    for (const item of plan.candidates) {
      const blocked = item.blocked_by && item.blocked_by.length
        ? ` blocked:${item.blocked_by.join(',')}`
        : '';
      const result = item.result ? ` ${item.result}` : '';
      lines.push(`  ${item.run_id}  ${item.action}${result}${blocked}  by=${item.by_run || '-'}`);
      lines.push(`    ${item.reason || '-'}`);
      if (item.error) lines.push(`    error: ${shortSummary(item.error, 140)}`);
    }
  }
  if (plan.next_action) {
    lines.push('', `Next: ${plan.next_action}`);
  }
  return lines.join('\n');
}

function deriveNextActions(context) {
  const { config, session, workspace, sync, evidence, image, deploy, publish, phase, remoteValidationGate } = context;
  const root = config.root;
  const set = sessionTrack(session) || resolveWorkspaceSet(config, null, { required: false }).value || '';
  const feat = sessionFeat(session);
  const scope = commandScopeArgs(set, feat);
  const scoped = suffix => [scope, suffix].filter(Boolean).join(' ');
  const actions = [];

  if (workspace.totals.missing > 0) {
    actions.push(`node ${JSON.stringify(path.join(__dirname, 'devteam.cjs'))} ws materialize --root ${JSON.stringify(root)} ${scope}`.trim());
  }
  if (workspace.totals.dirty > 0) {
    actions.push(`Review dirty worktrees with ws status before syncing.`);
  }
  if (
    remoteValidationGate &&
    remoteValidationGate.head_check &&
    remoteValidationGate.head_check.status === 'changed'
  ) {
    actions.push(`node ${JSON.stringify(path.join(__dirname, 'devteam.cjs'))} remote-loop start --root ${JSON.stringify(root)} ${scoped('--text')}`.trim());
    actions.push('Re-run sync and the relevant remote tests for the current worktree HEAD.');
    return actions;
  }
  if (evidence['env-doctor'].status !== 'passed' && session.profiles && session.profiles.env) {
    actions.push(`node ${JSON.stringify(path.join(__dirname, 'devteam.cjs'))} env doctor --root ${JSON.stringify(root)} --profile ${JSON.stringify(session.profiles.env)} --remote --run ${JSON.stringify(session.run_id)}`);
  }
  if (evidence.sync.status !== 'passed' && session.profiles && session.profiles.sync) {
    const syncable = sync && sync.totals ? sync.totals.syncable : 0;
    actions.push(syncable > 0
      ? `node ${JSON.stringify(path.join(__dirname, 'devteam.cjs'))} sync apply --root ${JSON.stringify(root)} ${scoped('--profile ' + JSON.stringify(session.profiles.sync) + ' --yes --run ' + JSON.stringify(session.run_id))}`
      : 'Fix sync plan entries before applying sync.');
  }
  if (evidence.test.status !== 'passed') {
    actions.push('Run the relevant remote tests, then record the pytest log with session record --remote-pytest-log.');
  }
  if (image && evidence['image-build'].status !== 'passed') {
    actions.push(image.complete
      ? `Review image plan, run the build, then record it with image record --run ${session.run_id}.`
      : `Fill build profile '${session.profiles.build}' before image build.`);
  }
  if (deploy && evidence.deploy.status !== 'passed') {
    actions.push(deploy.complete
      ? `Review deploy plan, deploy to preprod, then record it with deploy record --run ${session.run_id}.`
      : `Fill deploy profile '${session.profiles.deploy}' before preprod deploy.`);
  }
  if (deploy && evidence.deploy.status === 'passed' && evidence['deploy-verify'].status !== 'passed') {
    actions.push(`Run preprod health/traffic checks, then record them with deploy verify-record --run ${session.run_id}.`);
  }
  if (publish && publish.totals && publish.totals.entries > 0 && phase.name === 'publish-local-branches') {
    if ((publish.totals.create || 0) > 0 || (publish.totals.update || 0) > 0) {
      actions.push(`node ${JSON.stringify(path.join(__dirname, 'devteam.cjs'))} ws publish --root ${JSON.stringify(root)} --set ${JSON.stringify(set)} --run ${JSON.stringify(session.run_id)}`);
    } else if ((publish.totals.already_published || 0) === publish.totals.entries) {
      actions.push(`Local publish branches are already present on the remote; record publish evidence with ws publish --yes --run ${session.run_id}.`);
    } else if ((publish.totals.blocked || 0) > 0) {
      actions.push(`Review publish blockers with ws publish-plan ${scoped('--run ' + session.run_id)}.`);
    } else {
      actions.push(`Review publish plan with ws publish-plan ${scoped('--run ' + session.run_id)}.`);
    }
  }
  if (!actions.length) actions.push('No immediate action is required for the configured run stages.');
  return actions;
}

function resultLabel(kind) {
  const normalized = String(kind || '').trim().toLowerCase();
  if (['sync', 'sync-apply', 'sync_apply'].includes(normalized)) return 'Sync';
  if (['env-doctor', 'env_doctor', 'doctor'].includes(normalized)) return 'Env doctor';
  if (['env-refresh', 'env_refresh', 'refresh'].includes(normalized)) return 'Env refresh';
  if (['test', 'tests', 'pytest'].includes(normalized)) return 'Tests';
  if (['publish', 'git-push', 'push'].includes(normalized)) return 'Publish';
  if (['image', 'image-build', 'image_build', 'build'].includes(normalized)) return 'Image build';
  if (['deploy', 'deployment'].includes(normalized)) return 'Deploy';
  if (['deploy-verify', 'deploy_verify', 'preprod-verify', 'preprod_verify', 'verify-deploy', 'verify_deploy'].includes(normalized)) return 'Deploy verify';
  return null;
}

function updateResultsBullet(readme, label, status) {
  if (!label) return readme;
  const pattern = new RegExp(`^- ${label}: .*$`, 'm');
  const replacement = `- ${label}: ${status}`;
  if (pattern.test(readme)) return readme.replace(pattern, replacement);
  return `${readme.replace(/\s*$/, '\n')}${replacement}\n`;
}

function appendEventToReadme(readme, event) {
  let next = readme || `# ${event.run_id || 'run'}\n\n`;
  if (!/^## Event Log\s*$/m.test(next)) {
    next = `${next.replace(/\s*$/, '\n\n')}## Event Log\n`;
  }
  const lines = [
    '',
    `- \`${event.recorded_at}\` \`${inlineCode(event.kind)}\` \`${inlineCode(event.status)}\`: ${event.summary}`,
  ];
  if (event.command) lines.push(`  - Command: \`${inlineCode(event.command)}\``);
  if (event.log) lines.push(`  - Log: \`${inlineCode(event.log)}\``);
  if (event.artifact) lines.push(`  - Artifact: \`${inlineCode(event.artifact)}\``);
  if (event.notes) lines.push(`  - Notes: ${event.notes}`);
  return next.replace(/\s*$/, '\n') + lines.join('\n') + '\n';
}

function cleanPytestSummaryLine(line) {
  return String(line || '')
    .replace(/^=+\s*/, '')
    .replace(/\s*=+$/, '')
    .trim();
}

function inferPytestStatus(summary) {
  const text = String(summary || '').toLowerCase();
  const failed = /(,\s*|^)([1-9]\d*)\s+(failed|errors?)\b/.test(text);
  if (failed || /\bfailed\b/.test(text) && !/\b0 failed\b/.test(text)) return 'failed';
  if (/\bpassed\b/.test(text) || /\bskipped\b/.test(text) || /\bno tests ran\b/.test(text)) return 'passed';
  return 'info';
}

function parsePytestContent(content, logLabel) {
  const lines = content.split(/\r?\n/).reverse();
  let summary = null;
  for (const line of lines) {
    const clean = cleanPytestSummaryLine(line);
    if (!clean) continue;
    if (
      /\bno tests ran in\b/.test(clean) ||
      (/\b\d+\s+(failed|passed|errors?|skipped|xfailed|xpassed|warnings?)\b/.test(clean) && /\bin\s+[\d:.]+s?\b/.test(clean))
    ) {
      summary = clean;
      break;
    }
  }
  if (!summary) {
    const failureLine = lines.map(cleanPytestSummaryLine).find(line => /^FAILED\b/.test(line) || /^ERROR\b/.test(line));
    summary = failureLine || `pytest log recorded: ${path.basename(String(logLabel || 'pytest.log'))}`;
  }
  const status = inferPytestStatus(summary);
  return {
    path: logLabel,
    status,
    summary: `pytest ${status}: ${summary}`,
  };
}

function parsePytestLog(logPath) {
  const absolute = path.resolve(String(logPath || ''));
  if (!fs.existsSync(absolute)) {
    error(`pytest log not found: ${absolute}`);
  }
  return parsePytestContent(fs.readFileSync(absolute, 'utf8'), absolute);
}

function fetchRemoteText(profile, remotePath) {
  if (!profile || !profile.ssh) {
    error('remote pytest log requires an env profile with ssh.');
  }
  const command = `cat ${shellQuote(remotePath)}`;
  const result = spawnSync(`${profile.ssh} ${shellQuote(command)}`, {
    shell: true,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000,
  });
  if (result.status !== 0) {
    error(`Failed to read remote pytest log '${remotePath}': ${result.stderr || result.stdout || 'unknown error'}`);
  }
  return result.stdout || '';
}

function parseRemotePytestLog(config, session, options) {
  const remotePath = String(options.remotePytestLog || '');
  const profileName = options.profile ||
    (session.profiles && session.profiles.env) ||
    config.defaults.env ||
    null;
  if (!profileName) error('remote pytest log requires --profile <env-profile> or session profiles.env.');
  if (!config.env_profiles[profileName]) {
    error(`Unknown env profile '${profileName}'. Available: ${Object.keys(config.env_profiles).join(', ') || '(none)'}`);
  }
  const { effectiveEnvProfile } = require('./env-profile.cjs');
  const profile = effectiveEnvProfile(config, profileName);
  return parsePytestContent(fetchRemoteText(profile, remotePath), remotePath);
}

function selectedTrackForGuard(config, options = {}) {
  if (options.set) {
    return {
      value: resolveTrackName(config, options.set),
      source: 'explicit',
      input: String(options.set),
    };
  }
  const envValue = process.env.DEVTEAM_TRACK || null;
  if (envValue) {
    return {
      value: resolveTrackName(config, envValue),
      source: 'env',
      input: String(envValue),
    };
  }
  return { value: null, source: 'none', input: null };
}

function assertRunTrackGuard(config, session, options = {}) {
  const runTrack = sessionTrack(session) ? resolveTrackName(config, sessionTrack(session)) : null;
  const runFeat = sessionFeat(session);
  const selected = selectedTrackForGuard(config, options);
  const selectedFeat = options.feat ? resolveFeatureName(config, selected.value || runTrack, options.feat, { default: false }).value : null;
  if (!runTrack || !selected.value) {
    return {
      status: 'not_checked',
      run_track: runTrack,
      run_feat: runFeat,
      selected_track: selected.value,
      selected_feat: selectedFeat,
      selected_source: selected.source,
    };
  }
  if (runTrack !== selected.value) {
    if (options.allowCrossTrack === true) {
      return {
        status: 'allowed_cross_track',
        run_track: runTrack,
        run_feat: runFeat,
        selected_track: selected.value,
        selected_feat: selectedFeat,
        selected_source: selected.source,
      };
    }
    error(
      `Refusing to record evidence for run track '${runTrack}' while current track is '${selected.value}' (${selected.source}). ` +
      'Pass --set matching the run track, switch DEVTEAM_TRACK, or use --allow-cross-track if this is intentional.'
    );
  }
  if (selectedFeat && runFeat !== selectedFeat) {
    if (options.allowCrossTrack === true) {
      return {
        status: 'allowed_cross_feature',
        run_track: runTrack,
        run_feat: runFeat,
        selected_track: selected.value,
        selected_feat: selectedFeat,
        selected_source: selected.source,
      };
    }
    error(
      `Refusing to record evidence for run feature '${runFeat || '(track base)'}' while current feature is '${selectedFeat}'. ` +
      'Pass --feat matching the run feature, switch DEVTEAM_FEAT, or use --allow-cross-track if this is intentional.'
    );
  }
  return {
    status: 'matched',
    run_track: runTrack,
    run_feat: runFeat,
    selected_track: selected.value,
    selected_feat: selectedFeat,
    selected_source: selected.source,
  };
}

function headGuardRequired(kind) {
  return ['sync', 'test', 'publish', 'image-build', 'image_build', 'deploy', 'deploy-verify', 'deploy_verify']
    .includes(String(kind || '').trim().toLowerCase());
}

function sessionHeadMap(session) {
  const items = session && session.workspace_status && Array.isArray(session.workspace_status.worktrees)
    ? session.workspace_status.worktrees
    : [];
  const map = {};
  for (const item of items) {
    if (!item || !item.id) continue;
    map[item.id] = {
      id: item.id,
      repo: item.repo || null,
      path: item.path || null,
      branch: item.branch || item.desired_branch || null,
      head: item.head || null,
    };
  }
  return map;
}

function checkRunHeadGuard(config, session, kind, options = {}) {
  const workspaceSet = sessionTrack(session);
  const feat = sessionFeat(session);
  if (!workspaceSet || !headGuardRequired(kind)) {
    return {
      status: 'not_required',
      workspace_set: workspaceSet,
      feat,
      required: false,
    };
  }
  const workspace = getWorkspaceStatus({
    root: config.root,
    set: workspaceSet,
    feat,
  });
  const check = compareWorktreeHeads(sessionHeadMap(session), workspace.worktrees || []);
  if (check.status === 'changed' && options.allowStaleHead !== true) {
    const first = check.changes[0] || {};
    error(
      `Refusing to record ${kind} evidence because run '${session.run_id || '(unknown)'}' was created for an older worktree HEAD. ` +
      `${first.id || 'worktree'} expected ${first.expected_head || '-'} but current is ${first.current_head || '-'}. ` +
      'Start a new run for the current HEAD or pass --allow-stale-head if this is intentional.'
    );
  }
  return {
    status: check.status === 'changed' && options.allowStaleHead === true ? 'allowed_stale_head' : check.status,
    workspace_set: workspaceSet,
    feat,
    required: true,
    changes: check.changes,
    unknown: check.unknown,
  };
}

function recordSessionEvent(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const runDir = resolveRunDir(config, options.run || null, 'session record');
  if (!fs.existsSync(runDir) || !fs.statSync(runDir).isDirectory()) {
    error(`Run directory not found: ${runDir}`);
  }

  const sessionPath = path.join(runDir, 'session.json');
  let session = {};
  if (fs.existsSync(sessionPath)) {
    try {
      session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    } catch (err) {
      error(`Failed to parse ${sessionPath}: ${err.message}`);
    }
  }
  const lifecycle = sessionLifecycle(session);
  if (lifecycle.closed && options.allowClosed !== true) {
    error(
      `Refusing to record evidence for ${lifecycle.status} run '${session.run_id || path.basename(runDir)}'. ` +
      'Start a fresh run, reopen the run, or pass --allow-closed if this is intentional.'
    );
  }

  const track_guard = assertRunTrackGuard(config, session, options);

  const pytest = options.remotePytestLog
    ? parseRemotePytestLog(config, session, options)
    : (options.pytestLog ? parsePytestLog(options.pytestLog) : null);
  const kind = options.kind ? String(options.kind) : (pytest ? 'test' : null);
  if (!kind) error('session record requires --kind <kind>.');
  const status = options.status ? String(options.status) : (pytest ? pytest.status : 'info');
  const summary = options.summary ? String(options.summary) : (pytest ? pytest.summary : '');
  if (!summary) error('session record requires --summary <text>.');
  const head_guard = checkRunHeadGuard(config, session, kind, options);
  const profilePatch = options.profilePatch && typeof options.profilePatch === 'object'
    ? options.profilePatch
    : null;
  let sessionUpdated = false;
  if (profilePatch) {
    const nextProfiles = {
      ...(session.profiles && typeof session.profiles === 'object' ? session.profiles : {}),
    };
    for (const [key, value] of Object.entries(profilePatch)) {
      if (!['sync', 'env', 'build', 'deploy'].includes(key)) continue;
      if (!value) continue;
      if (nextProfiles[key] !== String(value)) {
        nextProfiles[key] = String(value);
        sessionUpdated = true;
      }
    }
    if (sessionUpdated) {
      session.profiles = nextProfiles;
      fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2) + '\n', 'utf8');
    }
  }

  const event = {
    version: 1,
    run_id: session.run_id || path.basename(runDir),
    recorded_at: new Date().toISOString(),
    kind,
    status,
    summary,
    command: options.command ? String(options.command) : null,
    log: options.log ? String(options.log) : (pytest ? pytest.path : null),
    artifact: options.artifact ? String(options.artifact) : null,
    notes: options.notes ? String(options.notes) : null,
  };
  const workspaceSet = sessionTrack(session) || resolveWorkspaceSet(config, null, { required: false }).value || null;
  if (workspaceSet) {
    const feat = sessionFeat(session);
    const workspace = getWorkspaceStatus({
      root: config.root,
      set: workspaceSet,
      feat,
    });
    event.workspace_set = workspaceSet;
    if (feat) event.feat = feat;
    event.worktree_heads = compactWorktreeHeads(workspace);
  }

  const eventsPath = path.join(runDir, 'events.jsonl');
  fs.appendFileSync(eventsPath, JSON.stringify(event) + '\n', 'utf8');

  const readmePath = path.join(runDir, 'README.md');
  const existingReadme = fs.existsSync(readmePath)
    ? fs.readFileSync(readmePath, 'utf8')
    : `# ${event.run_id}\n\n`;
  const label = resultLabel(kind);
  const withResult = updateResultsBullet(existingReadme, label, status);
  const withEvent = appendEventToReadme(withResult, event);
  fs.writeFileSync(readmePath, withEvent, 'utf8');

  return {
    action: 'record',
    run_id: event.run_id,
    run_dir: runDir,
    readme_path: readmePath,
    events_path: eventsPath,
    track_guard,
    head_guard,
    profile_patch: profilePatch,
    session_updated: sessionUpdated,
    event,
  };
}

function sessionStatus(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const selection = resolveTrackSelection(config, {
    set: options.set || null,
    feat: options.feat || null,
    required: false,
    label: 'session status track',
  });
  const filter = {
    track: selection.track ? String(selection.track) : null,
    feat: selection.feat ? String(selection.feat) : null,
    explicit: Boolean(selection.track),
  };
  const setFilter = filter.track;
  const runDir = options.run
    ? resolveRunDir(config, options.run, 'session status')
    : resolveLatestRunDir(config, setFilter, {
      feat: filter.feat,
      scopeExplicit: filter.explicit,
    });
  if (!runDir) {
    error(setFilter
      ? `session status could not find a readable run for '${scopedLabel(setFilter, filter.feat)}'. Pass --run <id> or start a session.`
      : 'session status could not find a run. Pass --run <id> or start a session.');
  }
  if (!fs.existsSync(runDir) || !fs.statSync(runDir).isDirectory()) {
    error(`Run directory not found: ${runDir}`);
  }

  const sessionPath = path.join(runDir, 'session.json');
  const session = parseJsonFile(sessionPath, null);
  if (!session) error(`session.json not found: ${sessionPath}`);

  const run = readRunEvents(config, runDir);
  const latest = compactLatestEvents(run.events);
  const evidenceKinds = ['env-doctor', 'env-refresh', 'sync', 'test', 'publish', 'image-build', 'deploy', 'deploy-verify'];
  const evidence = {};
  for (const kind of evidenceKinds) {
    evidence[kind] = compactEvent(kind, latest);
  }

  const workspace = getWorkspaceStatus({
    root: config.root,
    set: sessionTrack(session),
    feat: sessionFeat(session),
  });
  const remoteValidationGate = gateFromRun(run, ['sync', 'test'], {
    session,
    currentWorktrees: workspace.worktrees,
  });
  const sync = session.profiles && session.profiles.sync
    ? buildSyncPlan({
      root: config.root,
      set: sessionTrack(session),
      feat: sessionFeat(session),
      profile: session.profiles.sync,
    })
    : null;
  const runtime = session.runtime || buildRuntimeContext({
    config,
    set: sessionTrack(session),
    feat: sessionFeat(session),
    profile: session.profiles && session.profiles.env ? session.profiles.env : null,
    syncProfile: session.profiles && session.profiles.sync ? session.profiles.sync : null,
  });
  const image = session.profiles && session.profiles.build
    ? imagePlan({
      root: config.root,
      set: sessionTrack(session),
      feat: sessionFeat(session),
      profile: session.profiles.build,
      run: path.basename(runDir),
    })
    : null;
  const deploy = session.profiles && session.profiles.deploy
    ? deployPlan({
      root: config.root,
      set: sessionTrack(session),
      feat: sessionFeat(session),
      profile: session.profiles.deploy,
      run: path.basename(runDir),
    })
    : null;
  const publish = publishPlan({
    root: config.root,
    set: sessionTrack(session),
    feat: sessionFeat(session),
    run: path.basename(runDir),
  });

  const phase = deriveSessionPhase({
    workspace,
    evidence,
    image,
    deploy,
    publish,
    remoteValidationGate,
  });
  const context = {
    config,
    session,
    workspace,
    sync,
    evidence,
    image,
    deploy,
    publish,
    phase,
    remoteValidationGate,
  };

  return {
    action: 'session_status',
    run_id: session.run_id || path.basename(runDir),
    run_dir: runDir,
    workspace: config.root,
    track: sessionTrack(session),
    feat: sessionFeat(session),
    workspace_set: sessionTrack(session),
    lifecycle: sessionLifecycle(session),
    profiles: {
      sync: session.profiles && session.profiles.sync ? session.profiles.sync : null,
      env: session.profiles && session.profiles.env ? session.profiles.env : null,
      build: session.profiles && session.profiles.build ? session.profiles.build : null,
      deploy: session.profiles && session.profiles.deploy ? session.profiles.deploy : null,
    },
    runtime,
    phase,
    evidence,
    head_check: remoteValidationGate ? remoteValidationGate.head_check : null,
    gates: {
      remote_validation: remoteValidationGate,
      image_build: image ? image.run_gate : null,
      deploy: deploy ? deploy.run_gate : null,
      deploy_verify: deploy ? deploy.verify_gate : null,
      publish: publish && publish.totals && publish.totals.entries > 0 ? publish.run_gate : null,
    },
    workspace_status: workspace.totals,
    worktrees: workspace.worktrees.map(item => ({
      id: item.id,
      repo: item.repo,
      path: item.path,
      branch: item.branch || item.desired_branch || null,
      head: item.head,
      exists: item.exists,
      dirty: item.dirty,
      dirty_file_count: item.dirty_file_count || 0,
      dirty_summary: item.dirty_summary || { staged: 0, unstaged: 0, untracked: 0 },
      dirty_files: item.dirty_files || [],
      commits_ahead: item.commits_ahead,
      publish_after_validation: item.publish_after_validation,
    })),
    sync: sync ? sync.totals : null,
    image: image ? {
      profile: image.profile,
      complete: image.complete,
      image: image.image,
      command: image.command,
      run_gate: image.run_gate,
    } : null,
    deploy: deploy ? {
      profile: deploy.profile,
      complete: deploy.complete,
      namespace: deploy.namespace,
      run_gate: deploy.run_gate,
      verify_gate: deploy.verify_gate,
    } : null,
    publish: publish ? {
      totals: publish.totals,
      entries: compactPublishEntries(publish),
      next_action: publish.next_action,
    } : null,
    next_actions: deriveNextActions(context),
  };
}

function sessionHandoff(options = {}) {
  const status = sessionStatus(options);
  const evidenceKinds = ['env-doctor', 'env-refresh', 'sync', 'test', 'publish', 'image-build', 'deploy', 'deploy-verify'];
  const verified = evidenceKinds
    .filter(kind => status.evidence[kind])
    .filter(kind => status.evidence[kind].status !== 'missing' || ['env-doctor', 'sync', 'test'].includes(kind))
    .map(kind => ({
      kind,
      status: status.evidence[kind].status,
      summary: status.evidence[kind].summary || null,
      recorded_at: status.evidence[kind].recorded_at || null,
    }));
  const staleHeads = Boolean(status.head_check && status.head_check.status === 'changed');
  return {
    action: 'session_handoff',
    workspace: status.workspace,
    track: status.track || status.workspace_set,
    feat: status.feat || null,
    workspace_set: status.workspace_set,
    run_id: status.run_id,
    run_dir: status.run_dir,
    lifecycle: status.lifecycle,
    phase: status.phase,
    stale_heads: staleHeads,
    profiles: status.profiles,
    runtime: status.runtime || null,
    worktrees: status.worktrees.map(item => ({
      id: item.id,
      repo: item.repo,
      path: item.path,
      branch: item.branch,
      head: item.head,
      exists: item.exists,
      dirty: item.dirty,
      dirty_file_count: item.dirty_file_count || 0,
    })),
    verified,
    gates: status.gates,
    image: status.image,
    deploy: status.deploy,
    publish: status.publish ? {
      totals: status.publish.totals,
      next_action: status.publish.next_action,
    } : null,
    do_not: [
      staleHeads
        ? 'append new head-sensitive evidence to this stale run; start a fresh run for current HEAD'
        : 'append evidence to a different track without explicit --set or --allow-cross-track',
      'sync, publish, build, deploy, or mutate remote state without explicit user intent',
      'revert user changes unless explicitly requested',
    ],
    next_actions: status.next_actions || [],
  };
}

function evidenceSummary(evidence, status = null) {
  const publish = status && status.publish ? status.publish : null;
  const kinds = ['env-doctor', 'sync', 'test'];
  if (evidence && evidence['env-refresh'] && evidence['env-refresh'].status !== 'missing') {
    kinds.push('env-refresh');
  }
  if (publish && publish.totals && publish.totals.entries > 0) {
    kinds.push('publish');
  }
  if (status && status.image) {
    kinds.push('image-build');
  }
  if (status && status.deploy) {
    kinds.push('deploy', 'deploy-verify');
  }
  const passed = [];
  const failed = [];
  const missing = [];
  for (const kind of kinds) {
    const event = evidence && evidence[kind] ? evidence[kind] : null;
    if (!event || event.status === 'missing') {
      missing.push(kind);
    } else if (event.status === 'passed') {
      passed.push(kind);
    } else {
      failed.push(kind);
    }
  }
  return { passed, failed, missing };
}

function sessionList(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const limit = (() => {
    const parsed = Number.parseInt(String(options.limit || ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
  })();
  const filter = resolveSessionFilter(config, options, 'session list track');
  const setFilter = filter.track;
  const featFilter = filter.feat;
  const includeUnreadable = options.unreadable !== false;
  const includeClosed = options.includeClosed === true;
  const entries = [];
  const unreadable = [];
  let skippedClosed = 0;

  for (const item of listRunDirs(config)) {
    let session = null;
    try {
      session = JSON.parse(fs.readFileSync(item.session_path, 'utf8'));
    } catch (err) {
      if (includeUnreadable) {
        unreadable.push({
          run_id: item.run_id,
          run_dir: item.run_dir,
          status: 'unreadable',
          error: err.message,
        });
      }
      continue;
    }
    const workspaceSet = sessionTrack(session);
    const feat = sessionFeat(session);
    if (!sessionMatchesScope(session, setFilter, featFilter, filter.explicit)) continue;
    const lifecycle = sessionLifecycle(session);
    if (!includeSessionByLifecycle(session, includeClosed)) {
      skippedClosed += 1;
      continue;
    }

    try {
      const status = sessionStatus({
        root: config.root,
        run: item.run_id,
      });
      const evidence = evidenceSummary(status.evidence, status);
      entries.push({
        run_id: status.run_id,
        run_dir: status.run_dir,
        workspace_set: status.workspace_set,
        track: status.track || status.workspace_set,
        feat: status.feat || null,
        lifecycle: status.lifecycle || lifecycle,
        created_at: session.created_at || null,
        updated_at: new Date(item.mtime_ms).toISOString(),
        phase: status.phase,
        profiles: session.profiles || {},
        evidence,
        worktrees: {
          total: status.workspace_status.worktrees,
          present: status.workspace_status.present,
          dirty: status.workspace_status.dirty,
          missing: status.workspace_status.missing,
        },
        image: status.image ? {
          profile: status.image.profile,
          image: status.image.image,
          complete: status.image.complete,
        } : null,
        deploy: status.deploy ? {
          profile: status.deploy.profile,
          namespace: status.deploy.namespace,
          complete: status.deploy.complete,
        } : null,
        next_action: (status.next_actions || [])[0] || null,
      });
    } catch (err) {
      if (includeUnreadable) {
        unreadable.push({
          run_id: item.run_id,
          run_dir: item.run_dir,
          workspace_set: workspaceSet,
          feat,
          status: 'unreadable',
          error: err.message,
        });
      }
    }
  }

  const limited = entries.slice(0, limit);
  return {
    action: 'session_list',
    workspace: config.root,
    workspace_set: setFilter,
    track: setFilter,
    feat: featFilter,
    workspace_set_source: filter.track_source,
    feat_source: filter.feat_source,
    limit,
    totals: {
      matched: entries.length,
      returned: limited.length,
      unreadable: unreadable.length,
      skipped_closed: skippedClosed,
    },
    runs: limited,
    unreadable,
  };
}

function sessionLint(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const filter = resolveSessionFilter(config, options, 'session lint track');
  const setFilter = filter.track;
  const featFilter = filter.feat;
  const issues = [];
  let checked = 0;
  let skippedBySet = 0;
  let skippedClosed = 0;
  const includeClosed = options.includeClosed === true;
  const runs = listRunDirs(config);

  for (const item of runs) {
    let session = null;
    try {
      session = JSON.parse(fs.readFileSync(item.session_path, 'utf8'));
    } catch (err) {
      if (!filter.explicit) {
        checked += 1;
        issues.push({
          severity: 'error',
          kind: 'malformed_session_json',
          run_id: item.run_id,
          run_dir: item.run_dir,
          message: err.message,
        });
      }
      continue;
    }

    if (!sessionMatchesScope(session, setFilter, featFilter, filter.explicit)) {
      skippedBySet += 1;
      continue;
    }
    if (!includeSessionByLifecycle(session, includeClosed)) {
      skippedClosed += 1;
      continue;
    }
    checked += 1;

    const configIssues = sessionConfigIssues(config, session)
      .map(issue => ({
        ...issue,
        run_id: item.run_id,
        run_dir: item.run_dir,
      }));
    issues.push(...configIssues);

    if (configIssues.some(issue => issue.severity === 'error')) {
      continue;
    }

    try {
      const status = sessionStatus({
        root: config.root,
        run: item.run_id,
      });
      if (status.head_check && status.head_check.status === 'changed') {
        issues.push({
          severity: 'warning',
          kind: 'stale_worktree_heads',
          run_id: item.run_id,
          run_dir: item.run_dir,
          message: 'run evidence was recorded for an older worktree HEAD',
          head_check: status.head_check,
        });
      }
    } catch (err) {
      issues.push({
        severity: 'error',
        kind: 'status_unreadable',
        run_id: item.run_id,
        run_dir: item.run_dir,
        message: err.message,
      });
    }
  }

  const errors = issues.filter(issue => issue.severity === 'error').length;
  const warnings = issues.filter(issue => issue.severity === 'warning').length;
  const latestRunDir = resolveLatestRunDir(config, setFilter, {
    includeClosed,
    feat: featFilter,
    scopeExplicit: filter.explicit,
  });
  return {
    action: 'session_lint',
    workspace: config.root,
    workspace_set: setFilter,
    track: setFilter,
    feat: featFilter,
    workspace_set_source: filter.track_source,
    feat_source: filter.feat_source,
    status: errors > 0 ? 'failed' : (warnings > 0 ? 'needs_attention' : 'passed'),
    latest_run_id: latestRunDir ? path.basename(latestRunDir) : null,
    totals: {
      runs: runs.length,
      checked,
      skipped_by_set: skippedBySet,
      skipped_closed: skippedClosed,
      issues: issues.length,
      errors,
      warnings,
    },
    issues,
  };
}

function sessionArchivePlan(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const filter = resolveSessionFilter(config, options, 'session archive track');
  const lint = sessionLint({
    root: config.root,
    set: filter.track,
    feat: filter.feat,
    includeClosed: options.includeClosed === true,
  });
  const byRun = new Map();
  for (const issue of lint.issues || []) {
    if (issue.severity !== 'error') continue;
    if (!issue.run_id || !issue.run_dir) continue;
    if (!byRun.has(issue.run_id)) {
      byRun.set(issue.run_id, {
        run_id: issue.run_id,
        run_dir: issue.run_dir,
        issues: [],
      });
    }
    byRun.get(issue.run_id).issues.push(issue);
  }

  const archiveRoot = path.join(config.root, '.devteam', 'runs-archive');
  const candidates = Array.from(byRun.values())
    .sort((a, b) => a.run_id.localeCompare(b.run_id))
    .map(item => {
      const archiveDir = path.join(archiveRoot, item.run_id);
      const blockedBy = [];
      if (!fs.existsSync(item.run_dir)) blockedBy.push('run_dir_missing');
      if (fs.existsSync(archiveDir)) blockedBy.push('archive_target_exists');
      const reasons = Array.from(new Set(item.issues.map(issue => issue.kind))).sort();
      return {
        run_id: item.run_id,
        run_dir: item.run_dir,
        archive_dir: archiveDir,
        action: blockedBy.length ? 'blocked' : 'archive',
        blocked_by: blockedBy,
        reasons,
        issues: item.issues.map(issue => ({
          severity: issue.severity,
          kind: issue.kind,
          message: issue.message,
          field: issue.field || null,
          value: issue.value || null,
        })),
      };
    });

  const archiveable = candidates.filter(item => item.action === 'archive').length;
  const blocked = candidates.filter(item => item.action === 'blocked').length;
  return {
    action: 'session_archive_plan',
    workspace: config.root,
    workspace_set: filter.track,
    track: filter.track,
    feat: filter.feat,
    workspace_set_source: filter.track_source,
    feat_source: filter.feat_source,
    archive_root: archiveRoot,
    dry_run: true,
    lint_status: lint.status,
    latest_run_id: lint.latest_run_id,
    totals: {
      candidates: candidates.length,
      archiveable,
      blocked,
    },
    candidates,
    next_action: archiveable > 0
      ? 'Review candidates, then run session archive --yes to move invalid run directories to .devteam/runs-archive/.'
      : 'No invalid run directories need archiving.',
  };
}

function sessionArchive(options = {}) {
  const plan = sessionArchivePlan(options);
  if (options.yes !== true) {
    return {
      ...plan,
      action: 'session_archive',
      dry_run: true,
      applied: false,
    };
  }

  fs.mkdirSync(plan.archive_root, { recursive: true });
  const candidates = plan.candidates.map(item => {
    if (item.action !== 'archive') {
      return {
        ...item,
        result: 'skipped',
      };
    }
    try {
      fs.renameSync(item.run_dir, item.archive_dir);
      return {
        ...item,
        result: 'archived',
      };
    } catch (err) {
      return {
        ...item,
        result: 'failed',
        error: err.message,
      };
    }
  });

  const archived = candidates.filter(item => item.result === 'archived').length;
  const failed = candidates.filter(item => item.result === 'failed').length;
  const skipped = candidates.filter(item => item.result === 'skipped').length;
  return {
    ...plan,
    action: 'session_archive',
    dry_run: false,
    applied: true,
    status: failed > 0 ? 'failed' : 'applied',
    totals: {
      ...plan.totals,
      archived,
      failed,
      skipped,
    },
    candidates,
    next_action: failed > 0
      ? 'Review failed archive entries and retry after fixing the destination or filesystem issue.'
      : 'Run session lint to confirm history health after archiving.',
  };
}

function updateSessionLifecycle(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const runDir = resolveRunDir(config, options.run || null, `session ${options.action || 'close'}`);
  if (!fs.existsSync(runDir) || !fs.statSync(runDir).isDirectory()) {
    error(`Run directory not found: ${runDir}`);
  }
  const sessionPath = path.join(runDir, 'session.json');
  const session = parseJsonFile(sessionPath, null);
  if (!session) error(`session.json not found: ${sessionPath}`);

  const status = normalizeLifecycleStatus(options.status || 'closed');
  const now = new Date().toISOString();
  const previous = sessionLifecycle(session);
  const lifecycle = {
    status,
    updated_at: now,
    reason: options.reason ? String(options.reason) : null,
  };
  if (status === 'superseded' && options.byRun) {
    lifecycle.by_run = String(options.byRun);
  }
  if (status !== 'open') {
    lifecycle.closed_at = now;
  }

  session.lifecycle = lifecycle;
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2) + '\n', 'utf8');

  const readmePath = path.join(runDir, 'README.md');
  if (fs.existsSync(readmePath)) {
    const existingReadme = fs.readFileSync(readmePath, 'utf8');
    const line = [
      `- \`${now}\` \`lifecycle\` \`${status}\`: ${lifecycle.reason || 'no reason provided'}`,
      lifecycle.by_run ? `  - Superseded by: \`${inlineCode(lifecycle.by_run)}\`` : null,
    ].filter(Boolean).join('\n');
    const next = /^## Event Log\s*$/m.test(existingReadme)
      ? existingReadme.replace(/\s*$/, '\n\n') + line + '\n'
      : existingReadme.replace(/\s*$/, '\n\n') + '## Event Log\n\n' + line + '\n';
    fs.writeFileSync(readmePath, next, 'utf8');
  }

  return {
    action: options.action || 'session_lifecycle',
    run_id: session.run_id || path.basename(runDir),
    run_dir: runDir,
    session_path: sessionPath,
    previous_lifecycle: previous,
    lifecycle: sessionLifecycle(session),
    next_action: status === 'open'
      ? 'Run is open again and will appear in default session list/lint/status selection.'
      : 'Run is no longer part of default active history. Use --all to include closed/superseded runs.',
  };
}

function sessionSupersedePlan(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const filter = resolveSessionFilter(config, options, 'session supersede track');
  const setFilter = filter.track;
  const featFilter = filter.feat;
  const lint = sessionLint({
    root: config.root,
    set: setFilter,
    feat: featFilter,
  });
  const latestByScope = new Map();
  for (const item of listRunDirs(config)) {
    let session = null;
    try {
      session = JSON.parse(fs.readFileSync(item.session_path, 'utf8'));
    } catch (_) {
      continue;
    }
    if (!includeSessionByLifecycle(session, false)) continue;
    const workspaceSet = sessionTrack(session);
    const feat = sessionFeat(session);
    if (!workspaceSet || !sessionMatchesScope(session, setFilter, featFilter, filter.explicit)) continue;
    if (sessionConfigIssues(config, session).some(issue => issue.severity === 'error')) continue;
    const key = `${workspaceSet}\n${feat || ''}`;
    if (!latestByScope.has(key)) {
      latestByScope.set(key, {
        run_id: session.run_id || item.run_id,
        run_dir: item.run_dir,
        workspace_set: workspaceSet,
        feat,
      });
    }
  }

  const candidates = [];
  for (const issue of lint.issues || []) {
    if (issue.kind !== 'stale_worktree_heads') continue;
    const session = parseJsonFile(path.join(issue.run_dir, 'session.json'), null);
    if (!session || !includeSessionByLifecycle(session, false)) continue;
    const workspaceSet = sessionTrack(session);
    const feat = sessionFeat(session);
    const key = `${workspaceSet || ''}\n${feat || ''}`;
    const latest = workspaceSet ? latestByScope.get(key) : null;
    const blockedBy = [];
    if (!workspaceSet) blockedBy.push('missing_workspace_set');
    if (!latest) blockedBy.push('no_newer_open_run');
    if (latest && latest.run_id === issue.run_id) blockedBy.push('latest_open_run');
    candidates.push({
      run_id: issue.run_id,
      run_dir: issue.run_dir,
      workspace_set: workspaceSet,
      track: workspaceSet,
      feat,
      action: blockedBy.length ? 'blocked' : 'supersede',
      blocked_by: blockedBy,
      by_run: latest ? latest.run_id : null,
      reason: latest && latest.run_id !== issue.run_id
        ? `superseded by newer open run ${latest.run_id} for ${scopedLabel(workspaceSet, feat)}`
        : 'stale run is the latest open run for this track/feature',
      issue: {
        kind: issue.kind,
        message: issue.message,
      },
    });
  }

  const supersedeable = candidates.filter(item => item.action === 'supersede').length;
  const blocked = candidates.filter(item => item.action === 'blocked').length;
  return {
    action: 'session_supersede_plan',
    workspace: config.root,
    workspace_set: setFilter,
    track: setFilter,
    feat: featFilter,
    workspace_set_source: filter.track_source,
    feat_source: filter.feat_source,
    dry_run: true,
    totals: {
      candidates: candidates.length,
      supersedeable,
      blocked,
    },
    candidates,
    next_action: supersedeable > 0
      ? 'Review candidates, then run session supersede-stale --yes to mark old stale runs as superseded.'
      : 'No stale historical runs can be superseded automatically.',
  };
}

function sessionSupersedeStale(options = {}) {
  const plan = sessionSupersedePlan(options);
  if (options.yes !== true) {
    return {
      ...plan,
      action: 'session_supersede_stale',
      dry_run: true,
      applied: false,
    };
  }
  const results = plan.candidates.map(item => {
    if (item.action !== 'supersede') {
      return {
        ...item,
        result: 'skipped',
      };
    }
    try {
      const result = updateSessionLifecycle({
        root: options.root || null,
        run: item.run_id,
        status: 'superseded',
        byRun: item.by_run,
        reason: item.reason,
        action: 'session_supersede',
      });
      return {
        ...item,
        result: 'superseded',
        lifecycle: result.lifecycle,
      };
    } catch (err) {
      return {
        ...item,
        result: 'failed',
        error: err.message,
      };
    }
  });
  const superseded = results.filter(item => item.result === 'superseded').length;
  const failed = results.filter(item => item.result === 'failed').length;
  const skipped = results.filter(item => item.result === 'skipped').length;
  return {
    ...plan,
    action: 'session_supersede_stale',
    dry_run: false,
    applied: true,
    status: failed > 0 ? 'failed' : 'applied',
    totals: {
      ...plan.totals,
      superseded,
      failed,
      skipped,
    },
    candidates: results,
    next_action: failed > 0
      ? 'Review failed supersede entries and retry after fixing them.'
      : 'Run session lint to confirm active history health.',
  };
}

function snapshotSession(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const selection = resolveTrackSelection(config, {
    set: options.set || null,
    feat: options.feat || null,
  });
  const workspaceSet = selection.track || null;
  const feat = selection.feat || null;
  const trackProfile = workspaceSet
    ? inferTrackProfile(config, workspaceSet, { activeTrack: workspaceSet, feat })
    : null;
  const syncProfile = options.syncProfile ||
    (trackProfile ? trackProfile.sync : null) ||
    config.defaults.sync ||
    config.defaults.env ||
    null;
  const envProfile = options.envProfile ||
    (trackProfile ? trackProfile.env : null) ||
    syncProfile ||
    config.defaults.env ||
    null;
  const includeBuild = options.includeBuild !== false;
  const includeDeploy = options.includeDeploy !== false;
  const buildProfile = includeBuild
    ? (options.buildProfile || (trackProfile ? trackProfile.build : null) || config.defaults.build || workspaceSet)
    : null;
  const deployProfile = includeDeploy
    ? (options.deployProfile || (trackProfile ? trackProfile.deploy : null) || config.defaults.deploy || null)
    : null;
  const id = options.id || runId();

  const workspace = getWorkspaceStatus({
    root: config.root,
    set: workspaceSet,
    feat,
  });
  const sync = buildSyncPlan({
    root: config.root,
    set: workspaceSet,
    feat,
    profile: syncProfile,
  });
  const runtime = buildRuntimeContext({
    config,
    set: workspaceSet,
    feat,
    profile: envProfile,
    syncProfile,
  });
  const image = buildProfile
    ? imagePlan({
      root: config.root,
      profile: buildProfile,
      set: workspaceSet,
      feat,
    })
    : null;
  const deploy = deployProfile
    ? deployPlan({
      root: config.root,
      set: workspaceSet,
      feat,
      profile: deployProfile,
    })
    : null;

  const payload = {
    version: 1,
    run_id: id,
    created_at: new Date().toISOString(),
    workspace: config.root,
    track: workspaceSet,
    feat,
    workspace_set: workspaceSet,
    profiles: {
      sync: syncProfile,
      env: envProfile,
      build: buildProfile,
      deploy: deployProfile,
    },
    workspace_status: workspace,
    sync_plan: sync,
    runtime,
    image_plan: image,
    deploy_plan: deploy,
  };

  ensureWorkspaceDirs(config.root);
  const runDir = path.join(config.root, '.devteam', 'runs', id);
  fs.mkdirSync(runDir, { recursive: true });
  const runtimePath = path.join(runDir, 'runtime.sh');
  writeRuntimeShell(payload.runtime, runtimePath);
  const sessionPath = path.join(runDir, 'session.json');
  fs.writeFileSync(sessionPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  const status = workspace.totals.missing === 0 && sync.totals.missing === 0 ? 'ready' : 'needs_attention';
  let readmePath = null;
  if (options.writeReadme === true) {
    readmePath = path.join(runDir, 'README.md');
    fs.writeFileSync(readmePath, renderSessionReadme(payload, status, options.note || null), 'utf8');
  }

  return {
    action: options.action || 'snapshot',
    run_id: id,
    path: sessionPath,
    readme_path: readmePath,
    workspace: config.root,
    track: workspaceSet,
    feat,
    workspace_set: workspaceSet,
    profiles: payload.profiles,
    runtime: {
      path: runtimePath,
      source: payload.runtime.shell ? payload.runtime.shell.source : null,
      exports: Object.keys(payload.runtime.env || {}),
    },
    status,
  };
}

function handleSession(subcommand, args) {
  const parsed = parseArgs(args || []);
  if (!subcommand || subcommand === 'snapshot' || subcommand === 'start') {
    output(snapshotSession({
      root: parsed.root || null,
      set: parsed.set || null,
      feat: parsed.feat || null,
      syncProfile: parsed.sync || null,
      envProfile: parsed.env || null,
      buildProfile: parsed.build || parsed.profile || null,
      deployProfile: parsed.deploy || null,
      includeBuild: parsed['no-build'] === true ? false : true,
      includeDeploy: parsed['no-deploy'] === true ? false : true,
      id: parsed.id || null,
      writeReadme: subcommand === 'start',
      note: parsed.note || null,
      action: subcommand === 'start' ? 'start' : 'snapshot',
    }));
    return;
  }
  if (subcommand === 'record') {
    output(recordSessionEvent({
      root: parsed.root || null,
      run: parsed.run || parsed.id || null,
      kind: parsed.kind || null,
      status: parsed.status || null,
      summary: parsed.summary || null,
      command: parsed.command || null,
      log: parsed.log || null,
      artifact: parsed.artifact || null,
      notes: parsed.notes || parsed.note || null,
      pytestLog: parsed['pytest-log'] || parsed['from-pytest-log'] || null,
      remotePytestLog: parsed['remote-pytest-log'] || null,
      profile: parsed.profile || null,
      set: parsed.set || null,
      feat: parsed.feat || null,
      allowCrossTrack: parsed['allow-cross-track'] === true,
      allowStaleHead: parsed['allow-stale-head'] === true,
      allowClosed: parsed['allow-closed'] === true,
    }));
    return;
  }
  if (subcommand === 'status') {
    const status = sessionStatus({
      root: parsed.root || null,
      run: parsed.run || parsed.id || null,
      set: parsed.set || null,
      feat: parsed.feat || null,
    });
    if (parsed.text === true) {
      process.stdout.write(renderSessionStatusText(status) + '\n');
    } else {
      output(status);
    }
    return;
  }
  if (subcommand === 'handoff') {
    const handoff = sessionHandoff({
      root: parsed.root || null,
      run: parsed.run || parsed.id || null,
      set: parsed.set || null,
      feat: parsed.feat || null,
    });
    if (parsed.text === true) {
      process.stdout.write(renderSessionHandoffText(handoff) + '\n');
    } else {
      output(handoff);
    }
    return;
  }
  if (subcommand === 'list' || subcommand === 'ls') {
    const list = sessionList({
      root: parsed.root || null,
      set: parsed.set || null,
      feat: parsed.feat || null,
      limit: parsed.limit || null,
      unreadable: parsed['no-unreadable'] === true ? false : true,
      includeClosed: parsed.all === true || parsed['include-closed'] === true,
    });
    if (parsed.text === true) {
      process.stdout.write(renderSessionListText(list) + '\n');
    } else {
      output(list);
    }
    return;
  }
  if (subcommand === 'lint') {
    const lint = sessionLint({
      root: parsed.root || null,
      set: parsed.set || null,
      feat: parsed.feat || null,
      includeClosed: parsed.all === true || parsed['include-closed'] === true,
    });
    if (parsed.text === true) {
      process.stdout.write(renderSessionLintText(lint) + '\n');
    } else {
      output(lint);
    }
    return;
  }
  if (subcommand === 'archive-plan') {
    const plan = sessionArchivePlan({
      root: parsed.root || null,
      set: parsed.set || null,
      feat: parsed.feat || null,
      includeClosed: parsed.all === true || parsed['include-closed'] === true,
    });
    if (parsed.text === true) {
      process.stdout.write(renderSessionArchiveText(plan) + '\n');
    } else {
      output(plan);
    }
    return;
  }
  if (subcommand === 'archive') {
    const result = sessionArchive({
      root: parsed.root || null,
      set: parsed.set || null,
      feat: parsed.feat || null,
      includeClosed: parsed.all === true || parsed['include-closed'] === true,
      yes: parsed.yes === true,
    });
    if (parsed.text === true) {
      process.stdout.write(renderSessionArchiveText(result) + '\n');
    } else {
      output(result);
    }
    return;
  }
  if (subcommand === 'supersede-plan') {
    const plan = sessionSupersedePlan({
      root: parsed.root || null,
      set: parsed.set || null,
      feat: parsed.feat || null,
    });
    if (parsed.text === true) {
      process.stdout.write(renderSessionSupersedePlanText(plan) + '\n');
    } else {
      output(plan);
    }
    return;
  }
  if (subcommand === 'supersede-stale') {
    const result = sessionSupersedeStale({
      root: parsed.root || null,
      set: parsed.set || null,
      feat: parsed.feat || null,
      yes: parsed.yes === true,
    });
    if (parsed.text === true) {
      process.stdout.write(renderSessionSupersedePlanText(result) + '\n');
    } else {
      output(result);
    }
    return;
  }
  if (subcommand === 'close' || subcommand === 'supersede' || subcommand === 'reopen') {
    const status = subcommand === 'reopen'
      ? 'open'
      : (subcommand === 'supersede' ? 'superseded' : 'closed');
    const result = updateSessionLifecycle({
      root: parsed.root || null,
      run: parsed.run || parsed.id || parsed._[0] || null,
      status,
      byRun: parsed.by || parsed['by-run'] || null,
      reason: parsed.reason || parsed.summary || parsed.note || null,
      action: `session_${subcommand}`,
    });
    if (parsed.text === true) {
      process.stdout.write(renderSessionLifecycleText(result) + '\n');
    } else {
      output(result);
    }
    return;
  }
  error(`Unknown session subcommand: '${subcommand}'. Use: snapshot, start, record, status, handoff, list, lint, archive-plan, archive, supersede-plan, supersede-stale, close, supersede, reopen`);
}

function handleStatusOverview(args) {
  const parsed = parseArgs(args || []);
  const status = sessionStatus({
    root: parsed.root || null,
    run: parsed.run || parsed.id || null,
    set: parsed.set || null,
    feat: parsed.feat || null,
  });
  if (parsed.json === true) {
    output(status);
  } else {
    process.stdout.write(renderSessionStatusText(status) + '\n');
  }
}

module.exports = {
  handleStatusOverview,
  handleSession,
  recordSessionEvent,
  renderSessionReadme,
  renderSessionArchiveText,
  renderSessionHandoffText,
  renderSessionListText,
  renderSessionLintText,
  renderSessionStatusText,
  sessionArchive,
  sessionArchivePlan,
  sessionHandoff,
  sessionSupersedePlan,
  sessionSupersedeStale,
  sessionList,
  sessionLint,
  sessionStatus,
  snapshotSession,
};
