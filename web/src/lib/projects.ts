import { useSyncExternalStore } from 'react';

export interface ProjectGroup<T> {
  project: string;
  name: string;
  items: T[];
  latest: number;
}

/** Groups items by project folder, most recently active project first. */
export function groupByProject<T extends { project: string; updatedAt: number }>(items: T[]): ProjectGroup<T>[] {
  const map = new Map<string, ProjectGroup<T>>();
  for (const it of items) {
    let g = map.get(it.project);
    if (!g) {
      g = { project: it.project, name: it.project.split('/').filter(Boolean).pop() || '/', items: [], latest: 0 };
      map.set(it.project, g);
    }
    g.items.push(it);
    g.latest = Math.max(g.latest, it.updatedAt);
  }
  const groups = [...map.values()].sort((a, b) => b.latest - a.latest);
  for (const g of groups) g.items.sort((a, b) => b.updatedAt - a.updatedAt);
  return groups;
}

// Collapsed project groups, remembered per browser.
const KEY = 'collapsedProjects';
let collapsed: Set<string> = (() => {
  try {
    return new Set<string>(JSON.parse(localStorage.getItem(KEY) || '[]'));
  } catch {
    return new Set<string>();
  }
})();
const listeners = new Set<() => void>();

export function toggleCollapsed(key: string) {
  collapsed = new Set(collapsed);
  if (collapsed.has(key)) collapsed.delete(key);
  else collapsed.add(key);
  try {
    localStorage.setItem(KEY, JSON.stringify([...collapsed]));
  } catch {
    /* storage unavailable */
  }
  for (const fn of listeners) fn();
}

export function useCollapsed(): Set<string> {
  return useSyncExternalStore(
    (fn) => (listeners.add(fn), () => void listeners.delete(fn)),
    () => collapsed,
  );
}
