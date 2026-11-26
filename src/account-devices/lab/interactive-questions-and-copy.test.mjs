import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import {
  formatAnswersForPrompt,
  normalizeQuestions,
  normalizeSubmittedAnswers,
  stripAgyQuestionFallback,
} from '../../session-host/questions.mjs';
import { grantFor } from '../../execution/grants.mjs';
import { SessionHost } from '../../session-host/runtime.mjs';
import { CodexTurns } from '../../session-host/codex-turns.mjs';
import { AntigravityTurns } from '../../session-host/antigravity-turns.mjs';
import { extractLegacyQuestionPrompt, renderThread } from '../ui/thread.js';

const require = createRequire(import.meta.url);
const contract = require('../contract.cjs');

class MiniNode {
  constructor(tag) {
    this.localName = tag;
    this.className = '';
    this.dataset = {};
    this.attributes = {};
    this.style = {};
    this.children = [];
    this._text = '';
    this.disabled = false;
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

function withMiniDom(fn) {
  const prevDoc = globalThis.document;
  globalThis.document = {
    createElement: tag => new MiniNode(tag),
    createElementNS: (_ns, tag) => new MiniNode(tag),
    createTextNode: str => String(str),
    createDocumentFragment: () => new MiniNode('#fragment'),
  };
  try { return fn(); }
  finally { globalThis.document = prevDoc; }
}

function startJsonRpcUnixServer(socketPath, onMessage) {
  const server = net.createServer(sock => {
    let buf = '';
    const send = obj => sock.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\n');
    sock.on('data', chunk => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        onMessage(JSON.parse(line), send, sock);
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve(server));
  });
}

async function waitFor(pred, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = pred();
    if (val) return val;
    await delay(25);
  }
  throw Error('WAIT_TIMEOUT');
}

function makeFakeHost(dir, wsId) {
  const grant = grantFor({ accountId: '1', deviceId: randomUUID(), workspaceId: wsId }, 'execute', 1);
  const host = new SessionHost({
    stateDir: dir,
    accountId: '1',
    requireDeviceBinding: true,
    workspaces: [{ id: wsId, label: 'demo', brokerDir: dir, grant }],
    launchLimiterOptions: { minGapMs: 0 },
  });
  host.broker = async (_w, method) => {
    if (method === 'workspace') {
      return {
        confirmed: true,
        phase: 'ready',
        grant,
        blockers: [],
        activeOperations: [],
        unknownOperations: [],
        sandbox: { supportedTools: ['workspace_read_file'] },
      };
    }
    return { ok: true };
  };
  host.preloadProjectDocs = async () => [];
  return host;
}

test('questions.mjs normalizes Codex & Antigravity questions, strips fallback text, and validates answers', () => {
  const agyQs = normalizeQuestions([
    {
      question: '请选择发布策略？',
      is_multi_select: false,
      options: ['(Recommended) 随 origin/main 一起上线', '仅紧急热修 2 个文件'],
    },
    {
      question: '要检查哪些模块？',
      is_multi_select: true,
      options: ['前端 UI', '服务端 API'],
    },
  ]);
  assert.equal(agyQs.length, 2);
  assert.equal(agyQs[0].id, 'q1');
  assert.equal(agyQs[0].multiSelect, false);
  assert.equal(agyQs[0].options[0].recommended, true);
  assert.equal(agyQs[0].options[0].label, '随 origin/main 一起上线');
  assert.equal(agyQs[0].options[0].rawLabel, '(Recommended) 随 origin/main 一起上线');
  assert.equal(agyQs[1].multiSelect, true);

  const fallback = [
    '我已经检查完差异，需要确认两点：',
    '',
    '请选择发布策略？',
    '- [1] (Recommended) 随 origin/main 一起上线',
    '- [2] 仅紧急热修 2 个文件',
    '',
    '要检查哪些模块？',
    '- [1] 前端 UI',
    '- [2] 服务端 API',
  ].join('\n');
  assert.equal(stripAgyQuestionFallback(fallback, agyQs), '我已经检查完差异，需要确认两点：');
  assert.equal(stripAgyQuestionFallback('\n请选择发布策略？\n- [1] (Recommended) 随 origin/main 一起上线\n- [2] 仅紧急热修 2 个文件\n\n要检查哪些模块？\n- [1] 前端 UI\n- [2] 服务端 API\n', agyQs), '');

  const codexQs = normalizeQuestions([
    {
      id: 'deploy_mode',
      header: 'Deploy',
      question: 'Choose deploy mode',
      isSecret: false,
      isOther: true,
      options: [{ label: 'Full (Recommended)', description: 'Includes migration' }, { label: 'Hotfix', description: 'Code only' }],
    },
    {
      id: 'api_token',
      header: 'Secret',
      question: 'Enter token',
      isSecret: true,
      isOther: true,
      options: [],
    },
  ]);
  assert.equal(codexQs[0].options[0].recommended, true);
  assert.equal(codexQs[0].options[0].label, 'Full');
  assert.equal(codexQs[0].options[0].rawLabel, 'Full (Recommended)');
  assert.equal(codexQs[0].options[0].description, 'Includes migration');
  assert.equal(codexQs[1].secret, true);

  assert.throws(() => normalizeSubmittedAnswers(codexQs, { deploy_mode: ['Full (Recommended)'] }, false), /INVALID_ANSWER/);
  const norm = normalizeSubmittedAnswers(codexQs, { deploy_mode: ['Full (Recommended)'], api_token: ['sk-secret-123'] }, false);
  assert.deepEqual(norm.codexAnswers, {
    deploy_mode: { answers: ['Full (Recommended)'] },
    api_token: { answers: ['sk-secret-123'] },
  });
  assert.deepEqual(norm.displayAnswers, {
    deploy_mode: ['Full (Recommended)'],
    api_token: ['••••••'],
  });
  assert.match(formatAnswersForPrompt(agyQs, { q1: ['随 origin/main 一起上线'], q2: ['前端 UI', '服务端 API'] }), /1\. 请选择发布策略？[\s\S]*2\. 要检查哪些模块？/);
});

test('contract validates answerQuestion strictly', () => {
  const sid = randomUUID(), rid = randomUUID(), qid = randomUUID();
  assert.doesNotThrow(() => contract.validate('answerQuestion', { sessionId: sid, requestId: rid, questionId: qid, answers: { q1: ['Alpha'] }, skipped: false }));
  assert.doesNotThrow(() => contract.validate('answerQuestion', { sessionId: sid, requestId: rid, questionId: qid, skipped: true }));
  assert.throws(() => contract.validate('answerQuestion', { sessionId: sid, requestId: rid }), /INVALID_FIELDS/);
  assert.throws(() => contract.validate('answerQuestion', { sessionId: sid, requestId: rid, questionId: 'bad' }), /INVALID_ID/);
  assert.throws(() => contract.validate('answerQuestion', { sessionId: sid, requestId: rid, questionId: qid, skipped: 'yes' }), /INVALID_FIELDS/);
  assert.throws(() => contract.validate('answerQuestion', { sessionId: sid, requestId: rid, questionId: qid, answers: ['bad'] }), /INVALID_FIELDS/);
});

test('CodexTurns handles live item/tool/requestUserInput end-to-end and masks secret in history', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-codex-q-'));
  const sockPath = join(dir, 'codex.sock');
  const wsId = randomUUID();
  let receivedUserInputResp = null;

  const server = await startJsonRpcUnixServer(sockPath, (msg, send) => {
    if (msg.method === 'initialize') {
      send({ id: msg.id, result: { userAgent: 'mock-codex' } });
    } else if (msg.method === 'thread/start') {
      send({ id: msg.id, result: { thread: { id: 'th-1' }, model: 'gpt-5.4' } });
    } else if (msg.method === 'turn/start') {
      send({ id: msg.id, result: { turn: { id: 'turn-1' } } });
      setTimeout(() => {
        send({
          id: 99,
          method: 'item/tool/requestUserInput',
          params: {
            threadId: 'th-1',
            turnId: 'turn-1',
            itemId: 'call-q1',
            questions: [
              {
                id: 'plan',
                header: '发布策略',
                question: '本次发布采用哪种策略？',
                isOther: true,
                isSecret: false,
                options: [
                  { label: '随 main 上线 (Recommended)', description: '保持跟踪 origin/main' },
                  { label: '仅热修', description: '只更新 2 个文件' },
                ],
              },
              {
                id: 'pin',
                header: '验证口令',
                question: '请输入发布口令',
                isOther: true,
                isSecret: true,
                options: [],
              },
            ],
          },
        });
      }, 20);
    } else if (msg.id === 99 && msg.result) {
      receivedUserInputResp = msg.result;
      send({
        method: 'item/completed',
        params: {
          threadId: 'th-1',
          turnId: 'turn-1',
          item: { type: 'agentMessage', id: 'msg-final', phase: 'final_answer', text: '收到，将按 main 策略上线。' },
        },
      });
      send({
        method: 'turn/completed',
        params: { threadId: 'th-1', turn: { id: 'turn-1', status: 'completed', durationMs: 120 } },
      });
    }
  });
  const host = makeFakeHost(dir, wsId);
  host.codex = new CodexTurns(host, sockPath, dir);
  t.after(async () => {
    await host.close();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const session = host.create({ requestId: randomUUID(), workspaceId: wsId, title: 'Codex Q', options: { agent: 'codex' } });
  await host.send(session.id, { requestId: randomUUID(), text: '帮我发布' });

  const promptRow = await waitFor(() => host.store.page(session.id, 0).events.find(r => r.event.type === 'question_prompt'));
  assert.equal(promptRow.event.engine, 'codex');
  assert.equal(promptRow.event.mode, 'live');
  assert.equal(promptRow.event.questions.length, 2);

  const liveSession = host.sessions().find(s => s.id === session.id);
  assert.equal(liveSession.activeTurn?.state, 'waiting_input');
  assert.equal(liveSession.activeTurn?.waitingForInput, true);

  const ansRes = await host.answerQuestion(session.id, {
    requestId: randomUUID(),
    questionId: promptRow.event.id,
    answers: { plan: ['随 main 上线 (Recommended)'], pin: ['top-secret-888'] },
    skipped: false,
  });
  assert.equal(ansRes.ok, true);
  assert.equal(ansRes.mode, 'live');

  await waitFor(() => host.store.page(session.id, 0).events.find(r => r.event.type === 'turn_end'));
  assert.deepEqual(receivedUserInputResp, {
    answers: {
      plan: { answers: ['随 main 上线 (Recommended)'] },
      pin: { answers: ['top-secret-888'] },
    },
  });

  const allEvents = host.store.page(session.id, 0).events.map(r => r.event);
  const ansEvent = allEvents.find(e => e.type === 'question_answer');
  assert.deepEqual(ansEvent.answers.pin, ['••••••']);
  assert.ok(allEvents.some(e => e.type === 'assistant_text' && e.text.includes('按 main 策略上线')));
});

test('AntigravityTurns captures ask_question as interactive question_prompt, strips duplicate fallback text, and resumes on answerQuestion', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-agy-q-'));
  const sockPath = join(dir, 'agy.sock');
  const wsId = randomUUID();
  const seenPrompts = [];

  const server = await startJsonRpcUnixServer(sockPath, (msg, send) => {
    if (msg.method === 'initialize') {
      send({ id: msg.id, result: { protocolVersion: 1 } });
    } else if (msg.method === 'session/new') {
      send({ id: msg.id, result: { sessionId: 'agy-s1', models: { currentModelId: 'gemini-4-neon-high', availableModels: [] } } });
    } else if (msg.method === 'session/resume') {
      send({ id: msg.id, result: { sessionId: msg.params.sessionId, models: { currentModelId: 'gemini-4-neon-high', availableModels: [] } } });
    } else if (msg.method === 'session/prompt') {
      const promptText = msg.params.prompt.map(p => p.text ?? '').join('\n');
      seenPrompts.push(promptText);
      const sid = msg.params.sessionId;
      if (seenPrompts.length === 1) {
        send({ method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '升级前请确认以下两项：' } } } });
        const qs = [
          { question: '发布方式？', is_multi_select: false, options: ['(Recommended) 随 main 上线', '仅热修'] },
          { question: '是否重抽验证？', is_multi_select: false, options: ['(Recommended) 触发重抽', '留给操作员手动点'] },
        ];
        send({ method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'tool_call', toolCallId: 'call-agy-1', name: 'ask_question', status: 'in_progress', args: { questions: qs } } } });
        send({ method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-agy-1', name: 'ask_question', status: 'pending', args: { questions: qs } } } });
        send({
          method: 'session/update',
          params: {
            sessionId: sid,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: '\n发布方式？\n- [1] (Recommended) 随 main 上线\n- [2] 仅热修\n\n是否重抽验证？\n- [1] (Recommended) 触发重抽\n- [2] 留给操作员手动点\n',
              },
            },
          },
        });
        send({ id: msg.id, result: { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20 } } });
      } else {
        // Turn 2: agy marks prior ask_question as in_progress -> completed, then responds
        send({ method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-agy-1', name: 'ask_question', status: 'in_progress' } } });
        send({ method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-agy-1', name: 'ask_question', status: 'completed' } } });
        send({ method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好的，已按你的选择开始上线并验证。' } } } });
        send({ id: msg.id, result: { stopReason: 'end_turn', usage: { inputTokens: 120, outputTokens: 15 } } });
      }
    }
  });
  const host = makeFakeHost(dir, wsId);
  host.antigravity = new AntigravityTurns(host, sockPath, dir, { mcpDir: dir });
  t.after(async () => {
    await host.close();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const session = host.create({ requestId: randomUUID(), workspaceId: wsId, title: 'AGY Q', options: { agent: 'antigravity' } });
  await host.send(session.id, { requestId: randomUUID(), text: '准备升级' });

  await waitFor(() => host.store.page(session.id, 0).events.filter(r => r.event.type === 'turn_end').length === 1);
  const turn1Events = host.store.page(session.id, 0).events.map(r => r.event);
  const introMsg = turn1Events.find(e => e.type === 'assistant_text');
  assert.equal(introMsg?.text, '升级前请确认以下两项：');
  assert.ok(!introMsg.text.includes('- [1]'), 'Duplicate plain-text fallback should be stripped');

  const promptEv = turn1Events.find(e => e.type === 'question_prompt');
  assert.ok(promptEv);
  assert.equal(promptEv.mode, 'next_turn');
  assert.equal(promptEv.questions.length, 2);
  assert.equal(promptEv.questions[0].options[0].recommended, true);

  const ansRes = await host.answerQuestion(session.id, {
    requestId: randomUUID(),
    questionId: promptEv.id,
    answers: { q1: ['(Recommended) 随 main 上线'], q2: ['(Recommended) 触发重抽'] },
    skipped: false,
  });
  assert.equal(ansRes.ok, true);
  assert.equal(ansRes.mode, 'next_turn');

  await waitFor(() => host.store.page(session.id, 0).events.filter(r => r.event.type === 'turn_end').length === 2);
  assert.equal(seenPrompts.length, 2);
  assert.match(seenPrompts[1], /发布方式？/);
  assert.match(seenPrompts[1], /触发重抽/);

  const allEvents = host.store.page(session.id, 0).events.map(r => r.event);
  assert.equal(allEvents.filter(e => e.type === 'question_prompt').length, 1, 'Turn 2 must not re-create a question_prompt');
  assert.equal(allEvents.filter(e => e.type === 'question_answer').length, 1);
  assert.equal(allEvents.filter(e => e.type === 'user_message').length, 1, 'answerQuestion should not add duplicate user_message');
  assert.ok(allEvents.some(e => e.type === 'assistant_text' && e.text.includes('已按你的选择开始上线')));
});

test('renderThread renders copy button under assistant messages, interactive/resolved question cards, and legacy - [1] fallback', () => {
  withMiniDom(() => {
    // 1. Copy button on assistant messages
    const container = new MiniNode('div');
    const rawMd = '### 发布完成\n\n已更新 `server.mjs` 并通过检查。';
    renderThread(container, [
      { seq: 1, event: { type: 'assistant_text', id: 'a1-0', engine: 'antigravity', text: rawMd } },
    ]);
    const copyBtns = container.querySelectorAll(n => n.className.includes('msg-copy-btn'));
    assert.equal(copyBtns.length, 1);
    assert.equal(copyBtns[0].dataset.copyText, rawMd);
    assert.equal(copyBtns[0].dataset.tooltip, '复制回答');
    assert.equal(copyBtns[0].attributes['aria-label'], '复制回答');
    assert.ok(!container.textContent.includes('复制回答'), 'Tooltip should use CSS data-tooltip without polluting textContent');

    // 2. Active interactive question card with draft state
    const qId = randomUUID();
    const meta = new Map();
    const drafts = new Map([[qId, { picked: { q1: ['(Recommended) 选项 A'] }, other: { q2: '自定义输入' }, submitting: false }]]);
    const qRows = [
      {
        seq: 1,
        event: {
          type: 'question_prompt',
          id: qId,
          engine: 'codex',
          mode: 'live',
          questions: [
            {
              id: 'q1',
              header: '策略',
              question: '选哪个方案？',
              multiSelect: false,
              allowOther: true,
              options: [
                { label: '选项 A', rawLabel: '(Recommended) 选项 A', recommended: true, description: '更稳妥' },
                { label: '选项 B', rawLabel: '选项 B', description: '更轻量' },
              ],
            },
            {
              id: 'q2',
              question: '补充说明？',
              multiSelect: true,
              allowOther: true,
              options: [{ label: '跳过测试', rawLabel: '跳过测试' }],
            },
          ],
        },
      },
    ];
    renderThread(container, qRows, { hasActiveTurn: true, questionDrafts: drafts, questionMeta: meta });
    assert.ok(meta.has(qId));
    const activeCards = container.querySelectorAll(n => n.className.includes('ai-question-card active'));
    assert.equal(activeCards.length, 1);
    assert.equal(container.querySelectorAll(n => n.className.includes('q-rec-badge')).length, 1);
    const submitBtn = container.querySelectorAll(n => n.className.includes('q-submit-btn'))[0];
    assert.equal(submitBtn.disabled, false, 'Submit button should be enabled when all questions have answers');

    // 3. Resolved question card after question_answer
    renderThread(container, [
      ...qRows,
      { seq: 2, event: { type: 'question_answer', id: qId, engine: 'codex', skipped: false, answers: { q1: ['(Recommended) 选项 A'], q2: ['自定义输入'] } } },
    ], { hasActiveTurn: false });
    assert.equal(container.querySelectorAll(n => n.className.includes('ai-question-card resolved')).length, 1);
    assert.ok(container.textContent.includes('已回答提问'));
    assert.ok(container.textContent.includes('选项 A'));
    assert.ok(container.textContent.includes('自定义输入'));

    // 4. Legacy - [1] (Recommended) plain-text extraction (matches user screenshot format)
    const legacyText = [
      '发布前确认两件事：',
      '',
      '本次发布方式选哪种？',
      '- [1] (Recommended) 随 origin/main 一起上线（包含协同撰写工作台）',
      '- [2] 仅紧急热修 source-extraction 2 个文件',
      '',
      '服务器升级完之后，是否直接触发重抽验证？',
      '- [1] (Recommended) 上线验证通过后，帮项目重新触发一次「要求抽取」',
      '- [2] 只完成代码上线和健康检查，重试留给操作人员自己点',
    ].join('\n');
    const extracted = extractLegacyQuestionPrompt(legacyText);
    assert.ok(extracted);
    assert.equal(extracted.introText, '发布前确认两件事：');
    assert.equal(extracted.questions.length, 2);
    assert.equal(extracted.questions[0].options[0].recommended, true);
    assert.equal(extracted.questions[0].options[0].label, '随 origin/main 一起上线（包含协同撰写工作台）');

    renderThread(container, [
      { seq: 1, event: { type: 'assistant_text', id: 'legacy-1', engine: 'antigravity', text: legacyText } },
    ], { hasActiveTurn: false, questionMeta: meta });
    assert.equal(container.querySelectorAll(n => n.className.includes('ai-question-card active')).length, 1);
    assert.equal(container.querySelectorAll(n => n.localName === 'button' && n.className.split(' ').includes('q-option')).length, 4);
    assert.equal(container.querySelectorAll(n => n.className.includes('msg-copy-btn')).length, 1);

    // Normal Markdown lists must NOT be mistaken for legacy questions
    assert.equal(extractLegacyQuestionPrompt('说明：\n- 普通列表 1\n- 普通列表 2'), null);
    assert.equal(extractLegacyQuestionPrompt('任务：\n- [ ] 待办 A\n- [x] 已办 B'), null);
  });
});

test('stopping a Codex turn while waiting for requestUserInput cancels the question cleanly without deadlock', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-codex-q-stop-'));
  const sockPath = join(dir, 'codex.sock');
  const wsId = randomUUID();
  let receivedResp = null;

  const server = await startJsonRpcUnixServer(sockPath, (msg, send) => {
    if (msg.method === 'initialize') {
      send({ id: msg.id, result: { userAgent: 'mock-codex' } });
    } else if (msg.method === 'thread/start') {
      send({ id: msg.id, result: { thread: { id: 'th-stop' }, model: 'gpt-5.4' } });
    } else if (msg.method === 'turn/start') {
      send({ id: msg.id, result: { turn: { id: 'turn-stop' } } });
      setTimeout(() => {
        send({
          id: 77,
          method: 'item/tool/requestUserInput',
          params: {
            threadId: 'th-stop',
            turnId: 'turn-stop',
            itemId: 'call-stop',
            questions: [{ id: 'confirm', question: '确认继续？', options: [{ label: '是' }, { label: '否' }] }],
          },
        });
      }, 20);
    } else if (msg.id === 77 && msg.result) {
      receivedResp = msg.result;
    } else if (msg.method === 'turn/interrupt') {
      send({ id: msg.id, result: {} });
      send({ method: 'turn/completed', params: { threadId: 'th-stop', turn: { id: 'turn-stop', status: 'interrupted' } } });
    }
  });
  const host = makeFakeHost(dir, wsId);
  host.codex = new CodexTurns(host, sockPath, dir);
  t.after(async () => {
    await host.close();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const session = host.create({ requestId: randomUUID(), workspaceId: wsId, title: 'Codex Stop', options: { agent: 'codex' } });
  const sent = await host.send(session.id, { requestId: randomUUID(), text: '继续' });
  await waitFor(() => host.store.page(session.id, 0).events.find(r => r.event.type === 'question_prompt'));

  await host.stop(session.id, { requestId: randomUUID(), turnId: sent.turnId });
  await waitFor(() => host.store.page(session.id, 0).events.find(r => r.event.type === 'turn_end'));

  assert.deepEqual(receivedResp, { answers: {} });
  const events = host.store.page(session.id, 0).events.map(r => r.event);
  const ans = events.find(e => e.type === 'question_answer');
  assert.equal(ans?.skipped, true);
  assert.equal(ans?.cancelled, true);
  assert.equal(host.codex.pendingQuestions.size, 0);
});
