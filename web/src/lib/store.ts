import { useEffect, useSyncExternalStore } from 'react';
import type { OtherSession, SessionInfo, StoredEvent, TerminalInfo } from '../../../server/src/shared/protocol';
import { api, ApiError } from './api';
import { pushOnHere } from './push';
import { socket, type ConnState } from './socket';

/** Minimal observable value for useSyncExternalStore. */
class Store<T> {
  private listeners = new Set<() => void>();
  constructor(private value: T) {}
  get = () => this.value;
  set(v: T) {
    this.value = v;
    for (const fn of this.listeners) fn();
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
}

const useStore = <T,>(s: Store<T>) => useSyncExternalStore(s.subscribe, s.get);

// ---- connection ----
const connStore = new Store<ConnState>('offline');
socket.onState((s) => connStore.set(s));
export const useConnState = () => useStore(connStore);

// ---- session list ----
const sessionsStore = new Store<SessionInfo[]>([]);
export const useSessions = () => useStore(sessionsStore);

export async function loadSessions() {
  sessionsStore.set(await api.sessions());
}

/** Makes a freshly created/imported session visible before its WebSocket broadcast arrives. */
export function addSession(s: SessionInfo) {
  if (!sessionsStore.get().some((x) => x.id === s.id)) upsertSession(s);
}

function upsertSession(s: SessionInfo) {
  const list = sessionsStore.get();
  const prev = list.find((x) => x.id === s.id);
  notifyTransition(prev, s);
  const next = prev ? list.map((x) => (x.id === s.id ? s : x)) : [s, ...list];
  sessionsStore.set(next.sort((a, b) => b.updatedAt - a.updatedAt));
}

export function removeSession(id: string) {
  sessionsStore.set(sessionsStore.get().filter((s) => s.id !== id));
  timelines.delete(id);
}

// ---- other accounts' sessions: admins watch them, read-only ----
const othersStore = new Store<OtherSession[]>([]);
export const useOtherSessions = () => useStore(othersStore);
/** False while the server runs a version from before this (restart pending): it has no such list. */
const othersAvailable = new Store(true);
export const useOthersAvailable = () => useStore(othersAvailable);

export async function loadOthers() {
  try {
    othersStore.set(await api.otherSessions());
    othersAvailable.set(true);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) othersAvailable.set(false);
  }
}

function upsertOther(s: OtherSession) {
  const list = othersStore.get();
  const next = list.some((x) => x.id === s.id) ? list.map((x) => (x.id === s.id ? s : x)) : [s, ...list];
  othersStore.set(next.sort((a, b) => b.updatedAt - a.updatedAt));
}

// ---- terminals ----
const termsStore = new Store<TerminalInfo[]>([]);
export const useTerminals = () => useStore(termsStore);
export async function loadTerminals() {
  termsStore.set(await api.terminals());
}

// ---- per-session timeline ----
export interface Timeline {
  events: StoredEvent[];
  lastSeq: number;
  loaded: boolean;
  /** Assistant text streaming in, not yet finalized. */
  liveText: string;
  /** Running command output by tool id. */
  liveTool: Record<string, string>;
  /** Where the loaded history starts; older pages are fetched before it. */
  firstSeq: number;
  /** Older history exists on the server that is not loaded yet. */
  hasMore: boolean;
  loadingOlder: boolean;
}

const emptyTimeline: Timeline = {
  events: [],
  lastSeq: 0,
  loaded: false,
  liveText: '',
  liveTool: {},
  firstSeq: 1,
  hasMore: false,
  loadingOlder: false,
};
const timelines = new Map<string, Store<Timeline>>();

function timeline(id: string) {
  let s = timelines.get(id);
  if (!s) timelines.set(id, (s = new Store(emptyTimeline)));
  return s;
}

export function useTimeline(id: string): Timeline {
  const store = timeline(id);
  useEffect(() => {
    const off = socket.onOpen(() => socket.send({ t: 'sub', sessionId: id, afterSeq: store.get().lastSeq }));
    return () => {
      off();
      socket.send({ t: 'unsub', sessionId: id });
    };
  }, [id, store]);
  return useStore(store);
}

/** Fetches the page of history before what is loaded; returns false when there was nothing to load. */
export async function loadOlder(id: string): Promise<boolean> {
  const store = timeline(id);
  const cur = store.get();
  if (!cur.hasMore || cur.loadingOlder) return false;
  const before = cur.firstSeq;
  store.set({ ...cur, loadingOlder: true });
  try {
    const page = await api.olderEvents(id, before);
    const now = store.get();
    // The history was reset (resync) while this was in flight: drop the stale page.
    if (now.firstSeq !== before) return false;
    const have = new Set(now.events.map((e) => e.seq));
    const older = page.events.filter((e) => !have.has(e.seq));
    store.set({
      ...now,
      events: [...older, ...now.events].sort((a, b) => a.seq - b.seq),
      firstSeq: page.firstSeq,
      hasMore: page.hasMore,
      loadingOlder: false,
    });
    return true;
  } catch {
    const now = store.get();
    if (now.firstSeq === before) store.set({ ...now, loadingOlder: false });
    return false;
  }
}

socket.on((msg) => {
  switch (msg.t) {
    case 'events': {
      const store = timeline(msg.sessionId);
      const cur = store.get();
      const fresh = msg.events.filter((e) => e.seq > cur.lastSeq);
      let { liveText, liveTool } = cur;
      for (const { event } of fresh) {
        if (event.type === 'assistant_text' || event.type === 'turn_end') liveText = '';
        if (event.type === 'turn_end') liveTool = {};
        if (event.type === 'tool_call' && event.status !== 'running' && liveTool[event.id]) {
          liveTool = { ...liveTool };
          delete liveTool[event.id];
        }
      }
      store.set({
        ...cur,
        events: fresh.length ? [...cur.events, ...fresh] : cur.events,
        lastSeq: fresh.length ? fresh[fresh.length - 1].seq : cur.lastSeq,
        loaded: true,
        liveText,
        liveTool,
        ...(msg.page && { firstSeq: msg.page.firstSeq, hasMore: msg.page.hasMore }),
      });
      return;
    }
    case 'delta': {
      const store = timeline(msg.sessionId);
      const cur = store.get();
      const d = msg.delta;
      if (d.kind === 'text') store.set({ ...cur, liveText: cur.liveText + d.text });
      else if (d.id) store.set({ ...cur, liveTool: { ...cur.liveTool, [d.id]: d.text } });
      return;
    }
    case 'reset': {
      // History was rebuilt on the server: drop the cached copy and fetch it again.
      timeline(msg.sessionId).set(emptyTimeline);
      socket.send({ t: 'sub', sessionId: msg.sessionId, afterSeq: 0 });
      return;
    }
    case 'session':
      return upsertSession(msg.session);
    case 'session.deleted':
      return removeSession(msg.sessionId);
    case 'others':
      return upsertOther(msg.session);
    case 'others.deleted':
      othersStore.set(othersStore.get().filter((s) => s.id !== msg.sessionId));
      timelines.delete(msg.sessionId);
      return;
  }
});

// ---- browser notifications while the tab is in the background ----
export function requestNotifyPermission() {
  if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
}

function notifyTransition(prev: SessionInfo | undefined, next: SessionInfo) {
  if (!prev || prev.status === next.status || !document.hidden) return;
  // Web Push already notifies this device (with more detail, and also when the page is closed).
  if (pushOnHere()) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const body =
    next.status === 'waiting' ? '需要你确认操作' : next.status === 'idle' && prev.status !== 'idle' ? '任务已完成' : null;
  if (!body) return;
  const n = new Notification(`${next.title} · ${next.agent === 'claude' ? 'Claude' : 'Codex'}`, {
    body,
    tag: next.id,
  });
  n.onclick = () => {
    window.focus();
    location.hash = `#/s/${next.id}`;
    n.close();
  };
}
