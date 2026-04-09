#!/usr/bin/env node
'use strict';

/**
 * Generate command .md files from _registry.yaml.
 *
 * Usage: node bin/generate-commands.cjs [--dry-run]
 *
 * Reads commands/devteam/_registry.yaml and generates one .md file per command.
 * Skips commands listed in _skip (these are hand-maintained).
 *
 * Registry entry types:
 *   skill:    → skills/<file>       (flat skill file)
 */

const fs = require('fs');
const path = require('path');
const yaml = require(path.resolve(__dirname, '..', 'lib', 'yaml.cjs'));

const REGISTRY_PATH = path.resolve(__dirname, '..', 'commands', 'devteam', '_registry.yaml');
const OUTPUT_DIR = path.resolve(__dirname, '..', 'commands', 'devteam');
const dryRun = process.argv.includes('--dry-run');

function loadYaml(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return yaml.parse(content);
}

function resolveSkillPath(cmd) {
  if (cmd.skill) return `skills/${cmd.skill}`;
  if (cmd.stage) return `skills/stages/${cmd.stage}`;
  if (cmd.workflow) return `skills/workflows/${cmd.workflow}`;
  return '';
}

function resolveSkillType(cmd) {
  if (cmd.skill) return 'skill';
  if (cmd.stage) return 'stage';
  if (cmd.workflow) return 'workflow';
  return 'inline';
}

function generateCommandMd(name, cmd) {
  const initAs = cmd['init-as'] || name;
  const contextPrefix = cmd['context-prefix'] || '';
  const argHint = cmd['argument-hint'] || '';
  const tools = (cmd['allowed-tools'] || ['Read', 'Bash', 'Glob', 'Grep'])
    .map(t => `  - ${t}`)
    .join('\n');

  const references = cmd.references
    ? '\n' + cmd.references.map(r => r).join('\n')
    : '';

  const contextLine = contextPrefix
    ? `${contextPrefix} $ARGUMENTS`
    : '$ARGUMENTS';

  const skillPath = resolveSkillPath(cmd);
  const skillType = resolveSkillType(cmd);

  // Build execution_context reference
  const executionContext = skillPath
    ? `@../../${skillPath}`
    : (cmd.references ? cmd.references[0] : '');

  // Build process steps
  const processLines = [];
  processLines.push('**Step 1**: Discover CLI tool and load config:');
  processLines.push('```bash');
  processLines.push('DEVFLOW_BIN=$(ls ~/.claude/plugins/cache/devteam/devteam/*/lib/devteam.cjs 2>/dev/null | head -1)');
  processLines.push(`INIT=$(node "$DEVFLOW_BIN" init ${initAs})`);
  processLines.push('```');
  processLines.push('');

  if (skillPath) {
    processLines.push(`**Step 2**: Read the ${skillType} file and execute it end-to-end:`);
    const globPattern = `~/.claude/plugins/cache/devteam/devteam/*/${skillPath}`;
    processLines.push('```bash');
    processLines.push(`SKILL_FILE=$(ls ${globPattern} 2>/dev/null | head -1)`);
    processLines.push('```');
    processLines.push('Read `$SKILL_FILE` for the full process, then follow it step by step.');
  } else if (cmd['inline-process']) {
    processLines.push('**Step 2**: Execute:');
    processLines.push(cmd['inline-process']);
  } else {
    processLines.push('Execute inline based on arguments.');
  }

  const lines = [
    '---',
    `name: devteam:${name}`,
    `description: ${cmd.description}`,
  ];
  if (argHint) lines.push(`argument-hint: "${argHint}"`);
  lines.push('allowed-tools:');
  lines.push(tools);
  lines.push('---');
  lines.push(`<objective>`);
  lines.push(cmd.objective);
  lines.push(`</objective>`);
  lines.push('');
  if (executionContext) {
    lines.push(`<execution_context>`);
    lines.push(executionContext);
    lines.push(`</execution_context>`);
    lines.push('');
  }
  lines.push(`<context>`);
  lines.push(contextLine);
  lines.push(`</context>`);
  lines.push('');
  lines.push(`<process>`);
  lines.push(processLines.join('\n'));
  lines.push(`</process>`);

  return lines.join('\n') + '\n';
}

// Main
const registry = loadYaml(REGISTRY_PATH);
const skipList = registry._skip || [];
const commands = registry.commands || {};

let generated = 0;
let skipped = 0;

for (const [name, cmd] of Object.entries(commands)) {
  if (skipList.includes(name)) {
    skipped++;
    continue;
  }

  const content = generateCommandMd(name, cmd);
  const outPath = path.join(OUTPUT_DIR, `${name}.md`);

  if (dryRun) {
    console.log(`[DRY-RUN] Would write: ${outPath} (${content.length} bytes)`);
  } else {
    fs.writeFileSync(outPath, content, 'utf8');
    console.log(`[OK] ${name}.md (${content.length} bytes)`);
  }
  generated++;
}

console.log(`\nGenerated: ${generated}, Skipped (hand-maintained): ${skipped}`);
console.log(`Total commands: ${Object.keys(commands).length}`);
