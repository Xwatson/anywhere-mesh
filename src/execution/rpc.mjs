import { EventEmitter } from 'node:events';
import { id, exact, string, integer, ProtocolError, VERSION } from './protocol.mjs';

// A transport timeout is deliberately not a task failure. No automatic replay here.
export class Rpc extends EventEmitter {
  constructor(ws, handler, { epoch = 0, timeoutMs = 25000 } = {}) {
    super(); this.ws = ws; this.handler = handler; this.epoch = epoch;
    this.timeoutMs = timeoutMs; this.pending = new Map(); this.inflight = 0;
    ws.on('error', () => {});
    ws.on('close', () => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new ProtocolError('DISCONNECTED')); }
      this.pending.clear(); this.emit('closed');
    });
    ws.on('message', (data, binary) => this.receive(data, binary));
  }
  send(frame) {
    if (this.ws.readyState !== 1) throw new ProtocolError('DISCONNECTED');
    const payload = JSON.stringify({ v: VERSION, epoch: this.epoch, ...frame });
    if (Buffer.byteLength(payload) > 524288) throw new ProtocolError('FRAME_TOO_LARGE');
    if (this.ws.bufferedAmount > 1048576) { this.ws.terminate(); throw new ProtocolError('BACKPRESSURE'); }
    this.ws.send(payload);
  }
  request(method, params) {
    if (this.pending.size >= 16) return Promise.reject(new ProtocolError('BUSY'));
    const requestId = id();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new ProtocolError('RESULT_UNCONFIRMED')); }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer, method });
      try { this.send({ type: 'request', requestId, method, params }); }
      catch (e) { clearTimeout(timer); this.pending.delete(requestId); reject(e); }
    });
  }
  notify(method, params) { try { this.send({ type: 'notice', method, params }); } catch {} }
  async receive(data, binary) {
    let frame;
    try {
      if (binary || data.length > 524288) throw new Error('INVALID_FRAME');
      frame = JSON.parse(data.toString());
      exact(frame, ['v', 'epoch', 'type', 'requestId', 'method', 'params', 'result', 'error']);
      if (frame.v !== VERSION) throw new Error('PROTOCOL_VERSION');
      integer(frame.epoch, 0, Number.MAX_SAFE_INTEGER);
      if (frame.type === 'response') {
        const p = this.pending.get(frame.requestId); if (!p) return;
        if (frame.epoch !== this.epoch && !(p.method === 'hello' && this.epoch === 0 &&
            frame.epoch === frame.result?.connectionEpoch)) throw new Error('STALE_CONNECTION');
        this.pending.delete(frame.requestId); clearTimeout(p.timer);
        if (frame.error) p.reject(new ProtocolError(frame.error)); else p.resolve(frame.result);
        return;
      }
      if (frame.type !== 'request' && frame.type !== 'notice') throw new Error('INVALID_FRAME');
      string(frame.method); if (frame.type === 'request') string(frame.requestId);
      if (++this.inflight > 16) throw new Error('BUSY');
      let response;
      try { response = { result: await this.handler(frame.method, frame.params, frame) }; }
      catch (e) { response = { error: e.code || 'INTERNAL_ERROR' }; }
      finally { this.inflight--; }
      if (frame.type === 'request') {
        try { this.send({ type: 'response', requestId: frame.requestId, ...response }); } catch {}
      }
    } catch { this.ws.terminate(); }
  }
  close() { this.ws.terminate(); }
}
