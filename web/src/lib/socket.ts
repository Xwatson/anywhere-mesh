import type { ClientMessage, ServerMessage } from '../../../server/src/shared/protocol';

export type ConnState = 'connecting' | 'online' | 'offline';

type Listener = (msg: ServerMessage) => void;

/**
 * One WebSocket for the whole app. Reconnects with backoff and replays
 * subscriptions so a flaky mobile connection loses nothing.
 */
class Socket {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private stateListeners = new Set<(s: ConnState) => void>();
  private retry = 0;
  private timer: number | undefined;
  private pingTimer: number | undefined;
  private stopped = true;
  /** Called on (re)connect so owners can re-subscribe. */
  private openHooks = new Set<() => void>();
  state: ConnState = 'offline';
  onUnauthorized: () => void = () => {};

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
    document.addEventListener('visibilitychange', this.onVisible);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
    document.removeEventListener('visibilitychange', this.onVisible);
  }

  // Mobile browsers freeze background tabs; reconnect right away when shown again.
  private onVisible = () => {
    if (document.visibilityState === 'visible' && this.state === 'offline' && !this.stopped) {
      clearTimeout(this.timer);
      this.connect();
    }
  };

  private setState(s: ConnState) {
    this.state = s;
    for (const fn of this.stateListeners) fn(s);
  }

  private connect() {
    this.setState('connecting');
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setState('online');
      for (const fn of this.openHooks) fn();
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.send({ t: 'ping' }), 25_000);
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data) as ServerMessage;
      for (const fn of this.listeners) fn(msg);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      clearInterval(this.pingTimer);
      this.ws = null;
      this.setState('offline');
      if (e.code === 4401) {
        this.stopped = true;
        this.onUnauthorized();
        return;
      }
      if (this.stopped) return;
      const delay = Math.min(1000 * 2 ** this.retry++, 10_000);
      this.timer = window.setTimeout(() => this.connect(), delay);
    };
  }

  send(msg: ClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  on(fn: Listener) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  onState(fn: (s: ConnState) => void) {
    this.stateListeners.add(fn);
    return () => void this.stateListeners.delete(fn);
  }

  /** Runs now if connected, and again after every reconnect. */
  onOpen(fn: () => void) {
    this.openHooks.add(fn);
    if (this.state === 'online') fn();
    return () => void this.openHooks.delete(fn);
  }
}

export const socket = new Socket();
