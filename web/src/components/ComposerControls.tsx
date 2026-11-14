import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { cx } from './ui';

/**
 * A compact, borderless select for the toolbar under the input: it is as wide as the
 * current choice (not the longest option) and still opens the native picker, which
 * is what phones expect.
 */
export function GhostSelect<T extends string>({
  value,
  onChange,
  options,
  display,
  icon,
  title,
  disabled,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  display: ReactNode;
  icon?: ReactNode;
  title?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <label
      title={title}
      className={cx(
        'relative flex h-7 min-w-0 shrink-0 cursor-pointer items-center gap-0.5 rounded-md px-1 text-xs sm:gap-1 sm:px-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 focus-within:bg-zinc-800',
        disabled && 'pointer-events-none opacity-50',
        className,
      )}
    >
      {icon && <span className="hidden sm:inline-flex">{icon}</span>}
      <span className="truncate">{display}</span>
      <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0 opacity-60" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden>
        <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as T)}
        // The select is invisible, but its options still take their colours from it.
        className="absolute inset-0 h-full w-full cursor-pointer bg-zinc-900 text-sm text-zinc-200 opacity-0"
        aria-label={title}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-zinc-900 text-zinc-200">
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function fmtTokens(n?: number) {
  if (!n) return '0';
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * Context usage as a small ring; hovering (or tapping, on touch screens) opens a card
 * with the numbers and the compact action.
 */
export function ContextRing({
  context,
  canCompact,
  onCompact,
}: {
  context: { used: number; window?: number } | null;
  canCompact: boolean;
  onCompact: () => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);

  const pct = context?.window ? Math.min(100, Math.round((context.used / context.window) * 100)) : null;
  const color = pct === null ? '#71717a' : pct >= 80 ? '#f87171' : pct >= 60 ? '#fbbf24' : '#34d399';
  const r = 7;
  const circ = 2 * Math.PI * r;

  // A tap outside closes the card (hover handles the desktop case).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  const enter = (e: ReactPointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const leave = (e: ReactPointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    closeTimer.current = window.setTimeout(() => setOpen(false), 200);
  };

  return (
    <div ref={box} className="relative shrink-0" onPointerEnter={enter} onPointerLeave={leave}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-zinc-800"
        aria-label={pct === null ? '上下文用量' : `上下文已使用 ${pct}%`}
        aria-expanded={open}
      >
        <svg viewBox="0 0 20 20" className="h-[18px] w-[18px] -rotate-90" aria-hidden>
          <circle cx="10" cy="10" r={r} fill="none" stroke="#3f3f46" strokeWidth="2.5" />
          {pct !== null && pct > 0 && (
            <circle
              cx="10"
              cy="10"
              r={r}
              fill="none"
              stroke={color}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={`${(Math.max(pct, 3) / 100) * circ} ${circ}`}
            />
          )}
        </svg>
      </button>

      {open && (
        // pb-2 instead of a margin keeps the pointer inside while moving onto the card.
        <div className="absolute bottom-full right-0 z-30 pb-2">
          <div className="w-64 rounded-xl border border-zinc-700 bg-zinc-900 p-3 text-xs text-zinc-300 shadow-xl">
            <div className="mb-2 flex items-baseline justify-between">
              <span className="font-medium text-zinc-200">上下文</span>
              {pct !== null && <span className="tabular-nums" style={{ color }}>{pct}%</span>}
            </div>
            {context ? (
              <>
                {pct !== null && (
                  <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-zinc-800">
                    <div className="h-full rounded-full" style={{ width: `${Math.max(pct, 2)}%`, background: color }} />
                  </div>
                )}
                <div className="tabular-nums">
                  已使用 {fmtTokens(context.used)}
                  {context.window ? ` / ${fmtTokens(context.window)}` : ''} tokens
                </div>
                <div className="mt-1 text-zinc-500">根据最近一次回复的用量计算，不额外请求</div>
              </>
            ) : (
              <div className="text-zinc-500">还没有用量数据，发出第一条消息后显示</div>
            )}
            <button
              type="button"
              disabled={!canCompact}
              onClick={() => {
                setOpen(false);
                onCompact();
              }}
              className="mt-3 w-full rounded-lg border border-zinc-700 px-3 py-1.5 text-zinc-200 hover:bg-zinc-800 disabled:pointer-events-none disabled:opacity-40"
              title="把之前的对话总结成摘要，释放上下文空间"
            >
              压缩上下文
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
