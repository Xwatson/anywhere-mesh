import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';

const require = createRequire(import.meta.url);
const TIMEOUT_MS = 30_000;

/**
 * JSON-RPC client for `codex app-server` (stdio or attached Duplex transport, one JSON message per line).
 */
export class CodexAppServer {
  constructor(opts = {}) {
    this.opts = opts;
    this.proc = null;
    this.output = null;
    this.disconnect = undefined;
    this.ready = null;
    this.nextId = 0;
    this.waiters = new Map();
    this.idleTimer = null;
    this.holds = 0;
    this.notificationListeners = new Set();
  }

  onNotification(fn) {
    this.notificationListeners.add(fn);
    return () => this.notificationListeners.delete(fn);
  }

  hold() {
    this.holds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds--;
      this.touch();
    };
  }

  get running() {
    return this.output !== null;
  }

  async call(method, params) {
    await this.start();
    this.touch();
    return this.request(method, params);
  }

  command() {
    const args = ['app-server', ...(this.opts.config ?? []).flatMap(c => ['-c', c])];
    const codexPath = this.opts.codexPath || process.env.CODEX_PATH;
    if (codexPath) return [codexPath, args];
    return [process.execPath, [require.resolve('@openai/codex/bin/codex.js'), ...args]];
  }

  start() {
    if (this.ready) return this.ready;
    let transport = this.opts.transport;
    if (!transport) {
      const [cmd, args] = this.command();
      this.proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: this.opts.env ?? process.env });
      this.proc.stderr.resume();
      this.proc.stdin.on('error', () => {});
      transport = { input: this.proc.stdout, output: this.proc.stdin };
    }
    const proc = this.proc;
    const { input, output } = transport;
    this.output = output;
    const lines = createInterface({ input });
    lines.on('line', line => this.onLine(line));
    const fail = err => {
      if (this.disconnect !== detach) return;
      this.reset(err);
      proc?.kill();
      this.opts.onExit?.(err);
    };
    const ended = () => fail(new Error('codex app-server 已断开'));
    const detach = () => {
      lines.off('close', ended);
      lines.close();
      input.off('error', fail);
      output.off('error', fail);
      proc?.off('error', fail);
      proc?.off('exit', ended);
    };
    this.disconnect = detach;
    lines.once('close', ended);
    input.on('error', fail);
    output.on('error', fail);
    proc?.once('error', fail);
    proc?.once('exit', ended);

    this.ready = this.request('initialize', {
      clientInfo: { name: 'anywhere-mesh', title: 'AnywhereMesh', version: '0.4.2' },
      capabilities: this.opts.experimentalApi ? { experimentalApi: true } : null,
    }).then(() => {
      this.write({ jsonrpc: '2.0', method: 'initialized' });
    });
    this.ready.catch(() => fail(new Error('codex app-server 初始化失败')));
    return this.ready;
  }

  onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.method && msg.id !== undefined) {
      void this.answer(msg.id, msg.method, msg.params ?? {});
      return;
    }
    if (msg.method) {
      for (const fn of this.notificationListeners) fn(msg.method, msg.params ?? {});
      return;
    }
    if (typeof msg.id !== 'number') return;
    const w = this.waiters.get(msg.id);
    if (!w) return;
    this.waiters.delete(msg.id);
    if (msg.error) w.reject(new Error(msg.error.message || 'codex app-server error'));
    else w.resolve(msg.result);
  }

  async answer(id, method, params) {
    const connection = this.disconnect;
    try {
      if (!this.opts.onRequest) throw new Error(`unsupported request: ${method}`);
      const result = await this.opts.onRequest(method, params, id);
      if (this.disconnect === connection) this.write({ jsonrpc: '2.0', id, result });
    } catch (e) {
      if (this.disconnect === connection) {
        this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: e.message } });
      }
    }
  }

  request(method, params) {
    if (!this.output) return Promise.reject(new Error('codex app-server 已断开'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`codex app-server 请求超时: ${method}`));
      }, method === 'initialize' ? this.opts.initializeTimeoutMs ?? TIMEOUT_MS : TIMEOUT_MS);
      this.waiters.set(id, {
        resolve: v => (clearTimeout(timer), resolve(v)),
        reject: e => (clearTimeout(timer), reject(e)),
      });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  write(msg) {
    this.output?.write(JSON.stringify(msg) + '\n');
  }

  touch() {
    const idleMs = this.opts.idleMs ?? 0;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!idleMs) return;
    this.idleTimer = setTimeout(() => (this.holds > 0 ? this.touch() : this.stop()), idleMs);
  }

  reset(err) {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.disconnect?.();
    this.disconnect = undefined;
    this.output = null;
    this.proc = null;
    this.ready = null;
    for (const waiter of this.waiters.values()) waiter.reject(err);
    this.waiters.clear();
  }

  stop() {
    const p = this.proc;
    this.reset(new Error('codex app-server 已停止'));
    p?.kill();
  }
}
