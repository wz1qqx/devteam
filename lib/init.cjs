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

  // --- Workflow data requirements (v2 pipeline) ---
  // Each flag indicates a data source the workflow needs.
  // Only flagged sources are loaded, avoiding unnecessary I/O.
  const workflowNeeds = {
    // === Team orchestration (primary workflow) ===
    'team':         { memory: true, knowledge: true, featureState: true, cluster: true, allClusters: true, buildHistory: true, buildConfig: true, deployConfig: true, buildServer: true, benchmarkConfig: true, devlog: true },
    // Team sub-agent workflows (each agent loads only what it needs)
    'team-spec':    { memory: true, knowledge: true, featureState: true },
    'team-plan':    { memory: true, knowledge: true, featureState: true, buildHistory: true, devlog: true },
    'team-code':    { memory: true, knowledge: true, featureState: true },
    'team-review':  { memory: true, knowledge: true, featureState: true },
    'team-build':   { cluster: true, buildHistory: true, buildConfig: true, buildServer: true, knowledge: true, devlog: true },
    'team-deploy':  { cluster: true, allClusters: true, deployConfig: true, buildServer: true },
    'team-verify':  { cluster: true, buildHistory: true, benchmarkConfig: true, deployConfig: true, buildServer: true, knowledge: true, devlog: true },
    'team-vllm-opt': { cluster: true, buildHistory: true, benchmarkConfig: true, knowledge: true, devlog: true },
    // === Retained independent skills ===
    'learn':        { memory: true, knowledge: true, featureState: true, devlog: true, workspaceRepos: true },
    // Session & utilities
    'pause':        { memory: true, knowledge: true, artifacts: true, devlog: true },
    'resume':       { memory: true, cluster: true, knowledge: true, buildHistory: true, artifacts: true, featureState: true },
    'diff':         { gitStatus: false },
    'status':       { cluster: true, featureState: true, buildHistory: true, knowledge: true },
    'knowledge':    { knowledge: true, workspaceRepos: true },
    // Project management
    'clean':        { cluster: true, allFeatures: true, buildServer: true, gitStatus: false },
    'cluster':      { cluster: true, rawClusters: true, gitStatus: false },
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
    max_optimization_loops: 3,
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
  const wikiDir = resolveWikiDir(vault, config, workspace);
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
    wiki_dir: wikiDir,
    invariants,
    hooks,
    tuning,
    config_path: config._path,
  };

  // --- Lazy-loaded data sources (only computed when needed) ---
  const featureName = featureWithRepos.name || parsed._[0] || null;
  const devDir = path.join(root, '.dev');

  const knowledgeNotes = (needsAll || needs.knowledge)
    ? collectWikiPages(vault, config, workspace) : [];

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

  let cluster = null;
  if (needsAll || needs.cluster) {
    try {
      cluster = getActiveCluster(config, featureOverride);
    } catch (e) {
      process.stderr.write(`[devflow] WARN: cluster load failed (${e.message}), continuing without cluster context\n`);
    }
  }
  const clusterCtx = cluster ? {
    name: cluster.name,
    ssh: cluster.ssh,
    namespace: cluster.namespace,
    safety: cluster.safety || 'normal',
    hardware: cluster.hardware || null,
    network: cluster.network || null,
  } : null;

  let state = null;
  if (needsAll || needs.artifacts) {
    try {
      state = loadState(featureWithRepos.name, root);
    } catch (e) {
      process.stderr.write(`[devflow] WARN: artifact state load failed (${e.message}), continuing without artifacts\n`);
    }
  }

  const memoryContext = {
    state: stateMd ? stateMd.frontmatter : null,
    decisions,
    blockers,
    feature_context: featureContext,
    handoff,
    experience_notes: experienceNotes,
  };

  // --- Build workflow-specific output (v2 pipeline) ---
  const workflowContextMap = {
    // === Team orchestration ===
    'team':         { ...base, ...memoryContext, cluster: clusterCtx, all_clusters: buildClusterSummary(config), build_history: buildHistory, build: featureWithRepos.build || {}, deploy: featureWithRepos.deploy || {}, build_server: config.build_server || null, benchmark: featureWithRepos.benchmark || {}, verify: featureWithRepos.verify || {}, knowledge_notes: knowledgeNotes, feature_state: featureState, devlog: config.devlog || {} },
    // Team sub-agent workflows
    'team-spec':    { ...base, ...memoryContext, knowledge_notes: knowledgeNotes, feature_state: featureState },
    'team-plan':    { ...base, ...memoryContext, knowledge_notes: knowledgeNotes, feature_state: featureState, build_history: buildHistory, devlog: config.devlog || {} },
    'team-code':    { ...base, ...memoryContext, knowledge_notes: knowledgeNotes, feature_state: featureState },
    'team-review':  { ...base, ...memoryContext, knowledge_notes: knowledgeNotes, feature_state: featureState },
    'team-build':   { ...base, cluster: clusterCtx, build_history: buildHistory, build: featureWithRepos.build || {}, build_server: config.build_server || null, knowledge_notes: knowledgeNotes, devlog: config.devlog || {} },
    'team-deploy':  { ...base, cluster: clusterCtx, all_clusters: buildClusterSummary(config), deploy: featureWithRepos.deploy || {}, build_server: config.build_server || null },
    'team-verify':  { ...base, cluster: clusterCtx, build_history: buildHistory, benchmark: featureWithRepos.benchmark || {}, verify: featureWithRepos.verify || {}, deploy: featureWithRepos.deploy || {}, build_server: config.build_server || null, knowledge_notes: knowledgeNotes, devlog: config.devlog || {} },
    'team-vllm-opt': { ...base, cluster: clusterCtx, build_history: buildHistory, benchmark: featureWithRepos.benchmark || {}, verify: featureWithRepos.verify || {}, knowledge_notes: knowledgeNotes, devlog: config.devlog || {} },
    // Retained independent skills
    'learn':        { ...base, ...memoryContext, knowledge_notes: knowledgeNotes, feature_state: featureState, devlog: config.devlog || {}, workspace_repos: config.repos || {} },
    // Session & utilities
    'pause':        { ...base, ...memoryContext, knowledge_notes: knowledgeNotes, artifacts: state, devlog: config.devlog || {} },
    'resume':       { ...base, ...memoryContext, cluster: clusterCtx, knowledge_notes: knowledgeNotes, build_history: buildHistory, artifacts: state, feature_state: featureState },
    'diff':         { ...base },
    'status':       { ...base, cluster: clusterCtx, feature_state: featureState, build_history: buildHistory, knowledge_notes: knowledgeNotes },
    'knowledge':    { ...base, knowledge_notes: knowledgeNotes, workspace_repos: config.repos || {} },
    // Project management
    'clean':        { ...base, cluster: clusterCtx, all_features: buildAllFeaturesContext(config, workspace), build_server: config.build_server || null },
    'cluster':      { ...base, cluster: clusterCtx, all_clusters: config.clusters || {} },
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

  const wikiDir = resolveWikiDir(vault, config, workspace);

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
    wiki_dir: wikiDir,
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

function resolveWikiDir(vault, config, workspace) {
  // 1. Vault-level unified wiki/ (single wiki for all projects)
  if (vault) {
    const vaultWiki = path.join(vault, 'wiki');
    if (fs.existsSync(vaultWiki)) return vaultWiki;
  }
  // 2. Local .dev/wiki/ (no-vault fallback)
  if (workspace) {
    const localWiki = path.join(workspace, '.dev', 'wiki');
    if (fs.existsSync(localWiki)) return localWiki;
  }
  // 3. Default: vault-level wiki/ (will be created on first ingest)
  if (vault) return path.join(vault, 'wiki');
  if (workspace) return path.join(workspace, '.dev', 'wiki');
  return null;
}

function collectWikiPages(vault, config, workspace) {
  const wikiPages = [];
  const wikiDir = resolveWikiDir(vault, config, workspace);
  if (wikiDir && fs.existsSync(wikiDir)) {
    try {
      const files = fs.readdirSync(wikiDir)
        .filter(f => f.endsWith('.md') && f !== 'index.md' && f !== 'log.md' && !f.startsWith('_'));
      for (const file of files) {
        wikiPages.push({
          name: file.replace(/\.md$/, ''),
          path: path.join(wikiDir, file),
        });
      }
    } catch (_) { /* ignore */ }
  }
  return wikiPages;
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
