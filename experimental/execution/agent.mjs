import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { id, exact, string, integer, hash, canonical, validateRequest, validateScope, turnKey, sameTurn, TERMINAL, fail, summary } from './protocol.mjs';
import { GrantAuthority, assertIdentity } from './grants.mjs';

export function groupAlive(group) {
  // Confirms the supervised outer process group. DC additionally uses a fresh
  // bwrap PID namespace: killing its init also kills descendants using setsid().
  return readdirSync('/proc').some((name) => {
    if (!/^\d+$/.test(name)) return false;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return Number(fields[2]) === group && !['Z', 'X'].includes(fields[0]);
    } catch { return false; }
  });
}
const signalGroup = (pid, signal) => { try { process.kill(-pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; } };

export class LocalAgent extends EventEmitter {
  constructor(journal, grant, { stateDir, fault = () => {}, outputBytes = 65536, launcher, maxChildren = 4, workspace } = {}) {
    super(); this.journal = journal; this.grant = grant; this.stateDir = stateDir;
    this.fault = fault; this.outputBytes = outputBytes; this.children = new Map();
    this.launcher = launcher; this.maxChildren = maxChildren;
    this.workspace = workspace;
    if (workspace) { this.authority = new GrantAuthority(journal, grant); this.grant = this.authority.current; }
    this.instanceId = id(); this.connectionEpoch = 0; this.closing = false;
    // No PID reattachment: the VM service manager kills the old cgroup first.
    // A side effect may have happened before the durable result was written.
    journal.tx(() => {
      for (const op of journal.all('ops')) {
        if (!TERMINAL.has(op.state) && op.state !== 'unknown') {
          op.state = 'unknown'; op.reason = 'agent_restart_requires_review'; op.pid = null;
          journal.put('ops', op.operationId, op);
        }
      }
    });
  }
  attach(epoch) {
    integer(epoch, 1, Number.MAX_SAFE_INTEGER);
    const previous = this.journal.get('meta', 'epoch') || 0;
    if (epoch <= previous) fail('STALE_CONNECTION');
    this.journal.put('meta', 'epoch', epoch); this.connectionEpoch = epoch;
  }
  authorize(envelope, historical = false) {
    exact(envelope, ['operationId', 'requestHash', 'request']);
    string(envelope.operationId);
    if (this.authority) {
      assertIdentity(envelope.request?.scope, this.grant);
      if (hash(envelope.request) !== envelope.requestHash) fail('HASH_MISMATCH');
      const prior = this.journal.get('ops', envelope.operationId);
      if (prior) {
        if (prior.requestHash !== envelope.requestHash || canonical(prior.request) !== canonical(envelope.request)) fail('OPERATION_CONFLICT');
        return prior;
      }
      const grant = historical ? this.authority.historical(envelope.request.scope.grantVersion) : this.grant;
      validateRequest(envelope.request, grant); return undefined;
    }
    const requestHash = validateRequest(envelope.request, this.grant);
    if (envelope.requestHash !== requestHash) fail('HASH_MISMATCH');
    const op = this.journal.get('ops', envelope.operationId);
    if (op && op.requestHash !== requestHash) fail('OPERATION_CONFLICT');
    return op;
  }
  checkTurn(scope, allowStopped = false) {
    const key = turnKey(scope), prior = this.journal.get('turns', key);
    if (prior && JSON.stringify(prior.scope) !== JSON.stringify(scope)) {
      // Object key order is not identity; compare the actual fields.
      for (const field of Object.keys(scope)) if (prior.scope[field] !== scope[field]) fail('TURN_CONFLICT');
    }
    if (prior?.stopped && !allowStopped) fail('TURN_STOPPED');
    if (!prior) this.journal.put('turns', key, { scope, stopped: false });
  }
  create(envelope, state = 'accepted') {
    if (this.journal.all('ops').length >= 128) fail('JOURNAL_CAPACITY');
    const op = { ...envelope, taskId: id(), state, lastSeq: 0, result: null,
      pid: null, starts: 0, reason: null, cancelId: null, acknowledgedSeq: 0 };
    this.journal.put('ops', op.operationId, op); return op;
  }
  start(envelope) {
    let op;
    this.journal.tx(() => {
      op = this.authorize(envelope, Boolean(this.authority));
      if (op) return; // Scope and immutable request checked before deduplication.
      this.checkTurn(envelope.request.scope);
      // A peer cannot sidestep an unresolved side effect using a fresh tool ID.
      if (this.journal.all('ops').some((o) => o.state === 'unknown' &&
          o.request.scope.workspaceId === envelope.request.scope.workspaceId)) fail('WORKSPACE_RECOVERING');
      if (this.children.size + this.journal.all('ops').filter((o) => o.state === 'accepted').length >= this.maxChildren) fail('EXECUTOR_BUSY');
      op = this.create(envelope);
      if (this.authority) {
        try { validateRequest(op.request, this.grant); }
        catch (e) { op.state = 'rejected'; op.reason = e.code; this.journal.put('ops', op.operationId, op); }
      }
      if (Date.now() >= op.request.expiresAt) { op.state = 'rejected'; op.reason = 'deadline_expired'; this.journal.put('ops', op.operationId, op); }
    });
    this.fault('agent_after_accept');
    if (op.state === 'accepted') setImmediate(() => this.launch(op.operationId));
    return summary(op);
  }
  launch(operationId) {
    if (this.closing) return;
    let op = this.journal.get('ops', operationId);
    if (op.state !== 'accepted') return;
    let spec;
    try {
      validateRequest(op.request, this.grant); this.checkTurn(op.request.scope);
      if (Date.now() >= op.request.expiresAt) fail('DEADLINE_EXPIRED');
      spec = this.launcher?.(op, this.grant);
      if (!spec && op.request.kind !== 'mock.task') fail('EXECUTOR_UNAVAILABLE');
    } catch (e) {
      op.state = 'rejected'; op.reason = e.code || 'AUTHORIZATION_FAILED';
      this.journal.put('ops', operationId, op); this.emit('changed'); return;
    }
    op.state = 'running'; op.starts++; op.reason = 'launch_intent';
    this.journal.put('ops', operationId, op); this.fault('agent_after_intent');
    const child = spawn(spec?.command ?? process.execPath, spec?.args ?? [fileURLToPath(new URL('./mock-worker.mjs', import.meta.url))], {
      cwd: this.stateDir, detached: true, stdio: spec ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
      env: spec?.env ?? { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    });
    const entry = { child, timer: null, killTimer: null, structured: Boolean(spec), resultBytes: 0, resultChunks: [] }; this.children.set(operationId, entry);
    if (spec) child.stdio[3].on('data', (chunk) => {
      entry.resultBytes += chunk.length;
      if (entry.resultBytes <= 24576) entry.resultChunks.push(chunk);
      else this.signal(entry);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(spec?.input ?? { args: op.request.args, operationId, effectsPath: `${this.stateDir}/mock-effects.jsonl` }));
    for (const [stream, pipe] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
      const decoder = new StringDecoder('utf8');
      pipe.on('data', (chunk) => {
        // A single huge write cannot starve control messages: fixed bounded chunks.
        for (let i = 0; i < chunk.length; i += 2048) this.output(operationId, stream, decoder.write(chunk.subarray(i, i + 2048)));
      });
      pipe.on('end', () => { const tail = decoder.end(); if (tail) this.output(operationId, stream, tail); });
    }
    child.once('spawn', () => {
      op = this.journal.get('ops', operationId); op.pid = child.pid; op.reason = null;
      this.journal.put('ops', operationId, op); this.fault('agent_after_spawn'); this.emit('changed');
      // Cancel may have won while spawn was being completed.
      if (op.state === 'cancelling') this.signal(entry);
    });
    child.once('error', (error) => this.finish(operationId, null, null, error.code || 'SPAWN_FAILED'));
    child.once('exit', () => { if (child.pid) signalGroup(child.pid, 'SIGKILL'); });
    child.once('close', (code, signal) => this.finish(operationId, code, signal));
    entry.timer = setTimeout(() => this.cancel({ ...envelopeOf(op), cancelId: `deadline:${operationId}` }),
      Math.max(1, Math.min(125000, op.request.expiresAt - Date.now())));
  }
  output(operationId, stream, data) {
    if (!data) return;
    this.journal.tx(() => {
      const op = this.journal.get('ops', operationId); op.lastSeq++;
      this.journal.append(operationId, op.lastSeq, stream, data);
      this.journal.trim(operationId, this.outputBytes); this.journal.put('ops', operationId, op);
    });
    this.emit('changed');
  }
  finish(operationId, code, signal, error) {
    const entry = this.children.get(operationId); if (!entry || entry.finishing) return;
    entry.finishing = true; clearTimeout(entry.timer); clearTimeout(entry.killTimer);
    const deadline = Date.now() + 3000;
    const confirm = () => {
      if (entry.child.pid && groupAlive(entry.child.pid)) {
        signalGroup(entry.child.pid, 'SIGKILL');
        if (Date.now() < deadline) { setTimeout(confirm, 25); return; }
      }
      this.fault('agent_before_result');
      const op = this.journal.get('ops', operationId);
      let toolResult;
      if (entry.structured && entry.resultBytes <= 24576) {
        try {
          toolResult = JSON.parse(Buffer.concat(entry.resultChunks).toString('utf8'));
          if (typeof toolResult.ok !== 'boolean' || toolResult.version !== 1) toolResult = undefined;
        } catch { /* No durable result: the task may have had side effects. */ }
      }
      if (entry.child.pid && groupAlive(entry.child.pid)) {
        op.state = 'unknown'; op.reason = 'process_tree_unconfirmed';
      } else if (entry.structured && toolResult) {
        // Completion reported before a late cancel wins the race, even if the
        // wrapper is signalled while shutting down after reporting the result.
        op.state = toolResult.ok ? 'succeeded' : 'failed'; op.reason = toolResult.ok ? null : 'tool_failed';
      } else if (entry.structured && op.state === 'cancelling' && signal) {
        op.state = 'cancelled'; op.reason = 'sandbox_stopped';
      } else if (entry.structured && !toolResult) {
        op.state = 'unknown'; op.reason = 'executor_result_missing';
      } else if (code === 0) { op.state = 'succeeded'; op.reason = null; }
      else if (op.state === 'cancelling' && signal) { op.state = 'cancelled'; op.reason = 'process_tree_stopped'; }
      else { op.state = 'failed'; op.reason = error || signal || 'nonzero_exit'; }
      op.result = { exitCode: code, signal: signal || null }; op.pid = null;
      if (toolResult) op.result.tool = toolResult;
      this.journal.put('ops', operationId, op); this.children.delete(operationId); this.emit('changed');
    };
    confirm();
  }
  signal(entry) {
    if (!entry.child.pid) return;
    signalGroup(entry.child.pid, 'SIGTERM');
    if (!entry.killTimer) entry.killTimer = setTimeout(() => signalGroup(entry.child.pid, 'SIGKILL'), 1000);
  }
  cancel(params) {
    exact(params, ['operationId', 'requestHash', 'request', 'cancelId']); string(params.cancelId);
    const envelope = envelopeOf(params); let op;
    this.journal.tx(() => {
      op = this.authorize(envelope, Boolean(this.authority)); this.checkTurn(params.request.scope, true);
      if (!op) op = this.create(envelope, 'cancelled');
      const priorCancel = this.journal.get('cancels', params.cancelId);
      if (priorCancel && (priorCancel.operationId !== op.operationId || priorCancel.requestHash !== op.requestHash)) fail('CANCEL_CONFLICT');
      this.journal.put('cancels', params.cancelId, { operationId: op.operationId, requestHash: op.requestHash });
      op.cancelId ||= params.cancelId;
      if (op.state === 'accepted') { op.state = 'cancelled'; op.reason = 'cancelled_before_launch'; }
      if (op.state === 'running') { op.state = 'cancelling'; op.reason = 'awaiting_process_tree'; }
      this.journal.put('ops', op.operationId, op);
    });
    const entry = this.children.get(op.operationId); if (entry && op.state === 'cancelling') this.signal(entry);
    this.emit('changed'); return summary(op);
  }
  stopTurn(params) {
    exact(params, ['scope', 'cancelId']); validateScope(params.scope,
      this.authority ? this.authority.historical(params.scope.grantVersion) : this.grant); string(params.cancelId);
    this.journal.tx(() => {
      this.checkTurn(params.scope, true);
      this.journal.put('turns', turnKey(params.scope), { scope: params.scope, stopped: true, cancelId: params.cancelId });
    });
    for (const op of this.journal.all('ops')) if (sameTurn(op.request.scope, params.scope)) {
      this.cancel({ ...envelopeOf(op), cancelId: `${params.cancelId}:${op.operationId}` });
    }
    return { stopped: true };
  }
  handle(method, params, epoch) {
    if (epoch !== this.connectionEpoch || !epoch) fail('STALE_CONNECTION');
    if (method === 'start') return this.start(params);
    if (method === 'cancel') return this.cancel(params);
    if (method === 'stopTurn') return this.stopTurn(params);
    if (method === 'ping') return { instanceId: this.instanceId, now: Date.now() };
    if (method === 'workspaceInfo' && this.authority) { exact(params, []); return this.workspaceInfo(); }
    if (method === 'sync') {
      exact(params, ['items']);
      if (!Array.isArray(params.items) || params.items.length > 2) fail('INVALID_BATCH');
      return params.items.map((item) => {
        exact(item, ['operationId', 'requestHash', 'request', 'afterSeq']);
        const op = this.authorize(envelopeOf(item), Boolean(this.authority));
        if (!op) return { operationId: item.operationId, state: 'not_received' };
        integer(item.afterSeq, 0, op.lastSeq);
        return { ...summary(op), output: this.journal.output(op.operationId, item.afterSeq, op.lastSeq) };
      });
    }
    if (method === 'status') {
      const op = this.authorize(params, Boolean(this.authority)); return op ? summary(op) : { state: 'not_received' };
    }
    if (method === 'output' || method === 'ackOutput') {
      exact(params, ['operationId', 'requestHash', 'request', 'afterSeq']);
      const op = this.authorize(envelopeOf(params), Boolean(this.authority)); if (!op) fail('NOT_FOUND');
      integer(params.afterSeq, 0, op.lastSeq);
      if (method === 'output') return this.journal.output(op.operationId, params.afterSeq, op.lastSeq);
      op.acknowledgedSeq = Math.max(op.acknowledgedSeq, params.afterSeq); this.journal.put('ops', op.operationId, op);
      return { acknowledgedSeq: op.acknowledgedSeq };
    }
    fail('METHOD_NOT_FOUND');
  }
  workspaceInfo() {
    if (!this.authority) fail('WORKSPACE_UNMANAGED');
    const ops = this.journal.all('ops');
    return { grant: this.grant, label: this.workspace.label,
      pendingCancellations: ops.filter((o) => o.state === 'cancelling').map((o) => o.operationId),
      unknownOperations: ops.filter((o) => o.state === 'unknown').map((o) => o.operationId),
      sandbox: { network: false, readOnly: !this.grant.capabilities.includes('workspace.write') } };
  }
  control(method, params) {
    if (!this.authority) fail('WORKSPACE_UNMANAGED');
    if (method === 'status') { exact(params, []); return this.workspaceInfo(); }
    if (method !== 'setMode') fail('METHOD_NOT_FOUND');
    const decision = this.authority.change(params);
    // A retry of an old change must not roll the live policy back.
    this.grant = this.authority.current;
    for (const op of this.journal.all('ops')) if (!TERMINAL.has(op.state) && op.request.scope.grantVersion < this.grant.grantVersion) {
      this.cancel({ ...envelopeOf(op), cancelId: `grant:${this.grant.grantVersion}:${op.operationId}` });
    }
    this.emit('changed');
    return { decisionVersion: decision.grantVersion, ...this.workspaceInfo() };
  }
  async close() {
    this.closing = true;
    for (const op of this.journal.all('ops')) if (this.children.has(op.operationId)) {
      this.cancel({ ...envelopeOf(op), cancelId: `shutdown:${op.operationId}` });
    }
    while (this.children.size) await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
export const envelopeOf = (op) => ({ operationId: op.operationId, requestHash: op.requestHash, request: op.request });
