import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import * as pty from 'node-pty';
import type { TerminalInfo } from './shared/protocol.js';

const SCROLLBACK_BYTES = 256 * 1024;

interface Term {
  info: TerminalInfo;
  /** The account that opened it; nobody else sees it. */
  userId: number;
  proc: pty.IPty;
  /** Recent output, replayed when a client attaches. */
  buffer: string;
  listeners: Set<(data: string) => void>;
  exitListeners: Set<(code: number) => void>;
}

/** Raw PTY terminals: a fallback for anything the structured chat view cannot do. */
class TerminalManager {
  private terms = new Map<string, Term>();

  list(userId: number): TerminalInfo[] {
    return [...this.terms.values()]
      .filter((t) => t.userId === userId)
      .map((t) => t.info)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  owns(id: string, userId: number): boolean {
    return this.terms.get(id)?.userId === userId;
  }

  create(userId: number, cwd: string, command?: string): TerminalInfo {
    const shell = process.env.SHELL || 'bash';
    const args = command ? ['-lc', command] : ['-l'];
    const proc = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>,
    });
    const info: TerminalInfo = {
      id: randomUUID(),
      title: command ? `${command.split(' ')[0]} · ${basename(cwd)}` : `shell · ${basename(cwd)}`,
      cwd,
      command: command ?? shell,
      createdAt: Date.now(),
      exited: false,
    };
    const term: Term = { info, userId, proc, buffer: '', listeners: new Set(), exitListeners: new Set() };
    proc.onData((data) => {
      term.buffer += data;
      if (term.buffer.length > SCROLLBACK_BYTES) term.buffer = term.buffer.slice(-SCROLLBACK_BYTES);
      for (const fn of term.listeners) fn(data);
    });
    proc.onExit(({ exitCode }) => {
      info.exited = true;
      for (const fn of term.exitListeners) fn(exitCode);
    });
    this.terms.set(info.id, term);
    return info;
  }

  attach(id: string, onData: (d: string) => void, onExit: (code: number) => void): (() => void) | null {
    const t = this.terms.get(id);
    if (!t) return null;
    if (t.buffer) onData(t.buffer);
    if (t.info.exited) onExit(0);
    t.listeners.add(onData);
    t.exitListeners.add(onExit);
    return () => {
      t.listeners.delete(onData);
      t.exitListeners.delete(onExit);
    };
  }

  write(id: string, data: string) {
    const t = this.terms.get(id);
    if (t && !t.info.exited) t.proc.write(data);
  }

  resize(id: string, cols: number, rows: number) {
    const t = this.terms.get(id);
    if (t && !t.info.exited && cols > 0 && rows > 0) t.proc.resize(Math.min(cols, 500), Math.min(rows, 200));
  }

  kill(id: string) {
    const t = this.terms.get(id);
    if (!t) return;
    if (!t.info.exited) t.proc.kill();
    this.terms.delete(id);
  }

  /** Closes every terminal of the account (it is being deleted). */
  killAll(userId: number) {
    for (const [id, t] of [...this.terms]) if (t.userId === userId) this.kill(id);
  }

  shutdown() {
    for (const id of [...this.terms.keys()]) this.kill(id);
  }
}

export const terminals = new TerminalManager();
