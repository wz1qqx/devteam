#!/usr/bin/env node
'use strict';

const { output, error, DevflowError } = require('./core.cjs');

const args = process.argv.slice(2);
const command = args[0];
const subcommand = args[1];
const rest = args.slice(2);

if (!command) {
  error('Usage: devflow-tools <command> [subcommand] [args...]\n\nCommands:\n  init <workflow> [args]       Context loading for a workflow\n  config load|get <key>        Project config operations\n  state get|update [args]      State management\n  features list|active|switch  Feature management\n  build record [args]          Record a build into config files + build-manifest.md\n  migrate                      Split .dev.yaml into workspace.yaml + per-feature config.yaml\n  checkpoint [args]            Write checkpoint to devlog');
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
    case 'migrate': {
      const nodePath = require('path');
      const nodeFs  = require('fs');
      const { loadConfig: loadCfgM, listFeatures: listFeatM } = require('./config.cjs');

      // Must be in legacy format to migrate
      const cfgM = loadCfgM();
      if (cfgM._format === 'split') {
        error('Already in split format (workspace.yaml exists). Nothing to migrate.');
      }
      const devYamlPath = cfgM._path;
      const rootM = cfgM._root;
      const rawLines = nodeFs.readFileSync(devYamlPath, 'utf8').split('\n');

      // ── 1. Find features: block boundaries ──────────────────────────────
      let featuresLine = -1;
      let featuresEnd  = rawLines.length;
      for (let i = 0; i < rawLines.length; i++) {
        if (/^features:\s*$/.test(rawLines[i])) { featuresLine = i; break; }
      }
      if (featuresLine === -1) error('No features: block found in .dev.yaml');

      for (let i = featuresLine + 1; i < rawLines.length; i++) {
        if (/^\w/.test(rawLines[i]) && !/^#/.test(rawLines[i])) {
          featuresEnd = i; break;
        }
      }

      // ── 2. Extract each feature block and write config.yaml ─────────────
      // Feature name lines inside features: block match /^  ([a-zA-Z][a-zA-Z0-9_-]*):\s*$/
      const featureRanges = [];
      for (let i = featuresLine + 1; i < featuresEnd; i++) {
        const m = rawLines[i].match(/^  ([a-zA-Z][a-zA-Z0-9_-]*):\s*$/);
        if (m) featureRanges.push({ name: m[1], start: i + 1 });
      }
      // Compute end of each feature block
      for (let k = 0; k < featureRanges.length; k++) {
        const nextStart = featureRanges[k + 1] ? featureRanges[k + 1].start - 1 : featuresEnd;
        featureRanges[k].end = nextStart;
      }

      const migratedFeatures = [];
      for (const { name, start, end } of featureRanges) {
        const featLines = rawLines.slice(start, end)
          .map(l => l.startsWith('    ') ? l.slice(4) : l); // dedent by 4
        // Trim trailing blank lines
        while (featLines.length > 0 && featLines[featLines.length - 1].trim() === '') {
          featLines.pop();
        }
        const featDir = nodePath.join(rootM, '.dev', 'features', name);
        nodeFs.mkdirSync(featDir, { recursive: true });
        const configPath = nodePath.join(featDir, 'config.yaml');
        nodeFs.writeFileSync(configPath, featLines.join('\n') + '\n', 'utf8');
        migratedFeatures.push(name);
      }

      // ── 3. Build workspace.yaml ──────────────────────────────────────────
      // workspace content = lines before features: + lines after featuresEnd
      const wsBefore = rawLines.slice(0, featuresLine);
      const wsAfter  = rawLines.slice(featuresEnd);

      // Find defaults: block in wsBefore and append features list
      let defaultsLine = -1;
      let defaultsEnd  = wsBefore.length;
      for (let i = 0; i < wsBefore.length; i++) {
        if (/^defaults:\s*$/.test(wsBefore[i])) { defaultsLine = i; break; }
      }
      if (defaultsLine !== -1) {
        // Find end of defaults block (next indent-0 non-comment line)
        for (let i = defaultsLine + 1; i < wsBefore.length; i++) {
          const line = wsBefore[i];
          if (line.trim() !== '' && /^\w/.test(line) && !/^#/.test(line)) {
            defaultsEnd = i; break;
          }
        }
        // Insert features list right before defaultsEnd
        const featList = [
          '  features:',
          ...migratedFeatures.map(n => `    - ${n}`),
        ];
        wsBefore.splice(defaultsEnd, 0, ...featList);
      }

      const wsContent = [...wsBefore, '', ...wsAfter].join('\n');
      const wsPath = nodePath.join(rootM, 'workspace.yaml');
      nodeFs.writeFileSync(wsPath, wsContent, 'utf8');

      // ── 4. Backup .dev.yaml ─────────────────────────────────────────────
      nodeFs.renameSync(devYamlPath, devYamlPath + '.bak');

      output({ migrated_features: migratedFeatures, workspace_yaml: wsPath, backup: devYamlPath + '.bak' });
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
