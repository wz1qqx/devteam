'use strict';

const fs = require('fs');
const path = require('path');
const { output, error, parseArgs, findWorkspaceRoot, expandHome } = require('./core.cjs');
const { loadConfig, getActiveFeature } = require('./config.cjs');

/**
 * Write a standardized checkpoint entry to TWO targets:
 * 1. Obsidian devlog checkpoint file
 * 2. Feature devlog (.dev/features/<feature>/devlog.md)
 */
function writeCheckpoint(_subcommand, args) {
  const parsed = parseArgs(args || []);

  const action = parsed.action;
  const summary = parsed.summary;
  const tag = parsed.tag || '';
  const result = parsed.result || 'success';
  const featureArg = parsed.feature || null;

  if (!action) {
    error('Usage: checkpoint --action <action> --summary <text> [--tag <tag>] [--result success|failed|warning] [--feature <name>]');
  }
  if (!summary) {
    error('--summary is required');
  }

  // Load config
  const workspaceRoot = findWorkspaceRoot();
  if (!workspaceRoot) {
    error('.dev.yaml not found. Run `/devflow init` first.');
  }
  const config = loadConfig(workspaceRoot);

  // Resolve feature name
  const featureName = featureArg || (config.defaults && config.defaults.active_feature);
  if (!featureName) {
    error('No feature specified and no active_feature in config. Use --feature <name>.');
  }

  const feature = config.features && config.features[featureName];
  const repoNames = feature && feature.scope ? Object.keys(feature.scope) : [];

  // Resolve vault and devlog paths
  const vault = expandHome(config.vault || '');
  const devlogGroup = config.devlog && config.devlog.group ? config.devlog.group : '';
  const checkpointTemplate = config.devlog && config.devlog.checkpoint
    ? config.devlog.checkpoint
    : '{vault}/{group}/devlog/{feature}-checkpoint.md';

  // Generate timestamp
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toISOString().slice(11, 16);

  // --- Target 1: Obsidian devlog checkpoint file (optional) ---
  const vaultConfigured = !!(config.vault && vault);
  const obsidianPath = vaultConfigured
    ? expandHome(
        checkpointTemplate
          .replace('{vault}', config.vault)
          .replace('{group}', devlogGroup)
          .replace('{feature}', featureName)
          .replace('{project}', featureName)
      )
    : null;

  let checkpointNumber = 1;

  if (obsidianPath && vaultConfigured) {
    const obsidianDir = path.dirname(obsidianPath);
    fs.mkdirSync(obsidianDir, { recursive: true });

    if (fs.existsSync(obsidianPath)) {
      // Count existing checkpoint entries
      const existing = fs.readFileSync(obsidianPath, 'utf8');
      const matches = existing.match(/^### #\d+/gm);
      checkpointNumber = (matches ? matches.length : 0) + 1;
    } else {
      // Create with frontmatter
      const frontmatter = [
        '---',
        `date: ${dateStr}`,
        `project: ${config.project && config.project.name ? config.project.name : 'unknown'}`,
        `feature: ${featureName}`,
        `tags: [devlog, checkpoint, feature/${featureName}]`,
        '---',
        `# ${featureName} Checkpoint`,
        '',
      ].join('\n');
      fs.writeFileSync(obsidianPath, frontmatter, 'utf8');
    }

    // Build checkpoint entry
    const entry = buildCheckpointEntry(checkpointNumber, dateStr, timeStr, action, summary, featureName, tag, result, repoNames);
    fs.appendFileSync(obsidianPath, '\n' + entry + '\n', 'utf8');
  }

  // --- Target 2: Feature devlog (.dev/features/<feature>/devlog.md) ---
  const devlogPath = path.join(workspaceRoot, '.dev', 'features', featureName, 'devlog.md');
  const devlogDir = path.dirname(devlogPath);
  fs.mkdirSync(devlogDir, { recursive: true });

  const linkRef = `[[${featureName}-checkpoint]]`;
  const devlogLine = `- ${linkRef} (#${checkpointNumber}, ${dateStr}) \u2014 ${action}: ${summary}`;

  if (fs.existsSync(devlogPath)) {
    const content = fs.readFileSync(devlogPath, 'utf8');
    if (content.includes('## Checkpoint')) {
      // Append under existing Checkpoint section
      const updated = content.replace(
        /^(## Checkpoint\s*\n)/m,
        `$1${devlogLine}\n`
      );
      // If replace didn't change (section at end of file), append
      if (updated === content) {
        fs.appendFileSync(devlogPath, devlogLine + '\n', 'utf8');
      } else {
        fs.writeFileSync(devlogPath, updated, 'utf8');
      }
    } else {
      // Add Checkpoint section at end
      fs.appendFileSync(devlogPath, '\n## Checkpoint\n' + devlogLine + '\n', 'utf8');
    }
  } else {
    // Create devlog with Checkpoint section
    const devlogContent = [
      `# ${featureName} Devlog`,
      '',
      '## Checkpoint',
      devlogLine,
      '',
    ].join('\n');
    fs.writeFileSync(devlogPath, devlogContent, 'utf8');
  }

  output({
    checkpoint_number: checkpointNumber,
    obsidian_path: obsidianPath,
    devlog_path: devlogPath,
  });
}

function buildCheckpointEntry(n, dateStr, timeStr, action, summary, featureName, tag, result, repoNames) {
  const lines = [
    `### #${n} | ${dateStr} ${timeStr} | ${action}: ${summary}`,
    `**Feature**: ${featureName}`,
  ];
  if (tag) {
    lines.push(`**Tag**: ${tag}`);
  }
  lines.push(`**Result**: ${result}`);
  if (repoNames.length > 0) {
    lines.push(`**Repos**: ${repoNames.join(', ')}`);
  }
  return lines.join('\n');
}

module.exports = { writeCheckpoint };
