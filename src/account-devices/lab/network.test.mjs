import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sessionConfig } from '../windows/network.mjs';

test('only active native logins receive separate, revocable network leases', async () => {
  const dir = mkdtempSync(join(tmpdir(),'anywhere-network-'));
  process.env.DATA_DIR = dir;
  const {NetworkLeases} = await import('../network-leases.mjs');
  const directory = await import('../directory.mjs');
  const {createUser} = await import('../auth.mjs');
  const {db} = await import('../auth-db.mjs');
  try {
    const username = 'member', password = 'test password';
    createUser(username,password,false);
    const installation = () => randomBytes(32).toString('hex');
    const login = id => directory.login({username,password,...(id ? {installation:id,name:'Test',projects:[]} : {})},'test');
    const keys = new Map();
    let calls = 0;
    const rpc = async (command,args) => {
      if (command==='revoke') return {success:keys.delete(args[0])};
      const id = args[1];
      assert.deepEqual(args.slice(-2),['--reusable','false']);
      calls++;
      if (!keys.has(id)) keys.set(id,randomBytes(32).toString('base64'));
      return {credential_id:id,credential_secret:keys.get(id)};
    };
    const network = new NetworkLeases({name:'test-net',serverKey:randomBytes(32).toString('base64')},rpc);
    const id = installation(), a = login(id), b = login(installation());
    await assert.rejects(network.issue('unknown'),/LOGIN_REQUIRED/);
    await assert.rejects(network.issue(login().token),/FORBIDDEN/);
    const [first,retry] = await Promise.all([network.issue(a.token),network.issue(a.token)]);
    assert.deepEqual(retry,first); assert.equal(calls,1);
    const second = await network.issue(b.token);
    assert.notEqual(first.credential,second.credential); assert.notEqual(first.ipv4,second.ipv4);
    const file = sessionConfig(first,a.deviceId,30001,'https://mesh.example.com');
    assert.match(file,/127\.0\.0\.1:30001/); assert.match(file,/wss:\/\/mesh\.example\.com\/easytier/);
    assert.ok(!file.includes(first.credential)); assert.doesNotMatch(file,/network_secret|local_private_key/);
    assert.throws(()=>sessionConfig({...first,ipv4:'10.203.73.3/24'},a.deviceId,30001,'https://mesh.example.com'));
    assert.throws(()=>sessionConfig({...first,name:'invalid"\n[flags]'},a.deviceId,30001,'https://mesh.example.com'));
    assert.throws(()=>sessionConfig(first,a.deviceId,30001,'http://mesh.example.com'));
    directory.setDisabled(b.deviceId,true);
    const next = login(id);
    assert.equal(next.deviceId,a.deviceId);
    await assert.rejects(network.issue(a.token),/LOGIN_REQUIRED/);
    await assert.rejects(network.issue(b.token),/LOGIN_REQUIRED/);
    await network.sweep(); assert.equal(keys.size,0);
    const fresh = await network.issue(next.token);
    assert.notEqual(fresh.credential,first.credential); assert.equal(fresh.ipv4,first.ipv4);
    directory.logout(next.token);
    await network.sweep(); assert.equal(keys.size,0);
  } finally { db.close(); rmSync(dir,{recursive:true,force:true}); }
});
