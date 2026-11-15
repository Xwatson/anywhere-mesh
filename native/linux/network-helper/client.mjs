import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

/** No arbitrary command/config interface. Keep this connection alive to own the tunnel. */
export class NetworkClient extends EventEmitter {
  #socket;
  #pending = new Map();
  #buffer = Buffer.alloc(0);
  #lease;
  #timer;
  #closed = false;
  #closing;

  static async connect(path) {
    const socket = net.createConnection({ path });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { socket.destroy(); reject(new Error('CONNECT_TIMEOUT')); }, 3000);
      socket.once('connect', () => { clearTimeout(timeout); resolve(); });
      socket.once('error', (error) => { clearTimeout(timeout); reject(error); });
    });
    return new NetworkClient(socket);
  }

  constructor(socket) {
    super();
    this.#socket = socket;
    socket.on('data', (chunk) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      while (this.#buffer.includes(10)) {
        const end = this.#buffer.indexOf(10);
        if (end > 4096) return this.#fail(new Error('RESPONSE_TOO_LARGE'));
        const line = this.#buffer.subarray(0, end);
        this.#buffer = this.#buffer.subarray(end + 1);
        let response;
        try { response = JSON.parse(line); } catch { return this.#fail(new Error('INVALID_RESPONSE')); }
        const waiter = this.#pending.get(response.id);
        if (!waiter || response.version !== 1 || typeof response.ok !== 'boolean') {
          return this.#fail(new Error('INVALID_RESPONSE'));
        }
        clearTimeout(waiter.timer);
        this.#pending.delete(response.id);
        if (response.ok) waiter.resolve(response);
        else waiter.reject(new Error(response.error));
      }
      if (this.#buffer.length > 4096) this.#fail(new Error('RESPONSE_TOO_LARGE'));
    });
    socket.on('error', (error) => this.#fail(error));
    socket.on('close', () => this.#fail(new Error('HELPER_DISCONNECTED')));
  }

  #fail(error) {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    for (const waiter of this.#pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#pending.clear();
    this.#socket.destroy();
    this.emit('disconnected', error.message);
  }

  request(method, extra = {}) {
    if (this.#closed) return Promise.reject(new Error('CLIENT_CLOSED'));
    if (this.#pending.size >= 8) return Promise.reject(new Error('TOO_MANY_REQUESTS'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#fail(new Error('REQUEST_TIMEOUT')), 7000);
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.write(JSON.stringify({ version: 1, id, method, ...extra }) + '\n');
    });
  }

  async acquire() {
    const response = await this.request('start');
    this.#lease = response.lease;
    clearInterval(this.#timer);
    this.#timer = setInterval(() => {
      this.request('renew', { lease: this.#lease }).catch((error) => this.#fail(error));
    }, response.leaseSeconds * 1000 / 3);
    return response.status;
  }

  async status() { return (await this.request('status')).status; }

  async waitConnected(timeoutMs = 20000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const state = await this.status();
      if (state.phase === 'connected') return state;
      if (state.phase === 'failed' || state.phase === 'idle') throw new Error(state.error ?? 'LEASE_LOST');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('NETWORK_NOT_READY');
  }

  close() {
    if (this.#closing) return this.#closing;
    this.#closing = (async () => {
      clearInterval(this.#timer);
      try {
        if (this.#lease && !this.#closed) await this.request('stop', { lease: this.#lease });
      } finally {
        this.#lease = undefined;
        this.#fail(new Error('CLIENT_CLOSED'));
      }
    })();
    return this.#closing;
  }
}
