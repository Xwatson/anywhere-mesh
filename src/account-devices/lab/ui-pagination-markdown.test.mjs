import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { SessionStore } from '../../session-host/store.mjs';
import { formatTokenCount, highlightCode, renderThread } from '../ui/thread.js';

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

test('cached-session history sync indicator is rendered at the bottom of #timeline below #events', () => {
  const html = readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
  const appJs = readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');

  const timelineIdx = html.indexOf('id="timeline"');
  const loadOlderIdx = html.indexOf('id="load-older"');
  const eventsIdx = html.indexOf('id="events"');
  const liveIdx = html.indexOf('id="live"');
  const historySyncIdx = html.indexOf('id="history-sync"');
  const workingIdx = html.indexOf('id="working"');

  assert.ok(timelineIdx >= 0 && loadOlderIdx > timelineIdx, 'load-older should stay inside timeline');
  assert.ok(eventsIdx > loadOlderIdx, 'events should follow load-older');
  assert.ok(liveIdx > eventsIdx, 'live area should follow events');
  assert.ok(historySyncIdx > liveIdx, 'history-sync indicator must appear below events/live at the bottom of the thread');
  assert.ok(workingIdx > historySyncIdx, 'working indicator should remain after history-sync');
  assert.match(html, /id="history-sync-spinner" class="spinner"/);
  assert.match(appJs, /正在加载最新消息…/);
  assert.match(appJs, /pendingScrollBottom/);
});

test('renderThread supports GFM tables, headings h1-h6, emphasis/del, nested/task lists, code blocks with copy, autolinks, escapes and context_compacted', () => {
  class MiniNode {
    constructor(tag) {
      this.localName = tag;
      this.className = '';
      this.dataset = {};
      this.attributes = {};
      this.style = {};
      this.children = [];
      this._text = '';
    }
    set textContent(v) { this._text = String(v); this.children = []; }
    get textContent() { return this._text + this.children.map(c => (typeof c === 'string' ? c : c.textContent)).join(''); }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    append(...items) {
      for (const it of items) {
        if (typeof it === 'string') { if (it) this.children.push(it); }
        else if (it?.localName === '#fragment') this.children.push(...it.children);
        else if (it) this.children.push(it);
      }
    }
    replaceChildren(...items) { this.children = []; this._text = ''; this.append(...items); }
    querySelectorAll(pred) {
      if (typeof pred === 'string') return [];
      const out = [];
      const visit = n => {
        if (!n || typeof n === 'string') return;
        if (pred(n)) out.push(n);
        for (const c of n.children || []) visit(c);
      };
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
      '# 一级标题',
      '## 二级标题 ##',
      '#### 四级标题',
      '',
      '| 模块 | 说明 | 数量 |',
      '| :--- | :---: | ---: |',
      '| `a | b` | **支持** ~~旧版~~ *斜体* | 12 |',
      '| 转义\\|竖线 | `foo_bar_baz` 与 2 * 3 * 4 | 99 |',
      '',
      '- [x] 已完成任务',
      '- [ ] 待办任务',
      '  1. 子有序第一项',
      '  2. 子有序第二项',
      '',
      '3. 保留起始编号',
      '',
      '***粗斜体***、__下划线粗体__、``含 `反引号` 代码``、\\*转义星号\\*、![图](https://example.com/a.png)',
      '*斜体含 **加粗** 内容* 与 **加粗含 *斜体***',
      '自动链接 https://example.com/path(1)/docs。 以及 <https://example.com/auto>',
      '',
      '```ts title="demo.ts"',
      'const x = 1;',
      '```',
      '',
      '> [!WARNING]',
      '> 第一段说明',
      '>',
      '> - 引用内列表项',
    ].join('\n');

    renderThread(container, [
      { seq: 1, event: { type: 'assistant_text', id: 'm1', engine: 'antigravity', text: md } },
      { seq: 2, event: { type: 'context_compacted', engine: 'antigravity', before: { used: 183400, window: 1048576 }, after: { used: 24100, window: 1048576 } } },
    ], { isWeb: true });

    // Headings h1, h2, h4
    assert.equal(container.querySelectorAll(n => n.localName === 'h1').length, 1);
    assert.equal(container.querySelectorAll(n => n.localName === 'h2')[0].textContent, '二级标题');
    assert.equal(container.querySelectorAll(n => n.localName === 'h4').length, 1);

    // GFM table with alignments, pipe in code span, escaped pipe
    const tables = container.querySelectorAll(n => n.localName === 'table' && n.className === 'md-table');
    assert.equal(tables.length, 1);
    const ths = tables[0].querySelectorAll(n => n.localName === 'th');
    assert.equal(ths.length, 3);
    assert.equal(ths[0].style.textAlign, 'left');
    assert.equal(ths[1].style.textAlign, 'center');
    assert.equal(ths[2].style.textAlign, 'right');
    const tds = tables[0].querySelectorAll(n => n.localName === 'td');
    assert.equal(tds.length, 6);
    assert.equal(tds[0].textContent, 'a | b');
    assert.equal(tds[3].textContent, '转义|竖线');
    assert.equal(tds[4].querySelectorAll(n => n.localName === 'em').length, 0, 'foo_bar_baz and 2 * 3 * 4 must not become <em>');

    // Task lists & nested ordered list & start attribute
    const checkboxes = container.querySelectorAll(n => n.localName === 'input' && n.className === 'md-task-box');
    assert.equal(checkboxes.length, 2);
    assert.equal(checkboxes[0].checked, true);
    assert.equal(checkboxes[1].checked, undefined);
    const ols = container.querySelectorAll(n => n.localName === 'ol');
    assert.equal(ols.length, 2);
    assert.equal(ols[1].attributes.start, '3');

    // Inline del, em, strong, multi-backtick code, escape, image, autolinks
    assert.equal(container.querySelectorAll(n => n.localName === 'del').length, 1);
    assert.ok(container.querySelectorAll(n => n.localName === 'em').some(n => n.textContent === '斜体'));
    assert.ok(container.querySelectorAll(n => n.localName === 'em').some(n => n.textContent === '粗斜体'));
    assert.ok(container.querySelectorAll(n => n.localName === 'strong').some(n => n.textContent === '下划线粗体'));
    assert.ok(container.querySelectorAll(n => n.localName === 'em').some(n => n.textContent === '斜体含 加粗 内容' && n.querySelectorAll(c => c.localName === 'strong' && c.textContent === '加粗').length === 1));
    assert.ok(container.querySelectorAll(n => n.localName === 'strong').some(n => n.textContent === '加粗含 斜体' && n.querySelectorAll(c => c.localName === 'em' && c.textContent === '斜体').length === 1));
    assert.ok(container.querySelectorAll(n => n.localName === 'code').some(n => n.textContent === '含 `反引号` 代码'));
    assert.ok(container.textContent.includes('*转义星号*'));
    assert.ok(!container.textContent.includes('![图]'));
    const links = container.querySelectorAll(n => n.localName === 'a' && n.className === 'md-link');
    assert.ok(links.some(a => a.href === 'https://example.com/path(1)/docs'));
    assert.ok(links.some(a => a.href === 'https://example.com/auto'));
    assert.ok(links.some(a => a.href === 'https://example.com/a.png' && a.textContent === '图'));

    // Fenced code block with info string + language badge + copy button
    const codeBlocks = container.querySelectorAll(n => n.className === 'md-code-block');
    assert.equal(codeBlocks.length, 1);
    assert.equal(codeBlocks[0].querySelectorAll(n => n.className === 'md-code-lang')[0].textContent, 'ts');
    assert.equal(codeBlocks[0].querySelectorAll(n => n.className === 'md-code-copy').length, 1);
    assert.equal(codeBlocks[0].querySelectorAll(n => n.localName === 'code')[0].textContent, 'const x = 1;');

    // Nested list inside GitHub warning alert blockquote
    const warnQuote = container.querySelectorAll(n => n.localName === 'blockquote' && n.className.includes('warn'))[0];
    assert.ok(warnQuote);
    assert.equal(warnQuote.querySelectorAll(n => n.localName === 'li').length, 1);

    // Context compacted divider
    const compacted = container.querySelectorAll(n => n.className === 'context-compacted');
    assert.equal(compacted.length, 1);
    assert.match(compacted[0].textContent, /183\.4k → 24\.1k tokens/);
    assert.equal(formatTokenCount(1048576), '1M');
    assert.equal(formatTokenCount(183400), '183.4k');
    assert.equal(formatTokenCount(200000), '200k');
    assert.equal(formatTokenCount(850), '850');
  } finally {
    globalThis.document = prevDoc;
  }
});

test('highlightCode tokenizes TS, JSON, Bash, HTML and Diff while preserving verbatim code text', () => {
  class MiniNode {
    constructor(tag) { this.localName = tag; this.className = ''; this.children = []; this._text = ''; }
    set textContent(v) { this._text = String(v); this.children = []; }
    get textContent() { return this._text + this.children.map(c => (typeof c === 'string' ? c : c.textContent)).join(''); }
    append(...items) { for (const it of items) if (it) this.children.push(it); }
    tokens(cls) { return this.children.filter(c => typeof c !== 'string' && c.className === cls).map(c => c.textContent); }
  }
  const prevDoc = globalThis.document;
  globalThis.document = { createElement: tag => new MiniNode(tag) };
  try {
    const tsSrc = [
      '// pc-wiki-sky/common/plugins/toggle-list/toggle-list.plugin.ts',
      'toolbarItems: [',
      '  {',
      '    key: WikiPluginTypes.toggleList,',
      "    icon: 'list-toggle',",
      "    name: translate.instant<NestedKey<typeof i18nSourceDefinition>>('wiki.plugin.toggleList'),",
      '    execute: (editor: TheEditor) => ToggleListEditor.insertToggleList(editor),',
      '  }',
      ']',
    ].join('\n');
    const tsEl = new MiniNode('code');
    highlightCode(tsEl, tsSrc, 'ts');
    assert.equal(tsEl.textContent, tsSrc);
    assert.ok(tsEl.tokens('tok-comment').some(s => s.startsWith('// pc-wiki-sky')));
    assert.ok(tsEl.tokens('tok-prop').includes('toolbarItems'));
    assert.ok(tsEl.tokens('tok-prop').includes('key'));
    assert.ok(tsEl.tokens('tok-type').includes('WikiPluginTypes'));
    assert.ok(tsEl.tokens('tok-type').includes('TheEditor'));
    assert.ok(tsEl.tokens('tok-string').includes("'list-toggle'"));
    assert.ok(tsEl.tokens('tok-keyword').includes('typeof'));
    assert.ok(tsEl.tokens('tok-fn').includes('instant'));
    assert.ok(tsEl.tokens('tok-fn').includes('insertToggleList'));
    assert.ok(tsEl.tokens('tok-op').includes('=>'));

    const jsonSrc = '{\n  "version": "0.4.14",\n  "count": 42,\n  "ok": true\n}';
    const jsonEl = new MiniNode('code');
    highlightCode(jsonEl, jsonSrc, 'json');
    assert.equal(jsonEl.textContent, jsonSrc);
    assert.deepEqual(jsonEl.tokens('tok-prop'), ['"version"', '"count"', '"ok"']);
    assert.deepEqual(jsonEl.tokens('tok-string'), ['"0.4.14"']);
    assert.deepEqual(jsonEl.tokens('tok-number'), ['42', 'true']);

    const shSrc = '# deploy\nexport PORT=8080\nssh root@198.84.90.137 "systemctl restart $SVC"';
    const shEl = new MiniNode('code');
    highlightCode(shEl, shSrc, 'bash');
    assert.equal(shEl.textContent, shSrc);
    assert.ok(shEl.tokens('tok-comment').includes('# deploy'));
    assert.ok(shEl.tokens('tok-keyword').includes('export'));
    assert.ok(shEl.tokens('tok-prop').includes('PORT'));

    const htmlSrc = '<!-- tip --><div class="box">Hi</div>';
    const htmlEl = new MiniNode('code');
    highlightCode(htmlEl, htmlSrc, 'html');
    assert.equal(htmlEl.textContent, htmlSrc);
    assert.ok(htmlEl.tokens('tok-comment').includes('<!-- tip -->'));
    assert.deepEqual(htmlEl.tokens('tok-tag'), ['div', 'div']);
    assert.deepEqual(htmlEl.tokens('tok-prop'), ['class']);
    assert.deepEqual(htmlEl.tokens('tok-string'), ['"box"']);

    const diffSrc = '@@ -1,2 +1,2 @@\n-old line\n+new line\n context';
    const diffEl = new MiniNode('code');
    highlightCode(diffEl, diffSrc, 'diff');
    assert.equal(diffEl.textContent, diffSrc);
    assert.equal(diffEl.tokens('tok-hunk').length, 1);
    assert.equal(diffEl.tokens('tok-del').length, 1);
    assert.equal(diffEl.tokens('tok-add').length, 1);
  } finally {
    globalThis.document = prevDoc;
  }
});
