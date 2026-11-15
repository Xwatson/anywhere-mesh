import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// No expiry/deletion of operation identities in this prototype. Capacity exhaustion
// rejects new work; it never makes an old identifier executable again.
export class Journal {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS records(bucket TEXT, key TEXT, value TEXT NOT NULL,
        PRIMARY KEY(bucket,key));
      CREATE TABLE IF NOT EXISTS output(operation_id TEXT, seq INTEGER, stream TEXT,
        data TEXT, bytes INTEGER, PRIMARY KEY(operation_id,seq));`);
  }
  get(bucket, key) {
    const row = this.db.prepare('SELECT value FROM records WHERE bucket=? AND key=?').get(bucket, key);
    return row ? JSON.parse(row.value) : undefined;
  }
  put(bucket, key, value) {
    this.db.prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(bucket,key) DO UPDATE SET value=excluded.value')
      .run(bucket, key, JSON.stringify(value));
  }
  all(bucket) { return this.db.prepare('SELECT value FROM records WHERE bucket=? ORDER BY key').all(bucket).map((r) => JSON.parse(r.value)); }
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
    return { firstAvailableSeq: first, truncatedThrough: first - 1, lastSeq,
      rows: this.db.prepare('SELECT seq,stream,data FROM output WHERE operation_id=? AND seq>? ORDER BY seq LIMIT 8').all(operationId, afterSeq) };
  }
  close() { this.db.close(); }
}
