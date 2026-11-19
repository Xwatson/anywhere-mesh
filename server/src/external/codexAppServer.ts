import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { config } from '../config.js';

const require = createRequire(import.meta.url);
const TIMEOUT_MS = 30_000;

type Params = Record<string, unknown>;
type RequestId = string | number;

export interface CodexAppServerOptions {
  /** Stop the process after this long without calls; 0 keeps it until stop(). */
  idleMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Config overrides for this process only, as for `codex -c key=value`. */
  config?: string[];
  /** Attach to an already launched app-server, e.g. under a separate OS login. */
  transport?: { input: Readable; output: Writable };
  experimentalApi?: boolean;
  /**
   * Handles requests Codex sends to us (approvals, questions). The resolved value is
   * the JSON-RPC result; a rejection is returned as a JSON-RPC error.
   */
  onRequest?: (method: string, params: Params, id: RequestId) => Promise<unknown>;
  /** The process exited on its own (crash or kill from outside). */
  onExit?: (err: Error) => void;
}

/**
 * JSON-RPC client for `codex app-server` (stdio, one JSON message per line).
 * The process is started on demand.
 */
export class CodexAppServer {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private output: Writable | null = null;
  private disconnect?: () => void;
  private ready: Promise<void> | null = null;
  private nextId = 0;
  private waiters = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private idleTimer: NodeJS.Timeout | null = null;
  private holds = 0;
  private notificationListeners = new Set<(method: string, params: Params) => void>();

  constructor(private opts: CodexAppServerOptions = {}) {}

  onNotification(fn: (method: string, params: Params) => void): () => void {
    this.notificationListeners.add(fn);
    return () => this.notificationListeners.delete(fn);
  }

  /** Keeps the process alive past the idle timeout, for long operations such as compaction. */
  hold(): () => void {
    this.holds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds--;
      this.touch();
    };
  }

  get running(): boolean {
    return this.output !== null;
  }

  async call<T>(method: string, params: unknown): Promise<T> {
    await this.start();
    this.touch();
    return this.request<T>(method, params);
  }

  private command(): [string, string[]] {
    const args = ['app-server', ...(this.opts.config ?? []).flatMap((c) => ['-c', c])];
    if (config.codexPath) return [config.codexPath, args];
    // The bundled CLI that @openai/codex-sdk depends on; works without codex on PATH.
    return [process.execPath, [require.resolve('@openai/codex/bin/codex.js'), ...args]];
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    let transport = this.opts.transport;
    if (!transport) {
      const [cmd, args] = this.command();
      this.proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: this.opts.env ?? process.env });
      this.proc.stderr.resume();
      this.proc.stdin.on('error', () => {}); // A buffered write can fail after the child exits.
      transport = { input: this.proc.stdout, output: this.proc.stdin };
    }
    const proc = this.proc;
    const { input, output } = transport;
    this.output = output;
    const lines = createInterface({ input });
    lines.on('line', (line) => this.onLine(line));
    const fail = (err: Error) => {
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
      clientInfo: { name: 'anywhere-coding', title: 'Anywhere Coding', version: '0.1.0' },
      capabilities: this.opts.experimentalApi ? { experimentalApi: true } : null,
    }).then(() => {
      this.write({ jsonrpc: '2.0', method: 'initialized' });
    });
    this.ready.catch(() => fail(new Error('codex app-server 初始化失败')));
    return this.ready;
  }

  private onLine(line: string) {
    let msg: { id?: RequestId; method?: string; params?: Params; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    // A request from Codex: it has both a method and an id, and waits for our answer.
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

  private async answer(id: RequestId, method: string, params: Params) {
    const connection = this.disconnect;
    try {
      if (!this.opts.onRequest) throw new Error(`unsupported request: ${method}`);
      const result = await this.opts.onRequest(method, params, id);
      if (this.disconnect === connection) this.write({ jsonrpc: '2.0', id, result });
    } catch (e) {
      if (this.disconnect === connection) {
        this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: (e as Error).message } });
      }
    }
  }

  private request<T>(method: string, params: unknown): Promise<T> {
    if (!this.output) return Promise.reject(new Error('codex app-server 已断开'));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`codex app-server 请求超时: ${method}`));
      }, TIMEOUT_MS);
      this.waiters.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v as T)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private write(msg: unknown) {
    this.output?.write(JSON.stringify(msg) + '\n');
  }

  private touch() {
    const idleMs = this.opts.idleMs ?? 0;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!idleMs) return;
    this.idleTimer = setTimeout(() => (this.holds > 0 ? this.touch() : this.stop()), idleMs);
  }

  private reset(err: Error) {
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

/** Shared instance for read-only queries: thread history, rate limits, model list. */
export const codexAppServer = new CodexAppServer({ idleMs: 2 * 60 * 1000 });
