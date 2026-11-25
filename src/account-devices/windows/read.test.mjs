import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

async function installedWorkspace() {
  const base=join(process.env.LOCALAPPDATA,'AnywhereMesh');
  const nodeDir=dirname(process.execPath);
  const app=basename(nodeDir)==='tools' && basename(dirname(nodeDir))==='resources' ? join(dirname(nodeDir),'app') :
    join(base,'runtime',(await readFile(join(base,'Start-Anywhere.cmd'),'utf8')).match(/app-[A-F0-9]{16}/)[0]);
  const native=join(app,'src','account-devices','windows');
  const {windowsReader}=await import(pathToFileURL(join(native,'read.mjs')));
  return windowsReader(join(native,'WorkspaceSnapshot.exe'));
}

test('installed Windows reader pins the project and pages only bounded, single-link UTF-8 files', {skip:process.platform!=='win32'}, async t=>{
  const adapter=await installedWorkspace();
  const temp=await mkdtemp(join(tmpdir(),'anywhere-read-test-'));
  t.after(()=>rm(temp,{recursive:true,force:true,maxRetries:3}));
  const root=join(await realpath(temp),'project'), other=join(temp,'other'), stateDir=join(temp,'state');
  await Promise.all([mkdir(join(root,'子目录'),{recursive:true}),mkdir(other),mkdir(stateDir)]);
  const path='子目录/说明.txt';
  await writeFile(join(root,path),'第一行\r\n第二行\r\n第三行\r\n');
  await writeFile(join(other,'other.txt'),'separate fixture');
  const identity=adapter.identifyRoot(root);
  const build=(rootIdentity=identity)=>adapter.launcher({workspaceRoot:root,rootIdentity,stateDir});
  const launch=build();
  const req=(path)=>({request:{kind:'dc.tool',cwdRelative:'.',args:{tool:'read_file',arguments:{path,offset:1,length:1}}}});
  const read=(path,worker=launch)=>worker(req(path),{mode:'read'}).read(new AbortController().signal);
  assert.match((await read(path)).response.content[0].text,/\n第二行$/);
  assert.throws(()=>launch(req(path),{mode:'revoked'}),/TOOL_UNAVAILABLE_ON_DEVICE/);
  for(const name of ['../other/other.txt','C:/Windows/a','notes.txt:stream','NUL','file.']) await assert.rejects(read(name),/PATH_DENIED/);
  await symlink(other,join(root,'junction'),'junction');
  await link(join(other,'other.txt'),join(root,'linked.txt'));
  await assert.rejects(read('junction/other.txt'),/PATH_DENIED/);
  await assert.rejects(read('linked.txt'),/REGULAR_SINGLE_LINK_FILE_REQUIRED/);
  await writeFile(join(root,'binary.txt'),Buffer.from([65,0,66]));
  await assert.rejects(read('binary.txt'),/TEXT_FILE_REQUIRED/);
  await writeFile(join(root,'large.txt'),Buffer.alloc(1024*1024+1,65));
  await assert.rejects(read('large.txt'),/FILE_SNAPSHOT_TOO_LARGE/);
  await assert.rejects(read(path,build(adapter.identifyRoot(other))),/WORKSPACE_ROOT_CHANGED/);
});

test('installed project grants, guarded edits, direct command execution with network and cancellation', {skip:process.platform!=='win32'},async t=>{
  const adapter=await installedWorkspace();
  const temp=await realpath(await mkdtemp(join(tmpdir(),'anywhere-full-test-')));
  t.after(()=>rm(temp,{recursive:true,force:true,maxRetries:3}));
  const root=join(temp,'project'),stateDir=join(temp,'state');
  await Promise.all([mkdir(root),mkdir(stateDir)]);
  const launch=adapter.launcher({workspaceRoot:root,rootIdentity:adapter.identifyRoot(root),stateDir});
  const operation=(request,mode='execute')=>launch({operationId:randomUUID(),request},{mode});
  const tool=(name,args)=>({kind:'dc.tool',cwdRelative:'.',args:{tool:name,arguments:args}});
  const run=(command,cwdRelative='.')=>({kind:'dc.run',cwdRelative,args:{command}});
  const call=(request,mode,signal=new AbortController().signal,stream=()=>{})=>{
    const current=operation(request,mode);
    return (current.perform??current.read)(signal,stream);
  };
  const write=(path,content,expectedRevision=null,mode='rewrite')=>tool('write_file',{path,content,expectedRevision,mode});
  assert.deepEqual(adapter.modes,['revoked','read','edit','execute']);
  assert.equal(adapter.sandbox.platform,'win32');
  assert.equal(adapter.sandbox.network,true);
  assert.equal(adapter.sandbox.isolation,'none');
  assert.throws(()=>operation(write('a','!'),'read'),/TOOL_UNAVAILABLE_ON_DEVICE/);
  assert.throws(()=>operation(run('ver'),'edit'),/TOOL_UNAVAILABLE_ON_DEVICE/);
  await call(tool('create_directory',{path:'验证/sub'}),'edit');
  const path='验证/sub/说明.txt';
  const first=(await call(write(path,'line one\n'),'edit')).fileVersions[0].revision;
  const next=(await call(write(path,'line two\n',first,'append'),'edit')).fileVersions[0].revision;
  await assert.rejects(call(write(path,'lost update',first),'edit'),/FILE_VERSION_CONFLICT/);
  await call(tool('edit_block',{file_path:path,old_string:'line two',new_string:'line three',expected_replacements:1,expectedRevision:next}),'edit');
  assert.equal(await readFile(join(root,path),'utf8'),'line one\nline three\n');
  const inspect=(await call(tool('get_file_info',{path}),'read')).response.content[0].text;
  assert.equal(JSON.parse(inspect).directory,false);
  const list=await call(tool('list_directory',{path:'.',depth:3}),'read');
  assert.ok(list.response.content[0].text.includes(path));
  const matches=await call({kind:'dc.search',cwdRelative:'.',args:{path:'.',pattern:'three',searchType:'content',literalSearch:true,maxResults:10}},'read');
  assert.ok(matches.response.content[0].text.includes(path+':2:'));
  const multi=await call(tool('read_multiple_files',{paths:[path,'missing.txt']}),'read');
  assert.equal(multi.fileVersions.length,1);assert.match(multi.response.content[1].text,/FILE_NOT_FOUND/);
  // Direct execution in execute mode allows local network access and writes directly to workspaceRoot.
  const listener=createServer(socket=>socket.end());listener.listen(0,'127.0.0.1');await once(listener,'listening');
  t.after(()=>new Promise(resolve=>listener.close(resolve)));
  await writeFile(join(root,'验证','package.json'),JSON.stringify({scripts:{test:'node build.cjs'}}));
  await writeFile(join(root,'验证','build.cjs'),[
    "const fs=require('node:fs'),net=require('node:net');",
    "const s=net.createConnection("+listener.address().port+",'127.0.0.1');",
    "s.setTimeout(3000,()=>s.destroy(Error('timeout')));",
    "s.on('connect',()=>{s.destroy();fs.mkdirSync('dist');fs.writeFileSync('dist/result.bin',Buffer.from([0,254,1]));fs.renameSync('sub/说明.txt','sub/moved.txt');console.log('BUILD_VERIFIED');});",
    "s.on('error',()=>{process.exit(51);});"
  ].join('\n'));
  const output=[];
  const built=await call(run('npm test --silent','验证'),'execute',undefined,(_kind,data)=>output.push(data));
  assert.ok(built.ok,output.join(''));assert.ok(built.committed);assert.match(output.join(''),/BUILD_VERIFIED/);
  assert.deepEqual(await readFile(join(root,'验证','dist','result.bin')),Buffer.from([0,254,1]));
  await assert.rejects(readFile(join(root,path)),{code:'ENOENT'});
  assert.equal(await readFile(join(root,'验证','sub','moved.txt'),'utf8'),'line one\nline three\n');
  await writeFile(join(root,'wait.cjs'),"console.log('WAITING');setTimeout(()=>{},15000);");
  const cancel=new AbortController();
  await assert.rejects(call(run('node wait.cjs'),'execute',cancel.signal,(_kind,data)=>{
    if(data.includes('WAITING'))cancel.abort();
  }),{name:'AbortError'});
});
