import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('live folder registration is idempotent and bound to an authenticated device',async () => {
  const dir=mkdtempSync(join(tmpdir(),'anywhere-workspaces-'));
  process.env.DATA_DIR=dir;
  const {createUser}=await import('../auth.mjs');
  const {db}=await import('../auth-db.mjs');
  const {login,logout,registerWorkspace,workspaces}=await import('../directory.mjs');
  try {
    const account={username:'member',password:'test password'};
    createUser(account.username,account.password,false);
    const native=name=>login({...account,installation:randomBytes(32).toString('hex'),name,projects:[]},'local');
    const a=native('Device A'),b=native('Device B'),web=login(account,'local');
    const input={localId:randomUUID(),label:'Project'};
    assert.throws(()=>registerWorkspace(web.token,input),/FORBIDDEN/);
    assert.throws(()=>registerWorkspace(a.token,{...input,deviceId:b.deviceId}),/INVALID_FIELDS/);
    assert.throws(()=>registerWorkspace(a.token,{...input,path:'C:/private/project'}),/INVALID_FIELDS/);
    const first=registerWorkspace(a.token,input);
    const second=registerWorkspace(b.token,input);
    assert.deepEqual(registerWorkspace(a.token,input),first);
    assert.notEqual(first.id,second.id);
    assert.equal(first.deviceId,a.deviceId);
    assert.equal(second.deviceId,b.deviceId);
    assert.equal(workspaces(a.user.id).length,2);
    logout(a.token);
    assert.throws(()=>registerWorkspace(a.token,input),/LOGIN_REQUIRED/);
  } finally {
    db.close();
    rmSync(dir,{recursive:true,force:true});
  }
});
