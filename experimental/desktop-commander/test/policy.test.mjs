import test from 'node:test';
import assert from 'node:assert/strict';
import { relative, validate, register } from '../adapter.mjs';
import { validateRequest } from '../../execution/protocol.mjs';
register();
const grant = { accountId:'a',deviceId:'d',workspaceId:'w',grantVersion:1,capabilities:['dc.tool','dc.run','dc.search','workspace.write','workspace.exec'] };
const request = (kind,args) => ({ scope:{accountId:'a',deviceId:'d',workspaceId:'w',grantVersion:1,sessionId:'s',turnId:'t',turnEpoch:1},
  toolCallId:'call',kind,args,cwdRelative:'.',expiresAt:Date.now()+10000 });
test('paths, URLs, traversal and caller-selected configuration are denied',()=>{
  for (const p of ['/etc/passwd','../x','a/../b','C:\\secret','https://example.com','x\0a','a//b']) assert.throws(()=>relative(p));
  for (const p of ['.','src/main.js','中文/测试.txt']) assert.equal(relative(p),p);
  assert.throws(()=>validateRequest(request('dc.tool',{tool:'set_config_value',arguments:{key:'allowedDirectories',value:['/']}}),grant),/TOOL_DENIED/);
  assert.throws(()=>validateRequest(request('dc.tool',{tool:'read_file',arguments:{path:'a',isUrl:true}}),grant),/INVALID_FIELDS/);
});
test('write and exec grants independently gate capabilities',()=>{
  assert.throws(()=>validateRequest(request('dc.run',{command:'true'}),{...grant,capabilities:['dc.run']}),/EXEC_DENIED/);
  assert.throws(()=>validateRequest(request('dc.tool',{tool:'write_file',arguments:{path:'a',content:'x',mode:'append'}}),{...grant,capabilities:['dc.tool']}),/WRITE_DENIED/);
  assert.equal(typeof validateRequest(request('dc.tool',{tool:'read_file',arguments:{path:'a'}}),{...grant,capabilities:['dc.tool']}),'string');
});
test('scope identity and bounded arguments are enforced before execution',()=>{
  const r=request('dc.tool',{tool:'read_file',arguments:{path:'a',length:201}});
  assert.throws(()=>validateRequest(r,grant),/INVALID_INTEGER/);
  r.args.arguments.length=100;r.scope.deviceId='another';
  assert.throws(()=>validateRequest(r,grant),/SCOPE_DENIED/);
  assert.throws(()=>validate(request('dc.search',{path:'.',pattern:'x',searchType:'content',literalSearch:true,maxResults:0}),grant));
});
