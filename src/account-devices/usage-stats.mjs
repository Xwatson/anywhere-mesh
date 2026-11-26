import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const VALID_RANGES = new Set(['24h', '7d', '30d', 'all']);
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const RESET_TOLERANCE_MS = 10 * 60 * 1000;

export function rangeSince(range, now = Date.now()) {
  if (range === '24h') return now - DAY_MS;
  if (range === '7d') return now - 7 * DAY_MS;
  if (range === '30d') return now - 30 * DAY_MS;
  if (range === 'all') return 0;
  throw Error('INVALID_FIELDS');
}

export function classifyQuotaGroup(engine, model = '') {
  const eng = String(engine || '').toLowerCase();
  const mod = String(model || '').toLowerCase();
  if (eng === 'codex') {
    if (mod.includes('spark')) return 'codex_spark';
    return 'codex';
  }
  if (eng === 'antigravity') {
    if (/\b(?:claude|opus|sonnet|haiku|gpt|o1|o3|o4)\b|claude|gpt/i.test(mod)) return 'claude_gpt';
    return 'gemini';
  }
  return eng || 'other';
}

export function matchQuotaGroupKey(engine, group) {
  const eng = String(engine || '').toLowerCase();
  const hay = `${group?.id ?? ''} ${group?.name ?? ''}`.toLowerCase();
  if (eng === 'codex') {
    return hay.includes('spark') ? 'codex_spark' : 'codex';
  }
  if (eng === 'antigravity') {
    return /claude|gpt|3p/.test(hay) ? 'claude_gpt' : 'gemini';
  }
  return String(group?.id || eng || 'other');
}

export function inferWindowMinutes(win) {
  const explicit = Number(win?.windowMinutes);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const hay = `${win?.id ?? ''} ${win?.label ?? ''}`.toLowerCase();
  if (/5h|5.?小时|five|short/.test(hay)) return 300;
  if (/24h|24.?小时|1.?天|daily|\b1d\b/.test(hay)) return 1440;
  if (/week|7.?天|7d/.test(hay)) return 10080;
  return 300;
}

export function computeTurnMetrics({ engine, usage, toolCalls, durationMs }) {
  const safeInt = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
  const inputTokens = safeInt(usage?.inputTokens);
  const outputTokens = safeInt(usage?.outputTokens);
  const cachedTokens = safeInt(usage?.cachedInputTokens ?? usage?.cachedReadTokens);
  const toolCallsCount = typeof toolCalls === 'number'
    ? safeInt(toolCalls)
    : safeInt(toolCalls?.total);
  const durationMsVal = safeInt(durationMs);
  const isCodex = String(engine || '').toLowerCase() === 'codex';
  // Codex `inputTokens` includes `cachedInputTokens`; Antigravity reports `cachedReadTokens` separately.
  const uncachedInput = isCodex ? Math.max(0, inputTokens - cachedTokens) : inputTokens;
  const totalTokens = isCodex ? (inputTokens + outputTokens) : (inputTokens + outputTokens + cachedTokens);
  let weightedTokens = uncachedInput + cachedTokens * 0.1 + outputTokens * 4;
  if (weightedTokens <= 0) {
    weightedTokens = Math.max(1000, toolCallsCount * 1500 + Math.round(durationMsVal / 200));
  }
  return {
    inputTokens,
    outputTokens,
    cachedTokens,
    totalTokens,
    weightedTokens,
    toolCalls: toolCallsCount,
    durationMs: durationMsVal,
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

export class UsageTracker {
  constructor(database, { flushIntervalMs = 15000 } = {}) {
    if (!database) throw Error('USAGE_DB_REQUIRED');
    this.db = database;
    this.pendingTraffic = new Map();
    this.activeTurns = new Map();
    this.recentTurns = [];
    this.backfilledUsers = new Set();
    this.startedAt = Date.now();

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS account_traffic_hourly (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        bucket_ts INTEGER NOT NULL,
        http_in INTEGER NOT NULL DEFAULT 0,
        http_out INTEGER NOT NULL DEFAULT 0,
        ws_in INTEGER NOT NULL DEFAULT 0,
        ws_out INTEGER NOT NULL DEFAULT 0,
        requests INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, bucket_ts)
      );
      CREATE INDEX IF NOT EXISTS idx_traffic_hourly_bucket ON account_traffic_hourly(bucket_ts);

      CREATE TABLE IF NOT EXISTS account_ai_turns (
        turn_key TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ts INTEGER NOT NULL,
        engine TEXT NOT NULL,
        model TEXT,
        quota_group TEXT NOT NULL,
        ok INTEGER NOT NULL DEFAULT 1,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cached_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        weighted_tokens REAL NOT NULL DEFAULT 0,
        tool_calls INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_ai_turns_user_ts ON account_ai_turns(user_id, ts);
      CREATE INDEX IF NOT EXISTS idx_ai_turns_engine_ts ON account_ai_turns(engine, quota_group, ts);

      CREATE TABLE IF NOT EXISTS account_quota_attributions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ts INTEGER NOT NULL,
        engine TEXT NOT NULL,
        quota_group TEXT NOT NULL,
        window_id TEXT NOT NULL,
        window_label TEXT NOT NULL,
        resets_at INTEGER NOT NULL,
        delta_percent REAL NOT NULL,
        method TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_quota_attr_window
        ON account_quota_attributions(engine, quota_group, window_id, resets_at);
      CREATE INDEX IF NOT EXISTS idx_quota_attr_user
        ON account_quota_attributions(user_id, ts);

      CREATE TABLE IF NOT EXISTS quota_window_snapshots (
        engine TEXT NOT NULL,
        quota_group TEXT NOT NULL,
        window_id TEXT NOT NULL,
        window_label TEXT NOT NULL,
        window_minutes INTEGER NOT NULL DEFAULT 300,
        used_percent REAL NOT NULL,
        remaining_percent REAL NOT NULL,
        resets_at INTEGER NOT NULL DEFAULT 0,
        first_observed_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (engine, quota_group, window_id)
      );
    `);
    try { this.db.exec('ALTER TABLE quota_window_snapshots ADD COLUMN first_observed_at INTEGER NOT NULL DEFAULT 0'); } catch {}

    this.upsertTrafficStmt = this.db.prepare(`
      INSERT INTO account_traffic_hourly(user_id, bucket_ts, http_in, http_out, ws_in, ws_out, requests)
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(user_id, bucket_ts) DO UPDATE SET
        http_in = http_in + excluded.http_in,
        http_out = http_out + excluded.http_out,
        ws_in = ws_in + excluded.ws_in,
        ws_out = ws_out + excluded.ws_out,
        requests = requests + excluded.requests
    `);
    this.insertTurnStmt = this.db.prepare(`
      INSERT OR IGNORE INTO account_ai_turns(
        turn_key, user_id, ts, engine, model, quota_group, ok,
        input_tokens, output_tokens, cached_tokens, total_tokens, weighted_tokens, tool_calls, duration_ms
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    this.insertQuotaAttrStmt = this.db.prepare(`
      INSERT INTO account_quota_attributions(
        user_id, ts, engine, quota_group, window_id, window_label, resets_at, delta_percent, method
      ) VALUES(?,?,?,?,?,?,?,?,?)
    `);
    this.getSnapshotStmt = this.db.prepare(`
      SELECT engine, quota_group, window_id, window_label, window_minutes,
             used_percent, remaining_percent, resets_at, first_observed_at, updated_at
      FROM quota_window_snapshots
      WHERE engine=? AND quota_group=? AND window_id=?
    `);
    this.upsertSnapshotStmt = this.db.prepare(`
      INSERT INTO quota_window_snapshots(
        engine, quota_group, window_id, window_label, window_minutes,
        used_percent, remaining_percent, resets_at, first_observed_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(engine, quota_group, window_id) DO UPDATE SET
        window_label = excluded.window_label,
        window_minutes = excluded.window_minutes,
        used_percent = excluded.used_percent,
        remaining_percent = excluded.remaining_percent,
        resets_at = excluded.resets_at,
        first_observed_at = excluded.first_observed_at,
        updated_at = excluded.updated_at
    `);

    this.flushTimer = flushIntervalMs > 0
      ? setInterval(() => { try { this.flushTraffic(); } catch {} }, flushIntervalMs)
      : null;
    this.flushTimer?.unref?.();
  }

  recordTraffic(userId, delta, ts = Date.now()) {
    const uid = Number(userId);
    if (!Number.isSafeInteger(uid) || uid < 1 || !delta) return;
    const httpIn = delta.httpIn > 0 ? Math.round(delta.httpIn) : 0;
    const httpOut = delta.httpOut > 0 ? Math.round(delta.httpOut) : 0;
    const wsIn = delta.wsIn > 0 ? Math.round(delta.wsIn) : 0;
    const wsOut = delta.wsOut > 0 ? Math.round(delta.wsOut) : 0;
    const requests = delta.requests > 0 ? Math.round(delta.requests) : 0;
    if (!(httpIn || httpOut || wsIn || wsOut || requests)) return;
    const bucketTs = Math.floor(ts / HOUR_MS) * HOUR_MS;
    const key = `${uid}:${bucketTs}`;
    let cur = this.pendingTraffic.get(key);
    if (!cur) {
      cur = { userId: uid, bucketTs, httpIn: 0, httpOut: 0, wsIn: 0, wsOut: 0, requests: 0 };
      this.pendingTraffic.set(key, cur);
    }
    cur.httpIn += httpIn;
    cur.httpOut += httpOut;
    cur.wsIn += wsIn;
    cur.wsOut += wsOut;
    cur.requests += requests;
  }

  flushTraffic() {
    if (!this.pendingTraffic.size) return;
    const entries = [...this.pendingTraffic.values()];
    this.pendingTraffic.clear();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const e of entries) {
        try {
          this.upsertTrafficStmt.run(e.userId, e.bucketTs, e.httpIn, e.httpOut, e.wsIn, e.wsOut, e.requests);
        } catch {}
      }
      this.db.exec('COMMIT');
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw err;
    }
  }

  recordTurnStart(userId, { turnId, engine, model = null, startedAt = Date.now() }) {
    const uid = Number(userId);
    if (!Number.isSafeInteger(uid) || uid < 1 || !turnId) return;
    const eng = String(engine || '').toLowerCase();
    if (eng !== 'codex' && eng !== 'antigravity') return;
    this.activeTurns.set(turnId, {
      userId: uid,
      engine: eng,
      model,
      quotaGroup: classifyQuotaGroup(eng, model),
      startedAt,
    });
  }

  recordTurnEnd(userId, { turnId, sessionId = '', seq = 0, engine, model = null, ok = true, usage = null, toolCalls = null, durationMs = 0, ts = Date.now() }) {
    const uid = Number(userId);
    const active = turnId ? this.activeTurns.get(turnId) : null;
    if (turnId) this.activeTurns.delete(turnId);
    if (!Number.isSafeInteger(uid) || uid < 1) return;
    const eng = String(engine || active?.engine || '').toLowerCase();
    if (eng !== 'codex' && eng !== 'antigravity') return;
    const resolvedModel = model ?? active?.model ?? null;
    const quotaGroup = classifyQuotaGroup(eng, resolvedModel);
    const metrics = computeTurnMetrics({ engine: eng, usage, toolCalls, durationMs });
    const turnKey = turnId ? `turn:${uid}:${turnId}` : `hist:${uid}:${sessionId}:${seq}`;
    try {
      this.insertTurnStmt.run(
        turnKey,
        uid,
        Math.round(ts),
        eng,
        resolvedModel,
        quotaGroup,
        ok ? 1 : 0,
        metrics.inputTokens,
        metrics.outputTokens,
        metrics.cachedTokens,
        metrics.totalTokens,
        metrics.weightedTokens,
        metrics.toolCalls,
        metrics.durationMs,
      );
    } catch {}
    const startedAt = active?.startedAt ?? Math.max(0, ts - metrics.durationMs);
    this.recentTurns.push({
      userId: uid,
      engine: eng,
      quotaGroup,
      startedAt,
      endedAt: ts,
      weightedTokens: metrics.weightedTokens,
    });
    const cutoff = ts - 2 * HOUR_MS;
    if (this.recentTurns.length > 500) {
      this.recentTurns = this.recentTurns.filter(r => r.endedAt >= cutoff);
    }
  }

  backfillUserHistory(userId, historyDb) {
    const uid = Number(userId);
    if (!Number.isSafeInteger(uid) || uid < 1 || this.backfilledUsers.has(uid) || !historyDb) return 0;
    let rows;
    try {
      rows = historyDb.prepare(
        "SELECT session_id, seq, ts, event FROM chat_events WHERE json_extract(event, '$.type') = 'turn_end'",
      ).all();
    } catch {
      this.backfilledUsers.add(uid);
      return 0;
    }
    let inserted = 0;
    if (rows.length) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of rows) {
          let ev;
          try { ev = JSON.parse(row.event); } catch { continue; }
          const eng = String(ev?.engine || '').toLowerCase();
          if (eng !== 'codex' && eng !== 'antigravity') continue;
          const model = typeof ev.model === 'string' ? ev.model : null;
          const quotaGroup = classifyQuotaGroup(eng, model);
          const metrics = computeTurnMetrics({
            engine: eng,
            usage: ev.usage,
            toolCalls: ev.toolCalls,
            durationMs: ev.durationMs,
          });
          const turnKey = ev.turnId ? `turn:${uid}:${ev.turnId}` : `hist:${uid}:${row.session_id}:${row.seq}`;
          try {
            const res = this.insertTurnStmt.run(
              turnKey,
              uid,
              Number(row.ts || 0),
              eng,
              model,
              quotaGroup,
              ev.ok === false ? 0 : 1,
              metrics.inputTokens,
              metrics.outputTokens,
              metrics.cachedTokens,
              metrics.totalTokens,
              metrics.weightedTokens,
              metrics.toolCalls,
              metrics.durationMs,
            );
            if (res.changes > 0) inserted++;
          } catch {}
        }
        this.db.exec('COMMIT');
      } catch (err) {
        try { this.db.exec('ROLLBACK'); } catch {}
        throw err;
      }
    }
    this.backfilledUsers.add(uid);
    return inserted;
  }

  backfillFromStateDir(stateDir, userIds, getOpenDb = null) {
    if (!stateDir || !Array.isArray(userIds)) return 0;
    let total = 0;
    for (const uid of userIds) {
      if (this.backfilledUsers.has(uid)) continue;
      const openDb = typeof getOpenDb === 'function' ? getOpenDb(uid) : null;
      if (openDb) {
        total += this.backfillUserHistory(uid, openDb);
        continue;
      }
      const file = join(stateDir, 'u' + uid, 'history.sqlite');
      if (!existsSync(file)) {
        this.backfilledUsers.add(uid);
        continue;
      }
      let hdb = null;
      try {
        hdb = new DatabaseSync(file, { readOnly: true });
        total += this.backfillUserHistory(uid, hdb);
      } catch {
        this.backfilledUsers.add(uid);
      } finally {
        try { hdb?.close(); } catch {}
      }
    }
    return total;
  }

  collectIntervalWeights(engine, quotaGroup, fromTs, toTs) {
    const weights = new Map();
    const add = (uid, w) => {
      if (!Number.isSafeInteger(uid) || uid < 1) return;
      weights.set(uid, (weights.get(uid) ?? 0) + Math.max(1, w));
    };
    for (const r of this.recentTurns) {
      if (r.engine === engine && r.quotaGroup === quotaGroup && r.endedAt >= fromTs && r.startedAt <= toTs) {
        add(r.userId, r.weightedTokens);
      }
    }
    for (const a of this.activeTurns.values()) {
      if (a.engine === engine && a.quotaGroup === quotaGroup && a.startedAt <= toTs) {
        add(a.userId, 5000);
      }
    }
    if (!weights.size) {
      const dbRows = this.db.prepare(`
        SELECT user_id AS userId, SUM(weighted_tokens) AS weight
        FROM account_ai_turns
        WHERE engine = ? AND quota_group = ? AND ts >= ? AND ts <= ?
        GROUP BY user_id
      `).all(engine, quotaGroup, Math.round(fromTs), Math.round(toTs));
      for (const r of dbRows) add(Number(r.userId), Number(r.weight || 0));
    }
    return weights;
  }

  observeQuotaSnapshot(engineQuota, now = Date.now()) {
    if (!engineQuota || engineQuota.status !== 'ok' || !Array.isArray(engineQuota.groups)) return;
    const engine = String(engineQuota.engine || '').toLowerCase();
    if (engine !== 'codex' && engine !== 'antigravity') return;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const group of engineQuota.groups) {
        const groupKey = matchQuotaGroupKey(engine, group);
        for (const win of group.windows ?? []) {
          const usedExact = typeof win.usedPercentExact === 'number' && Number.isFinite(win.usedPercentExact)
            ? round4(Math.max(0, Math.min(100, win.usedPercentExact)))
            : round4(Math.max(0, Math.min(100, Number(win.usedPercent ?? 0))));
          const remExact = typeof win.remainingPercentExact === 'number' && Number.isFinite(win.remainingPercentExact)
            ? round4(Math.max(0, Math.min(100, win.remainingPercentExact)))
            : round4(Math.max(0, Math.min(100, 100 - usedExact)));
          const resetsAt = Number.isFinite(Number(win.resetsAt)) && Number(win.resetsAt) > 0 ? Math.round(Number(win.resetsAt)) : 0;
          const windowMinutes = inferWindowMinutes(win);
          const windowId = String(win.id || `${groupKey}:${windowMinutes}`);
          const windowLabel = String(win.label || '额度窗口');

          const prev = this.getSnapshotStmt.get(engine, groupKey, windowId);
          const sameWindow = Boolean(
            prev && (
              (resetsAt > 0 && Number(prev.resets_at) > 0 && Math.abs(resetsAt - Number(prev.resets_at)) < RESET_TOLERANCE_MS) ||
              (resetsAt === 0 && Number(prev.resets_at) === 0)
            ),
          );
          const notReset = Boolean(prev && usedExact >= Number(prev.used_percent) - 0.5);

          let delta = 0;
          let intervalFrom = 0;
          if (sameWindow && notReset) {
            delta = round4(usedExact - Number(prev.used_percent));
            intervalFrom = Number(prev.updated_at) - 5000;
          } else if (prev && usedExact > 0.0005) {
            // Window rolled over: attribute any new consumption since window start.
            const winStart = resetsAt > 0 ? (resetsAt - windowMinutes * 60000) : (now - windowMinutes * 60000);
            delta = usedExact;
            intervalFrom = Math.max(Number(prev.updated_at) - 5000, winStart);
          }

          if (delta > 0.0005) {
            const weights = this.collectIntervalWeights(engine, groupKey, intervalFrom, now);
            if (weights.size === 1) {
              const [[uid]] = [...weights.entries()];
              try {
                this.insertQuotaAttrStmt.run(uid, Math.round(now), engine, groupKey, windowId, windowLabel, resetsAt, delta, 'measured');
              } catch {}
            } else if (weights.size > 1) {
              let totalWeight = 0;
              for (const w of weights.values()) totalWeight += w;
              for (const [uid, w] of weights.entries()) {
                const share = round4(delta * (w / totalWeight));
                if (share <= 0) continue;
                try {
                  this.insertQuotaAttrStmt.run(uid, Math.round(now), engine, groupKey, windowId, windowLabel, resetsAt, share, 'split');
                } catch {}
              }
            }
          }

          const firstObservedAt = (sameWindow && notReset && prev)
            ? (Number(prev.first_observed_at) > 0 ? Number(prev.first_observed_at) : Number(prev.updated_at || now))
            : Math.round(now);
          this.upsertSnapshotStmt.run(
            engine,
            groupKey,
            windowId,
            windowLabel,
            windowMinutes,
            usedExact,
            remExact,
            resetsAt,
            firstObservedAt,
            Math.round(now),
          );
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw err;
    }
  }

  buildQuotaWindows(quotaSnapshot) {
    const windows = [];
    const seen = new Set();
    if (quotaSnapshot && Array.isArray(quotaSnapshot.engines)) {
      for (const eng of quotaSnapshot.engines) {
        if (eng?.status !== 'ok' || !Array.isArray(eng.groups)) continue;
        const engine = String(eng.engine || '').toLowerCase();
        const engineLabel = eng.label || (engine === 'codex' ? 'Codex' : engine === 'antigravity' ? 'Antigravity' : engine);
        for (const group of eng.groups) {
          const groupKey = matchQuotaGroupKey(engine, group);
          const groupName = group.name || engineLabel;
          for (const win of group.windows ?? []) {
            const windowId = String(win.id || `${groupKey}:${inferWindowMinutes(win)}`);
            const key = `${engine}:${groupKey}:${windowId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const usedExact = typeof win.usedPercentExact === 'number' && Number.isFinite(win.usedPercentExact)
              ? win.usedPercentExact
              : Number(win.usedPercent ?? 0);
            const remExact = typeof win.remainingPercentExact === 'number' && Number.isFinite(win.remainingPercentExact)
              ? win.remainingPercentExact
              : Math.max(0, 100 - usedExact);
            windows.push({
              engine,
              engineLabel,
              groupKey,
              groupName,
              windowId,
              windowLabel: String(win.label || '额度窗口'),
              windowMinutes: inferWindowMinutes(win),
              usedPercent: round1(usedExact),
              usedPercentExact: round4(usedExact),
              remainingPercent: round1(remExact),
              resetsAt: Number(win.resetsAt || 0) || null,
              updatedAt: quotaSnapshot.fetchedAt || Date.now(),
            });
          }
        }
      }
    }
    if (!windows.length) {
      const snaps = this.db.prepare(`
        SELECT engine, quota_group, window_id, window_label, window_minutes,
               used_percent, remaining_percent, resets_at, updated_at
        FROM quota_window_snapshots
        ORDER BY engine ASC, quota_group ASC, window_minutes ASC
      `).all();
      for (const s of snaps) {
        const engine = s.engine;
        const engineLabel = engine === 'codex' ? 'Codex' : engine === 'antigravity' ? 'Antigravity' : engine;
        const groupName = s.quota_group === 'gemini' ? 'Gemini 模型'
          : s.quota_group === 'claude_gpt' ? 'Claude / GPT 模型'
          : s.quota_group === 'codex_spark' ? 'Codex Spark'
          : 'Codex 通用额度';
        windows.push({
          engine,
          engineLabel,
          groupKey: s.quota_group,
          groupName,
          windowId: s.window_id,
          windowLabel: s.window_label,
          windowMinutes: Number(s.window_minutes || 300),
          usedPercent: round1(Number(s.used_percent || 0)),
          usedPercentExact: round4(Number(s.used_percent || 0)),
          remainingPercent: round1(Number(s.remaining_percent || 0)),
          resetsAt: Number(s.resets_at || 0) || null,
          updatedAt: Number(s.updated_at || 0) || null,
        });
      }
    }
    return windows;
  }

  summary({ users, onlineByUser = new Map(), range = '7d', quotaSnapshot = null, now = Date.now() }) {
    if (!VALID_RANGES.has(range)) throw Error('INVALID_FIELDS');
    this.flushTraffic();
    const sinceTs = rangeSince(range, now);
    const sinceBucketTs = sinceTs > 0 ? Math.floor(sinceTs / HOUR_MS) * HOUR_MS : 0;

    // 1. Traffic aggregation
    const trafficRows = this.db.prepare(`
      SELECT user_id AS userId,
        SUM(http_in) AS httpIn, SUM(http_out) AS httpOut,
        SUM(ws_in) AS wsIn, SUM(ws_out) AS wsOut,
        SUM(requests) AS requests
      FROM account_traffic_hourly
      WHERE bucket_ts >= ?
      GROUP BY user_id
    `).all(sinceBucketTs);
    const trafficMap = new Map();
    const trafficTotals = { httpIn: 0, httpOut: 0, wsIn: 0, wsOut: 0, bytesIn: 0, bytesOut: 0, totalBytes: 0, requests: 0 };
    for (const r of trafficRows) {
      const uid = Number(r.userId);
      const httpIn = Number(r.httpIn || 0);
      const httpOut = Number(r.httpOut || 0);
      const wsIn = Number(r.wsIn || 0);
      const wsOut = Number(r.wsOut || 0);
      const bytesIn = httpIn + wsIn;
      const bytesOut = httpOut + wsOut;
      const totalBytes = bytesIn + bytesOut;
      const requests = Number(r.requests || 0);
      trafficMap.set(uid, { httpIn, httpOut, wsIn, wsOut, bytesIn, bytesOut, totalBytes, requests });
      trafficTotals.httpIn += httpIn;
      trafficTotals.httpOut += httpOut;
      trafficTotals.wsIn += wsIn;
      trafficTotals.wsOut += wsOut;
      trafficTotals.bytesIn += bytesIn;
      trafficTotals.bytesOut += bytesOut;
      trafficTotals.totalBytes += totalBytes;
      trafficTotals.requests += requests;
    }

    // 2. AI usage aggregation for selected range
    const aiRows = this.db.prepare(`
      SELECT user_id AS userId,
        COUNT(*) AS turns,
        SUM(CASE WHEN engine = 'codex' THEN 1 ELSE 0 END) AS codexTurns,
        SUM(CASE WHEN engine = 'antigravity' THEN 1 ELSE 0 END) AS antigravityTurns,
        SUM(tool_calls) AS toolCalls,
        SUM(input_tokens) AS inputTokens,
        SUM(output_tokens) AS outputTokens,
        SUM(cached_tokens) AS cachedTokens,
        SUM(total_tokens) AS totalTokens,
        SUM(weighted_tokens) AS weightedTokens,
        MAX(ts) AS lastTurnAt
      FROM account_ai_turns
      WHERE ts >= ?
      GROUP BY user_id
    `).all(sinceTs);
    const aiMap = new Map();
    const aiTotals = {
      turns: 0, codexTurns: 0, antigravityTurns: 0, toolCalls: 0,
      inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, weightedTokens: 0,
    };
    for (const r of aiRows) {
      const uid = Number(r.userId);
      const entry = {
        turns: Number(r.turns || 0),
        codexTurns: Number(r.codexTurns || 0),
        antigravityTurns: Number(r.antigravityTurns || 0),
        toolCalls: Number(r.toolCalls || 0),
        inputTokens: Number(r.inputTokens || 0),
        outputTokens: Number(r.outputTokens || 0),
        cachedTokens: Number(r.cachedTokens || 0),
        totalTokens: Number(r.totalTokens || 0),
        weightedTokens: Number(r.weightedTokens || 0),
        lastTurnAt: r.lastTurnAt ? Number(r.lastTurnAt) : null,
      };
      aiMap.set(uid, entry);
      aiTotals.turns += entry.turns;
      aiTotals.codexTurns += entry.codexTurns;
      aiTotals.antigravityTurns += entry.antigravityTurns;
      aiTotals.toolCalls += entry.toolCalls;
      aiTotals.inputTokens += entry.inputTokens;
      aiTotals.outputTokens += entry.outputTokens;
      aiTotals.cachedTokens += entry.cachedTokens;
      aiTotals.totalTokens += entry.totalTokens;
      aiTotals.weightedTokens += entry.weightedTokens;
    }

    // 3. Quota pool attribution per active window
    const quotaWindows = this.buildQuotaWindows(quotaSnapshot);
    const userQuotaMap = new Map();
    for (const u of users) userQuotaMap.set(u.id, []);

    for (const win of quotaWindows) {
      const windowMs = win.windowMinutes * 60000;
      const windowStart = win.resetsAt ? (win.resetsAt - windowMs) : (now - windowMs);
      const poolUsed = win.usedPercentExact;

      const attrRows = win.resetsAt
        ? this.db.prepare(`
            SELECT user_id AS userId, SUM(delta_percent) AS deltaSum, MIN(ts) AS firstTs
            FROM account_quota_attributions
            WHERE engine = ? AND quota_group = ? AND window_id = ?
              AND ABS(resets_at - ?) < ?
            GROUP BY user_id
          `).all(win.engine, win.groupKey, win.windowId, win.resetsAt, RESET_TOLERANCE_MS)
        : this.db.prepare(`
            SELECT user_id AS userId, SUM(delta_percent) AS deltaSum, MIN(ts) AS firstTs
            FROM account_quota_attributions
            WHERE engine = ? AND quota_group = ? AND window_id = ? AND ts >= ?
            GROUP BY user_id
          `).all(win.engine, win.groupKey, win.windowId, Math.round(windowStart));

      const measuredByUser = new Map();
      let measuredSum = 0;
      let firstAttrTs = Infinity;
      for (const r of attrRows) {
        const uid = Number(r.userId);
        const val = Math.max(0, Number(r.deltaSum || 0));
        measuredByUser.set(uid, val);
        measuredSum += val;
        if (Number(r.firstTs) < firstAttrTs) firstAttrTs = Number(r.firstTs);
      }

      const turnWinRows = this.db.prepare(`
        SELECT user_id AS userId,
          SUM(weighted_tokens) AS weight,
          COUNT(*) AS turns,
          MIN(ts) AS firstTs
        FROM account_ai_turns
        WHERE engine = ? AND quota_group = ? AND ts >= ? AND ts <= ?
        GROUP BY user_id
      `).all(win.engine, win.groupKey, Math.round(windowStart), Math.round(now));

      const winWeightByUser = new Map();
      const winTurnsByUser = new Map();
      let totalWinWeight = 0;
      let earliestTurnTs = Infinity;
      for (const r of turnWinRows) {
        const uid = Number(r.userId);
        const w = Math.max(0, Number(r.weight || 0));
        winWeightByUser.set(uid, w);
        winTurnsByUser.set(uid, Number(r.turns || 0));
        totalWinWeight += w;
        if (Number(r.firstTs) < earliestTurnTs) earliestTurnTs = Number(r.firstTs);
      }

      const snap = this.getSnapshotStmt.get(win.engine, win.groupKey, win.windowId);
      const snapSameWin = Boolean(
        snap && (
          (win.resetsAt && Number(snap.resets_at) > 0 && Math.abs(win.resetsAt - Number(snap.resets_at)) < RESET_TOLERANCE_MS) ||
          (!win.resetsAt && Number(snap.resets_at) === 0)
        ),
      );
      const trackingCutoffTs = snapSameWin && Number(snap.first_observed_at) > 0 ? Number(snap.first_observed_at) : firstAttrTs;
      const hasPreTrackingTurns = earliestTurnTs < trackingCutoffTs;
      const consumedByUser = new Map();
      const sourceByUser = new Map();

      if (!hasPreTrackingTurns && measuredSum > 0) {
        const scale = measuredSum > poolUsed && poolUsed > 0 ? (poolUsed / measuredSum) : 1;
        for (const [uid, val] of measuredByUser.entries()) {
          consumedByUser.set(uid, val * scale);
          sourceByUser.set(uid, 'measured');
        }
      } else if (poolUsed > 0 && totalWinWeight > 0) {
        if (measuredSum > 0 && measuredSum < poolUsed) {
          // Credit directly measured deltas, apportion remaining unmeasured pool across pre-tracking turns.
          const preRows = this.db.prepare(`
            SELECT user_id AS userId, SUM(weighted_tokens) AS weight
            FROM account_ai_turns
            WHERE engine = ? AND quota_group = ? AND ts >= ? AND ts < ?
            GROUP BY user_id
          `).all(win.engine, win.groupKey, Math.round(windowStart), Math.round(trackingCutoffTs));
          let preWeightTotal = 0;
          const preWeightByUser = new Map();
          for (const r of preRows) {
            const w = Math.max(0, Number(r.weight || 0));
            preWeightByUser.set(Number(r.userId), w);
            preWeightTotal += w;
          }
          const remPool = Math.max(0, poolUsed - measuredSum);
          const denom = preWeightTotal > 0 ? preWeightTotal : totalWinWeight;
          const weightSrc = preWeightTotal > 0 ? preWeightByUser : winWeightByUser;
          for (const u of users) {
            const m = measuredByUser.get(u.id) ?? 0;
            const est = denom > 0 ? remPool * ((weightSrc.get(u.id) ?? 0) / denom) : 0;
            const total = m + est;
            if (total > 0.0005) {
              consumedByUser.set(u.id, total);
              sourceByUser.set(u.id, est > 0.0005 ? 'estimated' : 'measured');
            }
          }
        } else if (measuredSum >= poolUsed && measuredSum > 0) {
          const scale = poolUsed / measuredSum;
          for (const [uid, val] of measuredByUser.entries()) {
            consumedByUser.set(uid, val * scale);
            sourceByUser.set(uid, 'measured');
          }
        } else {
          for (const [uid, w] of winWeightByUser.entries()) {
            const share = w / totalWinWeight;
            const consumed = poolUsed * share;
            if (consumed > 0.0005) {
              consumedByUser.set(uid, consumed);
              sourceByUser.set(uid, 'estimated');
            }
          }
        }
      }

      for (const u of users) {
        const consumed = consumedByUser.get(u.id) ?? 0;
        const turnsInWindow = winTurnsByUser.get(u.id) ?? 0;
        if (consumed <= 0.0005 && turnsInWindow === 0) continue;
        const consumedPct = round1(Math.min(100, consumed));
        const shareOfUsedPct = poolUsed > 0
          ? round1(Math.min(100, (consumed / poolUsed) * 100))
          : 0;
        userQuotaMap.get(u.id).push({
          engine: win.engine,
          engineLabel: win.engineLabel,
          groupKey: win.groupKey,
          groupName: win.groupName,
          windowId: win.windowId,
          windowLabel: win.windowLabel,
          windowMinutes: win.windowMinutes,
          consumedPercent: consumedPct,
          consumedPercentExact: round2(Math.min(100, consumed)),
          shareOfUsedPercent: shareOfUsedPct,
          poolUsedPercent: win.usedPercent,
          poolRemainingPercent: win.remainingPercent,
          resetsAt: win.resetsAt,
          turns: turnsInWindow,
          source: sourceByUser.get(u.id) ?? 'estimated',
        });
      }
    }

    const earliestTraffic = this.db.prepare('SELECT MIN(bucket_ts) AS ts FROM account_traffic_hourly').get()?.ts;
    const trackingSince = earliestTraffic ? Number(earliestTraffic) : this.startedAt;

    const accounts = users.map(u => {
      const tr = trafficMap.get(u.id) ?? {
        httpIn: 0, httpOut: 0, wsIn: 0, wsOut: 0, bytesIn: 0, bytesOut: 0, totalBytes: 0, requests: 0,
      };
      const ai = aiMap.get(u.id) ?? {
        turns: 0, codexTurns: 0, antigravityTurns: 0, toolCalls: 0,
        inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, weightedTokens: 0, lastTurnAt: null,
      };
      const trafficShare = trafficTotals.totalBytes > 0
        ? round1((tr.totalBytes / trafficTotals.totalBytes) * 100)
        : 0;
      const aiShare = aiTotals.weightedTokens > 0
        ? round1((ai.weightedTokens / aiTotals.weightedTokens) * 100)
        : 0;
      const quotaEntries = (userQuotaMap.get(u.id) ?? []).sort((a, b) =>
        b.consumedPercentExact - a.consumedPercentExact || a.windowMinutes - b.windowMinutes,
      );
      return {
        id: u.id,
        username: u.username,
        isAdmin: Boolean(u.isAdmin),
        deviceCount: Number(u.deviceCount ?? 0),
        onlineDevices: Number(onlineByUser.get(u.id) ?? 0),
        lastLoginAt: u.lastLoginAt ?? null,
        traffic: {
          ...tr,
          sharePercent: trafficShare,
        },
        ai: {
          turns: ai.turns,
          codexTurns: ai.codexTurns,
          antigravityTurns: ai.antigravityTurns,
          toolCalls: ai.toolCalls,
          inputTokens: ai.inputTokens,
          outputTokens: ai.outputTokens,
          cachedTokens: ai.cachedTokens,
          totalTokens: ai.totalTokens,
          sharePercent: aiShare,
          lastTurnAt: ai.lastTurnAt,
        },
        quota: quotaEntries,
      };
    });

    accounts.sort((a, b) =>
      b.ai.totalTokens - a.ai.totalTokens ||
      b.traffic.totalBytes - a.traffic.totalBytes ||
      b.ai.turns - a.ai.turns ||
      Number(b.isAdmin) - Number(a.isAdmin) ||
      a.id - b.id,
    );

    return {
      range,
      sinceTs,
      generatedAt: now,
      trackingSince,
      quotaFetchedAt: quotaSnapshot?.fetchedAt ?? null,
      quotaPools: quotaWindows,
      totals: {
        traffic: trafficTotals,
        ai: {
          turns: aiTotals.turns,
          codexTurns: aiTotals.codexTurns,
          antigravityTurns: aiTotals.antigravityTurns,
          toolCalls: aiTotals.toolCalls,
          inputTokens: aiTotals.inputTokens,
          outputTokens: aiTotals.outputTokens,
          cachedTokens: aiTotals.cachedTokens,
          totalTokens: aiTotals.totalTokens,
        },
      },
      accounts,
    };
  }

  close() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    try { this.flushTraffic(); } catch {}
  }
}
