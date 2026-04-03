'use strict';

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const { output, error, findWorkspaceRoot, expandHome } = require('./core.cjs');
const { loadConfig, getActiveFeatureWithRepos, getActiveCluster, getFeatureRepos, listFeatures } = require('./config.cjs');
const { loadState, getPhase } = require('./state.cjs');
const { loadStateMd, readHandoff } = require('./session.cjs');
const { parseArgs } = require('./core.cjs');

/**
 * initWorkflow — compound context loader.
 * Returns ALL context a workflow needs as a single JSON blob.
 * Workflows should ONLY use this output, never call read-config separately.
 *
 * Requires schema_version: 2.
 */
async function initWorkflow(workflowName, args) {
  if (!workflowName) {
    error('Usage: init <workflow> [--feature <name>] [args...]');
  }

  const root = findWorkspaceRoot();
  if (!root) error('.dev.yaml not found');

  const config = loadConfig(root);

  // Parse --feature flag from args
  const parsed = parseArgs(args);
  const featureOverride = parsed.feature || null;

  if (workflowName === 'workspace') {
    return initWorkspace(config, root);
  }
  if (workflowName === 'feature') {
    return initFeature(config, root, args);
  }

  // --- Workflow data requirements ---
  // Each flag indicates a data source the workflow needs.
  // Only flagged sources are loaded, avoiding unnecessary I/O.
  const workflowNeeds = {
    'code':        { featureState: true },
    'code-spec':   { memory: true, knowledge: true, featureState: true },
    'code-plan':   { memory: true, knowledge: true, featureState: true, buildHistory: true, devlog: true },
    'code-exec':   { memory: true, featureState: true },
    'code-review': { memory: true, featureState: true },
    'build':       { buildHistory: true, buildConfig: true },
    'deploy':      { cluster: true, allClusters: true, deployConfig: true, buildServer: true },
    'verify':      { cluster: true, buildHistory: true, benchmarkConfig: true, deployConfig: true, buildServer: true },
    'rollback':    { cluster: true, allClusters: true, deployConfig: true, fullBuildHistory: true, buildServer: true },
    'observe':     { cluster: true, observability: true },
    'debug':       { memory: true, cluster: true, knowledge: true, buildHistory: true, devlog: true },
    'diff':        { gitStatus: false },
    'status':      { cluster: true, featureState: true, buildHistory: true },
    'clean':       { cluster: true, allFeatures: true, buildServer: true, gitStatus: false },
    'cluster':     { cluster: true, rawClusters: true, gitStatus: false },
    'log':         { devlog: true, gitStatus: false },
    'resume':      { memory: true, cluster: true, knowledge: true, buildHistory: true, artifacts: true, featureState: true },
    'pause':       { memory: true, knowledge: true, artifacts: true, devlog: true },
    'learn':       { memory: true, knowledge: true, featureState: true, devlog: true, workspaceRepos: true },
    'quick':       { memory: true, knowledge: true, featureState: true, buildHistory: true },
    'next':        { memory: true, cluster: true, featureState: true, buildHistory: true, artifacts: true },
    'discuss':     { memory: true, knowledge: true, featureState: true },
    'knowledge':   { knowledge: true },
    'switch':      { featureState: true, gitStatus: false },
  };

  const needs = workflowNeeds[workflowName] || { all: true };
  const needsAll = needs.all === true;
  const skipGit = needs.gitStatus === false && !needsAll;

  const featureWithRepos = getActiveFeatureWithRepos(config, featureOverride);
  const phase = getPhase(config, featureWithRepos.name);
  const workspace = expandHome(config.workspace) || root;
  const vault = expandHome(config.vault) || null;

  const defaultTuning = {
    regression_threshold: 20,
    max_task_retries: 2,
    deploy_timeout: 300,
    deploy_poll_interval: 15,
    build_history_limit: 5,
    commit_format: 'feat({feature}): {title}',
  };
  const tuning = { ...defaultTuning, ...((config.defaults && config.defaults.tuning) || {}) };

  const repos = await buildReposContextAsync(featureWithRepos, workspace, { skipGit });
  const invariants = featureWithRepos.invariants || {};
  const hooks = featureWithRepos.hooks || {};

  // Base context — shared by ALL workflows
  const base = {
    feature: {
      name: featureWithRepos.name,
      description: featureWithRepos.description || '',
      phase,
      current_tag: featureWithRepos.current_tag || null,
      base_image: featureWithRepos.base_image || null,
    },
    repos,
    workspace,
    vault,
    invariants,
    hooks,
    tuning,
    config_path: config._path,
  };

  // --- Lazy-loaded data sources (only computed when needed) ---
  const featureName = featureWithRepos.name || parsed._[0] || null;
  const devDir = path.join(root, '.dev');

  const knowledgeNotes = (needsAll || needs.knowledge)
    ? collectKnowledgeNotes(vault, config) : [];

  let stateMd = null;
  let decisions = [];
  let blockers = [];
  let handoff = null;
  let featureContext = null;
  let experienceNotes = [];
  if (needsAll || needs.memory) {
    stateMd = loadStateMd(root, featureWithRepos.name);
    decisions = stateMd ? stateMd.decisions : [];
    blockers = stateMd ? stateMd.blockers.filter(b => b.status === 'active') : [];
    handoff = readHandoff(root, featureWithRepos.name);
    if (featureName) {
      const contextPath = path.join(devDir, 'features', featureName, 'context.md');
      if (fs.existsSync(contextPath)) {
        try { featureContext = fs.readFileSync(contextPath, 'utf8'); } catch (_) { /* ignore */ }
      }
    }
    experienceNotes = collectExperienceNotes(vault, config, featureName);
  }

  const featureState = (needsAll || needs.featureState)
    ? buildFeatureState(featureName, devDir) : {};

  const buildHistory = (needsAll || needs.buildHistory)
    ? (featureWithRepos.build_history || []).slice(-tuning.build_history_limit) : [];

  const cluster = (needsAll || needs.cluster) ? getActiveCluster(config) : null;
  const clusterCtx = cluster ? {
    name: cluster.name,
    ssh: cluster.ssh,
    namespace: cluster.namespace,
    safety: cluster.safety || 'normal',
    hardware: cluster.hardware || null,
    network: cluster.network || null,
  } : null;

  const state = (needsAll || needs.artifacts) ? loadState(featureWithRepos.name) : null;

  const memoryContext = {
    state: stateMd ? stateMd.frontmatter : null,
    decisions,
    blockers,
    feature_context: featureContext,
    handoff,
    experience_notes: experienceNotes,
  };

  // --- Build workflow-specific output ---
  const workflowContextMap = {
    'code':        { ...base, feature_state: featureState },
    'code-spec':   { ...base, ...memoryContext, knowledge_notes: knowledgeNotes, feature_state: featureState },
    'code-plan':   { ...base, ...memoryContext, knowledge_notes: knowledgeNotes, feature_state: featureState, build_history: buildHistory, devlog: config.devlog || {} },
    'code-exec':   { ...base, ...memoryContext, feature_state: featureState },
    'code-review': { ...base, ...memoryContext, feature_state: featureState },
    'build':       { ...base, build_history: buildHistory, build: featureWithRepos.build || {}, build_server: config.build_server || null },
    'deploy':      { ...base, cluster: clusterCtx, all_clusters: buildClusterSummary(config), deploy: featureWithRepos.deploy || {}, build_server: config.build_server || null },
    'verify':      { ...base, cluster: clusterCtx, benchmark: featureWithRepos.benchmark || {}, verify: featureWithRepos.verify || {}, build_history: buildHistory, deploy: featureWithRepos.deploy || {}, build_server: config.build_server || null },
    'rollback':    { ...base, cluster: clusterCtx, all_clusters: buildClusterSummary(config), deploy: featureWithRepos.deploy || {}, build_history: (featureWithRepos.build_history || []), build_server: config.build_server || null },
    'observe':     { ...base, cluster: clusterCtx, observability: config.observability || {} },
    'debug':       { ...base, ...memoryContext, cluster: clusterCtx, knowledge_notes: knowledgeNotes, build_history: buildHistory, devlog: config.devlog || {} },
    'diff':        { ...base },
    'status':      { ...base, cluster: clusterCtx, feature_state: featureState, build_history: buildHistory },
    'clean':       { ...base, cluster: clusterCtx, all_features: buildAllFeaturesContext(config, workspace), build_server: config.build_server || null },
    'cluster':     { ...base, cluster: clusterCtx, all_clusters: config.clusters || {} },
    'log':         { ...base, devlog: config.devlog || {} },
    'resume':      { ...base, ...memoryContext, cluster: clusterCtx, knowledge_notes: knowledgeNotes, build_history: buildHistory, artifacts: state, feature_state: featureState },
    'pause':       { ...base, ...memoryContext, knowledge_notes: knowledgeNotes, artifacts: state, devlog: config.devlog || {} },
    'learn':       { ...base, ...memoryContext, knowledge_notes: knowledgeNotes, feature_state: featureState, devlog: config.devlog || {}, workspace_repos: config.repos || {} },
    'quick':       { ...base, ...memoryContext, knowledge_notes: knowledgeNotes, feature_state: featureState, build_history: buildHistory },
    'next':        { ...base, ...memoryContext, cluster: clusterCtx, feature_state: featureState, build_history: buildHistory, artifacts: state },
    'discuss':     { ...base, ...memoryContext, knowledge_notes: knowledgeNotes, feature_state: featureState },
    'knowledge':   { ...base, knowledge_notes: knowledgeNotes },
    'switch':      { ...base, feature_state: featureState },
  };

  const context = workflowContextMap[workflowName];
  if (!context) {
    output({
      ...base,
      ...memoryContext,
      cluster: clusterCtx,
      build_history: buildHistory,
      knowledge_notes: knowledgeNotes,
      feature_state: featureState,
      artifacts: state,
      deploy: featureWithRepos.deploy || {},
      build: featureWithRepos.build || {},
      benchmark: featureWithRepos.benchmark || {},
      build_server: config.build_server || null,
      devlog: config.devlog || {},
      observability: config.observability || {},
    });
    return;
  }

  output(context);
}

function initWorkspace(config, root) {
  const workspace = expandHome(config.workspace) || root;
  const vault = expandHome(config.vault) || null;
  const features = listFeatures(config);

  const repoStatus = {};
  for (const [repoName, repo] of Object.entries(config.repos || {})) {
    const baselines = {};
    for (const [ref, dirName] of Object.entries(repo.baselines || {})) {
      const worktreePath = path.resolve(workspace, dirName);
      baselines[ref] = { worktree: worktreePath, exists: fs.existsSync(worktreePath) };
    }
    repoStatus[repoName] = { upstream: repo.upstream || null, baselines };
  }

  output({
    schema_version: config.schema_version || 2,
    workspace,
    vault,
    repos: repoStatus,
    clusters: Object.keys(config.clusters || {}),
    active_cluster: config.defaults && config.defaults.active_cluster,
    active_feature: config.defaults && config.defaults.active_feature,
    build_server: config.build_server || null,
    devlog: config.devlog || null,
    features,
    config_path: config._path,
  });
}

async function initFeature(config, root, args) {
  const featureName = args[0] || (config.defaults && config.defaults.active_feature);
  if (!featureName) {
    error('Usage: init feature <name>  (or set defaults.active_feature)');
  }
  const feat = config.features && config.features[featureName];
  if (!feat) {
    error(`Feature '${featureName}' not found. Available: ${Object.keys(config.features || {}).join(', ')}`);
  }

  const workspace = expandHome(config.workspace) || root;
  const vault = expandHome(config.vault) || null;
  const repoEntries = getFeatureRepos(config, featureName);

  const repos = {};
  const repoResults = await Promise.all(
    repoEntries.map(entry =>
      buildSingleRepoContextAsync(entry, workspace).then(ctx => ({
        repo: entry.repo,
        ctx: { ...ctx, build_type: entry.build_type },
      }))
    )
  );
  for (const { repo, ctx } of repoResults) {
    repos[repo] = ctx;
  }

  const devDir = path.join(root, '.dev');
  const featureState = buildFeatureState(featureName, devDir);

  output({
    feature: {
      name: featureName,
      description: feat.description || '',
      phase: feat.phase || 'init',
      current_tag: feat.current_tag || null,
      base_image: feat.base_image || null,
    },
    repos,
    workspace,
    vault,
    invariants: feat.invariants || {},
    hooks: feat.hooks || {},
    deploy: feat.deploy || null,
    build: feat.build || null,
    benchmark: feat.benchmark || null,
    build_history: (feat.build_history || []).slice(-5),
    feature_state: featureState,
    config_path: config._path,
  });
}

// --- Helper functions ---

async function buildSingleRepoContextAsync(entry, workspace, { skipGit = false } = {}) {
  const devWorktree = entry.dev_worktree ? path.resolve(workspace, entry.dev_worktree) : null;
  const baseWorktree = entry.base_worktree ? path.resolve(workspace, entry.base_worktree) : null;

  let commitCount = 0;
  let hasUncommitted = false;
  if (!skipGit && devWorktree && fs.existsSync(devWorktree)) {
    const [logResult, statusResult] = await Promise.allSettled([
      execAsync(
        `git -C "${devWorktree}" log --oneline ${entry.base_ref || 'HEAD~10'}..HEAD 2>/dev/null | wc -l`,
        { encoding: 'utf8', timeout: 5000 }
      ),
      execAsync(
        `git -C "${devWorktree}" status --porcelain 2>/dev/null | head -1`,
        { encoding: 'utf8', timeout: 5000 }
      ),
    ]);
    if (logResult.status === 'fulfilled') {
      commitCount = parseInt(logResult.value.stdout.trim(), 10) || 0;
    }
    if (statusResult.status === 'fulfilled') {
      hasUncommitted = statusResult.value.stdout.trim().length > 0;
    }
  }

  return {
    upstream: entry.upstream || null,
    base_ref: entry.base_ref || null,
    base_worktree: baseWorktree,
    dev_worktree: devWorktree,
    commits_ahead: commitCount,
    has_uncommitted: hasUncommitted,
  };
}

async function buildReposContextAsync(featureWithRepos, workspace, { skipGit = false } = {}) {
  const repos = {};
  if (featureWithRepos.repos) {
    const entries = Object.entries(featureWithRepos.repos);
    const results = await Promise.all(
      entries.map(([repoName, repo]) =>
        buildSingleRepoContextAsync(repo, workspace, { skipGit }).then(ctx => {
          if (repo.build_type) ctx.build_type = repo.build_type;
          return { repoName, ctx };
        })
      )
    );
    for (const { repoName, ctx } of results) {
      repos[repoName] = ctx;
    }
  }
  return repos;
}

/**
 * Build context for ALL features (used by clean workflow to find orphans).
 */
function buildAllFeaturesContext(config, workspace) {
  const result = {};
  for (const [name, feat] of Object.entries(config.features || {})) {
    const scope = {};
    for (const [repoName, scopeEntry] of Object.entries(feat.scope || {})) {
      scope[repoName] = {
        dev_worktree: scopeEntry.dev_worktree || null,
        base_worktree: scopeEntry.base_worktree || null,
      };
    }
    result[name] = {
      phase: feat.phase || 'init',
      current_tag: feat.current_tag || null,
      scope,
      build_history_tags: (feat.build_history || []).map(h => h.tag),
    };
  }
  return result;
}

/**
 * Build a compact cluster summary for interactive selection.
 */
function buildClusterSummary(config) {
  const clusters = config.clusters || {};
  const result = {};
  for (const [name, cluster] of Object.entries(clusters)) {
    result[name] = {
      namespace: cluster.namespace || 'default',
      safety: cluster.safety || 'normal',
      gpu: (cluster.hardware && cluster.hardware.gpu) || 'unknown',
    };
  }
  return result;
}

function collectKnowledgeNotes(vault, config) {
  const knowledgeNotes = [];
  if (vault && config.devlog && config.devlog.group) {
    const knowledgeDir = path.join(vault, config.devlog.group, 'knowledge');
    if (fs.existsSync(knowledgeDir)) {
      try {
        const files = fs.readdirSync(knowledgeDir).filter(f => f.endsWith('.md'));
        for (const file of files) {
          knowledgeNotes.push({
            name: file.replace(/\.md$/, ''),
            path: path.join(knowledgeDir, file),
          });
        }
      } catch (_) { /* ignore */ }
    }
  }
  return knowledgeNotes;
}

function collectExperienceNotes(vault, config, featureName) {
  const experienceNotes = [];
  if (vault && config.devlog && config.devlog.group) {
    const experienceDir = path.join(vault, config.devlog.group, 'experience');
    if (fs.existsSync(experienceDir)) {
      try {
        const files = fs.readdirSync(experienceDir).filter(f => f.endsWith('.md'));
        for (const file of files) {
          const noteName = file.replace(/\.md$/, '');
          if (!featureName || noteName.toLowerCase().includes(featureName.toLowerCase())) {
            experienceNotes.push({ name: noteName, path: path.join(experienceDir, file) });
          }
        }
      } catch (_) { /* ignore */ }
    }
  }
  return experienceNotes;
}

function buildFeatureState(featureName, devDir) {
  const featureState = {};
  if (featureName) {
    featureState.name = featureName;
    const featureDir = path.join(devDir, 'features', featureName);
    featureState.spec_exists = fs.existsSync(path.join(featureDir, 'spec.md'));
    featureState.plan_exists = fs.existsSync(path.join(featureDir, 'plan.md'));
    featureState.review_exists = fs.existsSync(path.join(featureDir, 'review.md'));
    featureState.context_exists = fs.existsSync(path.join(featureDir, 'context.md'));
    featureState.summary_exists = fs.existsSync(path.join(featureDir, 'summary.md'));
  }
  return featureState;
}

module.exports = { initWorkflow };
