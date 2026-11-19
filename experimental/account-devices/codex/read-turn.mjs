import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '../../workspace/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../workspace/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { CodexAppServer } from '../../../server/src/external/codexAppServer.ts';
import { control } from '../../execution/control.mjs';
import { canonical } from '../../execution/protocol.mjs';
import { SessionStore, uuid } from '../../session-host/store.mjs';
import { listTools, normalize } from '../../workspace/catalog.mjs';
import { WorkspaceExecutor } from '../../workspace/executor.mjs';

// Private acceptance entry point. stdin/stdout are connected only to the CLI app-server.
if (process.getuid() === 0) throw Error('SERVICE_USER_REQUIRED');
process.umask(0o077);
const cfg = JSON.parse(await readFile(process.argv[2], 'utf8'));
const { accountId, deviceId, workspaceId, sessionId, file } = cfg;
if (!/^[1-9][0-9]*$/.test(accountId) || !/^codex-[a-f0-9-]{36}\.txt$/.test(file)) throw Error('INVALID_FIXTURE');
[deviceId, workspaceId, sessionId].forEach(uuid);
const stateDir = join(cfg.serviceState, 'u' + accountId);
const store = new SessionStore(join(stateDir, 'history.sqlite'));
const brokerSocket = join(stateDir, workspaceId, 'control.sock');
const broker = (method, params) => control(brokerSocket, method, params);
const tool = 'workspace_read_file';
const prompt = '请读取当前会话绑定的 Windows 项目中「' + file + '」的第一行，并将这一行原样作为最终回答。';
const report = { at: new Date().toISOString(), accountId, deviceId, workspaceId, sessionId, file, prompt, rejectedInputs: [] };
const digest = value => createHash('sha256').update(value).digest('hex');
const started = Date.now();
const turnReady = Promise.withResolvers(), finished = Promise.withResolvers();
finished.promise.catch(() => {});
let client, callTask, signature, answer, toolOutput, finalId, deadline;
let shuttingDown = false;
const session = store.session(sessionId);
function checkSession() {
  const now = store.session(sessionId);
  if (now.accountId !== accountId || now.deviceId !== deviceId || now.workspaceId !== workspaceId ||
      now.historyEpoch !== session.historyEpoch || now.lastSeq !== session.lastSeq || now.activeTurnId) {
    throw Error('SESSION_TARGET_OR_HISTORY_CHANGED');
  }
}
async function readFromDevice(params) {
  Object.assign(report, { tool, callId: params.callId, toolArgs: params.arguments });
  checkSession();
  const binding = { accountId, deviceId, workspaceId, grantVersion: report.grantVersion,
    sessionId, turnId: params.turnId, turnEpoch: 1 };
  const executor = new WorkspaceExecutor({ journal: store, control: broker, binding });
  const mcpConfig = join(cfg.runDir, 'mcp.json');
  await writeFile(mcpConfig, JSON.stringify({ binding, brokerSocket, journalPath: store.path, waitMs: 3500 }), { mode: 0o600, flag: 'wx' });
  client = new Client({ name: 'anywhere-codex-acceptance', version: '0.1.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cfg.mcpPath, mcpConfig],
    stderr: 'pipe', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } });
  const connected = client.connect(transport);
  transport.stderr?.resume();
  await connected;
  const advertised = await client.listTools();
  if (!advertised.tools.some(t => t.name === tool)) throw Error('MCP_READ_UNAVAILABLE');
  const ticket = await executor.issue(params.callId, tool, params.arguments);
  report.operationId = ticket.operationId;
  const callStarted = Date.now();
  let result = await client.callTool({ name: tool, arguments: params.arguments, _meta: { 'anywhere/callTicket': ticket.ticket } });
  for (;;) {
    const data = result.structuredContent;
    if (!data?.task || data.task.operationId !== ticket.operationId || data.workspaceId !== workspaceId) throw Error(data?.error ?? 'INVALID_MCP_RESPONSE');
    if (data.task.resultReady) break;
    if (data.task.state === 'unknown' || Date.now() - callStarted > 85000) throw Error('TOOL_RESULT_UNCONFIRMED');
    await delay(400);
    result = await client.callTool({name: 'workspace_task_status', arguments: { operationId: ticket.operationId }});
  }
  const { task, result: device } = result.structuredContent;
  const receipt = { operationId: ticket.operationId, resultDigest: task.resultDigest, receiptId: 'codex:' + params.callId };
  store.put('codex_tool_results', ticket.operationId, { binding, callId: params.callId, receipt, result });
  await executor.consumeAfterPersist(receipt);
  const op = await executor.operation(ticket.operationId);
  Object.assign(report, { starts: op.starts, delivery: op.delivery,
    taskState: task.state, toolMs: Date.now() - callStarted });
  if (result.isError || task.state !== 'succeeded' || !device?.ok || op.starts !== 1 || op.delivery !== 'consumed') throw Error('DEVICE_READ_FAILED');
  const texts = device.response.content.filter(p => p.type === 'text');
  if (!texts.length) throw Error('EMPTY_TOOL_RESULT');
  toolOutput = texts.map(p => p.text).join('\n');
  return { success: true, contentItems: texts.map(p => ({ type: 'inputText', text: p.text })) };
}
const app = new CodexAppServer({ experimentalApi: true, transport: { input: process.stdin, output: process.stdout },
  onExit: err => { if (!shuttingDown) finished.reject(err); },
  onRequest: async (method, params) => {
    if (method !== 'item/tool/call') throw Error('UNSUPPORTED_CODEX_REQUEST');
    if (!report.threadId || params.threadId !== report.threadId || params.turnId !== await turnReady.promise ||
        params.tool !== tool || params.namespace || typeof params.callId !== 'string' || !params.callId ||
        params.arguments?.path !== file) throw Error('TOOL_CALL_OUT_OF_SCOPE');
    try {
      normalize(tool, params.arguments);
    } catch (error) {
      if (callTask || report.rejectedInputs.length >= 3) throw Error('INVALID_TOOL_INPUT_LIMIT');
      report.rejectedInputs.push({ callId: params.callId, error: error.message });
      return { success: false, contentItems: [{ type: 'inputText',
        text: 'No read was submitted. The path must be relative. offset and length are integer line counts. ' +
          'Use offset 0 and length 1 to read the first line. The maximum length is 200 lines.' }] };
    }
    const key = canonical({ id: params.callId, args: params.arguments });
    if (callTask && key !== signature) throw Error('SINGLE_READ_ONLY');
    if (!callTask) {
      signature = key;
      callTask = readFromDevice(params).catch(err => {
        report.toolError = err.message;
        report.toolErrorTrace = err.stack?.split('\n').slice(1, 6);
        return { success: false, contentItems: [{type: 'inputText', text: 'Workspace read failed.'}] };
      });
    }
    return callTask;
  }
});
app.onNotification((method, p) => {
  if (!report.threadId || p.threadId !== report.threadId) return;
  if (method === 'item/completed' && p.item?.type === 'agentMessage' && p.item.phase !== 'commentary') {
    answer = p.item.text;
    finalId = p.item.id;
    report.answerTurnId = p.turnId;
  }
  if (method === 'turn/completed') finished.resolve(p.turn);
});
try {
  checkSession();
  const info = await broker('workspace');
  if (info.grant.accountId !== accountId || info.grant.deviceId !== deviceId || info.grant.workspaceId !== workspaceId) throw Error('WORKSPACE_TARGET_MISMATCH');
  if (!info.confirmed || info.phase !== 'ready' || info.blockers.length) throw Error('WORKSPACE_NOT_READY');
  const read = listTools(info.grant, info.confirmed, info.sandbox?.supportedTools).find(t => t.name === tool);
  if (!read || info.grant.mode !== 'read') throw Error('LOCAL_READ_PERMISSION_REQUIRED');
  report.grantVersion = info.grant.grantVersion;
  const thread = await app.call('thread/start', {
    cwd: cfg.cliCwd, sandbox: 'read-only', approvalPolicy: 'never', environments: [], ephemeral: true,
    selectedCapabilityRoots: [], config: { web_search: 'disabled' },
    developerInstructions: 'Use workspace_read_file to read the Windows project. Only return the requested line. If the read fails, report that it failed.',
    dynamicTools: [{ type: 'function', name: tool, description: read.description, inputSchema: read.inputSchema, deferLoading: false }]
  });
  report.threadId = thread.thread.id; report.model = thread.model;
  const {turn} = await app.call('turn/start', { threadId: report.threadId, effort: 'low', input: [{type: 'text', text: prompt}] });
  report.turnId = turn.id;
  turnReady.resolve(turn.id);
  deadline = setTimeout(() => finished.reject(Error('CODEX_TURN_TIMEOUT')), 155000);
  const ended = await finished.promise;
  if (ended.id !== turn.id || ended.status !== 'completed') throw Error('CODEX_TURN_' + ended.status + ': ' + (ended.error?.message ?? ''));
  if (callTask) await callTask;
  if (!toolOutput || !answer || report.answerTurnId !== turn.id || report.toolError) throw Error(report.toolError ?? 'MISSING_TOOL_OR_ANSWER');
  if (!toolOutput.split(/\r?\n/).includes(answer)) throw Error('ANSWER_NOT_IN_DEVICE_RESULT');
  const turnScope = { sessionId, turnId: turn.id, turnEpoch: 1 };
  await broker('reasoningIdle', turnScope);
  report.brokerTurnStatus = (await broker('session', turnScope)).status;
  if (report.brokerTurnStatus !== 'complete') throw Error('BROKER_TURN_INCOMPLETE');
  report.answerSha256 = digest(answer);
  report.fileRevision = (await broker('operation', { operationId: report.operationId })).result.tool.fileVersions[0].revision;
  store.tx(() => {
    checkSession();
    store.append(sessionId, { type: 'user_message', text: prompt });
    store.append(sessionId, { type: 'tool_call', id: report.callId, name: tool, input: report.toolArgs, status: 'completed', output: toolOutput });
    store.append(sessionId, { type: 'assistant_text', id: finalId, text: answer });
    store.append(sessionId, { type: 'turn_end', ok: true });
  });
  report.historyThroughSeq = store.session(sessionId).lastSeq;
  report.passed = true;
} catch (error) {
  report.error = error.message; report.passed = false; process.exitCode = 1;
} finally {
  shuttingDown = true;
  clearTimeout(deadline);
  turnReady.resolve(null);
  app.stop();
  process.stdin.pause();
  if (callTask) await callTask;
  if (client) await client.close().catch(() => {});
  report.totalMs = Date.now() - started;
  await writeFile(join(cfg.runDir, 'result.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  store.close();
}
