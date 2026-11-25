import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { SessionStore } from '../../session-host/store.mjs';
import {
  createSessionCache,
  decideSyncPlan,
  mergeIncrementalPage,
  mergeOlderPage,
  mergeServerTail,
  trimRecordForCache,
} from '../ui/session-cache.js';

function makeRow(seq, type = 'user_message', extra = {}) {
  if (type === 'user_message') return { seq, ts: seq * 1000, event: { type, text: `msg ${seq}`, ...extra } };
  if (type === 'assistant_text') return { seq, ts: seq * 1000, event: { type, id: `a-${seq}`, text: `reply ${seq}`, ...extra } };
  return { seq, ts: seq * 1000, event: { type, ...extra } };
}

test('decideSyncPlan distinguishes empty, up-to-date, incremental, large-gap tail_merge, and epoch reset', () => {
  const baseTarget = { id: 's1', workspaceId: 'w1', historyEpoch: 'ep1', lastSeq: 10 };
  const local = {
    sessionId: 's1', workspaceId: 'w1', historyEpoch: 'ep1',
    events: [makeRow(1), makeRow(2, 'assistant_text')],
    firstSeq: 1, throughSeq: 2, hasOlder: false,
  };

  assert.deepEqual(decideSyncPlan(null, { ...baseTarget, lastSeq: 0 }), { action: 'empty', invalidateCache: false });
  assert.deepEqual(decideSyncPlan(local, { ...baseTarget, lastSeq: 0 }), { action: 'empty', invalidateCache: true });

  // Exact match
  assert.deepEqual(decideSyncPlan(local, { ...baseTarget, lastSeq: 2 }), { action: 'up_to_date' });

  // Small forward delta -> incremental
  assert.deepEqual(decideSyncPlan(local, { ...baseTarget, lastSeq: 10 }), { action: 'incremental', afterSeq: 2 });

  // Huge forward gap -> tail_merge
  const huge = decideSyncPlan(local, { ...baseTarget, lastSeq: 500 });
  assert.equal(huge.action, 'tail_merge');
  assert.ok(huge.beforeSeq >= 501);

  // Epoch changed -> reset tail
  const reset = decideSyncPlan(local, { ...baseTarget, historyEpoch: 'ep2', lastSeq: 10 });
  assert.equal(reset.action, 'tail');
  assert.equal(reset.reset, true);

  // Server rollback (lastSeq < local.throughSeq) -> reset tail
  const rollback = decideSyncPlan({ ...local, throughSeq: 15, events: [makeRow(1), makeRow(15)] }, { ...baseTarget, lastSeq: 10 });
  assert.equal(rollback.action, 'tail');
  assert.equal(rollback.reset, true);
});

test('mergeServerTail stitches contiguous/overlapping tail without losing older cache, and replaces on disjoint gap or epoch change', () => {
  const local = {
    sessionId: 's1', workspaceId: 'w1', historyEpoch: 'ep1',
    events: [makeRow(1), makeRow(2, 'assistant_text'), makeRow(3), makeRow(4, 'assistant_text')],
    firstSeq: 1, throughSeq: 4, hasOlder: false,
  };

  // Overlapping server tail [3..6] with updated authoritative event 4
  const stitched = mergeServerTail(local, {
    sessionId: 's1', workspaceId: 'w1', historyEpoch: 'ep1',
    events: [makeRow(3), makeRow(4, 'assistant_text', { text: 'server-authoritative 4' }), makeRow(5), makeRow(6, 'assistant_text')],
    firstSeq: 3, throughSeq: 6, hasMore: true,
  });
  assert.equal(stitched.replaced, false);
  assert.deepEqual(stitched.events.map(r => r.seq), [1, 2, 3, 4, 5, 6]);
  assert.equal(stitched.events[3].event.text, 'server-authoritative 4');
  assert.equal(stitched.firstSeq, 1);
  assert.equal(stitched.throughSeq, 6);
  assert.equal(stitched.hasOlder, false);

  // Disjoint gap: local ends at 4, server tail starts at 20 -> must replace cleanly (no silent middle hole!)
  const disjoint = mergeServerTail(local, {
    sessionId: 's1', workspaceId: 'w1', historyEpoch: 'ep1',
    events: [makeRow(20), makeRow(21, 'assistant_text')],
    firstSeq: 20, throughSeq: 21, hasMore: true,
  });
  assert.equal(disjoint.replaced, true);
  assert.deepEqual(disjoint.events.map(r => r.seq), [20, 21]);
  assert.equal(disjoint.firstSeq, 20);
  assert.equal(disjoint.hasOlder, true);

  // Different epoch -> replace cleanly
  const newEpoch = mergeServerTail(local, {
    sessionId: 's1', workspaceId: 'w1', historyEpoch: 'ep2',
    events: [makeRow(1), makeRow(2, 'assistant_text')],
    firstSeq: 1, throughSeq: 2, hasMore: false,
  });
  assert.equal(newEpoch.replaced, true);
  assert.equal(newEpoch.historyEpoch, 'ep2');
  assert.deepEqual(newEpoch.events.map(r => r.seq), [1, 2]);
});

test('mergeIncrementalPage preserves older history on SSE overlap, detects gaps, and flags epoch mismatch', () => {
  const local = {
    sessionId: 's1', workspaceId: 'w1', historyEpoch: 'ep1',
    events: [makeRow(10), makeRow(11, 'assistant_text'), makeRow(12)],
    firstSeq: 10, throughSeq: 12, hasOlder: true,
  };

  // Overlapping SSE replay [11, 12, 13] MUST NOT wipe seq 10!
  const overlap = mergeIncrementalPage(local, {
    sessionId: 's1', workspaceId: 'w1', historyEpoch: 'ep1',
    events: [makeRow(11, 'assistant_text'), makeRow(12), makeRow(13, 'assistant_text')],
    throughSeq: 13,
  });
  assert.equal(overlap.status, 'merged');
  assert.deepEqual(overlap.added.map(r => r.seq), [13]);
  assert.deepEqual(overlap.state.events.map(r => r.seq), [10, 11, 12, 13]);
  assert.equal(overlap.state.firstSeq, 10);
  assert.equal(overlap.state.hasOlder, true);

  // Gap (jumping from 12 to 15) must report gap for catch-up
  const gapped = mergeIncrementalPage(local, {
    sessionId: 's1', workspaceId: 'w1', historyEpoch: 'ep1',
    events: [makeRow(15)],
    throughSeq: 15,
  });
  assert.equal(gapped.status, 'gap');
  assert.equal(gapped.expectedSeq, 13);
  assert.equal(gapped.gotSeq, 15);

  // Epoch mismatch triggers resync
  const mismatch = mergeIncrementalPage(local, {
    sessionId: 's1', workspaceId: 'w1', historyEpoch: 'ep2',
    events: [makeRow(1)],
    throughSeq: 1,
  });
  assert.equal(mismatch.status, 'resync_needed');
});

test('mergeOlderPage prepends older events losslessly and trims cache on user_message boundaries', () => {
  const local = {
    sessionId: 's1', workspaceId: 'w1', historyEpoch: 'ep1',
    events: [makeRow(5), makeRow(6, 'assistant_text')],
    firstSeq: 5, throughSeq: 6, hasOlder: true,
  };
  const prepended = mergeOlderPage(local, {
    sessionId: 's1', workspaceId: 'w1', historyEpoch: 'ep1',
    events: [makeRow(3), makeRow(4, 'assistant_text')],
    firstSeq: 3, throughSeq: 4, hasMore: true,
  });
  assert.equal(prepended.status, 'merged');
  assert.equal(prepended.prependedCount, 2);
  assert.deepEqual(prepended.state.events.map(r => r.seq), [3, 4, 5, 6]);
  assert.equal(prepended.state.firstSeq, 3);
  assert.equal(prepended.state.hasOlder, true);

  // Cache trimming keeps recent tail and aligns on user_message boundary
  const big = {
    sessionId: 's1', workspaceId: 'w1', historyEpoch: 'ep1',
    events: [
      makeRow(1, 'user_message'), makeRow(2, 'assistant_text'),
      makeRow(3, 'user_message'), makeRow(4, 'assistant_text'),
      makeRow(5, 'user_message'), makeRow(6, 'assistant_text'),
    ],
    firstSeq: 1, throughSeq: 6, hasOlder: false,
  };
  const trimmed = trimRecordForCache(big, { maxEvents: 3 });
  assert.deepEqual(trimmed.events.map(r => r.seq), [5, 6]);
  assert.equal(trimmed.firstSeq, 5);
  assert.equal(trimmed.throughSeq, 6);
  assert.equal(trimmed.hasOlder, true);
});

test('createSessionCache isolates users, enforces LRU limit, and prunes deleted sessions', async () => {
  const cache = createSessionCache({ indexedDBImpl: null, maxSessions: 2 });
  await cache.set(1, { sessionId: 's1', workspaceId: 'w1', historyEpoch: 'e1', events: [makeRow(1)], firstSeq: 1, throughSeq: 1 });
  await cache.set(1, { sessionId: 's2', workspaceId: 'w1', historyEpoch: 'e1', events: [makeRow(1)], firstSeq: 1, throughSeq: 1 });
  // Touch s1 so s2 becomes least recently used
  assert.ok(cache.getSync(1, 's1'));
  await cache.set(1, { sessionId: 's3', workspaceId: 'w1', historyEpoch: 'e1', events: [makeRow(1)], firstSeq: 1, throughSeq: 1 });
  assert.equal(cache.getSync(1, 's2'), null);
  assert.ok(cache.getSync(1, 's1'));
  assert.ok(cache.getSync(1, 's3'));

  // Cross-user isolation
  assert.equal(cache.getSync(2, 's1'), null);

  // Prune missing sessions removes s3 while preserving s1
  await cache.pruneMissing(1, new Set(['s1']));
  assert.ok(cache.getSync(1, 's1'));
  assert.equal(cache.getSync(1, 's3'), null);

  await cache.clearUser(1);
  assert.equal(cache.getSync(1, 's1'), null);
});

test('SessionStore.pageBefore includes at least one renderable event even when trailing turn_end follows a large event', t => {
  const dir = mkdtempSync(join(tmpdir(), 'anywhere-renderable-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new SessionStore(join(dir, 'history.sqlite'));
  t.after(() => store.close());

  const wsId = randomUUID();
  const s = store.create({ requestId: randomUUID(), workspaceId: wsId, title: 'Large tail' }, { accountId: '1', deviceId: randomUUID() });
  store.append(s.id, { type: 'user_message', text: 'Analyze this' });
  store.append(s.id, { type: 'assistant_text', id: 'big-0', text: 'x'.repeat(129000) });
  store.append(s.id, { type: 'turn_end', ok: true });

  const latest = store.session(s.id);
  const tail = store.pageBefore(s.id, latest.lastSeq + 1);
  assert.ok(tail.events.some(r => r.event.type === 'assistant_text'), 'Tail page must include a renderable event');
  assert.equal(tail.throughSeq, 3);
});

test('createSessionCache persists to IndexedDB backend and hydrates cold memory after restart', async () => {
  const backing = new Map();
  const fakeIdb = {
    open() {
      const req = {};
      queueMicrotask(() => {
        req.result = {
          objectStoreNames: { contains: () => true },
          transaction() {
            const tx = {};
            const done = () => queueMicrotask(() => tx.oncomplete?.());
            return Object.assign(tx, {
              objectStore() {
                return {
                  get(key) {
                    const r = {};
                    queueMicrotask(() => { r.result = backing.get(key); r.onsuccess?.(); done(); });
                    return r;
                  },
                  put(entry) {
                    backing.set(entry.key, structuredClone(entry));
                    done();
                  },
                  delete(key) {
                    backing.delete(key);
                    done();
                  },
                  count() {
                    const r = {};
                    queueMicrotask(() => { r.result = backing.size; r.onsuccess?.(); done(); });
                    return r;
                  },
                  index() {
                    return { openCursor() { const r = {}; queueMicrotask(() => { r.result = null; r.onsuccess?.(); }); return r; } };
                  },
                  openCursor() {
                    const r = {};
                    queueMicrotask(() => { r.result = null; r.onsuccess?.(); });
                    return r;
                  },
                };
              },
            });
          },
        };
        req.onsuccess?.();
      });
      return req;
    },
  };

  const cache1 = createSessionCache({ indexedDBImpl: fakeIdb });
  await cache1.set(7, { sessionId: 's-persist', workspaceId: 'w1', historyEpoch: 'ep1', events: [makeRow(1), makeRow(2, 'assistant_text')], firstSeq: 1, throughSeq: 2 });

  // Simulate fresh app reload (empty memory, same IndexedDB)
  const cache2 = createSessionCache({ indexedDBImpl: fakeIdb });
  assert.equal(cache2.getSync(7, 's-persist'), null);
  const restored = await cache2.get(7, 's-persist');
  assert.equal(restored?.throughSeq, 2);
  assert.deepEqual(restored?.events.map(r => r.seq), [1, 2]);
  assert.ok(cache2.getSync(7, 's-persist'), 'IndexedDB read should warm in-memory cache');
});
