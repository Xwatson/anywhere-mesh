import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { db } from './auth-db.mjs';
import { authenticate } from './directory.mjs';

const run = promisify(execFile);
async function credential(command, args) {
  try {
    const {stdout} = await run('/opt/anywhere-wan/bin/easytier-cli',
      ['-p','127.0.0.1:15897','-o','json','credential',command,...args],
      {timeout:4500, maxBuffer:16384});
    return JSON.parse(stdout);
  } catch { throw Error('NETWORK_ENROLLMENT_UNAVAILABLE'); }
}

// Keep a lease until its EasyTier credential has been revoked, including across host restarts.
export class NetworkLeases {
  constructor(network, rpc = credential) {
    this.network = network;
    this.rpc = rpc;
    this.issuing = new Map();
    db.exec(`CREATE TABLE IF NOT EXISTS mcp_network_leases (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, slot INTEGER NOT NULL UNIQUE CHECK(slot BETWEEN 4 AND 254)
    )`);
  }
  allocate(token) {
    const hash = createHash('sha256').update(token).digest('hex');
    db.exec('BEGIN IMMEDIATE');
    try {
      const auth = db.prepare('SELECT expires_at FROM auth_sessions WHERE token_hash=?').get(hash);
      const ttl = Math.floor(((auth?.expires_at ?? 0) - Date.now()) / 1000);
      if (ttl < 1) throw Error('LOGIN_REQUIRED');
      let lease = db.prepare('SELECT id,slot FROM mcp_network_leases WHERE token_hash=?').get(hash);
      if (!lease) {
        const used = new Set(db.prepare('SELECT slot FROM mcp_network_leases').all().map(row => row.slot));
        let slot = 4;
        while (used.has(slot)) slot++;
        if (slot > 254) throw Error('NETWORK_ADDRESS_LIMIT');
        lease = {id:randomUUID(), slot};
        db.prepare('INSERT INTO mcp_network_leases(id,token_hash,slot) VALUES(?,?,?)').run(lease.id,hash,slot);
      }
      db.exec('COMMIT');
      return {...lease,ttl,expiresAt:auth.expires_at};
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  async issue(token) {
    const {deviceId} = authenticate(token);
    if (!deviceId) throw Error('FORBIDDEN');
    const {id,slot,ttl,expiresAt} = this.allocate(token);
    let pending = this.issuing.get(id);
    if (!pending) {
      pending = this.rpc('generate',['--credential-id',id,'--ttl',String(ttl),'--reusable','false'])
        .finally(() => this.issuing.delete(id));
      this.issuing.set(id,pending);
    }
    const {credential_id,credential_secret} = await pending;
    authenticate(token);
    if (credential_id !== id || !/^[A-Za-z0-9+/]{43}=$/.test(credential_secret)) throw Error('NETWORK_ENROLLMENT_UNAVAILABLE');
    return {...this.network, expiresAt, ipv4:'10.203.73.'+slot+'/24', credential:credential_secret};
  }
  sweep() {
    if (!this.sweeping) this.sweeping = this.revokeExpired().finally(() => { this.sweeping = null; });
    return this.sweeping;
  }
  async revokeExpired() {
    const rows = db.prepare(`SELECT n.id FROM mcp_network_leases n LEFT JOIN auth_sessions s
      ON n.token_hash=s.token_hash WHERE s.token_hash IS NULL OR s.expires_at<=?`).all(Date.now());
    for (const {id} of rows) {
      if (this.issuing.has(id)) continue;
      // EasyTier's successful revoke command also acknowledges an already absent credential.
      await this.rpc('revoke',[id]);
      db.prepare('DELETE FROM mcp_network_leases WHERE id=?').run(id);
    }
  }
}
