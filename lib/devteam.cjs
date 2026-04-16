#!/usr/bin/env node
'use strict';

const { output, error, DevflowError } = require('./core.cjs');

const args = process.argv.slice(2);
const command = args[0];
const subcommand = args[1];
const rest = args.slice(2);
const ERROR_PREFIX = '[devteam] ERROR:';
const USAGE_MESSAGE = 'Usage: node lib/devteam.cjs <command> [subcommand] [args...]\n\nCommands:\n  init <workflow> [args]         Context loading for a workflow\n  config load|get <key>          Project config operations\n  state get|update [args]        State management\n  pipeline <subcommand> [args]   Pipeline-level state helpers (init, loop, reset, complete)\n  run init|get|reset [args]      Run snapshot helpers (RUN.json lifecycle)\n  tasks <subcommand> [args]      Task-state helpers (tasks.json lifecycle)\n  hooks run [args]               Execute normalized feature hooks for a phase\n  orchestration <subcommand>     Higher-level orchestration helpers (resolve-stage)\n  features list|delete           Feature management\n  build record [args]            Record a build into config files + build-manifest.md\n  stage-result parse [args]      Parse and validate an agent STAGE_RESULT message\n  stage-result decide [args]     Map a STAGE_RESULT to orchestrator branch logic\n  stage-result accept [args]     Accept a PASS stage result and write state/checkpoint\n  checkpoint [args]              Write checkpoint to devlog';

try {
  if (!command) {
    error(USAGE_MESSAGE);
  }
  switch (command) {
    case 'init': {
      const { initWorkflow } = require('./init.cjs');
      initWorkflow(subcommand, rest).catch(err => {
        process.stderr.write(`${ERROR_PREFIX} ${err.message}\n`);
        process.exit(1);
      });
      return;
    }
    case 'config': {
      const { handleConfig } = require('./config.cjs');
      handleConfig(subcommand, rest);
      break;
    }
    case 'state': {
      const { handleState } = require('./state.cjs');
      handleState(subcommand, rest);
      break;
    }
    case 'pipeline': {
      const { handlePipelineState } = require('./pipeline-state.cjs');
      handlePipelineState(subcommand, rest);
      break;
    }
    case 'run': {
      const { handleRunState } = require('./run-state.cjs');
      handleRunState(subcommand, rest);
      break;
    }
    case 'tasks': {
      const { handleTaskState } = require('./task-state.cjs');
      handleTaskState(subcommand, rest);
      break;
    }
    case 'hooks': {
      const { handleHooks } = require('./hooks-runner.cjs');
      handleHooks(subcommand, rest);
      break;
    }
    case 'orchestration': {
      const { handleOrchestration } = require('./orchestration-kernel.cjs');
      handleOrchestration(subcommand, rest);
      break;
    }
    case 'checkpoint': {
      const { writeCheckpoint } = require('./checkpoint.cjs');
      writeCheckpoint(null, args.slice(1));
      break;
    }
    case 'features': {
      const { loadConfig, listFeatures } = require('./config.cjs');
      const { deleteFeature } = require('./state.cjs');
      const config = loadConfig();

      if (!subcommand || subcommand === 'list') {
        const features = listFeatures(config);
        output({ features });
      } else if (subcommand === 'delete') {
        const name = rest[0];
        if (!name) {
          error('Usage: features delete <name>\n\nAvailable features: ' +
            Object.keys(config.features).join(', '));
        }
        const result = deleteFeature(config, name);
        output(result);
      } else {
        error(`Unknown features subcommand: ${subcommand}. Use: list, delete`);
      }
      break;
    }
    case 'build': {
      if (subcommand !== 'record') {
        error(`Unknown build subcommand: '${subcommand}'. Use: record`);
      }
      const { loadConfig: loadCfg, requireFeature, getWorkspaceRoot } = require('./config.cjs');
      const { appendBuildHistory, writeBuildManifest, updateFeatureField } = require('./state.cjs');
      const { readRunState } = require('./run-state.cjs');
      const cfg = loadCfg();

      const parseFlag = (flag) => {
        const idx = rest.indexOf(flag);
        return idx !== -1 ? rest[idx + 1] : null;
      };

      const feature = requireFeature(cfg, parseFlag('--feature'));
      const featureName = feature.name;
      const tag     = parseFlag('--tag');
      const legacyBase = parseFlag('--base');
      const changes = parseFlag('--changes');
      if (!tag || !changes) {
        error('Usage: build record --tag <tag> --changes "<summary>" [--feature <name>] [--base <legacy-parent>] [--parent-image <image>] [--fallback-base-image <image>] [--result-image <image>] [--mode fast|rust|full] [--cluster <name>] [--note "<note>"]');
      }

      const imageName = (feature.build && feature.build.image_name) || featureName;
      const registry = (cfg.build_server && cfg.build_server.registry) || null;
      const previousTag = feature.current_tag || null;
      const previousBuiltImage = previousTag && registry && imageName
        ? `${registry}/${imageName}:${previousTag}`
        : null;

      const fallbackBaseImage = parseFlag('--fallback-base-image') || feature.base_image || null;
      const parentImage = parseFlag('--parent-image')
        || (previousTag ? (previousBuiltImage || legacyBase || null) : (fallbackBaseImage || legacyBase || null));
      const resultingImage = parseFlag('--result-image')
        || (registry && imageName ? `${registry}/${imageName}:${tag}` : null);

      const root = getWorkspaceRoot(cfg);
      const runState = readRunState(root, featureName);
      const sourceRefs = runState && Array.isArray(runState.repos)
        ? runState.repos.map(repo => `${repo.repo}@${repo.start_head || 'unknown'}`)
        : [];
      const sourceRepos = runState && Array.isArray(runState.repos)
        ? runState.repos.map(repo => repo.repo)
        : [];

      const entry = {
        tag,
        date:    parseFlag('--date') || new Date().toISOString().slice(0, 10),
        changes,
        base: parentImage,
        parent_image: parentImage,
        fallback_base_image: fallbackBaseImage,
        resulting_tag: tag,
        resulting_image: resultingImage,
        run_id: runState && runState.run_id ? runState.run_id : null,
        source_refs: sourceRefs,
        source_repos: sourceRepos,
        mode:    parseFlag('--mode')    || null,
        cluster: parseFlag('--cluster') || null,
        note:    parseFlag('--note')    || null,
      };

      // 1. Update current_tag (scalar — existing function handles it)
      updateFeatureField(cfg, featureName, 'current_tag', tag);

      // 2. Append to build_history list (reload config after current_tag write)
      const cfg2 = loadCfg();
      appendBuildHistory(cfg2, featureName, entry);

      // 3. Write permanent build-manifest.md
      const manifestPath = writeBuildManifest(root, featureName, entry);

      output({
        feature: featureName,
        tag,
        date: entry.date,
        parent_image: entry.parent_image,
        fallback_base_image: entry.fallback_base_image,
        resulting_image: entry.resulting_image,
        run_id: entry.run_id,
        source_refs: entry.source_refs,
        manifest: manifestPath,
      });
      break;
    }
    case 'stage-result': {
      const { handleStageResult } = require('./stage-result.cjs');
      handleStageResult(subcommand, rest);
      break;
    }
    default:
      error(`Unknown command: ${command}`);
  }
} catch (err) {
  process.stderr.write(`${ERROR_PREFIX} ${err.message}\n`);
  process.exit(1);
}
