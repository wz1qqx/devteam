'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const { output, error, parseArgs } = require('./core.cjs');
const { gateFromRun, readRunEvents } = require('./action-plan.cjs');
const { loadWorkspaceConfig } = require('./workspace-config.cjs');
const { resolveTrackSelection, worktreeIdsForSelection } = require('./track-resolver.cjs');

function git(worktreePath, args) {
  try {
    return execFileSync('git', ['-C', worktreePath, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (_) {
    return null;
  }
}

function gitRaw(worktreePath, args) {
  try {
    return execFileSync('git', ['-C', worktreePath, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).replace(/\r?\n$/, '');
  } catch (_) {
    return null;
  }
}

function gitOk(worktreePath, args) {
  try {
    execFileSync('git', ['-C', worktreePath, ...args], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch (_) {
    return false;
  }
}

function shellArg(value) {
  return JSON.stringify(String(value));
}

function shortPath(value) {
  const text = String(value || '');
  if (!text) return '';
  const home = require('os').homedir();
  return text.startsWith(home) ? `~${text.slice(home.length)}` : text;
}

function shortHead(value) {
  const text = String(value || '');
  return text ? text.slice(0, 9) : '-';
}

function formatDirtySummary(summary) {
  const value = summary || {};
  return [
    `staged:${value.staged || 0}`,
    `unstaged:${value.unstaged || 0}`,
    `untracked:${value.untracked || 0}`,
  ].join(' ');
}

function parseDirtyFileLimit(value, flagName) {
  if (value == null) return null;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 0) {
    error(`${flagName || '--limit'} must be a non-negative integer`);
  }
  return limit;
}

function renderWorkspaceStatusText(status, options = {}) {
  const dirtyFileLimit = options.full === true
    ? null
    : (Number.isInteger(options.dirtyFileLimit) ? options.dirtyFileLimit : 10);
  const totals = status.totals || {};
  const lines = [
    `Workspace: ${shortPath(status.workspace)}`,
    `Track: ${status.workspace_set || '(none)'}`,
    `Worktrees: ${totals.present || 0}/${totals.worktrees || 0} present, ${totals.dirty || 0} dirty, ${totals.missing || 0} missing`,
    '',
    'Worktrees:',
  ];

  const worktrees = status.worktrees || [];
  if (!worktrees.length) {
    lines.push('  (none)');
    return lines.join('\n');
  }

  for (const item of worktrees) {
    const branch = item.branch || item.desired_branch || '(no branch)';
    const flags = [
      item.exists ? 'present' : 'missing',
      item.dirty ? 'dirty' : 'clean',
      item.dirty_file_count ? `files:${item.dirty_file_count}` : null,
      item.dirty_file_count ? formatDirtySummary(item.dirty_summary) : null,
      item.commits_ahead == null ? null : `ahead:${item.commits_ahead}`,
      item.publish_after_validation ? 'publish-after-validation' : null,
    ].filter(Boolean).join(', ');
    lines.push(`  ${item.id}  ${item.repo || '-'}  ${branch}  ${shortHead(item.head)}  ${flags}`);
    lines.push(`    path: ${shortPath(item.abs_path || item.path)}`);
    if (!item.exists && item.source_path) {
      lines.push(`    source: ${shortPath(item.abs_source_path || item.source_path)} (${item.source_exists ? 'present' : 'missing'})`);
    }
    const dirtyFiles = item.dirty_files || [];
    const visibleDirtyFiles = dirtyFileLimit == null
      ? dirtyFiles
      : dirtyFiles.slice(0, dirtyFileLimit);
    for (const dirty of visibleDirtyFiles) {
      lines.push(`    ${dirty.status || '??'} ${dirty.path}`);
    }
    const omitted = Math.max((item.dirty_file_count || dirtyFiles.length) - visibleDirtyFiles.length, 0);
    if (omitted > 0) {
      lines.push(`    +${omitted} more dirty files`);
    }
  }

  return lines.join('\n');
}

function parseStatusLine(line) {
  const raw = String(line || '').trimEnd();
  if (!raw) return null;
  const status = raw.slice(0, 2);
  const body = raw.length > 3 ? raw.slice(3) : '';
  const pathText = body.includes(' -> ') ? body.split(' -> ').pop() : body;
  return {
    status,
    path: pathText,
    raw,
    staged: status[0] && status[0] !== ' ' && status[0] !== '?' ? status[0] : null,
    unstaged: status[1] && status[1] !== ' ' && status[1] !== '?' ? status[1] : null,
    untracked: status === '??',
  };
}

function summarizeDirtyFiles(entries) {
  const summary = {
    staged: 0,
    unstaged: 0,
    untracked: 0,
  };
  for (const entry of entries || []) {
    if (entry.staged) summary.staged += 1;
    if (entry.unstaged) summary.unstaged += 1;
    if (entry.untracked) summary.untracked += 1;
  }
  return summary;
}

function selectedWorktreeIds(config, setName, featName = null) {
  const selection = resolveTrackSelection(config, {
    set: setName || null,
    feat: featName || null,
  });
  if (!selection.track) return Object.keys(config.worktrees);
  return worktreeIdsForSelection(config, selection);
}

function readRunSession(run) {
  if (!run || !run.run_dir) return null;
  const sessionPath = path.join(run.run_dir, 'session.json');
  if (!fs.existsSync(sessionPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function inspectWorktree(config, id, options = {}) {
  const entry = config.worktrees[id];
  if (!entry) {
    return {
      id,
      exists: false,
      status: 'undefined',
      reason: 'worktree id is referenced by a track or feature but not defined',
    };
  }

  const exists = fs.existsSync(entry.abs_path);
  const sourceExists = entry.abs_source_path ? fs.existsSync(entry.abs_source_path) : false;
  const result = {
    id: entry.id,
    repo: entry.repo,
    path: entry.path,
    abs_path: entry.abs_path,
    source_path: entry.source_path,
    exists,
    source_exists: sourceExists,
    base_ref: entry.base_ref,
    desired_branch: entry.branch,
    roles: entry.roles,
    publish_after_validation: entry.publish_after_validation,
    publish: entry.publish,
    sync: entry.sync,
    branch: null,
    head: null,
    dirty: false,
    status_summary: [],
    dirty_files: [],
    dirty_file_count: 0,
    dirty_summary: {
      staged: 0,
      unstaged: 0,
      untracked: 0,
    },
    commits_ahead: null,
    status: exists ? 'present' : 'missing',
  };

  if (!exists) return result;

  result.head = git(entry.abs_path, ['rev-parse', '--short', 'HEAD']);
  result.branch = git(entry.abs_path, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = gitRaw(entry.abs_path, ['status', '--porcelain']);
  result.dirty = Boolean(status && status.trim());
  result.status_summary = status
    ? status.split('\n').map(line => line.trimEnd()).filter(Boolean).slice(0, 30)
    : [];
  const dirtyFiles = status
    ? status.split('\n').map(parseStatusLine).filter(Boolean)
    : [];
  const dirtyFileLimit = options.dirtyFileLimit === null
    ? null
    : (Number.isInteger(options.dirtyFileLimit) ? options.dirtyFileLimit : 30);
  const visibleDirtyFiles = dirtyFileLimit == null
    ? dirtyFiles
    : dirtyFiles.slice(0, dirtyFileLimit);
  result.dirty_file_count = dirtyFiles.length;
  result.dirty_summary = summarizeDirtyFiles(dirtyFiles);
  result.dirty_files = visibleDirtyFiles;
  result.dirty_file_limit = dirtyFileLimit;
  result.dirty_files_truncated = visibleDirtyFiles.length < dirtyFiles.length;

  if (entry.base_ref) {
    const ahead = git(entry.abs_path, ['rev-list', '--count', `${entry.base_ref}..HEAD`]);
    result.commits_ahead = ahead == null || ahead === '' ? null : Number(ahead);
  }
  return result;
}

function getWorkspaceStatus(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const selection = resolveTrackSelection(config, {
    set: options.set || null,
    feat: options.feat || null,
  });
  const ids = selection.track ? worktreeIdsForSelection(config, selection) : Object.keys(config.worktrees);
  const worktrees = ids.map(id => inspectWorktree(config, id, {
    dirtyFileLimit: Object.prototype.hasOwnProperty.call(options, 'dirtyFileLimit')
      ? options.dirtyFileLimit
      : 30,
  }));
  const totals = {
    worktrees: worktrees.length,
    present: worktrees.filter(item => item.exists).length,
    missing: worktrees.filter(item => !item.exists).length,
    dirty: worktrees.filter(item => item.dirty).length,
  };

  return {
    workspace: config.root,
    config_path: config.config_path,
    track: selection.track || null,
    feat: selection.feat || null,
    workspace_set: selection.track || null,
    workspace_set_source: selection.track_source,
    selection,
    totals,
    worktrees,
  };
}

function publishPlan(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const selection = resolveTrackSelection(config, {
    set: options.set || null,
    feat: options.feat || null,
  });
  const ids = selection.track ? worktreeIdsForSelection(config, selection) : Object.keys(config.worktrees);
  const inspected = ids.map(id => inspectWorktree(config, id));
  const run = options.run
    ? readRunEvents(config, options.run)
    : null;
  const runSession = readRunSession(run);
  const runGate = run
    ? gateFromRun(run, ['sync', 'test'], {
      session: runSession,
      currentWorktrees: inspected,
    })
    : null;

  const entries = inspected
    .filter(entry => entry.publish_after_validation || (entry.publish && entry.publish.after_validation))
    .map(entry => {
      const remote = entry.publish && entry.publish.remote ? entry.publish.remote : 'origin';
      const targetBranch = entry.publish && entry.publish.branch
        ? entry.publish.branch
        : (entry.desired_branch || entry.branch || null);
      const localBranch = entry.branch || null;
      const exists = entry.exists === true;
      const remoteRef = exists && targetBranch
        ? `refs/remotes/${remote}/${targetBranch}`
        : null;
      const remoteRefExists = Boolean(remoteRef && gitOk(entry.abs_path, ['show-ref', '--verify', remoteRef]));
      const remoteUrl = exists && remote ? git(entry.abs_path, ['remote', 'get-url', remote]) : null;
      const aheadRemote = remoteRefExists
        ? git(entry.abs_path, ['rev-list', '--count', `${remote}/${targetBranch}..HEAD`])
        : null;
      const behindRemote = remoteRefExists
        ? git(entry.abs_path, ['rev-list', '--count', `HEAD..${remote}/${targetBranch}`])
        : null;
      const aheadRemoteCount = aheadRemote == null || aheadRemote === '' ? null : Number(aheadRemote);
      const behindRemoteCount = behindRemote == null || behindRemote === '' ? null : Number(behindRemote);

      const problems = [];
      if (!exists) problems.push('worktree_missing');
      if (entry.dirty) problems.push('worktree_dirty');
      if (!remote) problems.push('publish_remote_missing');
      if (exists && remote && !remoteUrl) problems.push('publish_remote_not_configured');
      if (!targetBranch) problems.push('publish_branch_missing');
      if (localBranch && targetBranch && localBranch !== targetBranch) problems.push('branch_mismatch');
      if (runGate && runGate.status !== 'ready') problems.push('run_gate_not_ready');
      if (aheadRemoteCount > 0 && behindRemoteCount > 0) problems.push('remote_has_unmerged_commits');

      const alreadyPublished = remoteRefExists && aheadRemoteCount === 0;
      const command = problems.length === 0 && !alreadyPublished
        ? `git -C ${shellArg(entry.abs_path)} push ${shellArg(remote)} ${shellArg(`HEAD:${targetBranch}`)}`
        : null;
      const action = problems.length
        ? 'blocked'
        : (alreadyPublished
          ? (behindRemoteCount > 0 ? 'already_published_remote_ahead' : 'already_published')
          : (remoteRefExists ? 'update_remote_branch' : 'create_remote_branch'));

      return {
        id: entry.id,
        repo: entry.repo,
        path: entry.path,
        local_path: entry.abs_path,
        branch: localBranch,
        head: entry.head,
        dirty: entry.dirty,
        commits_ahead_base: entry.commits_ahead,
        publish_status: entry.publish ? entry.publish.status : null,
        remote,
        remote_url: remoteUrl,
        target_branch: targetBranch,
        remote_ref: remoteRef,
        remote_ref_exists: remoteRefExists,
        commits_ahead_remote: aheadRemoteCount,
        commits_behind_remote: behindRemoteCount,
        run_gate_status: runGate ? runGate.status : null,
        action,
        blocked_by: problems,
        command,
        reason: alreadyPublished
          ? (behindRemoteCount > 0
            ? 'remote already contains local HEAD and has additional commits'
            : 'remote already equals local HEAD')
          : null,
        notes: entry.publish ? entry.publish.notes : null,
      };
    });

  const totals = {
    entries: entries.length,
    ready: entries.filter(entry => entry.action !== 'blocked').length,
    blocked: entries.filter(entry => entry.action === 'blocked').length,
    create: entries.filter(entry => entry.action === 'create_remote_branch').length,
    update: entries.filter(entry => entry.action === 'update_remote_branch').length,
    already_published: entries.filter(entry => String(entry.action || '').startsWith('already_published')).length,
  };
  const blockedByRunGate = runGate && runGate.status !== 'ready';
  const allAlreadyPublished = totals.entries > 0 && totals.already_published === totals.entries;
  return {
    action: 'publish_plan',
    workspace: config.root,
    track: selection.track || null,
    feat: selection.feat || null,
    workspace_set: selection.track || null,
    workspace_set_source: selection.track_source,
    selection,
    run_gate: runGate,
    entries,
    totals,
    next_action: blockedByRunGate
      ? 'Record passing sync and test evidence before publishing local-only branches.'
    : (allAlreadyPublished
        ? 'Remote branches already contain the local HEADs. Use ws publish --yes with a ready run to record publish evidence; no git push is needed.'
      : entries.length
        ? 'Review publish commands. Use ws publish after validation is complete; pass --yes only when ready to push.'
        : 'No worktrees in this track or feature are marked publish.after_validation.'),
  };
}

function materializeWorktrees(options = {}) {
  const path = require('path');
  const { execFileSync } = require('child_process');
  const config = loadWorkspaceConfig(options.root || null);
  const selection = resolveTrackSelection(config, {
    set: options.set || null,
    feat: options.feat || null,
  });
  const ids = selection.track ? worktreeIdsForSelection(config, selection) : Object.keys(config.worktrees);
  const apply = options.apply === true;

  const entries = ids.map(id => {
    const entry = config.worktrees[id];
    if (!entry) {
      return { id, action: 'error', reason: 'undefined worktree' };
    }
    const targetExists = fs.existsSync(entry.abs_path);
    const sourceExists = entry.abs_source_path ? fs.existsSync(entry.abs_source_path) : false;
    const command = entry.abs_source_path
      ? `git clone --no-hardlinks "${entry.abs_source_path}" "${entry.abs_path}"`
      : null;

    if (targetExists) {
      return {
        id,
        repo: entry.repo,
        source_path: entry.abs_source_path,
        target_path: entry.abs_path,
        action: 'skip',
        reason: 'target already exists',
        command,
      };
    }
    if (!sourceExists) {
      return {
        id,
        repo: entry.repo,
        source_path: entry.abs_source_path,
        target_path: entry.abs_path,
        action: 'missing_source',
        reason: 'source_path does not exist',
        command,
      };
    }

    if (apply) {
      fs.mkdirSync(path.dirname(entry.abs_path), { recursive: true });
      execFileSync('git', ['clone', '--no-hardlinks', entry.abs_source_path, entry.abs_path], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      return {
        id,
        repo: entry.repo,
        source_path: entry.abs_source_path,
        target_path: entry.abs_path,
        action: 'cloned',
        command,
      };
    }

    return {
      id,
      repo: entry.repo,
      source_path: entry.abs_source_path,
      target_path: entry.abs_path,
      action: 'clone',
      command,
    };
  });

  return {
    workspace: config.root,
    track: selection.track || null,
    feat: selection.feat || null,
    workspace_set: selection.track || null,
    workspace_set_source: selection.track_source,
    selection,
    applied: apply,
    entries,
    totals: {
      entries: entries.length,
      clone: entries.filter(entry => entry.action === 'clone').length,
      cloned: entries.filter(entry => entry.action === 'cloned').length,
      skipped: entries.filter(entry => entry.action === 'skip').length,
      blocked: entries.filter(entry => entry.action === 'missing_source' || entry.action === 'error').length,
    },
  };
}

function executePublish(entry) {
  const started = Date.now();
  const result = spawnSync('git', [
    '-C',
    entry.local_path,
    'push',
    entry.remote,
    `HEAD:${entry.target_branch}`,
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status === 0 ? 'passed' : 'failed',
    exit_code: typeof result.status === 'number' ? result.status : 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    duration_ms: Date.now() - started,
  };
}

function publishWorktrees(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const execute = options.yes === true;
  const requireRunGate = options.requireRunGate !== false;
  if (execute && options.run) {
    const runDir = path.isAbsolute(String(options.run))
      ? String(options.run)
      : path.join(config.root, '.devteam', 'runs', String(options.run));
    if (!fs.existsSync(runDir) || !fs.statSync(runDir).isDirectory()) {
      error(`Run directory not found: ${runDir}`);
    }
  }
  const plan = publishPlan({
    root: config.root,
    set: options.set || null,
    feat: options.feat || null,
    run: options.run || null,
  });
  const gateMissing = requireRunGate && !plan.run_gate;
  const gateBlocked = requireRunGate && plan.run_gate && plan.run_gate.status !== 'ready';
  const results = [];

  for (const entry of plan.entries) {
    const blockedBy = Array.from(new Set([
      ...(entry.blocked_by || []),
      gateMissing ? 'run_required' : null,
      gateBlocked ? 'run_gate_not_ready' : null,
    ].filter(Boolean)));

    if (blockedBy.length > 0) {
      results.push({
        id: entry.id,
        repo: entry.repo,
        action: 'blocked',
        status: 'skipped',
        blocked_by: blockedBy,
        command: entry.command,
      });
      continue;
    }

    if (String(entry.action || '').startsWith('already_published')) {
      results.push({
        id: entry.id,
        repo: entry.repo,
        action: entry.action,
        status: 'skipped',
        reason: entry.reason || 'remote already contains local HEAD',
        remote: entry.remote,
        target_branch: entry.target_branch,
        command: entry.command,
      });
      continue;
    }

    if (!execute) {
      results.push({
        id: entry.id,
        repo: entry.repo,
        action: entry.action,
        status: 'planned',
        remote: entry.remote,
        target_branch: entry.target_branch,
        command: entry.command,
      });
      continue;
    }

    const pushResult = executePublish(entry);
    results.push({
      id: entry.id,
      repo: entry.repo,
      action: entry.action,
      remote: entry.remote,
      target_branch: entry.target_branch,
      command: entry.command,
      ...pushResult,
    });
    if (pushResult.status !== 'passed' && options.continueOnError !== true) break;
  }

  const pushed = results.filter(item => item.status === 'passed').length;
  const failed = results.filter(item => item.status === 'failed').length;
  const planned = results.filter(item => item.status === 'planned').length;
  const blocked = results.filter(item => item.action === 'blocked').length;
  const alreadyPublished = results.filter(item => String(item.action || '').startsWith('already_published')).length;
  const allAlreadyPublished = results.length > 0 && alreadyPublished === results.length;
  const payload = {
    action: 'publish',
    workspace: config.root,
    track: plan.track || null,
    feat: plan.feat || null,
    workspace_set: plan.workspace_set,
    dry_run: !execute,
    status: results.length === 0
      ? 'noop'
      : (failed > 0
      ? 'failed'
      : (blocked > 0 ? 'blocked' : (execute ? 'applied' : 'planned'))),
    run_gate: plan.run_gate,
    require_run_gate: requireRunGate,
    totals: {
      entries: results.length,
      pushed,
      planned,
      blocked,
      already_published: alreadyPublished,
      failed,
    },
    results,
    next_action: results.length === 0
      ? 'No worktrees in this track or feature are marked publish.after_validation.'
      : (execute
      ? 'Review publish results and session status.'
      : (allAlreadyPublished
        ? 'Remote branches already contain the local HEADs. Re-run with --yes and a ready run to record publish evidence; no git push is needed.'
        : 'Review planned pushes. Re-run with --yes to publish after validation is complete.')),
  };

  if (execute && options.run) {
    const { recordSessionEvent } = require('./session-manager.cjs');
    payload.record = recordSessionEvent({
      root: config.root,
      run: options.run,
      set: options.set || plan.workspace_set || null,
      feat: options.feat || plan.feat || null,
      allowCrossTrack: options.allowCrossTrack === true,
      allowStaleHead: options.allowStaleHead === true,
      kind: 'publish',
      status: payload.status === 'applied' ? 'passed' : 'failed',
      summary: `publish ${payload.status}: ${pushed} pushed, ${alreadyPublished} already published, ${failed} failed, ${blocked} blocked`,
      command: [
        'devteam ws publish',
        plan.workspace_set ? `--set ${plan.workspace_set}` : null,
        plan.feat ? `--feat ${plan.feat}` : null,
        `--run ${options.run}`,
        '--yes',
      ].filter(Boolean).join(' '),
    });
  }

  return payload;
}

function handleWorkspaceInventory(subcommand, args) {
  const parsed = parseArgs(args || []);
  if (!subcommand || subcommand === 'status') {
    const parsedLimit = parsed.limit == null
      ? null
      : parseDirtyFileLimit(parsed.limit, '--limit');
    const full = parsed.full === true;
    const statusDirtyFileLimit = full
      ? null
      : (parsedLimit == null ? 30 : parsedLimit);
    const status = getWorkspaceStatus({
      root: parsed.root || null,
      set: parsed.set || null,
      feat: parsed.feat || null,
      dirtyFileLimit: statusDirtyFileLimit,
    });
    if (parsed.text === true) {
      process.stdout.write(renderWorkspaceStatusText(status, {
        full,
        dirtyFileLimit: parsedLimit == null ? 10 : parsedLimit,
      }) + '\n');
    } else {
      output(status);
    }
    return;
  }
  if (subcommand === 'materialize') {
    output(materializeWorktrees({
      root: parsed.root || null,
      set: parsed.set || null,
      feat: parsed.feat || null,
      apply: parsed.apply === true,
    }));
    return;
  }
  if (subcommand === 'publish-plan') {
    output(publishPlan({
      root: parsed.root || null,
      set: parsed.set || null,
      feat: parsed.feat || null,
      run: parsed.run || null,
    }));
    return;
  }
  if (subcommand === 'publish') {
    output(publishWorktrees({
      root: parsed.root || null,
      set: parsed.set || null,
      feat: parsed.feat || null,
      run: parsed.run || null,
      yes: parsed.yes === true,
      requireRunGate: parsed['no-run-gate'] === true ? false : true,
      continueOnError: parsed['continue-on-error'] === true,
      allowCrossTrack: parsed['allow-cross-track'] === true,
      allowStaleHead: parsed['allow-stale-head'] === true,
    }));
    return;
  }
  error(`Unknown ws subcommand: '${subcommand}'. Use: status, materialize, publish-plan, publish`);
}

module.exports = {
  getWorkspaceStatus,
  handleWorkspaceInventory,
  materializeWorktrees,
  publishPlan,
  publishWorktrees,
  renderWorkspaceStatusText,
  selectedWorktreeIds,
};
