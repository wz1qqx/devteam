#!/usr/bin/env node
'use strict';

/**
 * Generate command .md files from _registry.yaml.
 *
 * Usage: node bin/generate-commands.cjs [--dry-run]
 *
 * Reads commands/devflow/_registry.yaml and generates one .md file per command.
 * Skips commands listed in _skip (these are hand-maintained).
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REGISTRY_PATH = path.resolve(__dirname, '..', 'commands', 'devflow', '_registry.yaml');
const OUTPUT_DIR = path.resolve(__dirname, '..', 'commands', 'devflow');
const dryRun = process.argv.includes('--dry-run');

// Parse YAML via python3 (same approach as config.cjs)
function loadYaml(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const result = execSync(
    `python3 -c "import yaml,json,sys; data=yaml.safe_load(sys.stdin.read()); print(json.dumps(data))"`,
    { input: content, encoding: 'utf8', timeout: 10000 }
  );
  return JSON.parse(result.trim());
}

function generateCommandMd(name, cmd) {
  const workflowName = cmd.workflow || `${name}.md`;
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

  const executionContext = cmd.workflow
    ? `@~/.claude/my-dev/workflows/${workflowName}`
    : (cmd.references ? cmd.references[0] : '');

  const processLines = [];
  if (cmd.workflow) {
    processLines.push(`Execute the ${name} workflow from @~/.claude/my-dev/workflows/${workflowName} end-to-end.`);
    processLines.push(`Load project config via: \`node "$HOME/.claude/my-dev/bin/my-dev-tools.cjs" init ${initAs}\``);
  } else {
    processLines.push(`Load project config via: \`node "$HOME/.claude/my-dev/bin/my-dev-tools.cjs" init ${initAs}\``);
    processLines.push(`Execute inline based on arguments.`);
  }

  const lines = [
    '---',
    `name: devflow:${name}`,
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
