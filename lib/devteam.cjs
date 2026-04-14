#!/usr/bin/env node
'use strict';

const { output, error, DevflowError } = require('./core.cjs');

const args = process.argv.slice(2);
const command = args[0];
const subcommand = args[1];
const rest = args.slice(2);

if (!command) {
  error('Usage: devflow-tools <command> [subcommand] [args...]\n\nCommands:\n  init <workflow> [args]       Context loading for a workflow\n  config load|get <key>        Project config operations\n  state get|update [args]      State management\n  features list|active|switch  Feature management\n  build record [args]          Record a build into config files + build-manifest.md\n  checkpoint [args]            Write checkpoint to devlog');
}

try {
  switch (command) {
    case 'init': {
      const { initWorkflow } = require('./init.cjs');
      initWorkflow(subcommand, rest).catch(err => {
        process.stderr.write(`[devflow] ERROR: ${err.message}\n`);
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
    case 'checkpoint': {
      const { writeCheckpoint } = require('./checkpoint.cjs');
      writeCheckpoint(null, args.slice(1));
      break;
    }
    case 'features': {
      const { loadConfig, getActiveFeature, listFeatures } = require('./config.cjs');
      const { switchActiveFeature, deleteFeature } = require('./state.cjs');
      const config = loadConfig();

      if (!subcommand || subcommand === 'list') {
        const features = listFeatures(config);
        output({ features });
      } else if (subcommand === 'active') {
        const feature = getActiveFeature(config);
        if (!feature) {
          output({ name: null, available: Object.keys(config.features || {}) });
        } else {
          output({
            name: feature.name,
            description: feature.description || '',
            phase: feature.phase || 'spec',
            scope: Object.keys(feature.scope || {}),
          });
        }
      } else if (subcommand === 'switch') {
        const name = rest[0];
        if (!name) {
          error('Usage: features switch <name>\n\nAvailable features: ' +
            Object.keys(config.features || {}).join(', '));
        }
        const result = switchActiveFeature(config, name);
        // Ensure name is in defaults.features list (idempotent)
        const { addFeatureName } = require('./state.cjs');
        const existing = (config.defaults && config.defaults.features) || [];
        if (!existing.includes(name)) addFeatureName(config, name);
        output(result);
      } else if (subcommand === 'delete') {
        const name = rest[0];
        if (!name) {
          error('Usage: features delete <name>\n\nAvailable features: ' +
            Object.keys(config.features || {}).join(', '));
        }
        const result = deleteFeature(config, name);
        output(result);
      } else {
        error(`Unknown features subcommand: ${subcommand}. Use: list, active, switch, delete`);
      }
      break;
    }
    case 'build': {
      if (subcommand !== 'record') {
        error(`Unknown build subcommand: '${subcommand}'. Use: record`);
      }
      const { loadConfig: loadCfg, getActiveFeature: getActiveFeat } = require('./config.cjs');
      const { appendBuildHistory, writeBuildManifest, updateFeatureField } = require('./state.cjs');
      const cfg = loadCfg();

      const parseFlag = (flag) => {
        const idx = rest.indexOf(flag);
        return idx !== -1 ? rest[idx + 1] : null;
      };

      const featureName = parseFlag('--feature') || (getActiveFeat(cfg) && getActiveFeat(cfg).name);
      if (!featureName) error('No active feature. Specify with --feature <name>');
      const tag     = parseFlag('--tag');
      const base    = parseFlag('--base');
      const changes = parseFlag('--changes');
      if (!tag || !base || !changes) {
        error('Usage: build record --tag <tag> --base <base> --changes "<summary>" [--mode fast|rust|full] [--cluster <name>] [--note "<note>"]');
      }

      const entry = {
        tag,
        date:    parseFlag('--date') || new Date().toISOString().slice(0, 10),
        base,
        changes,
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
      const root = require('path').dirname(cfg._path);
      const manifestPath = writeBuildManifest(root, featureName, entry);

      output({ feature: featureName, tag, manifest: manifestPath, date: entry.date });
      break;
    }
    default:
      error(`Unknown command: ${command}`);
  }
} catch (err) {
  process.stderr.write(`[devflow] ERROR: ${err.message}\n`);
  process.exit(1);
}
