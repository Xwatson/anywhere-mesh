import { id, exact, string, integer, hash, validateRequest, turnKey, callKey, sameTurn, fail,
  TERMINAL, CAPABILITIES, resultDigest } from './protocol.mjs';
import { envelopeOf } from './agent.mjs';
import { grantFor, validateGrant } from './grants.mjs';
import { compactOperations } from './retention.mjs';

export class Broker {
  constructor(journal, grant, { workspace } = {}) {
    this.journal = journal; this.grant = grant; this.phase = 'offline'; this.rpc = null;
    this.syncPromise = null; this.again = false; this.lastError = null;
    this.workspace = workspace;
    if (workspace) this.grant = validateGrant(journal.get('meta', 'remoteGrant') ?? grantFor(grant, 'revoked', 1), grant);
    this.timer = setInterval(() => { if (!this.syncPromise) this.kick(); }, 1000);
  }
  hello(rpc, params) {
    exact(params, ['deviceId', 'instanceId', 'capabilities']); string(params.instanceId);
    if (params.deviceId !== this.grant.deviceId || !Array.isArray(params.capabilities) ||
        !CAPABILITIES.every((c) => params.capabilities.includes(c))) fail('CAPABILITY_MISMATCH');
    if (rpc.epoch !== 0) fail('ALREADY_AUTHENTICATED');
    const epoch = (this.journal.get('meta', 'epoch') || 0) + 1;
    this.journal.put('meta', 'epoch', epoch);
    const old = this.rpc; this.rpc = rpc; rpc.epoch = epoch;
    this.phase = 'reconciling'; this.instanceId = params.instanceId;
    if (old) old.close();
    rpc.on('closed', () => { if (this.rpc === rpc) { this.rpc = null; this.phase = 'offline'; } });
    return { connectionEpoch: epoch, capabilities: CAPABILITIES };
  }
  async peer(rpc, method, params, frame) {
    if (method === 'hello') return this.hello(rpc, params);
    if (rpc !== this.rpc || frame.epoch !== rpc.epoch) fail('STALE_CONNECTION');
    if (method === 'ready') { this.kick(); return { accepted: true }; }
    if (method === 'changed') { this.kick(); return {}; }
    if (method === 'ping') return { now: Date.now() };
    fail('METHOD_NOT_FOUND');
  }
  kick() { this.synchronize().catch(() => {}); }
  synchronize() {
    if (!this.rpc) return Promise.resolve();
    if (this.syncPromise) { this.again = true; return this.syncPromise; }
    const rpc = this.rpc;
    this.syncPromise = (async () => {
      do {
        this.again = false;
        if (this.rpc !== rpc) return;
        if (this.workspace) {
          const info = await rpc.request('workspaceInfo', {});
          if (this.rpc !== rpc) return;
          const grant = validateGrant(info.grant, this.grant);
          if (grant.grantVersion < this.grant.grantVersion ||
              (grant.grantVersion === this.grant.grantVersion && hash(grant) !== hash(this.grant))) fail('GRANT_ROLLBACK');
          this.journal.put('meta', 'remoteGrant', grant); this.grant = grant; this.workspaceStatus = info;
        }
        // Durable stop intentions always precede status reconciliation/new work.
        for (const turn of this.journal.all('turns')) if (turn.stopped && !turn.stopConfirmed) {
          await rpc.request('stopTurn', { scope: turn.scope, cancelId: turn.cancelId });
          if (this.rpc !== rpc) return;
          turn.stopConfirmed = true; this.journal.put('turns', turnKey(turn.scope), turn);
        }
        for (const op of this.journal.all('ops')) if (op.cancelId && !op.cancelConfirmed) {
          const remote = await rpc.request('cancel', { ...envelopeOf(op), cancelId: op.cancelId });
          if (this.rpc !== rpc) return;
          this.merge(remote);
          const current = this.journal.get('ops', op.operationId);
          current.cancelConfirmed = TERMINAL.has(remote.state);
          this.journal.put('ops', op.operationId, current);
        }
        if (this.workspace?.reliability) {
          for (const op of this.journal.all('ops')) if (TERMINAL.has(op.state) && op.delivery === 'consumed' && !op.consumeConfirmed) {
            await rpc.request('consumeResult', { ...envelopeOf(op), digest: op.resultDigest });
            if (this.rpc !== rpc) return;
            const current = this.get(op.operationId); current.consumeConfirmed = true;
            this.journal.put('ops', op.operationId, current);
          }
          compactOperations(this.journal, 'broker');
        }
        const pending = this.journal.all('ops').filter((o) => !TERMINAL.has(o.state) || o.receivedSeq < o.lastSeq);
        // DC returns structured tool content, so one result plus a bounded output
        // page must fit the 64 KiB frame even at the maximum accepted result size.
        const batchSize = this.workspace || this.grant.capabilities.some((c) => c.startsWith('dc.')) ? 1 : 2;
        for (let i = 0; i < pending.length; i += batchSize) {
          const page = pending.slice(i, i + batchSize);
          const batch = await rpc.request('sync', { items: page.map((o) => ({ ...envelopeOf(o), afterSeq: o.receivedSeq })) });
          if (this.rpc !== rpc) return;
          if (!Array.isArray(batch) || batch.length !== page.length) fail('INVALID_SYNC_RESPONSE');
          for (const remote of batch) {
            if (!page.some((o) => o.operationId === remote.operationId)) fail('INVALID_SYNC_RESPONSE');
            this.merge(remote);
            if (remote.output) {
              const op = this.journal.get('ops', remote.operationId);
              // Ack only after rows and cursor have committed in the same FULL tx.
              await rpc.request('ackOutput', { ...envelopeOf(op), afterSeq: op.receivedSeq });
              if (op.receivedSeq < op.lastSeq) this.again = true;
            }
          }
        }
        if (this.rpc !== rpc) return;
        await rpc.request('ping', {});
        if (this.rpc !== rpc) return;
        this.phase = 'ready'; this.lastError = null;
      } while (this.again);
    })().catch((e) => {
      if (this.rpc === rpc) { this.lastError = e.code || 'SYNC_FAILED'; this.phase = 'reconciling'; rpc.close(); }
    }).finally(() => { this.syncPromise = null; if (this.rpc && this.rpc !== rpc) this.kick(); });
    return this.syncPromise;
  }
  merge(remote) {
    this.journal.tx(() => {
      const op = this.journal.get('ops', remote.operationId); if (!op) fail('UNBOUND_OPERATION');
      if (remote.state === 'not_received') {
        // Explicitly retrying this same operation is allowed, automatic replay is not.
        if (!TERMINAL.has(op.state)) op.state = 'not_received';
      } else {
        if (remote.requestHash !== op.requestHash) fail('OPERATION_CONFLICT');
        if (TERMINAL.has(op.state) && resultDigest(op) !== resultDigest(remote)) fail('TERMINAL_CONFLICT');
        for (const key of ['taskId', 'state', 'lastSeq', 'result', 'reason', 'starts', 'pid']) op[key] = remote[key];
        if (remote.output) {
          const out = remote.output;
          if (out.truncatedThrough > op.receivedSeq) {
            op.gaps.push({ from: op.receivedSeq + 1, through: out.truncatedThrough });
            op.receivedSeq = out.truncatedThrough;
          }
          for (const row of out.rows) {
            if (row.seq !== op.receivedSeq + 1) fail('OUTPUT_SEQUENCE_GAP');
            this.journal.append(op.operationId, row.seq, row.stream, row.data); op.receivedSeq = row.seq;
          }
          this.journal.trim(op.operationId, 65536);
        }
        if (TERMINAL.has(op.state)) op.resultDigest = resultDigest(op);
      }
      this.journal.put('ops', op.operationId, op);
    });
  }
  blockers(workspaceId) {
    return this.journal.all('ops').filter((o) => o.request.scope.workspaceId === workspaceId &&
      (['unknown', 'dispatching', 'not_received'].includes(o.state) ||
       (TERMINAL.has(o.state) && (o.delivery !== 'consumed' || o.receivedSeq < o.lastSeq))));
  }
  prepare(params) {
    exact(params, ['sessionId', 'turnId', 'turnEpoch', 'toolCallId', 'kind', 'cwdRelative', 'args', 'expiresAt', 'expectedGrantVersion']);
    if (this.workspace && params.expectedGrantVersion !== this.grant.grantVersion) fail('GRANT_CHANGED');
    const scope = { accountId: this.grant.accountId, deviceId: this.grant.deviceId,
      workspaceId: this.grant.workspaceId, grantVersion: this.grant.grantVersion,
      sessionId: params.sessionId, turnId: params.turnId, turnEpoch: params.turnEpoch };
    const request = { scope, toolCallId: params.toolCallId, kind: params.kind ?? 'mock.task', args: params.args,
      cwdRelative: params.cwdRelative ?? '.', expiresAt: params.expiresAt };
    const requestHash = validateRequest(request, this.grant), key = callKey(request);
    return this.journal.tx(() => {
      const mapping = this.journal.get('calls', key);
      if (mapping) {
        if (mapping.requestHash !== requestHash) fail('TOOL_CALL_CONFLICT');
        return this.journal.get('ops', mapping.operationId);
      }
      if (this.phase !== 'ready') fail('DEVICE_RECOVERING');
      this.journal.ensureCapacity();
      if (this.blockers(scope.workspaceId).length) fail('WORKSPACE_RECOVERING');
      if (this.workspace && this.journal.all('ops').some((o) => !TERMINAL.has(o.state))) fail('EXECUTOR_BUSY');
      const turn = this.journal.get('turns', turnKey(scope));
      if (turn?.stopped) fail('TURN_STOPPED');
      if (this.journal.all('ops').length >= 128) fail('JOURNAL_CAPACITY');
      if (!turn) this.journal.put('turns', turnKey(scope), { scope, stopped: false, reasoning: 'running' });
      const operationId = id(), op = { operationId, requestHash, request, taskId: null,
        state: 'prepared', result: null, reason: null, pid: null, starts: 0,
        lastSeq: 0, receivedSeq: 0, gaps: [], cancelId: null, cancelConfirmed: false, delivery: 'pending' };
      this.journal.put('calls', key, { operationId, requestHash }); this.journal.put('ops', operationId, op);
      return op;
    });
  }
  get(operationId) { string(operationId); return this.journal.get('ops', operationId) || fail('NOT_FOUND'); }
  async dispatch(operationId) {
    let op = this.get(operationId);
    if (!['prepared', 'not_received', 'dispatching'].includes(op.state)) return op;
    if (!this.rpc || this.phase !== 'ready') fail('DEVICE_RECOVERING');
    const turn = this.journal.get('turns', turnKey(op.request.scope));
    if (turn?.stopped || op.cancelId) fail('TURN_STOPPED');
    if (this.blockers(op.request.scope.workspaceId).some((o) => o.operationId !== operationId)) fail('WORKSPACE_RECOVERING');
    op.state = 'dispatching'; this.journal.put('ops', operationId, op);
    const rpc = this.rpc;
    try {
      const remote = await rpc.request('start', envelopeOf(op));
      if (this.rpc !== rpc) fail('STALE_CONNECTION');
      this.merge({ operationId, ...remote });
    } catch (e) {
      // Even a timeout/closed connection can follow a successful remote start.
      // Definitive rejections are retained as diagnostic text until status sync.
      op = this.get(operationId); op.transportError = e.code || 'RESULT_UNCONFIRMED'; this.journal.put('ops', operationId, op);
    }
    this.kick(); return this.get(operationId);
  }
  async control(method, params = {}) {
    if (method === 'lookupCall') {
      exact(params, ['sessionId', 'turnId', 'turnEpoch', 'toolCallId']);
      string(params.sessionId); string(params.turnId); string(params.toolCallId); integer(params.turnEpoch, 1, 1e9);
      const mapping = this.journal.get('calls', callKey({ scope: params, toolCallId: params.toolCallId }));
      return mapping ? this.get(mapping.operationId) : null;
    }
    if (method === 'operation') { exact(params, ['operationId']); return this.get(params.operationId); }
    if (method === 'workspace' && this.workspace) {
      exact(params, []);
      return { phase: this.phase, grant: this.grant, label: this.workspace.label,
        confirmed: this.phase === 'ready', blockers: this.blockers(this.grant.workspaceId).map((o) => o.operationId),
        activeOperations: this.journal.all('ops').filter((o) => !TERMINAL.has(o.state)).map((o) => o.operationId),
        sandbox: this.workspaceStatus?.sandbox ?? { network: false, readOnly: true },
        history: { ...this.journal.storage(), device: this.workspaceStatus?.history ?? null } };
    }
    if (method === 'snapshot') return { phase: this.phase, epoch: this.rpc?.epoch || null,
      lastError: this.lastError, ops: this.journal.all('ops'), turns: this.journal.all('turns'),
      blockers: this.blockers(this.grant.workspaceId).map((o) => o.operationId) };
    if (method === 'prepare') return this.prepare(params);
    if (method === 'submit') return this.dispatch(this.prepare(params).operationId);
    if (method === 'dispatch') { exact(params, ['operationId']); return this.dispatch(params.operationId); }
    if (method === 'cancel') {
      exact(params, ['operationId']); const op = this.get(params.operationId);
      if (TERMINAL.has(op.state)) return { cancelId: op.cancelId, confirmed: true, state: op.state, alreadyTerminal: true };
      op.cancelId ||= id(); this.journal.put('ops', op.operationId, op); this.kick();
      return { cancelId: op.cancelId, confirmed: op.cancelConfirmed, state: op.state };
    }
    if (method === 'stopTurn' || method === 'reasoningIdle') {
      exact(params, ['sessionId', 'turnId', 'turnEpoch']);
      const key = turnKey(params), turn = this.journal.get('turns', key); if (!turn) fail('NOT_FOUND');
      if (method === 'stopTurn') { turn.stopped = true; turn.cancelId ||= id(); }
      else turn.reasoning = 'idle';
      this.journal.tx(() => {
        if (method === 'stopTurn') this.journal.activate('turns', key);
        this.journal.put('turns', key, turn);
      });
      this.kick(); return turn;
    }
    if (method === 'ackResult') {
      exact(params, ['operationId', 'digest', 'stage']); const op = this.get(params.operationId);
      if (!TERMINAL.has(op.state) || op.receivedSeq < op.lastSeq || params.digest !== op.resultDigest) fail('RESULT_NOT_READY');
      if (!['presented', 'consumed'].includes(params.stage)) fail('INVALID_STAGE');
      if (op.delivery !== 'consumed') op.delivery = params.stage;
      this.journal.put('ops', op.operationId, op); if (this.workspace?.reliability) this.kick(); return op;
    }
    if (method === 'output') {
      exact(params, ['operationId', 'afterSeq']); const op = this.get(params.operationId);
      integer(params.afterSeq, 0, op.receivedSeq); return this.journal.output(op.operationId, params.afterSeq, op.receivedSeq);
    }
    if (method === 'session') {
      exact(params, ['sessionId', 'turnId', 'turnEpoch']);
      const turn = this.journal.get('turns', turnKey(params)); if (!turn) fail('NOT_FOUND');
      const ops = this.journal.all('ops').filter((o) => sameTurn(o.request.scope, params));
      const complete = turn.reasoning === 'idle' && ops.every((o) => TERMINAL.has(o.state) && o.delivery === 'consumed');
      return { ...turn, complete: complete && !turn.stopped,
        status: turn.stopped ? (turn.stopConfirmed && ops.every((o) => TERMINAL.has(o.state)) ? 'stopped' : 'stopping') :
          ops.some((o) => o.state === 'unknown') ? 'needs_review' : this.phase !== 'ready' ? 'waiting_device' :
          complete ? 'complete' : ops.some((o) => !TERMINAL.has(o.state)) ? 'waiting_task' : 'waiting_delivery' };
    }
    fail('METHOD_NOT_FOUND');
  }
  close() { clearInterval(this.timer); this.rpc?.close(); }
}
