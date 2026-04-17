'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_INDEX_LIMIT = 100;

function getBuildIndexPath(root) {
  return path.join(root, '.dev', 'build-index.json');
}

function normalizeSourceRefsForKey(sourceRefs) {
  if (!Array.isArray(sourceRefs)) return [];
  const normalized = [];
  for (const ref of sourceRefs) {
    if (!ref) continue;
    if (typeof ref === 'string') {
      const [repo, ...shaParts] = ref.split('@');
      normalized.push({
        repo: repo || '',
        start_head: shaParts.join('@') || '',
      });
      continue;
    }
    normalized.push({
      repo: ref.repo || '',
      start_head: ref.start_head || '',
    });
  }
  normalized.sort((a, b) => {
    if (a.repo !== b.repo) return a.repo.localeCompare(b.repo);
    return a.start_head.localeCompare(b.start_head);
  });
  return normalized;
}

function computeReuseKey(sourceRefs, buildMode, parentImage) {
  const payload = {
    source_refs: normalizeSourceRefsForKey(sourceRefs),
    build_mode: buildMode || '',
    parent_image: parentImage || '',
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function defaultIndex() {
  return {
    version: '1.0',
    updated_at: null,
    entries: [],
  };
}

function normalizeIndex(index) {
  if (!index || typeof index !== 'object' || Array.isArray(index)) return defaultIndex();
  return {
    version: typeof index.version === 'string' ? index.version : '1.0',
    updated_at: typeof index.updated_at === 'string' ? index.updated_at : null,
    entries: Array.isArray(index.entries) ? index.entries : [],
  };
}

function readBuildIndex(root) {
  const indexPath = getBuildIndexPath(root);
  if (!fs.existsSync(indexPath)) return defaultIndex();
  try {
    return normalizeIndex(JSON.parse(fs.readFileSync(indexPath, 'utf8')));
  } catch (_) {
    // Degrade gracefully on corrupt index.
    return defaultIndex();
  }
}

function writeBuildIndex(root, index) {
  const indexPath = getBuildIndexPath(root);
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n', 'utf8');
  return indexPath;
}

function lookupReuse(root, reuseKey) {
  const index = readBuildIndex(root);
  const entry = index.entries.find(item => item && item.reuse_key === reuseKey) || null;
  return { index, entry };
}

function recordReuseEntry(root, reuseKey, inputs, result, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0
    ? options.limit
    : DEFAULT_INDEX_LIMIT;
  const index = readBuildIndex(root);
  const nextEntry = {
    reuse_key: reuseKey,
    inputs: inputs || {},
    result: result || {},
  };
  const existingIndex = index.entries.findIndex(item => item && item.reuse_key === reuseKey);
  if (existingIndex >= 0) {
    index.entries[existingIndex] = nextEntry;
  } else {
    index.entries.unshift(nextEntry);
  }
  // Trim oldest entries beyond limit (unshift puts newest first, so slice from head).
  if (index.entries.length > limit) {
    index.entries = index.entries.slice(0, limit);
  }
  index.updated_at = new Date().toISOString();
  writeBuildIndex(root, index);
  return nextEntry;
}

module.exports = {
  DEFAULT_INDEX_LIMIT,
  getBuildIndexPath,
  computeReuseKey,
  readBuildIndex,
  writeBuildIndex,
  lookupReuse,
  recordReuseEntry,
};
