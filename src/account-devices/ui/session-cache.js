export const CACHE_SCHEMA_VERSION = 1;
export const DEFAULT_MAX_SESSIONS = 40;
export const DEFAULT_MAX_EVENTS_PER_SESSION = 400;
export const DEFAULT_MAX_BYTES_PER_SESSION = 1024 * 1024;
export const DEFAULT_MAX_INCREMENTAL_GAP = 200;

export function isValidEventRow(row) {
  return Boolean(
    row &&
    Number.isSafeInteger(row.seq) &&
    row.seq >= 1 &&
    row.event &&
    typeof row.event === 'object' &&
    typeof row.event.type === 'string' &&
    (row.event.type !== 'assistant_text' || typeof row.event.text === 'string'),
  );
}

export function isRenderableEvent(event) {
  if (!event || typeof event !== 'object') return false;
  if (event.type === 'user_message' || event.type === 'tool_call' || event.type === 'context_compacted' || event.type === 'turn_notice') return true;
  if (event.type === 'assistant_text') return typeof event.text === 'string';
  if (event.type === 'thinking') return Boolean(event.text);
  if (event.type === 'turn_end') {
    return Boolean(!event.ok || event.model || event.durationMs || event.usage?.inputTokens || event.usage?.outputTokens || event.toolCalls?.total);
  }
  return false;
}

export function normalizeEvents(events) {
  const bySeq = new Map();
  for (const row of events ?? []) {
    if (isValidEventRow(row)) bySeq.set(row.seq, row);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export function isCompatibleLocalState(local, target) {
  if (!local || !target) return false;
  if (local.workspaceId !== target.workspaceId) return false;
  if (!local.historyEpoch || local.historyEpoch !== target.historyEpoch) return false;
  if (!Array.isArray(local.events) || !local.events.length) return false;
  const first = local.events[0]?.seq;
  const last = local.events.at(-1)?.seq;
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first) return false;
  if (local.firstSeq !== first || local.throughSeq < last) return false;
  if (Number.isSafeInteger(target.lastSeq) && local.throughSeq > target.lastSeq) return false;
  return true;
}

export function decideSyncPlan(local, target, { maxIncrementalGap = DEFAULT_MAX_INCREMENTAL_GAP } = {}) {
  if (!target) return { action: 'noop' };
  const lastSeq = Number.isSafeInteger(target.lastSeq) ? target.lastSeq : 0;
  if (lastSeq <= 0) {
    const stale = Boolean(local && (local.throughSeq > 0 || local.historyEpoch !== target.historyEpoch));
    return { action: 'empty', invalidateCache: stale };
  }
  if (!isCompatibleLocalState(local, target)) {
    return { action: 'tail', beforeSeq: Math.max(lastSeq + 1, 2147483647), reset: true };
  }
  if (local.throughSeq === lastSeq) {
    return { action: 'up_to_date' };
  }
  const gap = lastSeq - local.throughSeq;
  if (gap <= maxIncrementalGap) {
    return { action: 'incremental', afterSeq: local.throughSeq };
  }
  return { action: 'tail_merge', beforeSeq: Math.max(lastSeq + 1, 2147483647) };
}

export function mergeServerTail(local, page) {
  const incoming = normalizeEvents(page?.events);
  const pageFirst = incoming[0]?.seq ?? (Number.isSafeInteger(page?.firstSeq) ? page.firstSeq : 0);
  const pageThrough = incoming.at(-1)?.seq ?? (Number.isSafeInteger(page?.throughSeq) ? page.throughSeq : 0);
  const canStitch = Boolean(
    local &&
    local.workspaceId === page?.workspaceId &&
    local.historyEpoch &&
    local.historyEpoch === page?.historyEpoch &&
    Array.isArray(local.events) &&
    local.events.length > 0 &&
    Number.isSafeInteger(local.throughSeq) &&
    local.throughSeq <= pageThrough &&
    pageFirst > 0 &&
    pageFirst <= local.throughSeq + 1,
  );
  if (canStitch) {
    // Authoritative server rows override matching local seqs while preserving loaded older history.
    const merged = normalizeEvents([...local.events, ...incoming]);
    const firstSeq = merged[0]?.seq ?? 0;
    const throughSeq = Math.max(pageThrough, merged.at(-1)?.seq ?? 0);
    return {
      sessionId: page.sessionId,
      workspaceId: page.workspaceId,
      historyEpoch: page.historyEpoch,
      events: merged,
      firstSeq,
      throughSeq,
      hasOlder: firstSeq > 1,
      replaced: false,
    };
  }
  return {
    sessionId: page.sessionId,
    workspaceId: page.workspaceId,
    historyEpoch: page.historyEpoch,
    events: incoming,
    firstSeq: pageFirst,
    throughSeq: pageThrough,
    hasOlder: Boolean(page?.hasMore ?? (pageFirst > 1)),
    replaced: true,
  };
}

export function mergeIncrementalPage(local, page) {
  if (!page || typeof page.historyEpoch !== 'string') return { status: 'resync_needed' };
  const incoming = normalizeEvents(page.events);
  const pageThrough = Number.isSafeInteger(page.throughSeq) ? page.throughSeq : (incoming.at(-1)?.seq ?? 0);

  if (!local || !local.historyEpoch || local.workspaceId !== page.workspaceId || local.historyEpoch !== page.historyEpoch) {
    if ((!local || !local.events?.length) && (!incoming.length || incoming[0].seq === 1)) {
      const firstSeq = incoming[0]?.seq ?? 0;
      const throughSeq = Math.max(pageThrough, incoming.at(-1)?.seq ?? 0);
      return {
        status: incoming.length ? 'merged' : 'unchanged',
        added: incoming,
        state: {
          sessionId: page.sessionId,
          workspaceId: page.workspaceId,
          historyEpoch: page.historyEpoch,
          events: incoming,
          firstSeq,
          throughSeq,
          hasOlder: firstSeq > 1,
        },
      };
    }
    return { status: 'resync_needed' };
  }

  const baseEvents = Array.isArray(local.events) ? local.events : [];
  const prevThrough = Number.isSafeInteger(local.throughSeq) ? local.throughSeq : (baseEvents.at(-1)?.seq ?? 0);
  const prevFirst = Number.isSafeInteger(local.firstSeq) ? local.firstSeq : (baseEvents[0]?.seq ?? 0);

  if (!incoming.length) {
    const throughSeq = Math.max(prevThrough, pageThrough);
    return {
      status: 'unchanged',
      added: [],
      state: { ...local, events: baseEvents, firstSeq: prevFirst, throughSeq, hasOlder: prevFirst > 1 },
    };
  }

  if (prevThrough > 0) {
    if (incoming[0].seq > prevThrough + 1) {
      return { status: 'gap', expectedSeq: prevThrough + 1, gotSeq: incoming[0].seq };
    }
    if (prevFirst > 0 && incoming.at(-1).seq + 1 < prevFirst) {
      return { status: 'resync_needed' };
    }
  } else if (incoming[0].seq > 1) {
    return { status: 'resync_needed' };
  }

  const merged = normalizeEvents([...baseEvents, ...incoming]);
  const firstSeq = merged[0]?.seq ?? 0;
  const throughSeq = Math.max(prevThrough, pageThrough, merged.at(-1)?.seq ?? 0);
  const added = incoming.filter(r => r.seq > prevThrough);
  return {
    status: 'merged',
    added,
    state: {
      sessionId: page.sessionId,
      workspaceId: page.workspaceId,
      historyEpoch: page.historyEpoch,
      events: merged,
      firstSeq,
      throughSeq,
      hasOlder: firstSeq > 1,
    },
  };
}

export function mergeOlderPage(local, page) {
  if (!local || !page || local.workspaceId !== page.workspaceId || local.historyEpoch !== page.historyEpoch) {
    return { status: 'resync_needed' };
  }
  const older = normalizeEvents(page.events);
  if (!older.length) {
    return { status: 'exhausted', prependedCount: 0, state: { ...local, hasOlder: false } };
  }
  const baseEvents = Array.isArray(local.events) ? local.events : [];
  const prevFirst = Number.isSafeInteger(local.firstSeq) ? local.firstSeq : (baseEvents[0]?.seq ?? 0);
  if (prevFirst > 0 && older.at(-1).seq < prevFirst - 1) {
    return { status: 'resync_needed' };
  }
  const merged = normalizeEvents([...older, ...baseEvents]);
  const firstSeq = merged[0]?.seq ?? 0;
  const throughSeq = Math.max(local.throughSeq ?? 0, merged.at(-1)?.seq ?? 0);
  const hasOlder = Boolean((page.hasMore ?? (firstSeq > 1)) && firstSeq > 1);
  return {
    status: 'merged',
    prependedCount: Math.max(0, merged.length - baseEvents.length),
    state: {
      ...local,
      events: merged,
      firstSeq,
      throughSeq,
      hasOlder,
    },
  };
}

function estimateRowBytes(row) {
  try {
    return JSON.stringify(row).length * 2;
  } catch {
    return 1024;
  }
}

export function trimRecordForCache(
  record,
  { maxEvents = DEFAULT_MAX_EVENTS_PER_SESSION, maxBytes = DEFAULT_MAX_BYTES_PER_SESSION } = {},
) {
  const normalized = normalizeEvents(record?.events);
  if (!normalized.length) {
    return {
      sessionId: record.sessionId,
      workspaceId: record.workspaceId,
      historyEpoch: record.historyEpoch,
      events: [],
      firstSeq: 0,
      throughSeq: Number.isSafeInteger(record?.throughSeq) ? record.throughSeq : 0,
      hasOlder: false,
      updatedAt: record?.updatedAt ?? Date.now(),
      schemaVersion: CACHE_SCHEMA_VERSION,
    };
  }
  const keptRev = [];
  let bytes = 0;
  for (let i = normalized.length - 1; i >= 0; i--) {
    const row = normalized[i];
    const rowBytes = estimateRowBytes(row);
    if (keptRev.length >= maxEvents || (keptRev.length > 0 && bytes + rowBytes > maxBytes)) break;
    keptRev.push(row);
    bytes += rowBytes;
  }
  let kept = keptRev.reverse();
  // Prefer starting a trimmed cache slice on a user_message boundary when available without dropping too much.
  if (kept.length < normalized.length && kept[0]?.event?.type !== 'user_message') {
    const boundary = kept.findIndex(r => r.event?.type === 'user_message');
    if (boundary > 0 && boundary < kept.length - 1) {
      kept = kept.slice(boundary);
    }
  }
  const firstSeq = kept[0]?.seq ?? 0;
  const throughSeq = Math.max(Number.isSafeInteger(record?.throughSeq) ? record.throughSeq : 0, kept.at(-1)?.seq ?? 0);
  return {
    sessionId: record.sessionId,
    workspaceId: record.workspaceId,
    historyEpoch: record.historyEpoch,
    events: kept,
    firstSeq,
    throughSeq,
    hasOlder: firstSeq > 1,
    updatedAt: record?.updatedAt ?? Date.now(),
    schemaVersion: CACHE_SCHEMA_VERSION,
  };
}

function makeKey(userId, sessionId) {
  return `${userId}:${sessionId}`;
}

export function createSessionCache({
  dbName = 'anywhere-mesh-session-cache',
  maxSessions = DEFAULT_MAX_SESSIONS,
  maxEvents = DEFAULT_MAX_EVENTS_PER_SESSION,
  maxBytes = DEFAULT_MAX_BYTES_PER_SESSION,
  indexedDBImpl = typeof indexedDB !== 'undefined' ? indexedDB : null,
} = {}) {
  const memory = new Map();
  let dbPromise = null;

  function touchMemory(key, value) {
    memory.delete(key);
    memory.set(key, value);
    while (memory.size > maxSessions) {
      const oldestKey = memory.keys().next().value;
      if (oldestKey === undefined) break;
      memory.delete(oldestKey);
    }
  }

  function openDb() {
    if (!indexedDBImpl) return Promise.resolve(null);
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(resolve => {
      try {
        const req = indexedDBImpl.open(dbName, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('sessions')) {
            const store = db.createObjectStore('sessions', { keyPath: 'key' });
            store.createIndex('updatedAt', 'updatedAt', { unique: false });
          }
        };
        req.onsuccess = () => {
          const db = req.result;
          db.onversionchange = () => { try { db.close(); } catch {} dbPromise = null; };
          resolve(db);
        };
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return dbPromise;
  }

  async function pruneDb(db) {
    if (!db) return;
    await new Promise(resolve => {
      try {
        const tx = db.transaction('sessions', 'readwrite');
        const store = tx.objectStore('sessions');
        const countReq = store.count();
        countReq.onsuccess = () => {
          let excess = (countReq.result ?? 0) - maxSessions;
          if (excess <= 0) return;
          const idx = store.index('updatedAt');
          const curReq = idx.openCursor();
          curReq.onsuccess = () => {
            const cursor = curReq.result;
            if (!cursor || excess <= 0) return;
            cursor.delete();
            excess--;
            cursor.continue();
          };
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  function isUsableEntry(entry, userId, sessionId) {
    return Boolean(
      entry &&
      entry.schemaVersion === CACHE_SCHEMA_VERSION &&
      String(entry.userId) === String(userId) &&
      entry.sessionId === sessionId &&
      typeof entry.workspaceId === 'string' &&
      typeof entry.historyEpoch === 'string' &&
      Array.isArray(entry.events),
    );
  }

  return {
    getSync(userId, sessionId) {
      if (userId == null || !sessionId) return null;
      const key = makeKey(userId, sessionId);
      const entry = memory.get(key);
      if (!isUsableEntry(entry, userId, sessionId)) return null;
      touchMemory(key, entry);
      return entry;
    },

    async get(userId, sessionId) {
      if (userId == null || !sessionId) return null;
      const cached = this.getSync(userId, sessionId);
      if (cached) return cached;
      const db = await openDb();
      if (!db) return null;
      const key = makeKey(userId, sessionId);
      const entry = await new Promise(resolve => {
        try {
          const tx = db.transaction('sessions', 'readonly');
          const req = tx.objectStore('sessions').get(key);
          req.onsuccess = () => resolve(req.result ?? null);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
      if (!isUsableEntry(entry, userId, sessionId)) return null;
      const normalized = trimRecordForCache(entry, { maxEvents, maxBytes });
      const hydrated = { ...normalized, key, userId: String(userId) };
      touchMemory(key, hydrated);
      return hydrated;
    },

    async set(userId, record) {
      if (userId == null || !record?.sessionId || !record.workspaceId || !record.historyEpoch) return null;
      const trimmed = trimRecordForCache({ ...record, updatedAt: Date.now() }, { maxEvents, maxBytes });
      const key = makeKey(userId, record.sessionId);
      const entry = { ...trimmed, key, userId: String(userId) };
      touchMemory(key, entry);
      const db = await openDb();
      if (!db) return entry;
      await new Promise(resolve => {
        try {
          const tx = db.transaction('sessions', 'readwrite');
          tx.objectStore('sessions').put(entry);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
          tx.onabort = () => resolve();
        } catch {
          resolve();
        }
      });
      await pruneDb(db);
      return entry;
    },

    async delete(userId, sessionId) {
      if (userId == null || !sessionId) return;
      const key = makeKey(userId, sessionId);
      memory.delete(key);
      const db = await openDb();
      if (!db) return;
      await new Promise(resolve => {
        try {
          const tx = db.transaction('sessions', 'readwrite');
          tx.objectStore('sessions').delete(key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
          tx.onabort = () => resolve();
        } catch {
          resolve();
        }
      });
    },

    async pruneMissing(userId, validSessionIds) {
      if (userId == null || !(validSessionIds instanceof Set)) return;
      const prefix = `${userId}:`;
      for (const key of [...memory.keys()]) {
        if (key.startsWith(prefix) && !validSessionIds.has(key.slice(prefix.length))) {
          memory.delete(key);
        }
      }
      const db = await openDb();
      if (!db) return;
      await new Promise(resolve => {
        try {
          const tx = db.transaction('sessions', 'readwrite');
          const curReq = tx.objectStore('sessions').openCursor();
          curReq.onsuccess = () => {
            const cursor = curReq.result;
            if (!cursor) return;
            const k = String(cursor.key ?? '');
            if (k.startsWith(prefix) && !validSessionIds.has(k.slice(prefix.length))) {
              cursor.delete();
            }
            cursor.continue();
          };
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
          tx.onabort = () => resolve();
        } catch {
          resolve();
        }
      });
    },

    async clearUser(userId) {
      if (userId == null) return;
      const prefix = `${userId}:`;
      for (const key of [...memory.keys()]) {
        if (key.startsWith(prefix)) memory.delete(key);
      }
      const db = await openDb();
      if (!db) return;
      await new Promise(resolve => {
        try {
          const tx = db.transaction('sessions', 'readwrite');
          const curReq = tx.objectStore('sessions').openCursor();
          curReq.onsuccess = () => {
            const cursor = curReq.result;
            if (!cursor) return;
            if (String(cursor.key ?? '').startsWith(prefix)) cursor.delete();
            cursor.continue();
          };
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
          tx.onabort = () => resolve();
        } catch {
          resolve();
        }
      });
    },

    clearMemory() {
      memory.clear();
    },
  };
}
