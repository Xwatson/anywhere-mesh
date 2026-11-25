import { randomInt } from 'node:crypto';

export class TurnLaunchLimiter {
  constructor({ minDelayMs = 5000, maxDelayMs = 10000, now = () => Date.now(), sampleDelay } = {}) {
    if (!Number.isFinite(minDelayMs) || !Number.isFinite(maxDelayMs) || minDelayMs < 0 || maxDelayMs < minDelayMs) {
      throw Error('INVALID_LIMITER_CONFIG');
    }
    this.minDelayMs = Math.round(minDelayMs);
    this.maxDelayMs = Math.round(maxDelayMs);
    this.now = now;
    this.sampleDelay = sampleDelay ?? (() => (
      this.minDelayMs === this.maxDelayMs
        ? this.minDelayMs
        : randomInt(this.minDelayMs, this.maxDelayMs + 1)
    ));
    this.lanes = new Map();
    this.byTurn = new Map();
    this.closed = false;
  }

  lane(engine) {
    let l = this.lanes.get(engine);
    if (!l) {
      l = { engine, cooldownUntil: 0, queue: [], timer: null };
      this.lanes.set(engine, l);
    }
    return l;
  }

  enqueue(engine, turnId, { onUpdate } = {}) {
    if (this.closed) {
      return { queued: false, position: 0, remainingMs: 0, delayMs: 0, wait: Promise.resolve(false) };
    }
    if (!engine) {
      return { queued: false, position: 0, remainingMs: 0, delayMs: 0, wait: Promise.resolve(true) };
    }
    const existing = this.byTurn.get(turnId);
    if (existing) {
      const remainingMs = Math.max(0, existing.startAt - this.now());
      return { queued: true, position: existing.position, remainingMs, delayMs: existing.delayMs, wait: existing.promise };
    }
    const l = this.lane(engine);
    const now = this.now();
    if (l.queue.length === 0 && now >= l.cooldownUntil) {
      l.cooldownUntil = now + this.sampleDelay();
      return { queued: false, position: 0, remainingMs: 0, delayMs: 0, wait: Promise.resolve(true) };
    }
    const { promise, resolve } = Promise.withResolvers();
    const entry = {
      turnId,
      engine,
      gapAfterMs: this.sampleDelay(),
      position: 0,
      startAt: 0,
      delayMs: 0,
      onUpdate,
      resolve,
      promise,
    };
    l.queue.push(entry);
    this.byTurn.set(turnId, entry);
    this.#recompute(l, false);
    const remainingMs = Math.max(1, entry.startAt - now);
    entry.delayMs = remainingMs;
    this.#armTimer(l);
    return { queued: true, position: entry.position, remainingMs, delayMs: entry.delayMs, wait: promise };
  }

  status(turnId) {
    const entry = this.byTurn.get(turnId);
    if (!entry) return null;
    return {
      queued: true,
      engine: entry.engine,
      position: entry.position,
      startAt: entry.startAt,
      remainingMs: Math.max(0, entry.startAt - this.now()),
      delayMs: entry.delayMs,
    };
  }

  isQueued(turnId) {
    return this.byTurn.has(turnId);
  }

  cancel(turnId) {
    const entry = this.byTurn.get(turnId);
    if (!entry) return false;
    this.byTurn.delete(turnId);
    const l = this.lanes.get(entry.engine);
    if (l) {
      const idx = l.queue.indexOf(entry);
      if (idx >= 0) l.queue.splice(idx, 1);
      this.#recompute(l, true);
      this.#armTimer(l);
    }
    entry.resolve(false);
    return true;
  }

  #recompute(l, notify) {
    const now = this.now();
    let cursor = Math.max(now, l.cooldownUntil);
    for (let i = 0; i < l.queue.length; i++) {
      const item = l.queue[i];
      const prevStart = item.startAt;
      const prevPos = item.position;
      item.position = i + 1;
      item.startAt = cursor;
      const rem = Math.max(0, item.startAt - now);
      if (!item.delayMs || rem > item.delayMs) item.delayMs = rem;
      cursor = item.startAt + item.gapAfterMs;
      if (notify && (item.position !== prevPos || Math.abs(item.startAt - prevStart) >= 100)) {
        try {
          item.onUpdate?.({
            queued: true,
            engine: l.engine,
            position: item.position,
            remainingMs: rem,
            delayMs: item.delayMs,
          });
        } catch {}
      }
    }
  }

  #armTimer(l) {
    if (l.timer) {
      clearTimeout(l.timer);
      l.timer = null;
    }
    if (this.closed || !l.queue.length) return;
    const head = l.queue[0];
    const waitMs = Math.max(0, head.startAt - this.now());
    l.timer = setTimeout(() => {
      l.timer = null;
      this.#drainReady(l);
    }, waitMs);
    l.timer.unref?.();
  }

  #drainReady(l) {
    if (this.closed || !l.queue.length) return;
    const now = this.now();
    const head = l.queue[0];
    if (now < head.startAt) {
      this.#armTimer(l);
      return;
    }
    l.queue.shift();
    this.byTurn.delete(head.turnId);
    l.cooldownUntil = now + head.gapAfterMs;
    this.#recompute(l, true);
    this.#armTimer(l);
    head.resolve(true);
  }

  close() {
    this.closed = true;
    for (const l of this.lanes.values()) {
      if (l.timer) {
        clearTimeout(l.timer);
        l.timer = null;
      }
      while (l.queue.length) {
        const item = l.queue.shift();
        this.byTurn.delete(item.turnId);
        item.resolve(false);
      }
    }
  }
}
