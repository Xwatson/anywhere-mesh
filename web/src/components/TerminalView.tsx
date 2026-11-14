import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';
import type { TerminalInfo } from '../../../server/src/shared/protocol';
import { api } from '../lib/api';
import { socket } from '../lib/socket';
import { loadTerminals } from '../lib/store';
import { Button, Icon, shortPath } from './ui';

// Keys that are awkward or missing on phone keyboards.
const KEYS: { label: string; seq: string }[] = [
  { label: 'Esc', seq: '\x1b' },
  { label: 'Tab', seq: '\t' },
  { label: 'Ctrl-C', seq: '\x03' },
  { label: '↑', seq: '\x1b[A' },
  { label: '↓', seq: '\x1b[B' },
  { label: '←', seq: '\x1b[D' },
  { label: '→', seq: '\x1b[C' },
  { label: 'Ctrl-D', seq: '\x04' },
  { label: 'Enter', seq: '\r' },
];

export function TerminalView({
  term,
  onOpenSidebar,
  onClosed,
}: {
  term: TerminalInfo;
  onOpenSidebar: () => void;
  onClosed: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [exited, setExited] = useState(term.exited);

  useEffect(() => {
    const xterm = new Terminal({
      fontSize: window.innerWidth < 640 ? 12 : 14,
      fontFamily: 'ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace',
      theme: { background: '#09090b' },
      cursorBlink: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(host.current!);
    setExited(term.exited);

    const resize = () => {
      try {
        fit.fit();
        socket.send({ t: 'term.resize', termId: term.id, cols: xterm.cols, rows: xterm.rows });
      } catch {
        /* not visible yet */
      }
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host.current!);

    const offMsg = socket.on((m) => {
      if (m.t === 'term.out' && m.termId === term.id) xterm.write(m.data);
      if (m.t === 'term.exit' && m.termId === term.id) {
        setExited(true);
        xterm.write('\r\n\x1b[90m[进程已退出]\x1b[0m\r\n');
      }
    });
    // The server replays scrollback on attach, so clear first to avoid duplicates on reconnect.
    const offOpen = socket.onOpen(() => {
      xterm.reset();
      socket.send({ t: 'term.attach', termId: term.id });
      resize();
    });
    const input = xterm.onData((data) => socket.send({ t: 'term.in', termId: term.id, data }));

    return () => {
      offOpen();
      offMsg();
      input.dispose();
      ro.disconnect();
      socket.send({ t: 'term.detach', termId: term.id });
      xterm.dispose();
    };
  }, [term.id, term.exited]);

  const kill = async () => {
    if (!exited && !confirm('结束这个终端进程？')) return;
    await api.killTerminal(term.id);
    await loadTerminals();
    onClosed();
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <button onClick={onOpenSidebar} className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 md:hidden" aria-label="菜单">
          <Icon name="menu" className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{term.title}</div>
          <div className="truncate font-mono text-xs text-zinc-500">{shortPath(term.cwd)}</div>
        </div>
        <Button variant="danger" onClick={kill}>
          <Icon name="x" /> {exited ? '移除' : '结束'}
        </Button>
      </header>
      <div ref={host} className="min-h-0 flex-1 bg-zinc-950" />
      <div className="flex gap-1 overflow-x-auto border-t border-zinc-800 px-2 py-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] md:hidden">
        {KEYS.map((k) => (
          <button
            key={k.label}
            onClick={() => socket.send({ t: 'term.in', termId: term.id, data: k.seq })}
            className="shrink-0 rounded-md bg-zinc-800 px-2.5 py-1.5 font-mono text-xs active:bg-zinc-700"
          >
            {k.label}
          </button>
        ))}
      </div>
    </div>
  );
}
