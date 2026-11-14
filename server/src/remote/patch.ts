// Codex's apply_patch format, applied to files on a member's computer. Codex is trained to edit
// files this way; its built-in tool writes to this server (and is refused for members), so the
// remote tools take the same format. Pure functions: reading and writing happen in mcp.ts.
//
//   *** Begin Patch
//   *** Add File: path            lines follow, each starting with "+"
//   *** Delete File: path
//   *** Update File: path
//   *** Move to: new/path         (optional)
//   @@ optional line to anchor at
//    context line                (" " context, "-" removed, "+" added)
//   *** End of File               (optional: the hunk is at the end of the file)
//   *** End Patch

export interface Hunk {
  /** Text after "@@": a line just above the change, to find the right place. */
  anchor?: string;
  old: string[];
  new: string[];
  /** Trailing context lines that came from blank lines (often a stray blank line before the next hunk). */
  looseTail: number;
  atEnd: boolean;
}

export type PatchOp =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo?: string; hunks: Hunk[] };

export function parsePatch(patch: string): PatchOp[] {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  const skipBlank = () => {
    while (i < lines.length && !lines[i].trim()) i++;
  };
  skipBlank();
  if (lines[i]?.trim() === '*** Begin Patch') i++;
  const ops: PatchOp[] = [];
  const header = (l: string) => /^\*\*\* (Add File|Delete File|Update File|End Patch)\b/.test(l.trim());
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    let m: RegExpMatchArray | null;
    if (!t) {
      i++;
    } else if (t === '*** End Patch') {
      break;
    } else if ((m = t.match(/^\*\*\* Add File: (.+)$/))) {
      const op: PatchOp = { kind: 'add', path: m[1].trim(), lines: [] };
      i++;
      while (i < lines.length && !header(lines[i])) {
        const l = lines[i];
        if (l.startsWith('+')) op.lines.push(l.slice(1));
        else if (l.trim()) throw new Error(`Add File ${op.path}：每一行内容都要以 + 开头：${l}`);
        i++;
      }
      ops.push(op);
    } else if ((m = t.match(/^\*\*\* Delete File: (.+)$/))) {
      ops.push({ kind: 'delete', path: m[1].trim() });
      i++;
    } else if ((m = t.match(/^\*\*\* Update File: (.+)$/))) {
      const op: Extract<PatchOp, { kind: 'update' }> = { kind: 'update', path: m[1].trim(), hunks: [] };
      i++;
      const move = lines[i]?.trim().match(/^\*\*\* Move to: (.+)$/);
      if (move) {
        op.moveTo = move[1].trim();
        i++;
      }
      let hunk: Hunk | null = null;
      const start = (anchor?: string) => {
        hunk = { anchor, old: [], new: [], looseTail: 0, atEnd: false };
        op.hunks.push(hunk);
        return hunk;
      };
      while (i < lines.length && !header(lines[i])) {
        const l = lines[i];
        if (l.startsWith('@@')) {
          start(l.slice(2).replace(/@@\s*$/, '').trim() || undefined);
        } else if (l.trim() === '*** End of File') {
          if (hunk) (hunk as Hunk).atEnd = true;
        } else {
          const h: Hunk = hunk ?? start();
          if (l === '') {
            // A bare blank line inside a hunk is an empty context line.
            h.old.push('');
            h.new.push('');
            h.looseTail++;
          } else {
            const body = l.slice(1);
            if (l[0] === ' ') (h.old.push(body), h.new.push(body));
            else if (l[0] === '-') h.old.push(body);
            else if (l[0] === '+') h.new.push(body);
            else throw new Error(`Update File ${op.path}：无法理解这一行（应以空格、- 或 + 开头）：${l}`);
            h.looseTail = 0;
          }
        }
        i++;
      }
      if (!op.hunks.length && !op.moveTo) throw new Error(`Update File ${op.path}：没有要改的内容`);
      ops.push(op);
    } else {
      throw new Error(`无法理解这一行（应该是 *** Add File / *** Update File / *** Delete File）：${line}`);
    }
  }
  if (!ops.length) throw new Error('补丁里没有任何文件操作');
  return ops;
}

/** Where `want` appears in `lines` at or after `from`: exactly, then ignoring trailing, then all surrounding whitespace. */
function seek(lines: string[], want: string[], from: number, atEnd: boolean): number {
  const tests = [(a: string, b: string) => a === b, (a: string, b: string) => a.trimEnd() === b.trimEnd(), (a: string, b: string) => a.trim() === b.trim()];
  for (const eq of tests) {
    const matches = (at: number) => want.every((w, k) => eq(lines[at + k], w));
    if (atEnd) {
      const at = lines.length - want.length;
      if (at >= from && matches(at)) return at;
    }
    for (let at = from; at + want.length <= lines.length; at++) if (matches(at)) return at;
  }
  return -1;
}

/** Applies an update's hunks to a file's content. Throws, changing nothing, when a hunk does not fit. */
export function applyHunks(content: string, hunks: Hunk[], path: string): string {
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
      // Pure insertion: after the anchor if there was one, else at the end of the file.
      const at = h.anchor && cursor > 0 ? cursor : lines.length;
      lines.splice(at, 0, ...h.new);
      cursor = at + h.new.length;
      continue;
    }
    let old = h.old;
    let neu = h.new;
    let at = seek(lines, old, cursor, h.atEnd);
    // Blank lines the model left at the end of a hunk often are not in the file.
    if (at < 0 && h.looseTail) {
      old = old.slice(0, old.length - h.looseTail);
      neu = neu.slice(0, neu.length - Math.min(h.looseTail, neu.length));
      at = old.length ? seek(lines, old, cursor, h.atEnd) : -1;
    }
    // Hunks out of order: look from the top as well.
    if (at < 0 && cursor > 0) at = seek(lines, old, 0, h.atEnd);
    if (at < 0) throw new Error(`${path}：找不到要改的地方，这几行在文件里没对上：\n${old.slice(0, 8).join('\n')}`);
    lines.splice(at, old.length, ...neu);
    cursor = at + neu.length;
  }
  return lines.join(eol) + (trailingNewline ? eol : '');
}
