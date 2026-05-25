'use strict';

const fs = require('fs');
const path = require('path');

const { output, error, parseArgs } = require('./core.cjs');
const { loadWorkspaceConfig, resolvePath } = require('./workspace-config.cjs');
const { readRunEvents } = require('./action-plan.cjs');
const { sessionStatus } = require('./session-manager.cjs');

function nowIso() {
  return new Date().toISOString();
}

function safeInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeType(value) {
  const text = String(value || 'all').trim().toLowerCase();
  if (['recipe', 'recipes'].includes(text)) return 'recipes';
  if (['wiki', 'skills', 'all'].includes(text)) return text;
  error(`Unknown knowledge type '${value}'. Use: wiki, recipes, skills, all`);
}

function knowledgeDirs(config) {
  const knowledge = config.knowledge || {};
  return {
    wiki: resolvePath(config.root, knowledge.wiki_dir || '.devteam/wiki'),
    recipes: resolvePath(config.root, knowledge.recipes_dir || '.devteam/recipes'),
    skills: resolvePath(config.root, knowledge.skills_dir || '.devteam/skills'),
  };
}

function selectedDirs(config, type) {
  const dirs = knowledgeDirs(config);
  const normalized = normalizeType(type);
  if (normalized === 'all') {
    return [
      { type: 'wiki', dir: dirs.wiki },
      { type: 'recipes', dir: dirs.recipes },
      { type: 'skills', dir: dirs.skills },
    ];
  }
  return [{ type: normalized, dir: dirs[normalized] }];
}

function walkMarkdown(dir, type) {
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const files = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        files.push({ type, path: full, root: dir });
      }
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function lineCount(text) {
  if (!text) return 0;
  return text.split(/\r?\n/).length;
}

function titleFromMarkdown(content, fallback) {
  const line = String(content || '').split(/\r?\n/).find(item => /^#\s+/.test(item));
  return line ? line.replace(/^#\s+/, '').trim() : fallback;
}

function excerptFromMarkdown(content) {
  const lines = String(content || '').split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && !line.startsWith('```'));
  return lines.slice(0, 2).join(' ').slice(0, 220);
}

function describeFile(config, item) {
  const content = readText(item.path);
  const stat = fs.statSync(item.path);
  const relPath = path.relative(config.root, item.path);
  return {
    type: item.type,
    title: titleFromMarkdown(content, path.basename(item.path, '.md')),
    path: item.path,
    rel_path: relPath,
    lines: lineCount(content),
    updated_at: stat.mtime.toISOString(),
    excerpt: excerptFromMarkdown(content),
  };
}

function collectKnowledgeFiles(config, type = 'all') {
  const files = [];
  for (const entry of selectedDirs(config, type)) {
    files.push(...walkMarkdown(entry.dir, entry.type));
  }
  return files.map(item => describeFile(config, item));
}

function knowledgeList(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const type = normalizeType(options.type || 'all');
  const entries = collectKnowledgeFiles(config, type);
  const totals = entries.reduce((acc, entry) => {
    acc.entries += 1;
    acc[entry.type] = (acc[entry.type] || 0) + 1;
    return acc;
  }, { entries: 0, wiki: 0, recipes: 0, skills: 0 });
  return {
    action: 'knowledge_list',
    workspace: config.root,
    type,
    dirs: knowledgeDirs(config),
    totals,
    entries,
  };
}

function normalizeQuery(query) {
  const text = String(query || '').trim();
  if (!text) error('knowledge search requires a query.');
  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
  return { text, tokens };
}

function scoreDocument(entry, content, tokens) {
  const haystack = [
    entry.title,
    entry.rel_path,
    content,
  ].join('\n').toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (!haystack.includes(token)) return 0;
    if (String(entry.title || '').toLowerCase().includes(token)) score += 8;
    if (String(entry.rel_path || '').toLowerCase().includes(token)) score += 4;
    score += (haystack.match(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
  }
  return score;
}

function snippets(content, tokens) {
  const lines = String(content || '').split(/\r?\n/);
  const result = [];
  for (let i = 0; i < lines.length && result.length < 3; i++) {
    const lower = lines[i].toLowerCase();
    if (tokens.some(token => lower.includes(token))) {
      result.push({
        line: i + 1,
        text: lines[i].trim().slice(0, 240),
      });
    }
  }
  return result;
}

function knowledgeSearch(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const type = normalizeType(options.type || 'all');
  const query = normalizeQuery(options.query);
  const limit = safeInt(options.limit, 10);
  const matches = [];
  for (const entry of collectKnowledgeFiles(config, type)) {
    const content = readText(entry.path);
    const score = scoreDocument(entry, content, query.tokens);
    if (score <= 0) continue;
    matches.push({
      ...entry,
      score,
      snippets: snippets(content, query.tokens),
    });
  }
  matches.sort((a, b) => b.score - a.score || a.rel_path.localeCompare(b.rel_path));
  return {
    action: 'knowledge_search',
    workspace: config.root,
    type,
    query: query.text,
    total_matches: matches.length,
    matches: matches.slice(0, limit),
  };
}

function wikiLinkTargets(content) {
  const targets = [];
  const regex = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const raw = String(match[1] || '').trim();
    if (raw) targets.push(raw.replace(/\.md$/i, ''));
  }
  return targets;
}

function wikiTargetExists(wikiEntries, target) {
  const normalized = String(target || '').trim().toLowerCase();
  return wikiEntries.some(entry => {
    const base = path.basename(entry.path, '.md').toLowerCase();
    const title = String(entry.title || '').trim().toLowerCase();
    return base === normalized || title === normalized;
  });
}

function knowledgeLint(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const dirs = knowledgeDirs(config);
  const maxLines = safeInt(options.maxLines, 300);
  const problems = [];
  const warnings = [];
  for (const [type, dir] of Object.entries(dirs)) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      problems.push({ type: 'missing_dir', scope: type, path: dir });
    }
  }

  const allEntries = collectKnowledgeFiles(config, 'all');
  for (const entry of allEntries) {
    if (entry.lines > maxLines) {
      problems.push({
        type: 'overlong_markdown',
        path: entry.path,
        rel_path: entry.rel_path,
        lines: entry.lines,
        max_lines: maxLines,
      });
    }
  }

  const wikiEntries = allEntries.filter(entry => entry.type === 'wiki');
  const wikiIndex = path.join(dirs.wiki, 'index.md');
  if (!fs.existsSync(wikiIndex)) {
    problems.push({ type: 'missing_wiki_index', path: wikiIndex });
  } else {
    const indexContent = readText(wikiIndex);
    for (const entry of wikiEntries) {
      if (path.basename(entry.path) === 'index.md') continue;
      const base = path.basename(entry.path);
      if (!indexContent.includes(base) && !indexContent.includes(entry.title)) {
        warnings.push({
          type: 'wiki_page_not_in_index',
          path: entry.path,
          rel_path: entry.rel_path,
          title: entry.title,
        });
      }
    }
  }

  for (const entry of wikiEntries) {
    const content = readText(entry.path);
    for (const target of wikiLinkTargets(content)) {
      if (!wikiTargetExists(wikiEntries, target)) {
        problems.push({
          type: 'dead_wikilink',
          source: entry.path,
          rel_path: entry.rel_path,
          target,
        });
      }
    }
  }

  return {
    action: 'knowledge_lint',
    workspace: config.root,
    status: problems.length ? 'needs_attention' : 'pass',
    dirs,
    totals: {
      entries: allEntries.length,
      wiki: wikiEntries.length,
      recipes: allEntries.filter(entry => entry.type === 'recipes').length,
      skills: allEntries.filter(entry => entry.type === 'skills').length,
      problems: problems.length,
      warnings: warnings.length,
    },
    problems,
    warnings,
  };
}

function slugify(value) {
  return String(value || 'knowledge-note')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96) || 'knowledge-note';
}

function mdList(items, render) {
  if (!items || !items.length) return '- none';
  return items.map(item => `- ${render(item)}`).join('\n');
}

function renderCaptureMarkdown(status, run, options) {
  const title = options.title || `${status.workspace_set || 'workspace'} ${status.run_id}`;
  const summary = options.summary || 'Fill in the durable lesson, decision, or reusable command pattern from this run.';
  const evidenceEntries = Object.values(status.evidence || {})
    .filter(event => event && event.status && event.status !== 'missing');
  const eventLog = run && Array.isArray(run.events) ? run.events : [];
  return [
    `# ${title}`,
    '',
    `Captured: ${nowIso()}`,
    `Source run: \`.devteam/runs/${status.run_id}/\``,
    `Track: \`${status.track || status.workspace_set || ''}\``,
    `Feature: \`${status.feat || ''}\``,
    `Phase at capture: \`${status.phase ? `${status.phase.name}/${status.phase.status}` : ''}\``,
    '',
    '## Summary',
    '',
    summary,
    '',
    '## Worktree Heads',
    '',
    mdList(status.worktrees || [], item => [
      `\`${item.id}\``,
      item.branch ? `branch \`${item.branch}\`` : null,
      item.head ? `head \`${item.head}\`` : null,
      item.dirty ? 'dirty' : 'clean',
    ].filter(Boolean).join(', ')),
    '',
    '## Evidence',
    '',
    mdList(evidenceEntries, event => [
      `\`${event.kind}\``,
      `\`${event.status}\``,
      event.summary || '',
    ].filter(Boolean).join(' - ')),
    '',
    '## Commands And Logs',
    '',
    mdList(eventLog.filter(event => event.command || event.log || event.artifact), event => [
      `\`${event.kind}\``,
      event.command ? `command: \`${event.command.replace(/`/g, '\\`')}\`` : null,
      event.log ? `log: \`${event.log}\`` : null,
      event.artifact ? `artifact: \`${event.artifact}\`` : null,
    ].filter(Boolean).join('; ')),
    '',
    '## Next Actions At Capture',
    '',
    mdList(status.next_actions || [], item => item),
    '',
    '## Durable Notes',
    '',
    '- Keep only reusable knowledge here; leave one-off terminal details in the run directory.',
    '- Promote exact repeated commands into `.devteam/recipes/` when they stabilize.',
    '',
  ].join('\n');
}

function ensureWikiIndexEntry(wikiDir, title, targetPath) {
  const indexPath = path.join(wikiDir, 'index.md');
  const rel = path.basename(targetPath);
  const bullet = `- [${title}](${rel})`;
  let content = fs.existsSync(indexPath)
    ? readText(indexPath)
    : '# Wiki Index\n\n';
  if (content.includes(`](${rel})`) || content.includes(bullet)) {
    return { path: indexPath, action: 'unchanged' };
  }
  if (!/^## Captured Notes\s*$/m.test(content)) {
    content = `${content.replace(/\s*$/, '\n\n')}## Captured Notes\n`;
  }
  content = `${content.replace(/\s*$/, '\n')}${bullet}\n`;
  fs.writeFileSync(indexPath, content, 'utf8');
  return { path: indexPath, action: 'updated', entry: bullet };
}

function knowledgeCapture(options = {}) {
  const config = loadWorkspaceConfig(options.root || null);
  const to = normalizeType(options.to || 'wiki');
  if (!['wiki', 'recipes'].includes(to)) error("knowledge capture --to must be 'wiki' or 'recipes'.");
  const status = sessionStatus({
    root: config.root,
    run: options.run || null,
  });
  const run = readRunEvents(config, status.run_id);
  const title = options.title || `${status.workspace_set || 'workspace'} ${status.run_id}`;
  const slug = slugify(options.slug || title);
  const dirs = knowledgeDirs(config);
  const targetDir = to === 'recipes' ? dirs.recipes : dirs.wiki;
  const targetPath = path.join(targetDir, `${slug}.md`);
  const content = renderCaptureMarkdown(status, run, {
    title,
    summary: options.summary || null,
  });
  const exists = fs.existsSync(targetPath);
  const apply = options.apply === true;
  if (apply && exists && options.force !== true) {
    error(`Knowledge capture target already exists: ${targetPath}. Pass --force to overwrite.`);
  }

  const writes = [];
  if (apply) {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(targetPath, content, 'utf8');
    writes.push({ path: targetPath, action: exists ? 'overwritten' : 'created' });
    if (to === 'wiki') {
      writes.push(ensureWikiIndexEntry(dirs.wiki, title, targetPath));
    }
  }

  return {
    action: 'knowledge_capture',
    workspace: config.root,
    run_id: status.run_id,
    workspace_set: status.workspace_set,
    to,
    title,
    slug,
    target_path: targetPath,
    applied: apply,
    exists,
    writes,
    content,
    next_action: apply
      ? 'Review and trim the captured note so it contains durable knowledge, not just run output.'
      : 'Review the draft content, then rerun with --apply to write it.',
  };
}

function handleKnowledge(subcommand, args) {
  const parsed = parseArgs(args || []);
  const positional = parsed._ || [];
  const query = parsed.query || positional.join(' ');
  if (!subcommand || subcommand === 'list') {
    output(knowledgeList({
      root: parsed.root || null,
      type: parsed.type || null,
    }));
    return;
  }
  if (subcommand === 'search') {
    output(knowledgeSearch({
      root: parsed.root || null,
      type: parsed.type || null,
      query,
      limit: parsed.limit || null,
    }));
    return;
  }
  if (subcommand === 'lint') {
    output(knowledgeLint({
      root: parsed.root || null,
      maxLines: parsed['max-lines'] || null,
    }));
    return;
  }
  if (subcommand === 'capture') {
    output(knowledgeCapture({
      root: parsed.root || null,
      run: parsed.run || parsed.id || null,
      to: parsed.to || parsed.type || null,
      title: parsed.title || null,
      slug: parsed.slug || null,
      summary: parsed.summary || null,
      apply: parsed.apply === true,
      force: parsed.force === true,
    }));
    return;
  }
  error(`Unknown knowledge subcommand: '${subcommand}'. Use: list, search, lint, capture`);
}

module.exports = {
  handleKnowledge,
  knowledgeCapture,
  knowledgeLint,
  knowledgeList,
  knowledgeSearch,
};
