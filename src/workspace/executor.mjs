import { randomUUID } from 'node:crypto';
import { exact, string, integer, hash, canonical, validateScope, TERMINAL, fail } from '../execution/protocol.mjs';
import { assertIdentity } from '../execution/grants.mjs';
import { normalize, listTools, CATALOG, allowed } from './catalog.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export class WorkspaceExecutor {
  constructor({ journal, control, binding }) {
    validateScope(binding, { ...binding, revoked: false });
    this.journal = journal; this.control = control; this.binding = structuredClone(binding);
  }
  async capabilities() {
    const info = await this.control('workspace'); assertIdentity(info.grant, this.binding);
    const bindingCurrent = info.grant.grantVersion === this.binding.grantVersion;
    return { workspaceId: info.grant.workspaceId, label: info.label, connection: info.phase,
      permission: { mode: info.grant.mode, version: info.grant.grantVersion, confirmed: info.confirmed }, bindingCurrent,
      tools: listTools(info.grant, info.confirmed && bindingCurrent, info.sandbox?.supportedTools), activeOperations: info.activeOperations,
      blockers: info.blockers, sandbox: info.sandbox, history: info.history,
      limits: { maxRuntimeMs: 120000, maxReadLines: 500, maxSearchResults: 50, maxResultBytes: 196608, retainedOutputBytes: 65536, concurrentTasks: 1 } };
  }
  key(callId) { string(callId); return hash({ binding: this.binding, callId }); }
  verifyOperation(record, op) {
    if (op.requestHash !== record.requestHash || canonical(op.request.scope) !== canonical(this.binding)) fail('TASK_BINDING_MISMATCH');
    return op;
  }
  // Host-only API. The host must supply its stable tool-call identity. This is
  // never registered as a model-callable tool or derived from an MCP request ID.
  async issue(callId, toolName, args, { expiresAt } = {}) {
    const requestedExpiry = expiresAt;
    const normalized = normalize(toolName, args), key = this.key(callId), inputHash = hash({ toolName, normalized });
    let record = this.journal.get('calls', key);
    if (record && (record.inputHash !== inputHash || (expiresAt !== undefined && record.params.expiresAt !== expiresAt))) fail('TOOL_CALL_CONFLICT');
    if (!record) {
      const info = await this.control('workspace'); assertIdentity(info.grant, this.binding);
      if (info.grant.grantVersion !== this.binding.grantVersion) fail('GRANT_CHANGED');
      if (!allowed(CATALOG.find(t => t.name === toolName), info.grant, info.sandbox?.supportedTools)) fail('CAPABILITY_DENIED');
      if (!info.confirmed) fail('DEVICE_RECOVERING');
      expiresAt ??= Date.now() + 120000; integer(expiresAt, 1, Number.MAX_SAFE_INTEGER);
      if (expiresAt <= Date.now() || expiresAt > Date.now() + 120000) fail('INVALID_DEADLINE');
      this.compact();
      record = this.journal.tx(() => {
        const concurrent = this.journal.get('calls', key);
        if (concurrent) {
          if (concurrent.inputHash !== inputHash || (requestedExpiry !== undefined && concurrent.params.expiresAt !== requestedExpiry)) fail('TOOL_CALL_CONFLICT');
          return concurrent;
        }
        if (this.journal.all('calls').length >= 256) fail('TICKET_CAPACITY');
        this.journal.ensureCapacity();
        const { sessionId, turnId, turnEpoch, grantVersion } = this.binding;
        const params = { sessionId, turnId, turnEpoch, toolCallId: callId, ...normalized, expiresAt, expectedGrantVersion: grantVersion };
        const request = { scope: this.binding, toolCallId: callId, ...normalized, expiresAt };
        const intent = { token: randomUUID(), inputHash, toolName, binding: this.binding, params,
          operationId: null, requestHash: hash(request), consumed: false };
        this.journal.put('calls', key, intent); this.journal.put('tokens', hash(intent.token), { key }); return intent;
      });
    }
    if (!record.operationId) {
      const { sessionId, turnId, turnEpoch, toolCallId } = record.params;
      // Recover a crash/lost response after broker prepare before creating new work.
      const existing = await this.control('lookupCall', { sessionId, turnId, turnEpoch, toolCallId });
      const op = this.verifyOperation(record, existing ?? await this.control('prepare', record.params));
      record = this.journal.tx(() => {
        const current = this.journal.get('calls', key);
        if (current.operationId && current.operationId !== op.operationId) fail('TASK_BINDING_MISMATCH');
        current.operationId = op.operationId;
        this.journal.put('calls', key, current);
        this.journal.put('operations', op.operationId, { key });
        return current;
      });
    }
    return { ticket: record.token, operationId: record.operationId, requestHash: record.requestHash };
  }
  recordForOperation(operationId) {
    string(operationId);
    const ref = this.journal.get('operations', operationId) ?? fail('TASK_NOT_BOUND');
    const record = this.journal.get('calls', ref.key);
    if (canonical(record.binding) !== canonical(this.binding)) fail('TASK_NOT_BOUND');
    return record;
  }
  // Host restart recovery is query-only. In particular it must not prepare or
  // dispatch a call that may have been interrupted before the original send.
  async recover(callId) {
    const key = this.key(callId), record = this.journal.get('calls', key);
    if (!record) return null;
    if (canonical(record.binding) !== canonical(this.binding)) fail('TASK_NOT_BOUND');
    if (record.operationId) {
      await this.operation(record.operationId);
      return { operationId: record.operationId, requestHash: record.requestHash };
    }
    const { sessionId, turnId, turnEpoch, toolCallId } = record.params;
    const op = await this.control('lookupCall', { sessionId, turnId, turnEpoch, toolCallId });
    if (!op) return null;
    this.verifyOperation(record, op);
    this.journal.tx(() => {
      const current = this.journal.get('calls', key);
      if (current.operationId && current.operationId !== op.operationId) fail('TASK_BINDING_MISMATCH');
      current.operationId = op.operationId;
      this.journal.put('calls', key, current);
      this.journal.put('operations', op.operationId, { key });
    });
    return { operationId: op.operationId, requestHash: record.requestHash };
  }
  async operation(operationId) {
    return this.verifyOperation(this.recordForOperation(operationId), await this.control('operation', { operationId }));
  }
  async invoke(toolName, args, ticket, { waitMs = 10000, signal } = {}) {
    string(ticket, 128); integer(waitMs, 0, 10000);
    const ref = this.journal.get('tokens', hash(ticket)) ?? fail('CALL_TICKET_REQUIRED');
    const record = this.journal.get('calls', ref.key);
    if (canonical(record.binding) !== canonical(this.binding)) fail('CALL_TICKET_SCOPE_DENIED');
    if (record.inputHash !== hash({ toolName, normalized: normalize(toolName, args) })) fail('CALL_TICKET_MISMATCH');
    if (!record.operationId) fail('TICKET_NOT_READY');
    // MCP SDK also aborts request signals on transport disconnect. That only
    // stops waiting here; task cancellation requires the explicit durable API.
    {
      if (!signal?.aborted) await this.control('dispatch', { operationId: record.operationId });
      const end = Date.now() + waitMs;
      let op;
      do {
        op = await this.operation(record.operationId);
        if (op.state === 'unknown' || (TERMINAL.has(op.state) && op.receivedSeq === op.lastSeq)) break;
        if (signal?.aborted || Date.now() >= end) break;
        await sleep(100);
      } while (true);
      return this.view(op);
    }
  }
  async view(op) {
    const output = await this.output(op.operationId, 0);
    const resultReady = TERMINAL.has(op.state) && op.receivedSeq === op.lastSeq;
    const task = { operationId: op.operationId, taskId: op.taskId, state: op.state, reason: op.reason,
      cancelRequested: Boolean(op.cancelId), cancelConfirmed: Boolean(op.cancelConfirmed),
      resultReady, resultDigest: resultReady ? op.resultDigest : null, delivery: op.delivery,
      lastSeq: op.lastSeq, receivedSeq: op.receivedSeq, outputNextSeq: output.nextSeq, moreOutput: output.more, gaps: op.gaps };
    const content = resultReady && op.result?.tool?.response?.content ? [...op.result.tool.response.content] :
      [{ type: 'text', text: resultReady ? `Task ${op.state}.` :
        op.cancelId ? 'Cancellation requested; wait for device confirmation. Poll workspace_task_status.' :
        `Task ${op.state}; result is not ready. Poll workspace_task_status. Do not repeat the operation.` }];
    if (output.rows.length) content.push({ type: 'text', text: output.rows.map(r => r.data).join('') });
    if (output.truncatedThrough) content.push({ type: 'text', text: `Output before sequence ${output.firstAvailableSeq} was truncated.` });
    if (op.state === 'reviewed') content.push({ type: 'text', text: 'Locally reviewed and closed with execution outcome still unknown. No automatic retry. ' + op.result.review.note });
    return { isError: ['failed', 'rejected', 'unknown', 'cancelled', 'reviewed'].includes(op.state), content,
      structuredContent: { version: 1, workspaceId: this.binding.workspaceId, task, result: op.result?.tool ?? op.result, output } };
  }
  async output(operationId, afterSeq = 0) {
    const op = await this.operation(operationId); integer(afterSeq, 0, op.receivedSeq);
    const page = await this.control('output', { operationId, afterSeq });
    const nextSeq = Math.max(afterSeq, page.truncatedThrough, page.rows.at(-1)?.seq ?? 0);
    return { ...page, nextSeq, more: nextSeq < op.lastSeq, combinedCommandStreams: true };
  }
  async status(operationId) { return this.view(await this.operation(operationId)); }
  async cancel(operationId) {
    await this.operation(operationId);
    await this.control('cancel', { operationId }); return this.status(operationId);
  }
  // Host-only: call AFTER the terminal result has been committed into host history.
  // Returning an MCP response, or showing it in the UI, never calls this method.
  async consumeAfterPersist({ operationId, resultDigest, receiptId }) {
    string(receiptId); const op = await this.operation(operationId);
    if (!TERMINAL.has(op.state) || op.receivedSeq !== op.lastSeq || resultDigest !== op.resultDigest) fail('RESULT_NOT_READY');
    const prior = this.journal.get('receipts', operationId);
    if (prior && (prior.receiptId !== receiptId || prior.resultDigest !== resultDigest)) fail('RECEIPT_CONFLICT');
    this.journal.put('receipts', operationId, { resultDigest, receiptId });
    await this.control('ackResult', { operationId, digest: resultDigest, stage: 'consumed' });
    const ref = this.journal.get('operations', operationId), record = this.journal.get('calls', ref.key);
    record.consumed = true; this.journal.put('calls', ref.key, record);
    this.compact();
    return { consumed: true };
  }
  compact() {
    this.journal.tx(() => {
      const settled = this.journal.entries('calls').filter(r => r.value.consumed ||
        (!r.value.operationId && r.value.params.expiresAt < Date.now()));
      for (const { key, value: record } of settled.slice(0, Math.max(0, settled.length - 32))) {
        this.journal.archive('calls', key); this.journal.archive('tokens', hash(record.token));
        if (record.operationId) { this.journal.archive('operations', record.operationId); this.journal.archive('receipts', record.operationId); }
      }
    });
  }
}
