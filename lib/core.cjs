'use strict';

const path = require('path');
const fs = require('fs');

function output(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

class DevflowError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'DevflowError';
  }
}

function error(msg) {
  throw new DevflowError(msg);
}

function parseArgs(args) {
  const result = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        result[key] = next;
        i++;
      } else {
        result[key] = true;
      }
    } else {
      result._.push(arg);
    }
  }
  return result;
}

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith('~/') || p === '~') {
    return path.join(require('os').homedir(), p.slice(2));
  }
  return p;
}

function findWorkspaceRoot(startDir) {
  let dir = startDir || process.cwd();
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.dev.yaml'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Count effective words in text, handling CJK characters.
 * CJK characters (without spaces between them) each count as ~1.5 word equivalents.
 * Code blocks are stripped before counting.
 */
function countEffectiveWords(text) {
  if (!text) return 0;
  // Strip code blocks
  const stripped = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]+`/g, '');
  // Count CJK characters (CJK Unified Ideographs range)
  const cjkChars = (stripped.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
  // Count space-separated words (non-CJK)
  const nonCjk = stripped.replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g, ' ');
  const asciiWords = nonCjk.split(/\s+/).filter(w => w.length > 0).length;
  // Each CJK char ≈ 1.5 word equivalents (a Chinese sentence of 10 chars ≈ 15 English words)
  return Math.round(asciiWords + cjkChars * 1.5);
}

module.exports = { output, error, DevflowError, parseArgs, findWorkspaceRoot, expandHome, countEffectiveWords };
