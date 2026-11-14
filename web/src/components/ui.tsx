import { useEffect, useRef, useState, type ButtonHTMLAttributes, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { copyText } from '../lib/clipboard';
import type { AgentKind, SessionStatus } from '../../../server/src/shared/protocol';

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const variants: Record<Variant, string> = {
  primary: 'bg-emerald-500 text-emerald-950 hover:bg-emerald-400 font-medium',
  secondary: 'bg-zinc-800 text-zinc-100 hover:bg-zinc-700 border border-zinc-700',
  danger: 'bg-red-500/15 text-red-300 hover:bg-red-500/25 border border-red-500/30',
  ghost: 'text-zinc-300 hover:bg-zinc-800',
};

export function Button({
  variant = 'secondary',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...props}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm transition-colors disabled:opacity-40 disabled:pointer-events-none',
        variants[variant],
        className,
      )}
    />
  );
}

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className={cx(
          'flex max-h-[92dvh] w-full flex-col rounded-t-2xl sm:rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl',
          wide ? 'sm:max-w-5xl sm:h-[88dvh]' : 'sm:max-w-lg',
        )}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <div className="font-medium">{title}</div>
          <button onClick={onClose} className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" aria-label="关闭">
            <Icon name="x" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

export function AgentBadge({ agent, className }: { agent: AgentKind; className?: string }) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide',
        agent === 'claude' ? 'bg-claude/15 text-claude' : 'bg-codex/15 text-codex',
        className,
      )}
    >
      {agent}
    </span>
  );
}

/** Marks a product-advisor session (管家); such sessions are always Claude. */
export function RoleBadge({ className }: { className?: string }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded bg-amber-400/15 px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-amber-300',
        className,
      )}
    >
      <Icon name="compass" className="h-3 w-3" />
      管家
    </span>
  );
}

export function StatusDot({ status }: { status: SessionStatus }) {
  const cls =
    status === 'running'
      ? 'bg-emerald-400 animate-pulse'
      : status === 'waiting'
        ? 'bg-amber-400 animate-pulse'
        : 'bg-zinc-600';
  const label = status === 'running' ? '运行中' : status === 'waiting' ? '等待确认' : '空闲';
  return <span title={label} aria-label={label} className={cx('inline-block h-2 w-2 shrink-0 rounded-full', cls)} />;
}

const paths: Record<string, string> = {
  x: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  menu: 'M4 6h16M4 12h16M4 18h16',
  send: 'M5 12h14M13 6l6 6-6 6',
  stop: 'M7 7h10v10H7z',
  terminal: 'M4 17l6-5-6-5M12 19h8',
  diff: 'M6 3v12M18 9a3 3 0 100-6 3 3 0 000 6zM6 21a3 3 0 100-6 3 3 0 000 6zM18 9a9 9 0 01-9 9',
  chevron: 'M9 6l6 6-6 6',
  folder: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  logout: 'M15 17l5-5-5-5M20 12H9M12 19H5V5h7',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
  refresh: 'M4 4v6h6M20 20v-6h-6M5.6 15A8 8 0 0018.4 17M18.4 9A8 8 0 005.6 7',
  check: 'M5 12l5 5L20 7',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  branch: 'M6 3v12M6 15a3 3 0 100 6 3 3 0 000-6zM18 3a3 3 0 100 6 3 3 0 000-6zM18 9a9 9 0 01-9 9',
  pr: 'M6 3a3 3 0 100 6 3 3 0 000-6zM6 9v12M18 15a3 3 0 100 6 3 3 0 000-6zM18 15V8a2 2 0 00-2-2h-4M14 3l-3 3 3 3',
  shield: 'M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z',
  hand: 'M9 11V5a1.5 1.5 0 013 0v5M12 10V4a1.5 1.5 0 013 0v6M15 10V6a1.5 1.5 0 013 0v7a7 7 0 01-7 7h-.5a6 6 0 01-4.6-2.2L3.5 15a1.5 1.5 0 012.3-1.9L9 16V8a1.5 1.5 0 013 0',
  clip: 'M21 12.5l-8.5 8.5a5 5 0 01-7-7l9-9a3.5 3.5 0 015 5l-9 9a2 2 0 01-3-3l8-8',
  copy: 'M9 9h10a1 1 0 011 1v10a1 1 0 01-1 1H9a1 1 0 01-1-1V10a1 1 0 011-1zM5 15H4a1 1 0 01-1-1V4a1 1 0 011-1h10a1 1 0 011 1v1',
  compass: 'M12 21a9 9 0 100-18 9 9 0 000 18zM14.5 9.5l-1.5 4-4 1.5 1.5-4z',
  book: 'M4 19.5A2.5 2.5 0 016.5 17H20M4 19.5V5a2 2 0 012-2h14v14H6.5A2.5 2.5 0 004 19.5z',
  users: 'M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM22 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75',
  key: 'M15 7a2 2 0 012 2M21 9a6 6 0 01-7.74 5.74L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.59a1 1 0 01.29-.7l6-6A6 6 0 1121 9z',
  share: 'M4 12v7a1 1 0 001 1h14a1 1 0 001-1v-7M16 6l-4-4-4 4M12 2v13',
  lock: 'M6 11h12a1 1 0 011 1v8a1 1 0 01-1 1H6a1 1 0 01-1-1v-8a1 1 0 011-1zM8 11V7a4 4 0 018 0v4',
};

export function Icon({ name, className }: { name: keyof typeof paths | string; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cx('h-4 w-4 shrink-0', className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={paths[name]} />
    </svg>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{children}</div>;
}

/** Resolved workspace root → the path as configured, e.g. /vol1/1000/workspace → /home/me/workspace. */
let pathAliases: [real: string, shown: string][] = [];

/** Lets `shortPath` show symlink-resolved paths the way the workspace roots are configured. */
export function setPathAliases(roots: string[], rootsReal: string[] = []) {
  pathAliases = rootsReal
    .map((real, i) => [real, roots[i]] as [string, string])
    .filter(([real, shown]) => shown && real !== shown)
    .sort((a, b) => b[0].length - a[0].length);
}

export const shortPath = (p: string) => {
  for (const [real, shown] of pathAliases) {
    if (p === real || p.startsWith(real + '/')) {
      p = shown + p.slice(real.length);
      break;
    }
  }
  return p.replace(/^\/home\/[^/]+/, '~');
};

/** Small button that copies `text` (or the result of calling it) and briefly confirms. */
export function CopyButton({
  text,
  className,
  label,
}: {
  text: string | (() => string);
  className?: string;
  label?: boolean;
}) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const onClick = async (e: ReactMouseEvent) => {
    e.stopPropagation();
    const ok = await copyText(typeof text === 'function' ? text() : text);
    setState(ok ? 'ok' : 'fail');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1500);
  };
  const title = state === 'ok' ? '已复制' : state === 'fail' ? '复制失败' : '复制';
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={cx(
        'inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs transition-colors',
        state === 'ok' ? 'text-emerald-400' : state === 'fail' ? 'text-red-400' : 'text-zinc-400 hover:bg-zinc-700/60 hover:text-zinc-100',
        className,
      )}
    >
      <Icon name={state === 'ok' ? 'check' : 'copy'} className="h-3.5 w-3.5" />
      {label && <span>{title}</span>}
    </button>
  );
}
