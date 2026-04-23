'use strict';

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const { output, error, findWorkspaceRoot, expandHome } = require('./core.cjs');
const { loadConfig, requireFeature, resolveFeatureWithRepos, getActiveCluster, getFeatureRepos, listFeatures, listFeatureNames, getWorkspaceConfigPath, getFeatureConfigPath } = require('./config.cjs');
const { loadState, getPhase } = require('./state.cjs');
const { loadStateMd, loadFeatureContext, readHandoff } = require('./session.cjs');
const { parseArgs } = require('./core.cjs');
const { readRunState, getRunPath, reposMapFromRun } = require('./run-state.cjs');
const { readTaskState, getTasksPath, summarizeTaskState } = require('./task-state.cjs');

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
  if (!root) error('workspace.yaml not found');

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
  if (workflowName === 'bare-metal') {
    return initBareMetal(config, root, args);
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
    'team-vllm-opt': { cluster: true, buildHistory: true, benchmarkConfig: true, deployConfig: true, knowledge: true, devlog: true },
    // === Retained independent skills ===
    'learn':        { memory: true, knowledge: true, featureState: true, devlog: true, workspaceRepos: true },
    'observability': { cluster: true },
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
  const workflowFeaturePolicy = {
    team: 'required',
    'team-spec': 'required',
    'team-plan': 'required',
    'team-code': 'required',
    'team-review': 'required',
    'team-build': 'required',
    'team-deploy': 'required',
    'team-verify': 'required',
    'team-vllm-opt': 'required',
    learn: 'required',
    observability: 'optional',
    pause: 'required',
    resume: 'required',
    diff: 'optional',
    status: 'optional',
    knowledge: 'optional',
    clean: 'optional',
    cluster: 'optional',
  };

  if (!workflowNeeds[workflowName]) {
    error(`Unknown workflow '${workflowName}'. Valid: ${Object.keys(workflowNeeds).join(', ')}`);
  }
  const needs = workflowNeeds[workflowName];
  const featurePolicy = workflowFeaturePolicy[workflowName] || 'required';
  const needsAll = needs.all === true;
  const skipGit = needs.gitStatus === false && !needsAll;

  const featureWithRepos = resolveFeatureWithRepos(config, featureOverride);
  const workspace = expandHome(config.workspace) || root;
  const legacyStateArtifacts = detectLegacyStateArtifacts(workspace);
  emitLegacyStateWarning(legacyStateArtifacts);
  const vault = expandHome(config.vault) || null;
  const availableFeatures = listFeatureNames(config);
  const wikiDir = resolveWikiDir(vault, config, workspace);
  const tuning = config.defaults.tuning;

  // No feature resolved — return available_features for the skill layer to prompt
  if (!featureWithRepos && featurePolicy === 'required') {
    output({
      workspace,
      vault,
      config_path: getWorkspaceConfigPath(config),
      feature: null,
      available_features: availableFeatures,
    });
    return;
  }

  const featureName = featureWithRepos ? featureWithRepos.name : (featureOverride || null);
  const runState = featureName ? readRunState(root, featureName) : null;
  const phase = featureWithRepos ? getPhase(config, featureWithRepos.name) : null;
  const repos = featureWithRepos
    ? (runState
      ? attachRunReposMetadata(reposMapFromRun(runState), featureWithRepos.repos || {})
      : await buildReposContextAsync(featureWithRepos, workspace, { skipGit }))
    : {};
  const invariants = featureWithRepos ? featureWithRepos.invariants : {};
  const hooks = featureWithRepos ? featureWithRepos.hooks : {};
  const buildConfig = featureWithRepos ? featureWithRepos.build : {};
  let shipConfig = featureWithRepos ? { ...featureWithRepos.ship } : {};
  let deployConfig = featureWithRepos ? { ...featureWithRepos.deploy } : {};
  if (parsed['ship-strategy']) {
    shipConfig = { ...shipConfig, strategy: parsed['ship-strategy'] };
  }
  if (parsed['deploy-profile']) {
    deployConfig = { ...deployConfig, deploy_profile: parsed['deploy-profile'] };
    if (shipConfig.strategy === 'bare_metal' && shipConfig.metal) {
      shipConfig = {
        ...shipConfig,
        metal: { ...shipConfig.metal, deploy_profile: parsed['deploy-profile'] },
      };
    }
  }
  const initOverrides = {};
  if (parsed['ship-strategy']) initOverrides.ship_strategy = parsed['ship-strategy'];
  if (parsed['deploy-profile']) initOverrides.deploy_profile = parsed['deploy-profile'];
  const benchmarkConfig = featureWithRepos ? featureWithRepos.benchmark : {};
  const verifyConfig = featureWithRepos ? featureWithRepos.verify : {};
  const run = runState
    ? { path: getRunPath(root, featureName), ...runState }
    : null;
  const taskState = featureName ? readTaskState(root, featureName) : null;
  const taskStateSummary = summarizeTaskState(taskState);

  // Base context — shared by ALL workflows
  const base = {
    feature: featureWithRepos ? {
      name: featureWithRepos.name,
      description: featureWithRepos.description,
      phase,
      current_tag: featureWithRepos.current_tag,
      base_image: featureWithRepos.base_image,
    } : null,
    repos,
    workspace,
    vault,
    wiki_dir: wikiDir,
    invariants,
    hooks,
    run,
    legacy_state_artifacts: legacyStateArtifacts,
    task_state: {
      path: featureName ? getTasksPath(root, featureName) : null,
      exists: Boolean(taskState),
      summary: taskStateSummary,
      tasks: taskState ? taskState.tasks : [],
    },
    tuning,
    config_path: getWorkspaceConfigPath(config),
    ...(Object.keys(initOverrides).length ? { init_overrides: initOverrides } : {}),
    ...(featureWithRepos ? {} : { available_features: availableFeatures }),
  };

  // --- Lazy-loaded data sources (only computed when needed) ---
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
    stateMd = loadStateMd(root, featureName);
    const parsedFeatureContext = loadFeatureContext(root, featureName);
    decisions = parsedFeatureContext ? parsedFeatureContext.decisions : [];
    blockers = parsedFeatureContext ? parsedFeatureContext.blockers : [];
    handoff = readHandoff(root, featureName);
    featureContext = parsedFeatureContext ? parsedFeatureContext.raw : null;
    experienceNotes = collectExperienceNotes(vault, config, featureName);
  }

  const featureState = (needsAll || needs.featureState)
    ? buildFeatureState(featureName, devDir) : {};

  const buildHistory = (needsAll || needs.buildHistory)
    ? (featureWithRepos ? featureWithRepos.build_history.slice(-tuning.build_history_limit) : []) : [];

  let cluster = null;
  if (needsAll || needs.cluster) {
    try {
      cluster = getActiveCluster(config, featureOverride);
    } catch (e) {
      process.stderr.write(`[devteam] WARN: cluster load failed (${e.message}), continuing without cluster context\n`);
    }
  }
  const clusterCtx = cluster ? {
    name: cluster.name,
    ssh: cluster.ssh,
    namespace: cluster.namespace,
    safety: cluster.safety || 'normal',
    hardware: cluster.hardware,
    network: cluster.network,
  } : null;

  let state = null;
  if (needsAll || needs.artifacts) {
    try {
      state = loadState(featureName, root);
    } catch (e) {
      process.stderr.write(`[devteam] WARN: artifact state load failed (${e.message}), continuing without artifacts\n`);
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
    'team':         { ...base, ...memoryContext, cluster: clusterCtx, all_clusters: buildClusterSummary(config), build_history: buildHistory, build: buildConfig, ship: shipConfig, deploy: deployConfig, build_server: config.build_server, benchmark: benchmarkConfig, verify: verifyConfig, knowledge_notes: knowledgeNotes, feature_state: featureState, devlog: config.devlog },
    // Team sub-agent workflows
    'team-spec':    { ...base, ...memoryContext, knowledge_notes: knowledgeNotes, feature_state: featureState },
    'team-plan':    { ...base, ...memoryContext, knowledge_notes: knowledgeNotes, feature_state: featureState, build_history: buildHistory, devlog: config.devlog },
    'team-code':    { ...base, ...memoryContext, knowledge_notes: knowledgeNotes, feature_state: featureState },
    'team-review':  { ...base, ...memoryContext, knowledge_notes: knowledgeNotes, feature_state: featureState },
    'team-build':   { ...base, cluster: clusterCtx, build_history: buildHistory, build: buildConfig, ship: shipConfig, build_server: config.build_server, knowledge_notes: knowledgeNotes, devlog: config.devlog },
    'team-deploy':  { ...base, cluster: clusterCtx, all_clusters: buildClusterSummary(config), ship: shipConfig, deploy: deployConfig, build_server: config.build_server },
    'team-verify':  { ...base, cluster: clusterCtx, build_history: buildHistory, ship: shipConfig, benchmark: benchmarkConfig, verify: verifyConfig, deploy: deployConfig, build_server: config.build_server, knowledge_notes: knowledgeNotes, devlog: config.devlog },
    'team-vllm-opt': { ...base, cluster: clusterCtx, build_history: buildHistory, benchmark: benchmarkConfig, verify: verifyConfig, deploy: deployConfig, knowledge_notes: knowledgeNotes, devlog: config.devlog },
    // Retained independent skills
    'learn':        { ...base, ...memoryContext, knowledge_notes: knowledgeNotes, feature_state: featureState, devlog: config.devlog, workspace_repos: config.repos },
    'observability': { ...base, cluster: clusterCtx, observability: config.observability },
    // Session & utilities
    'pause':        { ...base, ...memoryContext, knowledge_notes: knowledgeNotes, artifacts: state, devlog: config.devlog },
    'resume':       { ...base, ...memoryContext, cluster: clusterCtx, knowledge_notes: knowledgeNotes, build_history: buildHistory, artifacts: state, feature_state: featureState },
    'diff':         { ...base },
    'status':       { ...base, cluster: clusterCtx, feature_state: featureState, build_history: buildHistory, knowledge_notes: knowledgeNotes },
    'knowledge':    { ...base, knowledge_notes: knowledgeNotes, workspace_repos: config.repos },
    // Project management
    'clean':        { ...base, cluster: clusterCtx, all_features: buildAllFeaturesContext(config, workspace), build_server: config.build_server },
    'cluster':      { ...base, cluster: clusterCtx, all_clusters: config.clusters },
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
      deploy: deployConfig,
      build: buildConfig,
      benchmark: benchmarkConfig,
      build_server: config.build_server,
      devlog: config.devlog,
    });
    return;
  }

  output(context);
}

function initWorkspace(config, root) {
  const workspace = expandHome(config.workspace) || root;
  const legacyStateArtifacts = detectLegacyStateArtifacts(workspace);
  emitLegacyStateWarning(legacyStateArtifacts);
  const vault = expandHome(config.vault) || null;
  const features = listFeatures(config);

  const repoStatus = {};
  for (const [repoName, repo] of Object.entries(config.repos)) {
    const baselines = {};
    for (const [baselineId, baseline] of Object.entries(repo.baselines || {})) {
      const worktreePath = baseline && baseline.worktree
        ? path.resolve(workspace, baseline.worktree)
        : null;
      baselines[baselineId] = {
        id: baseline && baseline.id ? baseline.id : baselineId,
        ref: baseline && baseline.ref ? baseline.ref : null,
        worktree: worktreePath,
        read_only: baseline ? Boolean(baseline.read_only) : true,
        exists: worktreePath ? fs.existsSync(worktreePath) : false,
      };
    }
    const devSlots = {};
    for (const [slotId, slot] of Object.entries(repo.dev_slots || {})) {
      const worktreePath = slot && slot.worktree
        ? path.resolve(workspace, slot.worktree)
        : null;
      devSlots[slotId] = {
        id: slot && slot.id ? slot.id : slotId,
        repo: slot && slot.repo ? slot.repo : repoName,
        worktree: worktreePath,
        baseline_id: slot ? (slot.baseline_id || null) : null,
        baseline_ref: slot ? (slot.baseline_ref || null) : null,
        sharing_mode: slot ? (slot.sharing_mode || null) : null,
        owner_features: slot && Array.isArray(slot.owner_features) ? slot.owner_features : [],
        exists: worktreePath ? fs.existsSync(worktreePath) : false,
      };
    }
    repoStatus[repoName] = {
      upstream: repo.upstream,
      remotes: repo.remotes || {},
      baselines,
      dev_slots: devSlots,
    };
  }

  output({
    schema_version: config.schema_version || 2,
    workspace,
    vault,
    repos: repoStatus,
    clusters: Object.keys(config.clusters),
    active_cluster: config.defaults.active_cluster,
    build_server: config.build_server,
    devlog: config.devlog,
    legacy_state_artifacts: legacyStateArtifacts,
    features,
    config_path: getWorkspaceConfigPath(config),
  });
}

async function initFeature(config, root, args) {
  const parsed = parseArgs(args || []);
  const featureName = parsed._[0] || parsed.feature || null;
  const feat = requireFeature(config, featureName);

  const workspace = expandHome(config.workspace) || root;
  const legacyStateArtifacts = detectLegacyStateArtifacts(workspace);
  emitLegacyStateWarning(legacyStateArtifacts);
  const vault = expandHome(config.vault) || null;
  const repoEntries = getFeatureRepos(config, feat.name);

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
  const featureState = buildFeatureState(feat.name, devDir);
  const featureTaskState = readTaskState(root, feat.name);

  const wikiDir = resolveWikiDir(vault, config, workspace);

  output({
    feature: {
      name: feat.name,
      description: feat.description,
      phase: feat.phase,
      current_tag: feat.current_tag,
      base_image: feat.base_image,
    },
    repos,
    workspace,
    vault,
    wiki_dir: wikiDir,
    invariants: feat.invariants,
    hooks: feat.hooks,
    ship: feat.ship,
    deploy: feat.deploy,
    build: feat.build,
    benchmark: feat.benchmark,
    verify: feat.verify,
    build_history: feat.build_history.slice(-5),
    feature_state: featureState,
    task_state: {
      path: getTasksPath(root, feat.name),
      exists: Boolean(featureTaskState),
      summary: summarizeTaskState(featureTaskState),
      tasks: featureTaskState ? featureTaskState.tasks : [],
    },
    legacy_state_artifacts: legacyStateArtifacts,
    config_path: getWorkspaceConfigPath(config),
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
    remotes: entry.remotes || null,
    base_ref: entry.base_ref || null,
    base_worktree: baseWorktree,
    dev_worktree: devWorktree,
    dev_slot: entry.dev_slot || null,
    baseline_id: entry.baseline_id || null,
    sharing_mode: entry.sharing_mode || null,
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
  for (const [name, feat] of Object.entries(config.features)) {
    const scope = {};
    const repoEntries = getFeatureRepos(config, name);
    for (const repoEntry of repoEntries) {
      const repoName = repoEntry.repo;
      scope[repoName] = {
        dev_worktree: repoEntry.dev_worktree || null,
        base_worktree: repoEntry.base_worktree || null,
        dev_slot: repoEntry.dev_slot || null,
        base_ref: repoEntry.base_ref || null,
      };
    }
    result[name] = {
      phase: feat.phase,
      current_tag: feat.current_tag,
      scope,
      build_history_tags: feat.build_history.map(h => h.tag),
    };
  }
  return result;
}

/**
 * Build a compact cluster summary for interactive selection.
 */
function buildClusterSummary(config) {
  const result = {};
  for (const [name, cluster] of Object.entries(config.clusters)) {
    result[name] = {
      namespace: cluster.namespace || 'default',
      safety: cluster.safety || 'normal',
      gpu: cluster.hardware.gpu || 'unknown',
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
  if (vault && config.devlog.group) {
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
    featureState.verify_report_exists = fs.existsSync(path.join(featureDir, 'verify.md'));
    featureState.optimization_guidance_exists = fs.existsSync(path.join(featureDir, 'optimization-guidance.md'));
    featureState.context_exists = fs.existsSync(path.join(featureDir, 'context.md'));
    featureState.summary_exists = fs.existsSync(path.join(featureDir, 'summary.md'));
    featureState.tasks_exists = fs.existsSync(path.join(featureDir, 'tasks.json'));
  }
  return featureState;
}

function detectLegacyStateArtifacts(workspaceRoot) {
  if (!workspaceRoot) return [];
  const devDir = path.join(workspaceRoot, '.dev');
  const candidates = [
    { name: 'STATE.md', path: path.join(devDir, 'STATE.md') },
    { name: 'HANDOFF.json', path: path.join(devDir, 'HANDOFF.json') },
  ];
  return candidates
    .filter(item => fs.existsSync(item.path))
    .map(item => ({
      name: item.name,
      path: item.path,
    }));
}

function emitLegacyStateWarning(legacyArtifacts) {
  if (!Array.isArray(legacyArtifacts) || legacyArtifacts.length === 0) return;
  const details = legacyArtifacts.map(item => `${item.name}:${item.path}`).join(', ');
  process.stderr.write(
    `[devteam] WARN: detected legacy root state artifacts under .dev/. ` +
    `Runtime uses feature-scoped artifacts in .dev/features/<feature>/. ` +
    `Found: ${details}\n`
  );
}

module.exports = { initWorkflow };

function attachRunReposMetadata(runRepos, configRepos) {
  const enriched = { ...runRepos };
  for (const [repoName, repoConfig] of Object.entries(configRepos)) {
    if (!enriched[repoName]) continue;
    enriched[repoName] = {
      ...enriched[repoName],
      upstream: repoConfig.upstream || (repoConfig.remotes ? repoConfig.remotes.official : null) || null,
      remotes: repoConfig.remotes || {},
      dev_slot: repoConfig.dev_slot || null,
      baseline_id: repoConfig.baseline_id || null,
      sharing_mode: repoConfig.sharing_mode || null,
    };
  }
  return enriched;
}

function initBareMetal(config, root, args) {
  const parsed = parseArgs(args || []);
  const featureName = parsed.feature || parsed._[0] || null;
  if (!featureName) {
    error('Usage: init bare-metal --feature <name> [--host <user@host>] [--profile <name>] [--config <name>] [--port <port>] [--force] [--no-write-config]');
  }

  const feature = requireFeature(config, featureName);
  const workspace = expandHome(config.workspace) || root;
  const host = String(parsed.host || 'user@host');
  const profile = String(parsed.profile || 'default');
  const configName = String(parsed.config || 'default');
  const port = String(parsed.port || '8000');
  const force = Boolean(parsed.force);
  const writeConfig = !parsed['no-write-config'];

  const rapidDir = path.join(workspace, '.dev', 'rapid-test');
  const templateDir = path.resolve(__dirname, '..', 'templates', 'bare-metal', 'rapid-test');
  if (!fs.existsSync(templateDir)) {
    error(`Built-in bare-metal templates not found at ${templateDir}`);
  }
  fs.mkdirSync(rapidDir, { recursive: true });

  const created = [];
  const updated = [];
  const skipped = [];
  const scriptNames = ['sync.sh', 'start.sh', 'setup.sh'];
  for (const scriptName of scriptNames) {
    const src = path.join(templateDir, scriptName);
    const dest = path.join(rapidDir, scriptName);
    copyTemplateFile(src, dest, { force, created, updated, skipped });
    try {
      fs.chmodSync(dest, 0o755);
    } catch (_) {
      // Best effort: chmod may be restricted in some environments.
    }
  }

  const profilePath = path.join(rapidDir, `${profile}.env`);
  const profileContent = renderProfileEnv({ host, port, profile, configName });
  writeManagedFile(profilePath, profileContent, { force, created, updated, skipped });

  const featureConfigPath = getFeatureConfigPath(config, feature.name);
  let featureConfigUpdated = false;
  if (writeConfig) {
    const hostWithoutUser = host.includes('@') ? host.split('@').slice(-1)[0] : host;
    const serviceUrl = String(parsed['service-url'] || `${hostWithoutUser}:${port}`);
    upsertShipBlock(featureConfigPath, {
      host,
      profile,
      config: configName,
      serviceUrl,
    });
    featureConfigUpdated = true;
  }

  output({
    feature: feature.name,
    workspace,
    rapid_test_dir: rapidDir,
    profile: {
      name: profile,
      path: profilePath,
      host,
      config: configName,
    },
    scripts: {
      sync_script: '.dev/rapid-test/sync.sh',
      start_script: '.dev/rapid-test/start.sh',
      setup_script: '.dev/rapid-test/setup.sh',
    },
    file_changes: {
      created,
      updated,
      skipped,
      forced: force,
    },
    feature_config_path: featureConfigPath,
    feature_config_updated: featureConfigUpdated,
    write_config: writeConfig,
    next_steps: [
      `Edit ${path.relative(workspace, profilePath) || profilePath} and set RAPID_* values for your environment`,
      'Run: bash .dev/rapid-test/sync.sh <profile> --dry-run',
      'Run: /devteam team <feature> --stages build,ship,verify --build-mode sync_only',
    ],
  });
}

function copyTemplateFile(src, dest, trackers) {
  if (!fs.existsSync(src)) error(`Template file missing: ${src}`);
  const content = fs.readFileSync(src, 'utf8');
  writeManagedFile(dest, content, trackers);
}

function writeManagedFile(dest, content, trackers) {
  const { force, created, updated, skipped } = trackers;
  if (!fs.existsSync(dest)) {
    fs.writeFileSync(dest, content, 'utf8');
    created.push(dest);
    return;
  }
  if (!force) {
    skipped.push(dest);
    return;
  }
  const existing = fs.readFileSync(dest, 'utf8');
  if (existing === content) {
    skipped.push(dest);
    return;
  }
  fs.writeFileSync(dest, content, 'utf8');
  updated.push(dest);
}

function renderProfileEnv({ host, port, profile, configName }) {
  const hostNoUser = host.includes('@') ? host.split('@').slice(-1)[0] : host;
  return [
    '# ============================================================',
    `# devteam built-in bare-metal profile: ${profile}`,
    '# Generated by: node lib/devteam.cjs init bare-metal',
    '# Edit these values for your environment before first deploy.',
    '# ============================================================',
    '',
    `RAPID_HOST=${host}`,
    'RAPID_CODE_DIR=/opt/dynamo',
    '',
    '# Relative paths from workspace root to sync.',
    '# Example:',
    '# RAPID_SYNC_PATHS="dynamo/components/src/dynamo vllm/vllm pegaflow/python/pegaflow"',
    'RAPID_SYNC_PATHS=""',
    '',
    '# Service check endpoint used by start.sh after startup.',
    `RAPID_SERVICE_URL=${hostNoUser}:${port}`,
    '',
    '# Default config name passed to start command when omitted.',
    `RAPID_DEFAULT_CONFIG=${configName}`,
    '',
    '# Remote commands (executed through: ssh $RAPID_HOST "bash -lc <cmd>").',
    '# Must include {config} placeholder for start command.',
    'RAPID_START_CMD="echo \'TODO: set RAPID_START_CMD in this profile (use {config})\' && exit 1"',
    'RAPID_STOP_CMD="pkill -f \\"dynamo|vllm|pegaflow-server\\" 2>/dev/null || true"',
    'RAPID_STATUS_CMD="pgrep -fla \\"dynamo|vllm|pegaflow-server\\" || true"',
    '',
  ].join('\n');
}

function upsertShipBlock(featureConfigPath, options) {
  const content = fs.readFileSync(featureConfigPath, 'utf8');
  const lines = content.split('\n');
  const shipBlock = [
    'ship:',
    '  strategy: bare_metal',
    '  metal:',
    `    host: ${options.host}`,
    `    profile: ${options.profile}`,
    `    config: ${options.config}`,
    '    build_mode: sync_only',
    '    sync_script: .dev/rapid-test/sync.sh',
    '    start_script: .dev/rapid-test/start.sh',
    '    setup_script: .dev/rapid-test/setup.sh',
    `    service_url: ${options.serviceUrl}`,
    '    log_paths:',
    '      decode: /tmp/dynamo-decode.log',
    '      prefill: /tmp/dynamo-prefill.log',
  ];

  const isTopLevelLine = (line) => {
    const trimmed = line.trim();
    return trimmed !== '' && !line.startsWith(' ') && !line.startsWith('\t');
  };

  let shipStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === 'ship:') {
      shipStart = i;
      break;
    }
  }

  if (shipStart !== -1) {
    let shipEnd = lines.length;
    for (let i = shipStart + 1; i < lines.length; i++) {
      if (isTopLevelLine(lines[i])) {
        shipEnd = i;
        break;
      }
    }
    lines.splice(shipStart, shipEnd - shipStart, ...shipBlock);
  } else {
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    if (lines.length > 0) lines.push('');
    lines.push(...shipBlock);
  }

  const next = lines.join('\n').replace(/\s*$/, '') + '\n';
  fs.writeFileSync(featureConfigPath, next, 'utf8');
}
