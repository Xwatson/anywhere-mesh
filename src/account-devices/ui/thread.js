export function element(tag, text, className) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}

export function formatTokenCount(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '0';
  if (n >= 999500) {
    if (n >= 1000000 && n <= 1055000) return '1M';
    return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  }
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(n));
}

export function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const graphic = document.createElementNS(ns, 'svg');
  graphic.setAttribute('class', 'icon');
  graphic.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS(ns, 'use');
  shape.setAttribute('href', '#i-' + name);
  graphic.append(shape);
  return graphic;
}

// Construct text nodes even when model output or a file contains HTML.
const ALERT_LABELS = { NOTE: '说明', TIP: '提示', IMPORTANT: '重要', WARNING: '注意', CAUTION: '警告' };

function parseFileUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'file:') return null;
    let path = decodeURIComponent(u.pathname || '');
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    const hashMatch = (u.hash || '').match(/^#L(\d+)(?:-L?(\d+))?$/i);
    const lineRange = hashMatch ? (hashMatch[2] ? `${hashMatch[1]}-${hashMatch[2]}` : hashMatch[1]) : '';
    return { path: path || rawUrl, lineRange };
  } catch {
    return null;
  }
}

function makeFileChip(label, copyPath, lineRange = '', rawUrl = '') {
  const btn = element('button', undefined, 'md-file');
  btn.type = 'button';
  btn.dataset.copyText = copyPath;
  if (rawUrl && rawUrl !== copyPath) btn.dataset.rawUrl = rawUrl;
  if (lineRange) btn.dataset.lineRange = lineRange;
  const showRange = lineRange && !label.includes(lineRange) && !/#L\d+/i.test(label);
  btn.append(icon('file'), element('span', label));
  if (showRange) btn.append(element('small', ':' + lineRange));
  return btn;
}

function unwrapCodeLabel(rawLabel) {
  const trimmed = rawLabel.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('`') && trimmed.endsWith('`') && !trimmed.slice(1, -1).includes('`')) {
    return trimmed.slice(1, -1);
  }
  return rawLabel;
}

function findMarkdownLink(text, startIdx) {
  let i = startIdx + 1;
  let inCode = false;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\n') return null;
    if (ch === '`') inCode = !inCode;
    else if (!inCode && ch === ']') break;
    i++;
  }
  if (i >= text.length || text[i] !== ']' || text[i + 1] !== '(') return null;
  const rawLabel = text.slice(startIdx + 1, i);
  if (!rawLabel.trim()) return null;
  let j = i + 2;
  let depth = 0;
  while (j < text.length) {
    const ch = text[j];
    if (ch === '\n' || (depth === 0 && /\s/.test(ch))) return null;
    if (ch === '(') depth++;
    else if (ch === ')') {
      if (depth === 0) break;
      depth--;
    }
    j++;
  }
  if (j >= text.length || text[j] !== ')') return null;
  const rawTarget = text.slice(i + 2, j).trim();
  if (!rawTarget) return null;
  return { rawLabel, rawTarget, endIdx: j + 1 };
}

function renderLinkNode(rawLabel, rawTarget) {
  const cleanLabel = unwrapCodeLabel(rawLabel);
  if (/^file:\/\//i.test(rawTarget)) {
    const info = parseFileUrl(rawTarget);
    const filePath = info?.path || rawTarget.replace(/^file:\/\//i, '');
    return makeFileChip(cleanLabel, filePath, info?.lineRange || '', rawTarget);
  }
  if (/^https?:\/\//i.test(rawTarget)) {
    try {
      const u = new URL(rawTarget);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        const a = element('a', undefined, 'md-link');
        a.href = u.href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        inline(a, cleanLabel, false);
        return a;
      }
    } catch {}
  }
  if (/^conversation:\/\//i.test(rawTarget) || !/^[a-z][a-z0-9+.-]*:/i.test(rawTarget)) {
    return makeFileChip(cleanLabel, rawTarget, '', rawTarget);
  }
  return document.createTextNode(cleanLabel);
}

function renderImageNode(rawAlt, rawTarget) {
  const alt = rawAlt.trim() || '图片';
  if (/^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+$/i.test(rawTarget)) {
    const img = element('img', undefined, 'md-inline-img');
    img.src = rawTarget;
    img.alt = alt;
    img.loading = 'lazy';
    return img;
  }
  if (/^https?:\/\//i.test(rawTarget)) {
    return renderLinkNode(alt, rawTarget);
  }
  if (/^file:\/\//i.test(rawTarget) || !/^[a-z][a-z0-9+.-]*:/i.test(rawTarget)) {
    return renderLinkNode(alt, rawTarget);
  }
  return document.createTextNode(alt);
}

const ESCAPABLE_RE = /^[\\`*_{}[\]()#+\-.!|~<>]/;
const WORD_CHAR_RE = /[A-Za-z0-9_]/;

function findDelimClose(text, from, delim, requireBoundary = false) {
  let i = from;
  while (i < text.length) {
    if (text[i] === '\\' && i + 1 < text.length) { i += 2; continue; }
    if (text[i] === '\n') return -1;
    if (text[i] === '`') {
      let ticks = 1;
      while (text[i + ticks] === '`') ticks++;
      const close = findCodeSpanClose(text, i + ticks, ticks);
      if (close >= 0) { i = close + ticks; continue; }
    }
    if (text.startsWith(delim, i)) {
      const prev = text[i - 1];
      const next = text[i + delim.length];
      const okInner = prev && !/\s/.test(prev);
      const okOuter = !requireBoundary || !next || !WORD_CHAR_RE.test(next);
      if (delim.length === 1 && (prev === delim || next === delim)) { i++; continue; }
      if (delim.length === 2 && next === delim[0]) { i++; continue; }
      if (okInner && okOuter) return i;
    }
    i++;
  }
  return -1;
}

function findCodeSpanClose(text, startIdx, ticks) {
  let i = startIdx;
  while (i < text.length) {
    if (text[i] === '\n') return -1;
    if (text[i] === '`') {
      let run = 1;
      while (text[i + run] === '`') run++;
      if (run === ticks) return i;
      i += run;
      continue;
    }
    i++;
  }
  return -1;
}

function trimAutolinkUrl(raw) {
  let url = raw;
  while (url.length) {
    const last = url[url.length - 1];
    if (/[.,;:!?。，；：！？、'"»》）】]/.test(last)) {
      url = url.slice(0, -1);
      continue;
    }
    if (last === ')') {
      const opens = (url.match(/\(/g) || []).length;
      const closes = (url.match(/\)/g) || []).length;
      if (closes > opens) { url = url.slice(0, -1); continue; }
    }
    break;
  }
  return url;
}

function inline(parent, text, allowLinks = true) {
  let cursor = 0;
  let plainStart = 0;
  const flushPlain = end => {
    if (end > plainStart) parent.append(text.slice(plainStart, end));
  };
  while (cursor < text.length) {
    const ch = text[cursor];
    if (ch === '\\' && cursor + 1 < text.length && ESCAPABLE_RE.test(text[cursor + 1])) {
      flushPlain(cursor);
      parent.append(text[cursor + 1]);
      cursor = plainStart = cursor + 2;
      continue;
    }
    if (ch === '`') {
      let ticks = 1;
      while (text[cursor + ticks] === '`') ticks++;
      const close = findCodeSpanClose(text, cursor + ticks, ticks);
      if (close >= 0) {
        flushPlain(cursor);
        let inner = text.slice(cursor + ticks, close);
        if (inner.length >= 2 && inner.startsWith(' ') && inner.endsWith(' ') && inner.trim().length > 0) {
          inner = inner.slice(1, -1);
        }
        parent.append(element('code', inner));
        cursor = plainStart = close + ticks;
        continue;
      }
    }
    if (allowLinks && ch === '!' && text[cursor + 1] === '[') {
      const img = findMarkdownLink(text, cursor + 1);
      if (img) {
        flushPlain(cursor);
        parent.append(renderImageNode(img.rawLabel, img.rawTarget));
        cursor = plainStart = img.endIdx;
        continue;
      }
    }
    if ((ch === '*' || ch === '_') && text.startsWith(ch.repeat(3), cursor)) {
      const prev = text[cursor - 1];
      const next = text[cursor + 3];
      const needBoundary = ch === '_';
      if (next && !/\s/.test(next) && (!needBoundary || !prev || !WORD_CHAR_RE.test(prev))) {
        const close = findDelimClose(text, cursor + 3, ch.repeat(3), needBoundary);
        if (close > cursor + 3) {
          flushPlain(cursor);
          const strong = element('strong');
          const em = element('em');
          inline(em, text.slice(cursor + 3, close), allowLinks);
          strong.append(em);
          parent.append(strong);
          cursor = plainStart = close + 3;
          continue;
        }
      }
    }
    if ((ch === '*' && text[cursor + 1] === '*') || (ch === '_' && text[cursor + 1] === '_')) {
      const delim = ch + ch;
      const prev = text[cursor - 1];
      const next = text[cursor + 2];
      const needBoundary = ch === '_';
      if (next && !/\s/.test(next) && (!needBoundary || !prev || !WORD_CHAR_RE.test(prev))) {
        const close = findDelimClose(text, cursor + 2, delim, needBoundary);
        if (close > cursor + 2) {
          flushPlain(cursor);
          const strong = element('strong');
          inline(strong, text.slice(cursor + 2, close), allowLinks);
          parent.append(strong);
          cursor = plainStart = close + 2;
          continue;
        }
      }
    }
    if (ch === '~' && text[cursor + 1] === '~') {
      const next = text[cursor + 2];
      if (next && !/\s/.test(next)) {
        const close = findDelimClose(text, cursor + 2, '~~', false);
        if (close > cursor + 2) {
          flushPlain(cursor);
          const del = element('del');
          inline(del, text.slice(cursor + 2, close), allowLinks);
          parent.append(del);
          cursor = plainStart = close + 2;
          continue;
        }
      }
    }
    if ((ch === '*' && text[cursor + 1] !== '*') || (ch === '_' && text[cursor + 1] !== '_')) {
      const prev = text[cursor - 1];
      const next = text[cursor + 1];
      const needBoundary = ch === '_';
      if (next && !/\s/.test(next) && (!needBoundary || !prev || !WORD_CHAR_RE.test(prev))) {
        const close = findDelimClose(text, cursor + 1, ch, needBoundary);
        if (close > cursor + 1) {
          flushPlain(cursor);
          const em = element('em');
          inline(em, text.slice(cursor + 1, close), allowLinks);
          parent.append(em);
          cursor = plainStart = close + 1;
          continue;
        }
      }
    }
    if (allowLinks && ch === '<') {
      const m = text.slice(cursor).match(/^<(https?:\/\/[^\s<>]+)>/i);
      if (m) {
        flushPlain(cursor);
        parent.append(renderLinkNode(m[1], m[1]));
        cursor = plainStart = cursor + m[0].length;
        continue;
      }
    }
    if (allowLinks && ch === '[') {
      const link = findMarkdownLink(text, cursor);
      if (link) {
        flushPlain(cursor);
        parent.append(renderLinkNode(link.rawLabel, link.rawTarget));
        cursor = plainStart = link.endIdx;
        continue;
      }
    }
    if (allowLinks && ch === 'f' && text.startsWith('file:///', cursor)) {
      const m = text.slice(cursor).match(/^file:\/\/\/[^\s<>()`"'\]]+/);
      if (m) {
        const rawUrl = m[0].replace(/[.,;:!?。，；：！？]+$/, '');
        const info = parseFileUrl(rawUrl);
        if (info?.path) {
          flushPlain(cursor);
          const base = info.path.split('/').filter(Boolean).at(-1) || info.path;
          parent.append(makeFileChip(base, info.path, info.lineRange, rawUrl));
          cursor = plainStart = cursor + rawUrl.length;
          continue;
        }
      }
    }
    if (allowLinks && (ch === 'h' || ch === 'H') && /^https?:\/\//i.test(text.slice(cursor, cursor + 8))) {
      const prev = text[cursor - 1];
      if (!prev || /[\s([{"'（【《：:，,。;]/.test(prev)) {
        const m = text.slice(cursor).match(/^https?:\/\/[^\s<>`"'）\]】》]+/i);
        if (m) {
          const url = trimAutolinkUrl(m[0]);
          if (url.length > 8) {
            flushPlain(cursor);
            parent.append(renderLinkNode(url, url));
            cursor = plainStart = cursor + url.length;
            continue;
          }
        }
      }
    }
    cursor++;
  }
  flushPlain(text.length);
}

function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|';
      i += 2;
      continue;
    }
    if (ch === '`') {
      let ticks = 1;
      while (s[i + ticks] === '`') ticks++;
      const close = findCodeSpanClose(s, i + ticks, ticks);
      if (close >= 0) {
        cur += s.slice(i, close + ticks);
        i = close + ticks;
        continue;
      }
    }
    if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  cells.push(cur.trim());
  return cells;
}

function parseTableSeparator(line) {
  if (!line || !line.includes('|')) return null;
  const cells = splitTableRow(line);
  if (!cells.length) return null;
  const aligns = [];
  for (const cell of cells) {
    if (!/^:?-{1,}:?$/.test(cell)) return null;
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : '');
  }
  return aligns;
}

const SYN_JS_KW = new Set([
  'abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'declare', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'finally', 'for', 'from',
  'function', 'get', 'if', 'implements', 'import', 'in', 'infer', 'instanceof', 'interface', 'is', 'keyof',
  'let', 'module', 'namespace', 'new', 'of', 'override', 'package', 'private', 'protected', 'public',
  'readonly', 'return', 'satisfies', 'set', 'static', 'super', 'switch', 'this', 'throw', 'try', 'type',
  'typeof', 'var', 'void', 'while', 'with', 'yield',
]);
const SYN_PY_KW = new Set([
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else',
  'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'match', 'nonlocal',
  'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
]);
const SYN_CLAN_KW = new Set([
  'auto', 'bool', 'break', 'byte', 'case', 'catch', 'chan', 'char', 'class', 'const', 'continue', 'crate',
  'default', 'defer', 'do', 'double', 'dyn', 'else', 'enum', 'extern', 'fallthrough', 'final', 'finally',
  'float', 'fn', 'for', 'func', 'go', 'goto', 'if', 'impl', 'import', 'in', 'inline', 'int', 'interface',
  'internal', 'let', 'long', 'loop', 'map', 'match', 'mod', 'move', 'mut', 'namespace', 'new', 'operator',
  'out', 'override', 'package', 'private', 'protected', 'pub', 'public', 'range', 'readonly', 'ref',
  'return', 'sealed', 'select', 'short', 'signed', 'sizeof', 'static', 'string', 'struct', 'super',
  'switch', 'template', 'this', 'throw', 'throws', 'trait', 'try', 'type', 'typedef', 'typename', 'uint',
  'union', 'unsafe', 'unsigned', 'use', 'using', 'var', 'virtual', 'void', 'volatile', 'where', 'while',
]);
const SYN_SQL_KW = new Set([
  'select', 'from', 'where', 'join', 'left', 'right', 'inner', 'outer', 'on', 'group', 'by', 'order',
  'having', 'limit', 'offset', 'insert', 'into', 'values', 'update', 'set', 'delete', 'create', 'table',
  'alter', 'drop', 'index', 'primary', 'key', 'not', 'null', 'and', 'or', 'as', 'in', 'is', 'like',
  'distinct', 'union', 'all', 'case', 'when', 'then', 'else', 'end', 'exists', 'with', 'asc', 'desc',
]);
const SYN_SH_KW = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'until', 'case', 'esac',
  'function', 'local', 'export', 'unset', 'set', 'return', 'exit', 'exec', 'source', 'readonly', 'shift',
  'echo', 'printf', 'cd', 'pwd', 'mkdir', 'rm', 'cp', 'mv', 'ln', 'cat', 'grep', 'sed', 'awk', 'find',
  'tar', 'chmod', 'chown', 'sudo', 'ssh', 'scp', 'curl', 'git', 'npm', 'npx', 'node', 'python3', 'python',
  'systemctl', 'journalctl', 'docker', 'systemd-run',
]);
const SYN_CONST = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity', 'None', 'True', 'False', 'nil']);
const SYN_GENERIC_KW = new Set([...SYN_JS_KW, ...SYN_PY_KW, ...SYN_CLAN_KW]);

function appendTok(parent, cls, text) {
  if (!text) return;
  if (!cls) parent.append(text);
  else parent.append(element('span', text, cls));
}

function scanQuoted(text, start, quote, allowMultiline = false) {
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) { i += 2; continue; }
    if (!allowMultiline && ch === '\n') return i;
    if (ch === quote) return i + 1;
    i++;
  }
  return text.length;
}

function hasGenericCall(text, start) {
  let depth = 0;
  let i = start;
  while (i < text.length && i < start + 160) {
    const ch = text[i];
    if (ch === '\n' || ch === ';' || ch === '{' || ch === '}') return false;
    if (ch === '<') depth++;
    else if (ch === '>') {
      depth--;
      if (depth === 0) {
        let k = i + 1;
        while (k < text.length && (text[k] === ' ' || text[k] === '\t')) k++;
        return text[k] === '(';
      }
    }
    i++;
  }
  return false;
}

function highlightDiff(codeEl, text) {
  const lines = text.split('\n');
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const suffix = idx < lines.length - 1 ? '\n' : '';
    if (/^(?:\+\+\+|---|diff --git |index )/.test(line)) appendTok(codeEl, 'tok-comment', line + suffix);
    else if (line.startsWith('@@')) appendTok(codeEl, 'tok-hunk', line + suffix);
    else if (line.startsWith('+')) appendTok(codeEl, 'tok-add', line + suffix);
    else if (line.startsWith('-')) appendTok(codeEl, 'tok-del', line + suffix);
    else appendTok(codeEl, '', line + suffix);
  }
}

function highlightMarkup(codeEl, text) {
  let i = 0;
  let plain = 0;
  const flush = end => { if (end > plain) codeEl.append(text.slice(plain, end)); };
  while (i < text.length) {
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      const stop = end >= 0 ? end + 3 : text.length;
      flush(i);
      appendTok(codeEl, 'tok-comment', text.slice(i, stop));
      i = plain = stop;
      continue;
    }
    if (text[i] === '<' && /^<\/?[A-Za-z!?]/.test(text.slice(i, i + 3))) {
      const m = text.slice(i).match(/^(\<\/?)([A-Za-z!?][A-Za-z0-9:._-]*)/);
      if (m) {
        flush(i);
        appendTok(codeEl, 'tok-op', m[1]);
        appendTok(codeEl, 'tok-tag', m[2]);
        i += m[0].length;
        while (i < text.length && text[i] !== '>') {
          if (/\s/.test(text[i])) {
            let j = i + 1;
            while (j < text.length && /\s/.test(text[j])) j++;
            codeEl.append(text.slice(i, j));
            i = j;
          } else if (text[i] === '/' && text[i + 1] === '>') {
            break;
          } else if (text[i] === '"' || text[i] === "'") {
            const stop = scanQuoted(text, i, text[i], true);
            appendTok(codeEl, 'tok-string', text.slice(i, stop));
            i = stop;
          } else if (/[A-Za-z_:@-]/.test(text[i])) {
            let j = i + 1;
            while (j < text.length && /[A-Za-z0-9_:@.-]/.test(text[j])) j++;
            appendTok(codeEl, 'tok-prop', text.slice(i, j));
            i = j;
          } else {
            appendTok(codeEl, 'tok-op', text[i]);
            i++;
          }
        }
        if (text.startsWith('/>', i)) { appendTok(codeEl, 'tok-op', '/>'); i += 2; }
        else if (text[i] === '>') { appendTok(codeEl, 'tok-op', '>'); i++; }
        plain = i;
        continue;
      }
    }
    i++;
  }
  flush(text.length);
}

function highlightJson(codeEl, text) {
  let i = 0;
  let plain = 0;
  const flush = end => { if (end > plain) codeEl.append(text.slice(plain, end)); };
  while (i < text.length) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i + 2);
      const stop = nl >= 0 ? nl : text.length;
      flush(i); appendTok(codeEl, 'tok-comment', text.slice(i, stop)); i = plain = stop; continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end >= 0 ? end + 2 : text.length;
      flush(i); appendTok(codeEl, 'tok-comment', text.slice(i, stop)); i = plain = stop; continue;
    }
    if (ch === '"') {
      const stop = scanQuoted(text, i, '"', false);
      let k = stop;
      while (k < text.length && (text[k] === ' ' || text[k] === '\t')) k++;
      flush(i);
      appendTok(codeEl, text[k] === ':' ? 'tok-prop' : 'tok-string', text.slice(i, stop));
      i = plain = stop;
      continue;
    }
    if ((ch === '-' && /\d/.test(text[i + 1] || '')) || /\d/.test(ch)) {
      const m = text.slice(i).match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (m) { flush(i); appendTok(codeEl, 'tok-number', m[0]); i = plain = i + m[0].length; continue; }
    }
    if (/[a-z]/.test(ch)) {
      const m = text.slice(i).match(/^(?:true|false|null)\b/);
      if (m) { flush(i); appendTok(codeEl, 'tok-number', m[0]); i = plain = i + m[0].length; continue; }
    }
    i++;
  }
  flush(text.length);
}

function highlightCss(codeEl, text) {
  let i = 0;
  let plain = 0;
  const flush = end => { if (end > plain) codeEl.append(text.slice(plain, end)); };
  while (i < text.length) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end >= 0 ? end + 2 : text.length;
      flush(i); appendTok(codeEl, 'tok-comment', text.slice(i, stop)); i = plain = stop; continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i + 2);
      const stop = nl >= 0 ? nl : text.length;
      flush(i); appendTok(codeEl, 'tok-comment', text.slice(i, stop)); i = plain = stop; continue;
    }
    if (ch === '"' || ch === "'") {
      const stop = scanQuoted(text, i, ch, false);
      flush(i); appendTok(codeEl, 'tok-string', text.slice(i, stop)); i = plain = stop; continue;
    }
    if (ch === '@') {
      const m = text.slice(i).match(/^@[A-Za-z-]+/);
      if (m) { flush(i); appendTok(codeEl, 'tok-keyword', m[0]); i = plain = i + m[0].length; continue; }
    }
    if (ch === '-' && text[i + 1] === '-') {
      const m = text.slice(i).match(/^--[A-Za-z0-9_-]+/);
      if (m) { flush(i); appendTok(codeEl, 'tok-prop', m[0]); i = plain = i + m[0].length; continue; }
    }
    if (ch === '#') {
      const m = text.slice(i).match(/^#[0-9A-Fa-f]{3,8}\b/);
      if (m) { flush(i); appendTok(codeEl, 'tok-number', m[0]); i = plain = i + m[0].length; continue; }
    }
    if (/\d/.test(ch) && !/[A-Za-z_-]/.test(text[i - 1] || '')) {
      const m = text.slice(i).match(/^\d+(?:\.\d+)?(?:px|rem|em|vh|vw|dvh|%|ms|s|deg|fr|ch)?\b/);
      if (m) { flush(i); appendTok(codeEl, 'tok-number', m[0]); i = plain = i + m[0].length; continue; }
    }
    if (/[A-Za-z-]/.test(ch) && !/[A-Za-z0-9_-]/.test(text[i - 1] || '')) {
      const m = text.slice(i).match(/^[A-Za-z][A-Za-z0-9-]*/);
      if (m) {
        let k = i + m[0].length;
        while (k < text.length && (text[k] === ' ' || text[k] === '\t')) k++;
        if (text[k] === ':' && text[k + 1] !== ':') {
          flush(i); appendTok(codeEl, 'tok-prop', m[0]); i = plain = i + m[0].length; continue;
        }
        if (text[k] === '(') {
          flush(i); appendTok(codeEl, 'tok-fn', m[0]); i = plain = i + m[0].length; continue;
        }
      }
    }
    i++;
  }
  flush(text.length);
}

function highlightShell(codeEl, text) {
  let i = 0;
  let plain = 0;
  const flush = end => { if (end > plain) codeEl.append(text.slice(plain, end)); };
  while (i < text.length) {
    const ch = text[i];
    if (ch === '#' && (!text[i - 1] || /[\s;(]/.test(text[i - 1]))) {
      const nl = text.indexOf('\n', i + 1);
      const stop = nl >= 0 ? nl : text.length;
      flush(i); appendTok(codeEl, 'tok-comment', text.slice(i, stop)); i = plain = stop; continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const stop = scanQuoted(text, i, ch, true);
      flush(i); appendTok(codeEl, 'tok-string', text.slice(i, stop)); i = plain = stop; continue;
    }
    if (ch === '$') {
      const m = text.slice(i).match(/^\$(?:\{[^}\n]+\}|[A-Za-z_][A-Za-z0-9_]*|[0-9@#?$!*])/);
      if (m) { flush(i); appendTok(codeEl, 'tok-prop', m[0]); i = plain = i + m[0].length; continue; }
    }
    if (ch === '-' && (!text[i - 1] || /\s/.test(text[i - 1]))) {
      const m = text.slice(i).match(/^--?[A-Za-z0-9][A-Za-z0-9_-]*/);
      if (m) { flush(i); appendTok(codeEl, 'tok-type', m[0]); i = plain = i + m[0].length; continue; }
    }
    if (/[A-Za-z_]/.test(ch) && !/[A-Za-z0-9_/-]/.test(text[i - 1] || '')) {
      const m = text.slice(i).match(/^[A-Za-z_][A-Za-z0-9_-]*/);
      if (m) {
        const next = text[i + m[0].length];
        if (next === '=') {
          flush(i); appendTok(codeEl, 'tok-prop', m[0]); i = plain = i + m[0].length; continue;
        }
        if (SYN_SH_KW.has(m[0])) {
          flush(i); appendTok(codeEl, 'tok-keyword', m[0]); i = plain = i + m[0].length; continue;
        }
      }
    }
    if (/\d/.test(ch) && !/[A-Za-z0-9_.-]/.test(text[i - 1] || '')) {
      const m = text.slice(i).match(/^\d+(?:\.\d+)?\b/);
      if (m) { flush(i); appendTok(codeEl, 'tok-number', m[0]); i = plain = i + m[0].length; continue; }
    }
    i++;
  }
  flush(text.length);
}

function highlightConfig(codeEl, text, isDockerfile) {
  let i = 0;
  let plain = 0;
  const flush = end => { if (end > plain) codeEl.append(text.slice(plain, end)); };
  while (i < text.length) {
    const ch = text[i];
    const lineStart = i === 0 || text[i - 1] === '\n';
    if (ch === '#' && (lineStart || /\s/.test(text[i - 1] || ''))) {
      const nl = text.indexOf('\n', i + 1);
      const stop = nl >= 0 ? nl : text.length;
      flush(i); appendTok(codeEl, 'tok-comment', text.slice(i, stop)); i = plain = stop; continue;
    }
    if (lineStart && ch === '[') {
      const end = text.indexOf(']', i + 1);
      if (end > i && !text.slice(i, end).includes('\n')) {
        flush(i); appendTok(codeEl, 'tok-type', text.slice(i, end + 1)); i = plain = end + 1; continue;
      }
    }
    if (lineStart && isDockerfile) {
      const m = text.slice(i).match(/^(?:FROM|RUN|CMD|LABEL|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL)\b/i);
      if (m) { flush(i); appendTok(codeEl, 'tok-keyword', m[0]); i = plain = i + m[0].length; continue; }
    }
    if (lineStart) {
      const m = text.slice(i).match(/^([ \t]*(?:-\s+)?)([A-Za-z0-9_.-]+)(?=\s*[:=])/);
      if (m) {
        flush(i + m[1].length);
        appendTok(codeEl, 'tok-prop', m[2]);
        i = plain = i + m[0].length;
        continue;
      }
    }
    if (ch === '"' || ch === "'") {
      const stop = scanQuoted(text, i, ch, false);
      flush(i); appendTok(codeEl, 'tok-string', text.slice(i, stop)); i = plain = stop; continue;
    }
    if (/\d/.test(ch) && !/[A-Za-z0-9_.-]/.test(text[i - 1] || '')) {
      const m = text.slice(i).match(/^\d+(?:\.\d+)?\b/);
      if (m) { flush(i); appendTok(codeEl, 'tok-number', m[0]); i = plain = i + m[0].length; continue; }
    }
    if (/[a-zA-Z]/.test(ch) && !/[A-Za-z0-9_-]/.test(text[i - 1] || '')) {
      const m = text.slice(i).match(/^(?:true|false|null|yes|no|on|off)\b/i);
      if (m) { flush(i); appendTok(codeEl, 'tok-number', m[0]); i = plain = i + m[0].length; continue; }
    }
    i++;
  }
  flush(text.length);
}

function highlightGeneralCode(codeEl, text, lang) {
  const isPy = lang === 'py' || lang === 'python';
  const isSql = lang === 'sql';
  const isJs = ['js', 'javascript', 'mjs', 'cjs', 'ts', 'typescript', 'jsx', 'tsx'].includes(lang);
  const kwSet = isPy ? SYN_PY_KW : isSql ? SYN_SQL_KW : isJs ? SYN_JS_KW : lang ? SYN_CLAN_KW : SYN_GENERIC_KW;
  const allowHashComment = isPy || lang === 'rb' || lang === 'ruby' || lang === 'r';
  const allowSlashComment = !isPy && !isSql;
  const allowBacktickStr = isJs || lang === 'go' || !lang;
  let i = 0;
  let plain = 0;
  const flush = end => { if (end > plain) codeEl.append(text.slice(plain, end)); };
  while (i < text.length) {
    const ch = text[i];
    if (allowSlashComment && ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i + 2);
      const stop = nl >= 0 ? nl : text.length;
      flush(i); appendTok(codeEl, 'tok-comment', text.slice(i, stop)); i = plain = stop; continue;
    }
    if ((allowSlashComment || isSql) && ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end >= 0 ? end + 2 : text.length;
      flush(i); appendTok(codeEl, 'tok-comment', text.slice(i, stop)); i = plain = stop; continue;
    }
    if (isSql && ch === '-' && text[i + 1] === '-') {
      const nl = text.indexOf('\n', i + 2);
      const stop = nl >= 0 ? nl : text.length;
      flush(i); appendTok(codeEl, 'tok-comment', text.slice(i, stop)); i = plain = stop; continue;
    }
    if (allowHashComment && ch === '#') {
      const nl = text.indexOf('\n', i + 1);
      const stop = nl >= 0 ? nl : text.length;
      flush(i); appendTok(codeEl, 'tok-comment', text.slice(i, stop)); i = plain = stop; continue;
    }
    if (!allowHashComment && ch === '#' && (i === 0 || text[i - 1] === '\n')) {
      const m = text.slice(i).match(/^#(?:include|define|ifdef|ifndef|endif|pragma|if|else|elif|region|endregion)\b/);
      if (m) { flush(i); appendTok(codeEl, 'tok-keyword', m[0]); i = plain = i + m[0].length; continue; }
    }
    if (isPy && (text.startsWith('"""', i) || text.startsWith("'''", i))) {
      const delim = text.slice(i, i + 3);
      const end = text.indexOf(delim, i + 3);
      const stop = end >= 0 ? end + 3 : text.length;
      flush(i); appendTok(codeEl, 'tok-string', text.slice(i, stop)); i = plain = stop; continue;
    }
    if (ch === '"' || ch === "'" || (allowBacktickStr && ch === '`')) {
      const stop = scanQuoted(text, i, ch, ch === '`');
      flush(i); appendTok(codeEl, 'tok-string', text.slice(i, stop)); i = plain = stop; continue;
    }
    if (ch === '@' && /[A-Za-z_]/.test(text[i + 1] || '')) {
      const m = text.slice(i).match(/^@[A-Za-z_][A-Za-z0-9_.]*/);
      if (m) { flush(i); appendTok(codeEl, 'tok-type', m[0]); i = plain = i + m[0].length; continue; }
    }
    if (/\d/.test(ch) && !/[A-Za-z_$]/.test(text[i - 1] || '')) {
      const m = text.slice(i).match(/^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?n?)/);
      if (m) { flush(i); appendTok(codeEl, 'tok-number', m[0]); i = plain = i + m[0].length; continue; }
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const m = text.slice(i).match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
      if (m) {
        const word = m[0];
        const end = i + word.length;
        let k = end;
        while (k < text.length && (text[k] === ' ' || text[k] === '\t')) k++;
        const nextCh = text[k];
        const prevCh = text[i - 1];
        let cls = '';
        if (SYN_CONST.has(word)) cls = 'tok-number';
        else if (isSql ? kwSet.has(word.toLowerCase()) : kwSet.has(word)) cls = 'tok-keyword';
        else if (nextCh === '(') cls = 'tok-fn';
        else if (nextCh === '<' && hasGenericCall(text, k)) cls = 'tok-fn';
        else if (nextCh === ':' && text[k + 1] !== ':' && prevCh !== '.') {
          const linePrefix = text.slice(text.lastIndexOf('\n', i - 1) + 1, i).trim();
          if (!linePrefix || /[{,(]$/.test(linePrefix)) cls = 'tok-prop';
        }
        if (!cls && /^[A-Z][A-Za-z0-9_]*$/.test(word) && /[a-z]/.test(word)) cls = 'tok-type';
        if (cls) { flush(i); appendTok(codeEl, cls, word); i = plain = end; continue; }
        i = end;
        continue;
      }
    }
    const op = text.slice(i).match(/^(?:=>|===|!==|==|!=|<=|>=|&&|\|\||\?\?|\?\.|\.\.\.|->|::)/);
    if (op) {
      flush(i); appendTok(codeEl, 'tok-op', op[0]); i = plain = i + op[0].length; continue;
    }
    i++;
  }
  flush(text.length);
}

export function highlightCode(codeEl, text, rawLang = '') {
  const lang = String(rawLang || '').toLowerCase().trim();
  if (!text || text.length > 65536 || lang === 'text' || lang === 'txt' || lang === 'plain') {
    codeEl.textContent = text;
    return;
  }
  if (lang === 'diff' || lang === 'patch') { highlightDiff(codeEl, text); return; }
  if (lang === 'html' || lang === 'htm' || lang === 'xml' || lang === 'svg') { highlightMarkup(codeEl, text); return; }
  if (lang === 'json' || lang === 'jsonc') { highlightJson(codeEl, text); return; }
  if (lang === 'css' || lang === 'scss' || lang === 'less') { highlightCss(codeEl, text); return; }
  if (['sh', 'bash', 'zsh', 'shell', 'ps1', 'powershell', 'cmd', 'bat'].includes(lang)) { highlightShell(codeEl, text); return; }
  if (['yaml', 'yml', 'toml', 'ini', 'conf', 'nginx', 'dockerfile'].includes(lang)) { highlightConfig(codeEl, text, lang === 'dockerfile'); return; }
  highlightGeneralCode(codeEl, text, lang);
}

function makeCodeBlock(codeLines, lang = '') {
  const wrap = element('div', undefined, 'md-code-block');
  const head = element('div', undefined, 'md-code-head');
  head.append(element('span', lang || 'code', 'md-code-lang'));
  const copyBtn = element('button', undefined, 'md-code-copy');
  copyBtn.type = 'button';
  copyBtn.setAttribute('aria-label', '复制代码');
  copyBtn.append(icon('copy'), element('span', '复制'));
  head.append(copyBtn);
  const pre = element('pre');
  const codeEl = element('code');
  highlightCode(codeEl, codeLines.join('\n'), lang);
  if (lang) codeEl.className = 'language-' + lang.replace(/[^a-zA-Z0-9_+-]/g, '');
  pre.append(codeEl);
  wrap.append(head, pre);
  return wrap;
}

function isBlockBoundary(line, nextLine) {
  if (!line.trim()) return true;
  const fenceOpen = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
  if (fenceOpen && !(fenceOpen[1][0] === '`' && fenceOpen[2].includes('`'))) return true;
  if (/^\s*(?:-\s*){3,}$|^\s*(?:\*\s*){3,}$|^\s*(?:_\s*){3,}$/.test(line)) return true;
  if (/^\s*#{1,6}\s+.+$/.test(line)) return true;
  if (/^\s*>/.test(line)) return true;
  if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) return true;
  if (line.includes('|') && parseTableSeparator(nextLine)) return true;
  return false;
}

function indentWidth(ws) {
  let width = 0;
  for (const ch of ws) width += ch === '\t' ? 2 : 1;
  return width;
}

function renderBlocks(container, text) {
  const lines = text.split(/\r?\n/);
  let i = 0;
  let paragraph = [];
  let listStack = [];

  function flushParagraph() {
    if (!paragraph.length) return;
    const p = element('p');
    inline(p, paragraph.join('\n'));
    container.append(p);
    paragraph = [];
  }
  function closeLists() {
    listStack = [];
  }

  while (i < lines.length) {
    const line = lines[i];
    const nextLine = lines[i + 1];

    // 1. Fenced code block (supports info strings with args and closing fence >= open length)
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fenceMatch && !(fenceMatch[1][0] === '`' && fenceMatch[2].includes('`'))) {
      flushParagraph();
      closeLists();
      const fenceChar = fenceMatch[1][0];
      const fenceLen = fenceMatch[1].length;
      const lang = fenceMatch[2].trim().split(/\s+/)[0] || '';
      const codeLines = [];
      i++;
      while (i < lines.length) {
        const trimmed = lines[i].trim();
        if (trimmed.length >= fenceLen && trimmed === fenceChar.repeat(trimmed.length)) {
          i++;
          break;
        }
        codeLines.push(lines[i]);
        i++;
      }
      container.append(makeCodeBlock(codeLines, lang));
      continue;
    }

    // 2. Blank line
    if (!line.trim()) {
      flushParagraph();
      closeLists();
      i++;
      continue;
    }

    // 3. GFM Table
    const tableAligns = line.includes('|') ? parseTableSeparator(nextLine) : null;
    if (tableAligns) {
      const headerCells = splitTableRow(line);
      if (headerCells.length === tableAligns.length || headerCells.length > 0) {
        flushParagraph();
        closeLists();
        const colCount = Math.max(headerCells.length, tableAligns.length);
        const wrap = element('div', undefined, 'md-table-wrap');
        const table = element('table', undefined, 'md-table');
        const thead = element('thead');
        const htr = element('tr');
        for (let c = 0; c < colCount; c++) {
          const th = element('th');
          if (tableAligns[c]) th.style.textAlign = tableAligns[c];
          inline(th, headerCells[c] ?? '');
          htr.append(th);
        }
        thead.append(htr);
        table.append(thead);
        const tbody = element('tbody');
        i += 2;
        while (i < lines.length) {
          const rowLine = lines[i];
          if (!rowLine.trim() || !rowLine.includes('|')) break;
          if (isBlockBoundary(rowLine, lines[i + 1]) && !parseTableSeparator(lines[i + 1])) {
            // Headings / quotes / fences / hrs break out of table
            if (/^\s*(?:#{1,6}\s|>|`{3,}|~{3,}|(?:-\s*){3,}$|(?:\*\s*){3,}$|(?:_\s*){3,}$)/.test(rowLine)) break;
          }
          const rowCells = splitTableRow(rowLine);
          const tr = element('tr');
          for (let c = 0; c < colCount; c++) {
            const td = element('td');
            if (tableAligns[c]) td.style.textAlign = tableAligns[c];
            inline(td, rowCells[c] ?? '');
            tr.append(td);
          }
          tbody.append(tr);
          i++;
        }
        if (tbody.childNodes?.length || tbody.children?.length) table.append(tbody);
        wrap.append(table);
        container.append(wrap);
        continue;
      }
    }

    // 4. Horizontal rule
    if (/^\s*(?:-\s*){3,}$|^\s*(?:\*\s*){3,}$|^\s*(?:_\s*){3,}$/.test(line)) {
      flushParagraph();
      closeLists();
      container.append(element('hr', undefined, 'md-hr'));
      i++;
      continue;
    }

    // 5. ATX Headings h1-h6
    const headingMatch = line.match(/^\s*(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/);
    if (headingMatch) {
      flushParagraph();
      closeLists();
      const level = headingMatch[1].length;
      const h = element('h' + level, undefined, 'md-h md-h' + level);
      inline(h, headingMatch[2]);
      container.append(h);
      i++;
      continue;
    }

    // 6. Blockquote & GitHub Alerts (recursively renders nested blocks!)
    if (/^\s*>/.test(line)) {
      flushParagraph();
      closeLists();
      const quoteLines = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      let kind = '';
      const alertMatch = quoteLines[0]?.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i);
      if (alertMatch) {
        kind = alertMatch[1].toUpperCase();
        if (alertMatch[2]) quoteLines[0] = alertMatch[2];
        else quoteLines.shift();
      }
      const warn = kind === 'WARNING' || kind === 'CAUTION';
      const q = element('blockquote', undefined, 'md-quote' + (kind ? ' md-alert' + (warn ? ' warn' : '') : ''));
      if (kind && ALERT_LABELS[kind]) q.append(element('span', ALERT_LABELS[kind], 'md-alert-title'));
      if (quoteLines.length) {
        const content = element('div', undefined, 'md-quote-body');
        renderBlocks(content, quoteLines.join('\n'));
        q.append(content);
      }
      container.append(q);
      continue;
    }

    // 7. Nested lists & GFM task lists
    const itemMatch = line.match(/^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/);
    if (itemMatch) {
      flushParagraph();
      const ind = indentWidth(itemMatch[1]);
      const tag = itemMatch[3] ? 'ol' : 'ul';
      const startNum = itemMatch[3] ? Number(itemMatch[3]) : 1;
      const itemText = itemMatch[4];
      while (listStack.length > 1 && ind < listStack[listStack.length - 1].indent) {
        listStack.pop();
      }
      let top = listStack[listStack.length - 1];
      if (!top) {
        const el = element(tag);
        if (tag === 'ol' && startNum !== 1) el.setAttribute('start', String(startNum));
        container.append(el);
        top = { indent: ind, tag, el, lastLi: null };
        listStack.push(top);
      } else if (ind > top.indent && top.lastLi) {
        const el = element(tag);
        if (tag === 'ol' && startNum !== 1) el.setAttribute('start', String(startNum));
        top.lastLi.append(el);
        top = { indent: ind, tag, el, lastLi: null };
        listStack.push(top);
      } else if (top.tag !== tag) {
        listStack.pop();
        const parent = listStack[listStack.length - 1]?.lastLi ?? container;
        const el = element(tag);
        if (tag === 'ol' && startNum !== 1) el.setAttribute('start', String(startNum));
        parent.append(el);
        top = { indent: ind, tag, el, lastLi: null };
        listStack.push(top);
      }
      const taskMatch = itemText.match(/^\[([ xX])\]\s+(.*)$/);
      let li;
      if (taskMatch) {
        const checked = taskMatch[1].toLowerCase() === 'x';
        li = element('li', undefined, checked ? 'md-task-item done' : 'md-task-item');
        const box = element('input', undefined, 'md-task-box');
        box.type = 'checkbox';
        box.disabled = true;
        box.setAttribute('disabled', '');
        if (checked) { box.checked = true; box.setAttribute('checked', ''); }
        const span = element('span', undefined, 'md-task-text');
        inline(span, taskMatch[2]);
        li.append(box, span);
      } else {
        li = element('li');
        inline(li, itemText);
      }
      top.el.append(li);
      top.lastLi = li;
      i++;
      continue;
    }

    // Indented continuation of an active list item
    if (listStack.length && /^\s{2,}\S/.test(line)) {
      const lastLi = listStack[listStack.length - 1].lastLi;
      if (lastLi) {
        lastLi.append(element('br'));
        inline(lastLi, line.trim());
        i++;
        continue;
      }
    }

    // 8. Normal paragraph line
    closeLists();
    paragraph.push(line);
    i++;
  }
  flushParagraph();
}

function formatted(text) {
  const body = element('div', undefined, 'answer');
  renderBlocks(body, text);
  return body;
}

const toolLabels = {
  workspace_read_file: '读取文件', workspace_read_files: '批量读取', workspace_list_directory: '查看目录',
  workspace_file_info: '文件信息', workspace_search: '搜索项目', workspace_create_directory: '创建目录',
  workspace_write_file: '写入文件', workspace_edit_file: '编辑文件', workspace_delete_file: '删除文件',
  workspace_move_file: '移动文件', workspace_apply_patch: '应用补丁', workspace_run: '执行命令',
  session_read_attachment: '读取附件', session_send_attachment: '写入附件',
  memory_save: '保存记忆', memory_list: '查看记忆', memory_delete: '删除记忆',
};

function fmtSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}
function fmtDuration(ms) {
  if (!ms) return '';
  return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms';
}

function toolStep(event, expanded, liveOutput) {
  const step = element('details', undefined, 'tool-step');
  step.dataset.call = event.id;
  step.open = expanded.has(event.id);
  const summary = element('summary');
  const label = toolLabels[event.name] ?? event.name;
  const subject = event.input?.path ?? event.input?.fromPath ?? event.input?.attachment ?? event.input?.key ?? event.input?.pattern ?? event.input?.command?.slice(0, 48) ?? '';
  const status = event.status === 'failed' ? '失败' : event.status === 'running' ? '进行中' : '';
  const iconName = event.name?.startsWith('memory_') ? 'spark' : event.name?.includes('read') ? 'file' : 'terminal';
  summary.append(icon(iconName),
    element('span', [label, subject, status].filter(Boolean).join(' · ')), icon('down'));
  const outputText = event.output ?? (event.status === 'running' && liveOutput ? liveOutput : null);
  step.append(summary, element('pre', outputText ?? (event.status === 'running' ? '等待设备返回结果…' : '本次操作已结束。')));
  return step;
}

function thinkingStep(id, text, expanded, openDefault = false) {
  const details = element('details', undefined, 'thinking-step');
  details.dataset.think = id;
  details.open = expanded.has(id) || openDefault;
  const summary = element('summary');
  summary.append(icon('spark'), element('span', '思考过程'), icon('down'));
  details.append(summary, element('div', text, 'thinking-body'));
  return details;
}

export function renderThread(container, rows, { sessionId, isWeb = false, liveToolOutput = new Map(), hasActiveTurn = false } = {}) {
  const latest = new Map();
  const expandedTools = new Set([...container.querySelectorAll('details.tool-step[open]')].map(d => d.dataset.call));
  const expandedThink = new Set([...container.querySelectorAll('details.thinking-step[open]')].map(d => d.dataset.think));
  for (const row of rows) if (row.event.type === 'tool_call') latest.set(row.event.id, row.seq);
  const output = document.createDocumentFragment();
  for (let i = 0; i < rows.length; i++) {
    const { event, seq } = rows[i];
    if (event.type === 'user_message') {
      const bubble = element('article', undefined, 'user-message');
      bubble.setAttribute('aria-label', '你的消息');
      bubble.append(element('div', event.text));
      if (Array.isArray(event.attachments) && event.attachments.length) {
        const list = element('div', undefined, 'msg-atts');
        for (const att of event.attachments) {
          const url = isWeb && sessionId ? `/api/sessions/${sessionId}/attachments/${att.id}` : null;
          if (url && /^image\//.test(att.mime)) {
            const btn = element('button', undefined, 'msg-att-img-btn');
            btn.type = 'button';
            btn.dataset.previewUrl = url;
            btn.dataset.previewName = att.name;
            btn.dataset.previewSize = String(att.size ?? 0);
            btn.title = `点击查看大图：${att.name} (${fmtSize(att.size)})`;
            btn.setAttribute('aria-label', `预览图片 ${att.name}`);
            const img = element('img', undefined, 'msg-att-img');
            img.src = url; img.alt = att.name; img.loading = 'lazy';
            btn.append(img, element('span', att.name, 'msg-att-img-cap'));
            list.append(btn);
          } else {
            const chip = element(url ? 'a' : 'span', undefined, 'msg-att');
            if (url) { chip.href = url; chip.target = '_blank'; chip.rel = 'noopener'; }
            chip.append(icon('paperclip'), element('span', `${att.name} (${fmtSize(att.size)})`));
            list.append(chip);
          }
        }
        bubble.append(list);
      }
      output.append(bubble);
    } else if (event.type === 'thinking' && event.text) {
      output.append(thinkingStep(event.id ?? String(seq), event.text, expandedThink));
    } else if (event.type === 'assistant_text') {
      let text = event.text;
      const group = String(event.id).replace(/-\d+$/, '');
      while (rows[i + 1]?.event.type === 'assistant_text' && String(rows[i + 1].event.id).replace(/-\d+$/, '') === group) {
        text += rows[++i].event.text;
      }
      const message = element('article', undefined, 'assistant-message');
      const author = element('div', undefined, 'author'), mark = element('span', undefined, 'brand-mark');
      mark.append(icon('terminal'));
      author.append(mark, element('span', event.engine === 'antigravity' ? 'Antigravity' : event.engine === 'codex' ? 'Codex' : '助手'));
      message.append(author, formatted(text));
      output.append(message);
    } else if (event.type === 'tool_call' && latest.get(event.id) === seq) {
      output.append(toolStep(event, expandedTools, liveToolOutput.get(event.id)));
    } else if (event.type === 'context_compacted') {
      const div = element('div', undefined, 'context-compacted');
      div.setAttribute('role', 'status');
      let label = '上下文已压缩';
      if (typeof event.before?.used === 'number' && typeof event.after?.used === 'number') {
        label += ` · ${formatTokenCount(event.before.used)} → ${formatTokenCount(event.after.used)} tokens`;
      } else if (typeof event.after?.used === 'number') {
        label += ` · 当前 ${formatTokenCount(event.after.used)} tokens`;
      }
      div.append(icon('compress'), element('span', label));
      output.append(div);
    } else if (event.type === 'turn_notice') {
      const div = element('div', undefined, 'turn-notice');
      div.setAttribute('role', 'status');
      if (event.code) div.dataset.noticeCode = event.code;
      const body = element('div', undefined, 'turn-notice-body');
      body.append(element('strong', event.title || '回合提示'));
      if (event.detail) body.append(element('span', event.detail));
      div.append(icon('alert'), body);
      const laterRows = rows.slice(i + 1);
      const hasLaterUserMessage = laterRows.some(r => r?.event?.type === 'user_message');
      const hasLaterTurnEnd = laterRows.some(r => r?.event?.type === 'turn_end');
      if (event.canContinue && !hasLaterUserMessage) {
        const btn = element('button', '继续执行', 'secondary turn-continue-btn');
        btn.type = 'button';
        btn.dataset.continuePrompt = event.continuePrompt || '请从上次暂停的位置继续完成剩余任务。';
        if (hasActiveTurn && !hasLaterTurnEnd) btn.disabled = true;
        div.append(btn);
      }
      output.append(div);
    } else if (event.type === 'turn_end') {
      if (!event.ok) {
        output.append(element('p', event.error || '本次回复中断。', 'turn-error'));
      } else {
        const parts = [];
        if (event.model) parts.push(event.model);
        if (event.durationMs) parts.push(fmtDuration(event.durationMs));
        if (event.toolCalls?.total) parts.push(`${event.toolCalls.total} 次工具`);
        if (event.usage?.inputTokens || event.usage?.outputTokens) {
          parts.push(`in ${event.usage.inputTokens ?? 0} / out ${event.usage.outputTokens ?? 0}`);
        }
        if (parts.length) output.append(element('p', parts.join(' · '), 'turn-meta'));
      }
    }
  }
  container.replaceChildren(output);
}

export function renderLive(container, live, engineLabel = 'Codex') {
  const hasContent = Boolean(live.thinking || live.text);
  container.hidden = !hasContent;
  if (!hasContent) { container.replaceChildren(); return; }
  const frag = document.createDocumentFragment();
  if (live.thinking) {
    const details = element('details', undefined, 'thinking-step');
    details.open = true;
    const summary = element('summary');
    summary.append(icon('spark'), element('span', '思考中…'), icon('down'));
    details.append(summary, element('div', live.thinking, 'thinking-body'));
    frag.append(details);
  }
  if (live.text) {
    const msg = element('article', undefined, 'assistant-message');
    const author = element('div', undefined, 'author'), mark = element('span', undefined, 'brand-mark');
    mark.append(icon('terminal'));
    author.append(mark, element('span', engineLabel));
    msg.append(author, formatted(live.text));
    frag.append(msg);
  }
  container.replaceChildren(frag);
}
