#!/usr/bin/env node
'use strict';

const { output, error, DevflowError } = require('./core.cjs');

const args = process.argv.slice(2);
const command = args[0];
const subcommand = args[1];
const rest = args.slice(2);

if (!command) {
  error('Usage: devflow-tools <command> [subcommand] [args...]\n\nCommands:\n  init <workflow> [args]       Context loading for a workflow\n  config load|get <key>        Project config operations\n  state get|update [args]      State management\n  features list|active|switch  Feature management\n  checkpoint [args]            Write checkpoint to devlog');
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
      const { switchActiveFeature } = require('./state.cjs');
      const config = loadConfig();

      if (!subcommand || subcommand === 'list') {
        const features = listFeatures(config);
        output({ features });
      } else if (subcommand === 'active') {
        const feature = getActiveFeature(config);
        output({
          name: feature.name,
          description: feature.description || '',
          phase: feature.phase || 'spec',
          scope: Object.keys(feature.scope || {}),
        });
      } else if (subcommand === 'switch') {
        const name = rest[0];
        if (!name) {
          error('Usage: features switch <name>\n\nAvailable features: ' +
            Object.keys(config.features || {}).join(', '));
        }
        const result = switchActiveFeature(config, name);
        output(result);
      } else {
        error(`Unknown features subcommand: ${subcommand}. Use: list, active, switch`);
      }
      break;
    }
    default:
      error(`Unknown command: ${command}`);
  }
} catch (err) {
  process.stderr.write(`[devflow] ERROR: ${err.message}\n`);
  process.exit(1);
}
