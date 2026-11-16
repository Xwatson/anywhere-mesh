import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, rename, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { guardCall, prepareFileGuard } from '../../desktop-commander/file-guard.mjs';
import { hash } from '../../execution/protocol.mjs';
import { execFileSync } from 'node:child_process';

async function setup(t){
  const base=await mkdtemp(path.join(tmpdir(),'guard-test-')),root=path.join(base,'workspace'),state=path.join(base,'state');await mkdir(root);await mkdir(state);
  t.after(()=>rm(base,{recursive:true,force:true}));
  const snapshot=path=>guardCall({action:'snapshot',root,path});
  const commit=(path,expectedRevision,text)=>guardCall({action:'commit',root,path,expectedRevision,content:Buffer.from(text).toString('base64'),backupRoot:state,backupId:hash(randomUUID())});
  return{base,root,state,snapshot,commit};
}
test('snapshot revision rejects an external change and preserves the local edit',async t=>{
  const {root,snapshot,commit}=await setup(t);await writeFile(path.join(root,'x'),'before');
  const read=await snapshot('x');assert.equal(read.ok,true);
  await writeFile(path.join(root,'x'),'local editor change');
  assert.equal((await commit('x',read.revision,'AI overwrite')).error,'FILE_VERSION_CONFLICT');
  assert.equal(await readFile(path.join(root,'x'),'utf8'),'local editor change');
});
test('guarded write is atomic replacement with preimage, fresh revision and create-if-absent',async t=>{
  const {root,state,snapshot,commit}=await setup(t);await writeFile(path.join(root,'x'),'before',{mode:0o755});
  execFileSync('python3',['-c',"import os,sys;os.setxattr(sys.argv[1],'user.anywhere_lab',b'preserve')",path.join(root,'x')]);
  const read=await snapshot('x'),result=await commit('x',read.revision,'after');assert.equal(result.ok,true);assert.notEqual(result.revision,read.revision);
  const backup=JSON.parse(await readFile(path.join(state,result.backupId+'.json'),'utf8'));assert.equal(Buffer.from(backup.before.data,'base64').toString(),'before');
  assert.equal(await readFile(path.join(root,'x'),'utf8'),'after');
  execFileSync('python3',['-c',"import os,sys,stat;s=os.stat(sys.argv[1]);assert stat.S_IMODE(s.st_mode)==0o755;assert s.st_uid==os.geteuid();assert os.getxattr(sys.argv[1],'user.anywhere_lab')==b'preserve'",path.join(root,'x')]);
  assert.equal((await commit('new',null,'first')).ok,true);assert.equal((await commit('new',null,'second')).error,'FILE_VERSION_CONFLICT');
  assert.ok(!(await readdir(root)).some(p=>p.startsWith('.anywhere-stage-')));
});
test('symlink parents, leaf symlinks, hardlinks and oversized files are refused',async t=>{
  const {base,root,snapshot,commit}=await setup(t);await writeFile(path.join(base,'outside'),'secret');
  await symlink(base,path.join(root,'escape'));await symlink('../outside',path.join(root,'leaf'));await link(path.join(base,'outside'),path.join(root,'hard'));
  assert.equal((await snapshot('escape/outside')).ok,false);assert.equal((await commit('leaf',null,'overwrite')).ok,false);
  assert.equal((await snapshot('hard')).error,'REGULAR_SINGLE_LINK_FILE_REQUIRED');
  await writeFile(path.join(root,'big'),Buffer.alloc(1024*1024+1,97));assert.equal((await snapshot('big')).error,'FILE_SNAPSHOT_TOO_LARGE');
  assert.equal(await readFile(path.join(base,'outside'),'utf8'),'secret');
});
test('staging gives Desktop Commander a stable snapshot and refuses changes before commit',async t=>{
  const {root,state,snapshot}=await setup(t);await writeFile(path.join(root,'x'),'original');const version=(await snapshot('x')).revision;
  const guard=await prepareFileGuard({kind:'dc.tool',args:{tool:'edit_block',arguments:{file_path:'x',expectedRevision:version}}},{workspaceRoot:root,stateDir:state},randomUUID());
  t.after(()=>guard.close());await writeFile(path.join(guard.staging,'x'),'staged AI edit');
  await rename(path.join(root,'x'),path.join(root,'moved'));await writeFile(path.join(root,'x'),'new local file');
  const result=await guard.commit();assert.equal(result.error,'FILE_VERSION_CONFLICT');assert.equal(await readFile(path.join(root,'x'),'utf8'),'new local file');
});
test('same text replaced by another inode is still a conflict',async t=>{
  const {root,snapshot,commit}=await setup(t);await writeFile(path.join(root,'x'),'same');const version=(await snapshot('x')).revision;
  await writeFile(path.join(root,'replacement'),'same');await rename(path.join(root,'replacement'),path.join(root,'x'));
  assert.equal((await commit('x',version,'edit')).error,'FILE_VERSION_CONFLICT');
});
