import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const deviceId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const token = /^[A-Za-z0-9_-]{43}$/;

// Linux desktop profiles belong to a dedicated service account. Windows additionally
// protects each record with current-user DPAPI before any bytes reach the filesystem.
export function rememberedLogin(stateDir, installation, service, protection) {
  if (process.platform === 'win32' && !protection) throw Error('LOGIN_PROTECTION_REQUIRED');
  const file = join(stateDir, protection ? 'login.dpapi' : 'login.json');
  const binding = createHash('sha256').update(JSON.stringify([service,installation])).digest('hex');
  function clear() { rmSync(file, {force:true}); }
  function valid(record) {
    return record?.version === 1 && record.binding === binding &&
      typeof record.token === 'string' && token.test(record.token) &&
      typeof record.deviceId === 'string' && deviceId.test(record.deviceId) &&
      Number.isSafeInteger(record.userId) && record.userId > 0;
  }
  return {
    clear,
    load() {
      let bytes;
      try { bytes = readFileSync(file); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      let record;
      if (bytes.length <= 16384) {
        const plain = protection ? protection.open(bytes) : bytes;
        try { if (plain) record = JSON.parse(plain.toString('utf8')); } catch {}
      }
      if (valid(record)) return record;
      clear();
      return null;
    },
    save(signed) {
      const record = {version:1, binding, deviceId:signed.deviceId, userId:signed.user.id, token:signed.token};
      if (!valid(record)) throw Error('INVALID_DEVICE_LOGIN');
      const plain = Buffer.from(JSON.stringify(record));
      const bytes = protection ? protection.seal(plain) : plain;
      const temporary = file + '.' + randomUUID();
      try {
        writeFileSync(temporary, bytes, {flag:'wx',mode:0o600,flush:true});
        renameSync(temporary,file);
      } finally { rmSync(temporary,{force:true}); }
      return record;
    }
  };
}
