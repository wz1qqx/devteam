'use strict';

/**
 * Lightweight YAML parser for .dev.yaml files.
 * Supports: maps, sequences, scalars (string/number/bool/null), quoted strings, comments.
 * Does NOT support: anchors, aliases, tags, multi-document, flow mappings/sequences, block scalars (|, >).
 */

function parse(text) {
  const lines = text.split('\n');
  const filtered = [];
  for (const raw of lines) {
    const stripped = stripComment(raw);
    if (stripped.trim() === '') continue;
    filtered.push(stripped);
  }
  if (filtered.length === 0) return null;
  const { value } = parseNode(filtered, 0, -1);
  return value;
}

function stripComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (ch === '#' && !inSingle && !inDouble) {
      return line.slice(0, i);
    }
  }
  return line;
}

function indent(line) {
  let n = 0;
  while (n < line.length && line[n] === ' ') n++;
  return n;
}

function parseScalar(s) {
  s = s.trim();
  if (s === '' || s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;

  // Flow sequence: [a, b, c]
  if (s[0] === '[' && s[s.length - 1] === ']') {
    const inner = s.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map(item => parseScalar(item.trim()));
  }

  if ((s[0] === '"' && s[s.length - 1] === '"') ||
      (s[0] === "'" && s[s.length - 1] === "'")) {
    return s.slice(1, -1);
  }

  const num = Number(s);
  if (!isNaN(num) && s !== '') return num;

  return s;
}

/**
 * Parse a node (map or sequence or scalar) starting at lines[idx].
 * parentIndent is the indent of the parent key line.
 * Returns { value, nextIdx }.
 */
function parseNode(lines, idx, parentIndent) {
  if (idx >= lines.length) return { value: null, nextIdx: idx };

  const line = lines[idx];
  const ind = indent(line);
  const trimmed = line.trim();

  if (trimmed.startsWith('- ')) {
    return parseSequence(lines, idx, ind);
  }

  const colonPos = findColon(trimmed);
  if (colonPos === -1) {
    return { value: parseScalar(trimmed), nextIdx: idx + 1 };
  }

  return parseMapping(lines, idx, ind);
}

function isBlockScalarIndicator(s) {
  s = s.trim();
  return s === '|' || s === '>' || s === '|-' || s === '|+' || s === '>-' || s === '>+';
}

function findColon(trimmed) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (ch === ':' && !inSingle && !inDouble) {
      if (i + 1 === trimmed.length || trimmed[i + 1] === ' ') {
        return i;
      }
    }
  }
  return -1;
}

function parseMapping(lines, idx, baseIndent) {
  const result = {};

  while (idx < lines.length) {
    const line = lines[idx];
    const ind = indent(line);
    if (ind < baseIndent) break;
    if (ind > baseIndent) break;

    const trimmed = line.trim();

    if (trimmed.startsWith('- ')) break;

    const colonPos = findColon(trimmed);
    if (colonPos === -1) break;

    const key = trimmed.slice(0, colonPos).trim();
    const rest = trimmed.slice(colonPos + 1).trim();

    if (rest !== '' && isBlockScalarIndicator(rest)) {
      // Block scalar (| or >): consume all deeper-indented continuation lines
      const blockIndent = indent(lines[idx]);
      idx++;
      const blockLines = [];
      while (idx < lines.length && indent(lines[idx]) > blockIndent) {
        blockLines.push(lines[idx].slice(blockIndent + 2)); // strip base indent
        idx++;
      }
      result[key] = blockLines.join('\n');
    } else if (rest !== '') {
      result[key] = parseScalar(rest);
      idx++;
    } else {
      idx++;
      if (idx < lines.length && indent(lines[idx]) > baseIndent) {
        const child = parseNode(lines, idx, baseIndent);
        result[key] = child.value;
        idx = child.nextIdx;
      } else {
        result[key] = null;
      }
    }
  }

  return { value: result, nextIdx: idx };
}

function parseSequence(lines, idx, baseIndent) {
  const result = [];

  while (idx < lines.length) {
    const line = lines[idx];
    const ind = indent(line);
    if (ind < baseIndent) break;
    if (ind > baseIndent) {
      idx++;
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed.startsWith('- ')) break;

    const itemContent = trimmed.slice(2).trim();

    if (itemContent === '') {
      idx++;
      if (idx < lines.length && indent(lines[idx]) > baseIndent) {
        const child = parseNode(lines, idx, baseIndent);
        result.push(child.value);
        idx = child.nextIdx;
      } else {
        result.push(null);
      }
    } else {
      const itemColonPos = findColon(itemContent);
      if (itemColonPos !== -1) {
        const key = itemContent.slice(0, itemColonPos).trim();
        const val = itemContent.slice(itemColonPos + 1).trim();

        const mapItem = {};
        mapItem[key] = val !== '' ? parseScalar(val) : null;

        idx++;
        const childIndent = baseIndent + 2;
        while (idx < lines.length && indent(lines[idx]) >= childIndent) {
          const childLine = lines[idx];
          const childTrimmed = childLine.trim();
          const cc = findColon(childTrimmed);
          if (cc !== -1) {
            const ck = childTrimmed.slice(0, cc).trim();
            const cv = childTrimmed.slice(cc + 1).trim();
            if (cv !== '') {
              mapItem[ck] = parseScalar(cv);
              idx++;
            } else {
              idx++;
              if (idx < lines.length && indent(lines[idx]) > indent(childLine)) {
                const nested = parseNode(lines, idx, indent(childLine));
                mapItem[ck] = nested.value;
                idx = nested.nextIdx;
              } else {
                mapItem[ck] = null;
              }
            }
          } else {
            idx++;
          }
        }


        result.push(mapItem);
      } else {
        result.push(parseScalar(itemContent));
        idx++;
      }
    }
  }

  return { value: result, nextIdx: idx };
}

module.exports = { parse };
