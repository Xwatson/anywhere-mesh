import { useEffect, useState, type KeyboardEvent } from 'react';
import type { RemoteListing } from '../../../server/src/shared/protocol';
import { api, type DirListing } from '../lib/api';
import { cx, ErrorText, Icon, shortPath } from './ui';

/** Browses directories inside the folders the account may use, and creates new ones there. */
export function DirPicker({
  roots,
  rootsReal = [],
  value,
  onChange,
}: {
  roots: string[];
  /** `roots` with symlinks resolved: listings report resolved paths. */
  rootsReal?: string[];
  value: string;
  onChange: (p: string) => void;
}) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState('');
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!value) return;
    let stale = false;
    api
      .dirs(value)
      .then((l) => !stale && (setListing(l), setError('')))
      .catch((e) => !stale && setError(e.message));
    return () => {
      stale = true;
    };
  }, [value]);

  // No ".." above the folders the account may use.
  const atRoot = listing ? roots.includes(listing.path) || rootsReal.includes(listing.path) : true;
  const parent = listing?.path.replace(/\/[^/]+$/, '') || '';

  /** Creates the folder in the one shown and opens it. Enter must not submit the dialog's own form. */
  const create = async (e?: { preventDefault(): void }) => {
    e?.preventDefault();
    if (!listing || !name.trim()) return;
    setBusy(true);
    setError('');
    try {
      const { path } = await api.mkdir(listing.path, name);
      setNaming(false);
      setName('');
      onChange(path);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-700">
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-950 px-3 py-2 text-sm">
        <Icon name="folder" className="text-emerald-400" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={value}>
          {shortPath(value)}
        </span>
        {listing?.isGit && <span className="rounded bg-orange-500/15 px-1.5 text-[11px] text-orange-300">git</span>}
        {listing && !naming && (
          <button
            type="button"
            onClick={() => (setNaming(true), setError(''))}
            className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          >
            <Icon name="plus" className="h-3.5 w-3.5" /> 新建文件夹
          </button>
        )}
      </div>
      {naming && (
        // Not a <form>: the picker sits inside the dialog's own form.
        <div className="flex gap-2 border-b border-zinc-800 px-2 py-1.5">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void create(e);
              if (e.key === 'Escape') (e.stopPropagation(), setNaming(false));
            }}
            placeholder="新文件夹的名字"
            className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm outline-none focus:border-emerald-500"
          />
          <button
            type="button"
            onClick={() => void create()}
            disabled={busy || !name.trim()}
            className="rounded-md bg-emerald-500 px-2.5 py-1 text-xs font-medium text-emerald-950 hover:bg-emerald-400 disabled:opacity-40"
          >
            创建
          </button>
          <button type="button" onClick={() => setNaming(false)} className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800">
            取消
          </button>
        </div>
      )}
      {roots.length > 1 && (
        <div className="flex gap-1 overflow-x-auto border-b border-zinc-800 px-2 py-1.5">
          {roots.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => onChange(r)}
              className="shrink-0 rounded bg-zinc-800 px-2 py-0.5 font-mono text-xs hover:bg-zinc-700"
            >
              {shortPath(r)}
            </button>
          ))}
        </div>
      )}
      <ErrorText>{error}</ErrorText>
      <ul className="max-h-56 overflow-y-auto py-1 text-sm">
        {!atRoot && (
          <li>
            <button type="button" onClick={() => onChange(parent)} className="w-full px-3 py-1.5 text-left text-zinc-400 hover:bg-zinc-800">
              ..
            </button>
          </li>
        )}
        {listing?.dirs.map((d) => (
          <li key={d.path}>
            <button
              type="button"
              onClick={() => onChange(d.path)}
              className={cx('flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-800')}
            >
              <Icon name="folder" className="text-zinc-500" />
              <span className="truncate">{d.name}</span>
            </button>
          </li>
        ))}
        {listing && !listing.dirs.length && <li className="px-3 py-1.5 text-zinc-500">（没有子目录，可以点「新建文件夹」）</li>}
      </ul>
    </div>
  );
}

/**
 * Browses folders on a member's own computer (over SSH) to pick a session's project there; also
 * creates folders and takes a typed or pasted path.
 */
export function RemoteDirPicker({ value, onChange }: { value: string; onChange: (p: string) => void }) {
  const [listing, setListing] = useState<RemoteListing | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [typed, setTyped] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');

  useEffect(() => {
    let stale = false;
    setLoading(true);
    api
      .remoteDirs(value || undefined)
      .then((l) => {
        if (stale) return;
        setListing(l);
        setError('');
        // The server answers with the absolute path ("~" or a typed path resolved).
        if (l.path !== value) onChange(l.path);
      })
      .catch((e: Error) => !stale && setError(e.message))
      .finally(() => !stale && setLoading(false));
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const go = (path: string) => {
    setTyped(null);
    onChange(path);
  };
  const join = (dir: string) => `${listing!.path.replace(/\/+$/, '')}/${dir}`;

  const create = async () => {
    if (!listing || !name.trim()) return;
    setLoading(true);
    setError('');
    try {
      const { path } = await api.remoteMkdir(listing.path, name);
      setNaming(false);
      setName('');
      go(path);
    } catch (e) {
      setError((e as Error).message);
      setLoading(false);
    }
  };

  // Enter in these fields must not submit the dialog's own form.
  const onKey = (submit: () => void, cancel: () => void) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') (e.preventDefault(), submit());
    if (e.key === 'Escape') (e.stopPropagation(), cancel());
  };

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-700">
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-950 px-3 py-2 text-sm">
        <Icon name="folder" className="text-emerald-400" />
        {typed !== null ? (
          <input
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={onKey(() => typed.trim() && go(typed.trim()), () => setTyped(null))}
            onBlur={() => setTyped(null)}
            placeholder="输入或粘贴他电脑上的路径，回车打开"
            className="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none"
          />
        ) : (
          <button
            type="button"
            title="点击输入路径"
            onClick={() => setTyped(listing?.path ?? value)}
            className="min-w-0 flex-1 truncate text-left font-mono text-xs hover:text-zinc-100"
          >
            {listing?.path ?? (value || '~')}
          </button>
        )}
        {loading && <Icon name="refresh" className="h-3.5 w-3.5 animate-spin text-zinc-500" />}
        {listing?.isGit && <span className="rounded bg-orange-500/15 px-1.5 text-[11px] text-orange-300">git</span>}
        {listing && !naming && typed === null && (
          <button
            type="button"
            onClick={() => (setNaming(true), setError(''))}
            className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          >
            <Icon name="plus" className="h-3.5 w-3.5" /> 新建文件夹
          </button>
        )}
      </div>
      {naming && (
        <div className="flex gap-2 border-b border-zinc-800 px-2 py-1.5">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={onKey(create, () => setNaming(false))}
            placeholder="新文件夹的名字"
            className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm outline-none focus:border-emerald-500"
          />
          <button
            type="button"
            onClick={() => void create()}
            disabled={loading || !name.trim()}
            className="rounded-md bg-emerald-500 px-2.5 py-1 text-xs font-medium text-emerald-950 hover:bg-emerald-400 disabled:opacity-40"
          >
            创建
          </button>
          <button type="button" onClick={() => setNaming(false)} className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800">
            取消
          </button>
        </div>
      )}
      <ErrorText>{error}</ErrorText>
      <ul className="max-h-56 overflow-y-auto py-1 text-sm">
        {listing?.parent && (
          <li>
            <button type="button" onClick={() => go(listing.parent!)} className="w-full px-3 py-1.5 text-left text-zinc-400 hover:bg-zinc-800">
              ..
            </button>
          </li>
        )}
        {listing?.dirs.map((d) => (
          <li key={d}>
            <button type="button" onClick={() => go(join(d))} className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-800">
              <Icon name="folder" className="text-zinc-500" />
              <span className="truncate">{d}</span>
            </button>
          </li>
        ))}
        {listing && !listing.dirs.length && <li className="px-3 py-1.5 text-zinc-500">（没有子文件夹，可以点「新建文件夹」）</li>}
        {!listing && !error && <li className="px-3 py-1.5 text-zinc-500">正在连接他的电脑…</li>}
      </ul>
    </div>
  );
}
