import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { SessionStore } from '../../session-host/store.mjs';
import { renderThread } from '../ui/thread.js';

test('SessionStore.pageBefore loads tail 16 messages aligned on user_message and paginates backward losslessly', t => {
  const dir = mkdtempSync(join(tmpdir(), 'anywhere-paginate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new SessionStore(join(dir, 'history.sqlite'));
  t.after(() => store.close());

  const wsId = randomUUID();
  const s = store.create({ requestId: randomUUID(), workspaceId: wsId, title: 'Long thread' }, { accountId: '1', deviceId: randomUUID() });

  // Append 30 turns (60 messages + tool_call & turn_end = 150 events total)
  for (let turn = 1; turn <= 30; turn++) {
    store.append(s.id, { type: 'user_message', text: `User turn ${turn}` });
    store.append(s.id, { type: 'thinking', id: `th-${turn}`, text: `Thinking ${turn}` });
    store.append(s.id, { type: 'tool_call', id: `tc-${turn}`, name: 'workspace_read_file', input: { path: 'a.js' }, status: 'completed', output: 'ok' });
    store.append(s.id, { type: 'assistant_text', id: `msg-${turn}-0`, text: `Assistant reply ${turn}` });
    store.append(s.id, { type: 'turn_end', ok: true, durationMs: 100 });
  }

  const latest = store.session(s.id);
  assert.equal(latest.lastSeq, 150);

  // Initial tail load (like opening a session)
  const tail = store.pageBefore(s.id, latest.lastSeq + 1);
  assert.equal(tail.throughSeq, 150);
  assert.equal(tail.hasMore, true);
  // First event of tail page MUST be a user_message (turn-boundary aligned, never mid-turn)
  assert.equal(tail.events[0].event.type, 'user_message');
  const tailMsgCount = tail.events.filter(r => r.event.type === 'user_message' || r.event.type === 'assistant_text').length;
  assert.equal(tailMsgCount, 16);
  assert.equal(tail.events[0].event.text, 'User turn 23');

  // Walk backward page by page until seq 1
  let collected = [...tail.events];
  let cursor = tail.firstSeq;
  let pages = 1;
  while (cursor > 1) {
    const older = store.pageBefore(s.id, cursor);
    assert.ok(older.events.length > 0);
    assert.equal(older.events[0].event.type, 'user_message');
    assert.equal(older.events.at(-1).seq, cursor - 1);
    collected = older.events.concat(collected);
    cursor = older.firstSeq;
    pages++;
  }
  assert.equal(pages, 4);
  assert.equal(collected.length, 150);
  assert.deepEqual(collected.map(r => r.seq), Array.from({ length: 150 }, (_, i) => i + 1));
});

test('renderThread renders Markdown file:// links, web links, bold links, hr and GitHub alerts cleanly without raw URLs', () => {
  class MiniNode {
    constructor(tag) {
      this.localName = tag;
      this.className = '';
      this.dataset = {};
      this.attributes = {};
      this.children = [];
      this._text = '';
    }
    set textContent(v) { this._text = String(v); this.children = []; }
    get textContent() { return this._text + this.children.map(c => (typeof c === 'string' ? c : c.textContent)).join(''); }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    append(...items) {
      for (const it of items) {
        if (typeof it === 'string') {
          if (it) this.children.push(it);
        } else if (it?.localName === '#fragment') {
          this.children.push(...it.children);
        } else if (it) {
          this.children.push(it);
        }
      }
    }
    replaceChildren(...items) { this.children = []; this._text = ''; this.append(...items); }
    querySelectorAll(pred) {
      const out = [];
      const visit = n => {
        if (!n || typeof n === 'string') return;
        if (typeof pred === 'function' && pred(n)) out.push(n);
        for (const c of n.children || []) visit(c);
      };
      // Also preserve basic selector string call used by renderThread at start
      if (typeof pred === 'string') return [];
      visit(this);
      return out;
    }
  }
  const prevDoc = globalThis.document;
  globalThis.document = {
    createElement: tag => new MiniNode(tag),
    createElementNS: (_ns, tag) => new MiniNode(tag),
    createTextNode: str => String(str),
    createDocumentFragment: () => new MiniNode('#fragment'),
  };
  try {
    const container = new MiniNode('div');
    const md = [
      '已从 [AnywhereMesh-0.4.8-linux-x64.tar.gz](file:///vol1/1000/workspace/coding/anywhere-crossborder-lab/releases/AnywhereMesh-0.4.8-linux-x64.tar.gz) 升级安装。',
      '',
      '- **[index.html](file:///vol1/1000/source/index.html#L130-L148)** 与 [`v0.4.8`](https://github.com/Xwatson/anywhere-mesh/releases/tag/v0.4.8)',
      '- 安全过滤 [恶意链接](javascript:alert(1))',
      '',
      '---',
      '',
      '> [!TIP]',
      '> 等待约 **10 秒**后刷新页面。',
    ].join('\n');

    renderThread(container, [{ seq: 1, event: { type: 'assistant_text', id: 'm1', engine: 'antigravity', text: md } }], { isWeb: true });

    const renderedText = container.textContent;
    assert.ok(!renderedText.includes('file:///'), 'Should not render raw file:/// URL: ' + renderedText);
    assert.ok(renderedText.includes('AnywhereMesh-0.4.8-linux-x64.tar.gz'));
    assert.ok(renderedText.includes('index.html:130-148'));
    assert.ok(!renderedText.includes('[!TIP]'), 'Should transform [!TIP] alert tag');
    assert.ok(renderedText.includes('提示'));

    const fileChips = container.querySelectorAll(n => n.className === 'md-file');
    assert.equal(fileChips.length, 2);
    assert.equal(fileChips[0].dataset.copyText, '/vol1/1000/workspace/coding/anywhere-crossborder-lab/releases/AnywhereMesh-0.4.8-linux-x64.tar.gz');
    assert.equal(fileChips[0].dataset.rawUrl, 'file:///vol1/1000/workspace/coding/anywhere-crossborder-lab/releases/AnywhereMesh-0.4.8-linux-x64.tar.gz');
    assert.equal(fileChips[1].dataset.copyText, '/vol1/1000/source/index.html');
    assert.equal(fileChips[1].dataset.lineRange, '130-148');

    const webLinks = container.querySelectorAll(n => n.className === 'md-link');
    assert.equal(webLinks.length, 1);
    assert.equal(webLinks[0].href, 'https://github.com/Xwatson/anywhere-mesh/releases/tag/v0.4.8');
    assert.equal(webLinks[0].textContent, 'v0.4.8');

    const hrs = container.querySelectorAll(n => n.localName === 'hr');
    assert.equal(hrs.length, 1);

    const quotes = container.querySelectorAll(n => n.localName === 'blockquote' && n.className.includes('md-alert'));
    assert.equal(quotes.length, 1);
  } finally {
    globalThis.document = prevDoc;
  }
});
