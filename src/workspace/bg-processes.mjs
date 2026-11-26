import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fail } from '../execution/protocol.mjs';

const MAX_RUNNING = 4;
const MAX_RECORDS = 16;
const MAX_OUTPUT_BYTES = 65536;
const MAX_TTL_MS = 30 * 60 * 1000;

function killProcessTree(pid, isWin = process.platform === 'win32') {
  if (!pid) return;
  if (isWin) {
    try {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => {});
    } catch {}
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch {}
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

function defaultEnv(isWin) {
  if (isWin) {
    const env = { ...process.env };
    const runtimeDir = dirname(process.execPath);
    const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH';
    const cur = env[pathKey] ?? '';
    const parts = cur ? cur.split(';').filter(Boolean) : [];
    if (runtimeDir && !parts.some(p => p.trim().toLowerCase() === runtimeDir.toLowerCase())) {
      env[pathKey] = cur ? `${cur};${runtimeDir}` : runtimeDir;
    }
    return env;
  }
  return {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME || '/tmp',
    LANG: process.env.LANG || 'C.UTF-8',
    TERM: 'dumb',
  };
}

export class BackgroundProcessManager {
  constructor({ stateDir = null, platform = process.platform, maxRunning = MAX_RUNNING, ttlMs = MAX_TTL_MS } = {}) {
    this.stateDir = stateDir;
    this.isWin = platform === 'win32';
    this.maxRunning = maxRunning;
    this.ttlMs = ttlMs;
    this.procs = new Map();
  }

  runningCount() {
    let n = 0;
    for (const p of this.procs.values()) if (p.running) n++;
    return n;
  }

  pruneOld() {
    if (this.procs.size <= MAX_RECORDS) return;
    const exited = [...this.procs.values()]
      .filter(p => !p.running)
      .sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt));
    while (this.procs.size > MAX_RECORDS && exited.length) {
      this.procs.delete(exited.shift().id);
    }
  }

  get(processId) {
    const p = this.procs.get(processId);
    if (!p) fail('BG_PROCESS_NOT_FOUND');
    return p;
  }

  async start({ cwd, command, waitMs = 1500, env }) {
    if (this.runningCount() >= this.maxRunning) fail('BG_PROCESS_LIMIT');
    const id = 'bg-' + randomUUID().slice(0, 8);
    const procEnv = env ?? defaultEnv(this.isWin);
    let batchFile = null;
    let child;
    if (this.isWin) {
      const tasksDir = join(this.stateDir || cwd, 'bg-tasks');
      mkdirSync(tasksDir, { recursive: true });
      batchFile = join(tasksDir, `${id}.cmd`);
      const script = '@echo off\r\nchcp 65001 >nul\r\n' + command.replace(/\r?\n/g, '\r\n') + '\r\n';
      writeFileSync(batchFile, script, { flag: 'wx' });
      const comspec = procEnv.ComSpec || procEnv.COMSPEC || 'cmd.exe';
      child = spawn(comspec, ['/D', '/S', '/C', `""${batchFile}""`], {
        cwd, env: procEnv, windowsHide: true, windowsVerbatimArguments: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } else {
      child = spawn('/bin/bash', ['-lc', command], {
        cwd, detached: true, env: procEnv, stdio: ['pipe', 'pipe', 'pipe'],
      });
    }

    const entry = {
      id,
      pid: child.pid ?? null,
      command: command.length > 200 ? command.slice(0, 200) + '…' : command,
      cwd,
      child,
      batchFile,
      running: true,
      exitCode: null,
      signal: null,
      error: null,
      startedAt: Date.now(),
      endedAt: null,
      chunks: [],
      bufferedBytes: 0,
      lastSeq: 0,
      truncatedBefore: 0,
      waiters: new Set(),
      closeWaiters: new Set(),
      ttlTimer: null,
    };

    const notify = () => {
      for (const fn of entry.waiters) fn();
      entry.waiters.clear();
    };
    const pushChunk = (text) => {
      if (!text) return;
      entry.lastSeq += 1;
      const bytes = Buffer.byteLength(text, 'utf8');
      entry.chunks.push({ seq: entry.lastSeq, text, bytes });
      entry.bufferedBytes += bytes;
      while (entry.bufferedBytes > MAX_OUTPUT_BYTES && entry.chunks.length > 1) {
        const dropped = entry.chunks.shift();
        entry.bufferedBytes -= dropped.bytes;
        entry.truncatedBefore = dropped.seq;
      }
      notify();
    };
    const cleanupBatch = () => {
      if (entry.batchFile) {
        try { rmSync(entry.batchFile, { force: true }); } catch {}
        entry.batchFile = null;
      }
    };

    for (const pipe of [child.stdout, child.stderr]) {
      const dec = new StringDecoder('utf8');
      pipe.on('data', buf => pushChunk(dec.write(buf)));
      pipe.on('end', () => pushChunk(dec.end()));
    }
    child.stdin.on('error', () => {});
    child.once('error', err => {
      entry.error = err.code || err.message;
      entry.running = false;
      entry.endedAt = Date.now();
      clearTimeout(entry.ttlTimer);
      cleanupBatch();
      notify();
      for (const fn of entry.closeWaiters) fn();
      entry.closeWaiters.clear();
    });
    child.once('close', (code, sig) => {
      entry.exitCode = code;
      entry.signal = sig ?? null;
      entry.running = false;
      entry.endedAt = Date.now();
      clearTimeout(entry.ttlTimer);
      killProcessTree(entry.pid, this.isWin);
      cleanupBatch();
      notify();
      for (const fn of entry.closeWaiters) fn();
      entry.closeWaiters.clear();
    });

    entry.ttlTimer = setTimeout(() => {
      if (entry.running) {
        pushChunk('\n[Background process terminated after max TTL]\n');
        killProcessTree(entry.pid, this.isWin);
      }
    }, this.ttlMs);
    entry.ttlTimer.unref?.();

    this.procs.set(id, entry);
    this.pruneOld();

    if (waitMs > 0 && entry.running) {
      await new Promise(resolve => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          entry.closeWaiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, waitMs);
        entry.closeWaiters.add(done);
      });
    }

    return this.formatOutput(entry, 0);
  }

  formatOutput(entry, afterSeq = 0) {
    const fresh = entry.chunks.filter(c => c.seq > afterSeq);
    const output = fresh.map(c => c.text).join('');
    return {
      processId: entry.id,
      pid: entry.pid,
      command: entry.command,
      running: entry.running,
      exitCode: entry.exitCode,
      signal: entry.signal,
      ...(entry.error ? { error: entry.error } : {}),
      nextSeq: entry.lastSeq,
      truncatedBefore: entry.truncatedBefore,
      output: output.slice(-24000),
    };
  }

  list() {
    return [...this.procs.values()].map(p => ({
      processId: p.id,
      pid: p.pid,
      command: p.command,
      running: p.running,
      exitCode: p.exitCode,
      signal: p.signal,
      startedAt: p.startedAt,
      endedAt: p.endedAt,
      lastSeq: p.lastSeq,
    }));
  }

  async output({ processId, afterSeq = 0, waitMs = 0 }) {
    const entry = this.get(processId);
    if (waitMs > 0 && entry.running && entry.lastSeq <= afterSeq) {
      await new Promise(resolve => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          entry.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, waitMs);
        entry.waiters.add(done);
      });
    }
    return this.formatOutput(entry, afterSeq);
  }

  input({ processId, input }) {
    const entry = this.get(processId);
    if (!entry.running || entry.child.stdin.destroyed || !entry.child.stdin.writable) {
      fail('BG_PROCESS_NOT_RUNNING');
    }
    entry.child.stdin.write(input);
    return { processId: entry.id, writtenBytes: Buffer.byteLength(input, 'utf8'), running: entry.running };
  }

  async stop({ processId }) {
    const entry = this.get(processId);
    if (entry.running) {
      killProcessTree(entry.pid, this.isWin);
      try { entry.child.kill('SIGKILL'); } catch {}
      await new Promise(resolve => {
        if (!entry.running) { resolve(); return; }
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          entry.closeWaiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, 3000);
        entry.closeWaiters.add(done);
      });
    }
    return this.formatOutput(entry, Math.max(0, entry.lastSeq - 20));
  }

  async stopAll() {
    const running = [...this.procs.values()].filter(p => p.running);
    await Promise.allSettled(running.map(p => this.stop({ processId: p.id })));
  }
}
