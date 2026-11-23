import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('changing a password keeps only the initiating login for that account', async () => {
  const dir = mkdtempSync(join(tmpdir(),'anywhere-password-'));
  process.env.DATA_DIR = dir;
  const directory = await import('../directory.mjs');
  const {createUser} = await import('../auth.mjs');
  const {db} = await import('../auth-db.mjs');
  try {
    const previous = 'first password', next = ' 新的密码 123 ';
    createUser('member',previous,false);
    createUser('admin',previous,true);
    const signin = (username,password,installation) => directory.login({username,password,...(installation
      ? {installation,name:'Desktop',projects:[]} : {})},'127.0.0.1');
    const browser = signin('member',previous);
    const device = signin('member',previous,randomBytes(32).toString('hex'));
    const admin = signin('admin',previous);
    const change = (current,password) => directory.changePassword(device.token,{current,password});

    assert.throws(() => change('wrong password',next),/INCORRECT_CURRENT_PASSWORD/);
    for (const invalid of ['short',' '.repeat(12),'x'.repeat(201)]) {
      assert.throws(() => change(previous,invalid),/INVALID_NEW_PASSWORD/);
    }
    assert.throws(() => change(previous,previous),/PASSWORD_UNCHANGED/);
    assert.throws(() => directory.changePassword(device.token,{current:previous,password:next,userId:admin.user.id}),/INVALID_FIELDS/);
    assert.equal(directory.authenticate(browser.token).user.id,device.user.id);

    assert.equal(change(previous,next),device.user.id);
    assert.equal(directory.authenticate(device.token).deviceId,device.deviceId);
    assert.equal(directory.authenticate(admin.token).user.id,admin.user.id);
    assert.throws(() => directory.authenticate(browser.token),/LOGIN_REQUIRED/);
    assert.throws(() => directory.changePassword(browser.token,{current:next,password:previous}),/LOGIN_REQUIRED/);
    assert.throws(() => signin('member',previous),/INVALID_CREDENTIALS/);
    assert.equal(signin('member',next).user.id,device.user.id);
    for (let i=0; i<4; i++) assert.throws(() => change(previous,'another password'),/INCORRECT_CURRENT_PASSWORD/);
    assert.throws(() => change(next,'another password'),/PASSWORD_THROTTLED/);
    assert.equal(directory.changePassword(admin.token,{current:previous,password:next}),admin.user.id);
  } finally {
    db.close();
    rmSync(dir,{recursive:true,force:true});
  }
});
