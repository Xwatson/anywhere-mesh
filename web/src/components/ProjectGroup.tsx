import type { ReactNode } from 'react';
import { toggleCollapsed, useCollapsed } from '../lib/projects';
import { cx, Icon, shortPath } from './ui';

/** Collapsible project folder header used by the sidebar tabs (in「其他账号」one per account). */
export function ProjectGroup({
  scope,
  project,
  name,
  hint,
  icon = 'folder',
  count,
  active,
  actions,
  children,
}: {
  scope: string;
  project: string;
  name: string;
  /** Tooltip; the project's path by default. */
  hint?: string;
  icon?: 'folder' | 'users';
  count: number;
  active?: boolean;
  /** Extra controls on the right of the header, e.g. quick "new session". */
  actions?: ReactNode;
  children: ReactNode;
}) {
  const key = `${scope}:${project}`;
  const closed = useCollapsed().has(key);
  return (
    <div className="mb-1">
      <div className="group/header flex items-center rounded-md hover:bg-zinc-800/60">
        <button
          onClick={() => toggleCollapsed(key)}
          title={hint ?? shortPath(project)}
          className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left text-xs text-zinc-400 hover:text-zinc-200"
        >
          <Icon name="chevron" className={cx('h-3 w-3 transition-transform', !closed && 'rotate-90')} />
          <Icon name={icon} className={cx('h-3.5 w-3.5', active ? 'text-emerald-400' : 'text-zinc-500')} />
          <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
          <span className="text-zinc-600">{count}</span>
        </button>
        {actions && <div className="pr-1">{actions}</div>}
      </div>
      {!closed && <div className="pl-3">{children}</div>}
    </div>
  );
}
