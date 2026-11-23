// Codex apply_patch format parser and hunk applier (pure JS, zero dependencies).
// Format:
//   *** Begin Patch
//   *** Add File: path
//   +line
//   *** Delete File: path
//   *** Update File: path
//   *** Move to: new/path         (optional)
//   @@ optional anchor line
//    context / -removed / +added
//   *** End of File               (optional)
//   *** End Patch

export function parsePatch(patch) {
  const lines = String(patch).replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  const skipBlank = () => {
    while (i < lines.length && !lines[i].trim()) i++;
  };
  skipBlank();
  if (lines[i]?.trim() === '*** Begin Patch') i++;
  const ops = [];
  const isHeader = (l) => /^\*\*\* (Add File|Delete File|Update File|End Patch)\b/.test(l.trim());
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    let m;
    if (!t) {
      i++;
    } else if (t === '*** End Patch') {
      break;
    } else if ((m = t.match(/^\*\*\* Add File: (.+)$/))) {
      const op = { kind: 'add', path: m[1].trim(), lines: [] };
      i++;
      while (i < lines.length && !isHeader(lines[i])) {
        const l = lines[i];
        if (l.startsWith('+')) op.lines.push(l.slice(1));
        else if (l.trim()) throw Object.assign(new Error(`PATCH_INVALID_ADD_LINE:${op.path}`), { code: 'PATCH_PARSE_ERROR' });
        i++;
      }
      ops.push(op);
    } else if ((m = t.match(/^\*\*\* Delete File: (.+)$/))) {
      ops.push({ kind: 'delete', path: m[1].trim() });
      i++;
    } else if ((m = t.match(/^\*\*\* Update File: (.+)$/))) {
      const op = { kind: 'update', path: m[1].trim(), hunks: [] };
      i++;
      const move = lines[i]?.trim().match(/^\*\*\* Move to: (.+)$/);
      if (move) {
        op.moveTo = move[1].trim();
        i++;
      }
      let hunk = null;
      const start = (anchor) => {
        hunk = { anchor, old: [], new: [], looseTail: 0, atEnd: false };
        op.hunks.push(hunk);
        return hunk;
      };
      while (i < lines.length && !isHeader(lines[i])) {
        const l = lines[i];
        if (l.startsWith('@@')) {
          start(l.slice(2).replace(/@@\s*$/, '').trim() || undefined);
        } else if (l.trim() === '*** End of File') {
          if (hunk) hunk.atEnd = true;
        } else {
          const h = hunk ?? start();
          if (l === '') {
            h.old.push('');
            h.new.push('');
            h.looseTail++;
          } else {
            const body = l.slice(1);
            if (l[0] === ' ') { h.old.push(body); h.new.push(body); }
            else if (l[0] === '-') h.old.push(body);
            else if (l[0] === '+') h.new.push(body);
            else throw Object.assign(new Error(`PATCH_INVALID_HUNK_LINE:${op.path}`), { code: 'PATCH_PARSE_ERROR' });
            h.looseTail = 0;
          }
        }
        i++;
      }
      if (!op.hunks.length && !op.moveTo) throw Object.assign(new Error(`PATCH_EMPTY_UPDATE:${op.path}`), { code: 'PATCH_PARSE_ERROR' });
      ops.push(op);
    } else {
      throw Object.assign(new Error('PATCH_INVALID_HEADER'), { code: 'PATCH_PARSE_ERROR' });
    }
  }
  if (!ops.length) throw Object.assign(new Error('PATCH_EMPTY'), { code: 'PATCH_PARSE_ERROR' });
  return ops;
}

function seek(lines, want, from, atEnd) {
  const tests = [(a, b) => a === b, (a, b) => a.trimEnd() === b.trimEnd(), (a, b) => a.trim() === b.trim()];
  for (const eq of tests) {
    const matches = (at) => want.every((w, k) => eq(lines[at + k], w));
    if (atEnd) {
      const at = lines.length - want.length;
      if (at >= from && matches(at)) return at;
    }
    for (let at = from; at + want.length <= lines.length; at++) if (matches(at)) return at;
  }
  return -1;
}

export function applyHunks(content, hunks, path) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content === '' ? [] : content.split(/\r?\n/);
  const trailingNewline = content === '' || content.endsWith('\n');
  if (content.endsWith('\n')) lines.pop();
  let cursor = 0;
  for (const h of hunks) {
    if (h.anchor) {
      const a = seek(lines, [h.anchor], cursor, false);
      if (a >= 0) cursor = a + 1;
    }
    if (!h.old.length) {
      const at = h.anchor && cursor > 0 ? cursor : lines.length;
      lines.splice(at, 0, ...h.new);
      cursor = at + h.new.length;
      continue;
    }
    let old = h.old;
    let neu = h.new;
    let at = seek(lines, old, cursor, h.atEnd);
    if (at < 0 && h.looseTail) {
      old = old.slice(0, old.length - h.looseTail);
      neu = neu.slice(0, neu.length - Math.min(h.looseTail, neu.length));
      at = old.length ? seek(lines, old, cursor, h.atEnd) : -1;
    }
    if (at < 0 && cursor > 0) at = seek(lines, old, 0, h.atEnd);
    if (at < 0) throw Object.assign(new Error(`PATCH_HUNK_MISMATCH:${path}`), { code: 'PATCH_HUNK_MISMATCH' });
    lines.splice(at, old.length, ...neu);
    cursor = at + neu.length;
  }
  return lines.join(eol) + (trailingNewline ? eol : '');
}
