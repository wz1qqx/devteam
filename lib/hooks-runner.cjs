'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const { output, error, parseArgs, findWorkspaceRoot, expandHome } = require('./core.cjs');
const { loadConfig, requireFeature, getFeatureRepos } = require('./config.cjs');
const { readRunState, getRunPath } = require('./run-state.cjs');

const PHASE_POLICIES = Object.freeze({
  pre_build: { blocking: true },
  post_build: { blocking: false },
  pre_deploy: { blocking: true },
  post_deploy: { blocking: false },
  post_verify: { blocking: false },
});

function resolveWorkspaceRoot(rootArg) {
  const root = rootArg ? findWorkspaceRoot(rootArg) : findWorkspaceRoot();
  if (!root) error('workspace.yaml not found');
  return root;
}

function sanitizeEnvSuffix(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function buildHookEnvironment({ workspace, featureName, phase, trigger, runPath, runState, repos }) {
  const env = {
    ...process.env,
    DEVTEAM_FEATURE: featureName,
    DEVTEAM_PHASE: phase,
    DEVTEAM_TRIGGER: trigger,
    DEVTEAM_WORKSPACE: workspace,
    DEVTEAM_RUN_PATH: runPath,
    DEVTEAM_REPOS: repos.map(repo => repo.repo).join(','),
  };

  if (runState && runState.run_id) {
    env.DEVTEAM_RUN_ID = String(runState.run_id);
  }

  if (repos.length === 1) {
    const single = repos[0];
    env.DEVTEAM_REPO = single.repo || '';
    env.DEVTEAM_DEV_WORKTREE = single.dev_worktree || '';
    env.DEVTEAM_BASE_WORKTREE = single.base_worktree || '';
    env.DEVTEAM_BASE_REF = single.base_ref || '';
  }

  for (const repo of repos) {
    const suffix = sanitizeEnvSuffix(repo.repo);
    if (!suffix) continue;
    env[`DEVTEAM_REPO_${suffix}_DEV_WORKTREE`] = repo.dev_worktree || '';
    env[`DEVTEAM_REPO_${suffix}_BASE_WORKTREE`] = repo.base_worktree || '';
    env[`DEVTEAM_REPO_${suffix}_BASE_REF`] = repo.base_ref || '';
  }

  return env;
}

function normalizeHookEntry(raw, meta) {
  const { source, index, trigger } = meta;
  if (typeof raw === 'string') {
    const command = raw.trim();
    if (!command) return null;
    return {
      source,
      index,
      name: `${source}-${index + 1}`,
      command,
      trigger,
      cwd: null,
      env: {},
    };
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    error(`Invalid hook entry in ${source}[${index}]. Expected string or object.`);
  }

  const command = (raw.command || raw.script || raw.rule || '').trim();
  if (!command) {
    error(`Hook entry ${source}[${index}] is missing command/script/rule.`);
  }

  const cwd = raw.cwd ? String(raw.cwd).trim() : null;
  const hookEnv = {};
  if (raw.env != null) {
    if (typeof raw.env !== 'object' || Array.isArray(raw.env)) {
      error(`Hook entry ${source}[${index}].env must be a mapping.`);
    }
    for (const [key, value] of Object.entries(raw.env)) {
      hookEnv[String(key)] = String(value == null ? '' : value);
    }
  }

  return {
    source,
    index,
    name: raw.name ? String(raw.name).trim() : `${source}-${index + 1}`,
    command,
    trigger: raw.trigger ? String(raw.trigger).trim() : trigger,
    cwd,
    env: hookEnv,
  };
}

function collectPhaseHooks(feature, phase, trigger) {
  const phaseHooks = Array.isArray(feature.hooks[phase]) ? feature.hooks[phase] : [];
  const normalized = phaseHooks.map((entry, index) => normalizeHookEntry(entry, {
    source: phase,
    index,
    trigger,
  }));

  const learned = Array.isArray(feature.hooks.learned) ? feature.hooks.learned : [];
  const learnedFiltered = learned.filter(entry => {
    if (entry && typeof entry === 'object' && !Array.isArray(entry) && entry.trigger != null) {
      return String(entry.trigger).trim() === trigger;
    }
    return false;
  });
  const normalizedLearned = learnedFiltered.map((entry, index) => normalizeHookEntry(entry, {
    source: 'learned',
    index,
    trigger,
  }));

  return [...normalized, ...normalizedLearned];
}

function resolveHookCwd(workspace, hookCwd) {
  if (!hookCwd) return workspace;
  if (path.isAbsolute(hookCwd)) return hookCwd;
  return path.resolve(workspace, hookCwd);
}

function executeHook(hook, context) {
  const started = Date.now();
  const cwd = resolveHookCwd(context.workspace, hook.cwd);
  const child = spawnSync(hook.command, {
    shell: true,
    cwd,
    env: { ...context.env, ...hook.env },
    encoding: 'utf8',
  });
  const elapsed = Date.now() - started;

  return {
    name: hook.name,
    source: hook.source,
    trigger: hook.trigger,
    command: hook.command,
    cwd,
    blocking: context.blocking,
    status: child.status === 0 ? 'passed' : 'failed',
    exit_code: typeof child.status === 'number' ? child.status : 1,
    stdout: child.stdout || '',
    stderr: child.stderr || '',
    duration_ms: elapsed,
  };
}

function runHooks(root, featureName, options = {}) {
  const config = loadConfig(root);
  const feature = requireFeature(config, featureName);
  const workspace = expandHome(config.workspace) || root;
  const phase = String(options.phase || '').trim();
  if (!phase) error('--phase is required');
  if (!Object.prototype.hasOwnProperty.call(PHASE_POLICIES, phase)) {
    error(`Unsupported hook phase '${phase}'. Valid: ${Object.keys(PHASE_POLICIES).join(', ')}`);
  }

  const trigger = options.trigger ? String(options.trigger).trim() : phase;
  const blocking = PHASE_POLICIES[phase].blocking;
  const hooks = collectPhaseHooks(feature, phase, trigger);
  const runPath = getRunPath(root, feature.name);
  const runState = readRunState(root, feature.name);
  const repos = getFeatureRepos(config, feature.name);
  const env = buildHookEnvironment({
    workspace,
    featureName: feature.name,
    phase,
    trigger,
    runPath,
    runState,
    repos,
  });

  const results = [];
  const warnings = [];
  for (const hook of hooks) {
    const result = executeHook(hook, {
      workspace,
      env,
      blocking,
    });
    results.push(result);
    if (result.status === 'failed') {
      const warning = `${result.name} failed with exit ${result.exit_code}`;
      if (blocking) {
        error(
          `Blocking hook failed for phase '${phase}': ${warning}\n` +
          `command: ${result.command}\n` +
          `${result.stderr || result.stdout || '(no output)'}`
        );
      }
      warnings.push(warning);
    }
  }

  const succeeded = results.filter(item => item.status === 'passed').length;
  const failed = results.filter(item => item.status === 'failed').length;

  return {
    feature: feature.name,
    phase,
    trigger,
    blocking,
    hook_count: hooks.length,
    executed_count: results.length,
    succeeded_count: succeeded,
    failed_count: failed,
    warnings,
    hooks: results,
  };
}

function handleHooks(subcommand, args) {
  if (subcommand !== 'run') {
    error(`Unknown hooks subcommand: '${subcommand}'. Use: run`);
  }

  const parsed = parseArgs(args || []);
  const root = resolveWorkspaceRoot(parsed.root || null);
  const config = loadConfig(root);
  const feature = requireFeature(config, parsed.feature || null);

  const result = runHooks(root, feature.name, {
    phase: parsed.phase || null,
    trigger: parsed.trigger || null,
  });
  output(result);
}

module.exports = {
  PHASE_POLICIES,
  buildHookEnvironment,
  normalizeHookEntry,
  collectPhaseHooks,
  executeHook,
  runHooks,
  handleHooks,
};
