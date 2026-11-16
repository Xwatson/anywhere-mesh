import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { fail } from './protocol.mjs';

// Active records are bounded independently of retained identities. Reads always
// consult the archive; compaction never makes an old call executable again.
export class Journal {
  constructor(path, { maxHistoryBytes = 64 * 1024 * 1024 } = {}) {
    this.path = path; this.maxHistoryBytes = maxHistoryBytes;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS records(bucket TEXT, key TEXT, value TEXT NOT NULL,
        PRIMARY KEY(bucket,key));
      CREATE TABLE IF NOT EXISTS archive_records(bucket TEXT, key TEXT, value TEXT NOT NULL,
        PRIMARY KEY(bucket,key));
      CREATE TABLE IF NOT EXISTS output(operation_id TEXT, seq INTEGER, stream TEXT,
        data TEXT, bytes INTEGER, PRIMARY KEY(operation_id,seq));`);
  }
  get(bucket, key) {
    const row = this.db.prepare('SELECT value FROM records WHERE bucket=? AND key=?').get(bucket, key) ??
      this.db.prepare('SELECT value FROM archive_records WHERE bucket=? AND key=?').get(bucket, key);
    return row ? JSON.parse(row.value) : undefined;
  }
  put(bucket, key, value) {
    const table = this.db.prepare('SELECT 1 FROM archive_records WHERE bucket=? AND key=?').get(bucket, key) ? 'archive_records' : 'records';
    this.db.prepare(`INSERT INTO ${table} VALUES(?,?,?) ON CONFLICT(bucket,key) DO UPDATE SET value=excluded.value`)
      .run(bucket, key, JSON.stringify(value));
  }
  all(bucket) { return this.db.prepare('SELECT value FROM records WHERE bucket=? ORDER BY key').all(bucket).map((r) => JSON.parse(r.value)); }
  entries(bucket) { return this.db.prepare('SELECT key,value FROM records WHERE bucket=? ORDER BY rowid').all(bucket).map(r => ({ key: r.key, value: JSON.parse(r.value) })); }
  archive(bucket, key) {
    // Call inside tx with all related indexes and output removal.
    this.db.prepare('INSERT INTO archive_records SELECT * FROM records WHERE bucket=? AND key=? ON CONFLICT(bucket,key) DO UPDATE SET value=excluded.value').run(bucket, key);
    this.db.prepare('DELETE FROM records WHERE bucket=? AND key=?').run(bucket, key);
  }
  activate(bucket, key) {
    this.db.prepare('INSERT INTO records SELECT * FROM archive_records WHERE bucket=? AND key=? ON CONFLICT(bucket,key) DO UPDATE SET value=excluded.value').run(bucket, key);
    this.db.prepare('DELETE FROM archive_records WHERE bucket=? AND key=?').run(bucket, key);
  }
  dropOutput(operationId) { this.db.prepare('DELETE FROM output WHERE operation_id=?').run(operationId); }
  storage() {
    const activeRecords = Number(this.db.prepare('SELECT COUNT(*) AS n FROM records').get().n);
    const archivedRecords = Number(this.db.prepare('SELECT COUNT(*) AS n FROM archive_records').get().n);
    const databaseBytes = Number(this.db.prepare('PRAGMA page_count').get().page_count) * Number(this.db.prepare('PRAGMA page_size').get().page_size);
    let walBytes = 0; try { walBytes = statSync(`${this.path}-wal`).size; } catch {}
    return { activeRecords, archivedRecords, bytes: databaseBytes + walBytes, maxBytes: this.maxHistoryBytes };
  }
  ensureCapacity(reserveBytes = 262144) {
    if (this.storage().bytes + reserveBytes > this.maxHistoryBytes) fail('HISTORY_STORAGE_FULL');
  }
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  append(operationId, seq, stream, data) {
    const prior = this.db.prepare('SELECT stream,data FROM output WHERE operation_id=? AND seq=?').get(operationId, seq);
    if (prior && (prior.stream !== stream || prior.data !== data)) throw new Error('OUTPUT_CONFLICT');
    this.db.prepare('INSERT OR IGNORE INTO output VALUES(?,?,?,?,?)').run(operationId, seq, stream, data, Buffer.byteLength(data));
  }
  trim(operationId, maxBytes) {
    let total = Number(this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM output WHERE operation_id=?').get(operationId).n);
    for (const row of this.db.prepare('SELECT seq,bytes FROM output WHERE operation_id=? ORDER BY seq').all(operationId)) {
      if (total <= maxBytes) break;
      this.db.prepare('DELETE FROM output WHERE operation_id=? AND seq=?').run(operationId, row.seq);
      total -= row.bytes;
    }
  }
  output(operationId, afterSeq, lastSeq) {
    const first = this.db.prepare('SELECT MIN(seq) AS n FROM output WHERE operation_id=?').get(operationId).n ?? lastSeq + 1;
    const rows = []; let encodedBytes = 0;
    for (const row of this.db.prepare('SELECT seq,stream,data FROM output WHERE operation_id=? AND seq>? ORDER BY seq LIMIT 8').all(operationId, afterSeq)) {
      const size = Buffer.byteLength(JSON.stringify(row));
      if (encodedBytes + size > 16384) break;
      rows.push(row); encodedBytes += size;
    }
    return { firstAvailableSeq: first, truncatedThrough: first - 1, lastSeq,
      rows };
  }
  close() { this.db.close(); }
}
