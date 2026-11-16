// Run inside CN network namespace as lab. No private key material is printed.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {Remote} from '../remote.mjs';
const cfg=JSON.parse(readFileSync('/etc/anywhere-desktop2/desktop/config.json','utf8')),remote=new Remote(cfg);
const id=process.argv[2];
await assert.rejects(remote.request('POST','/api/sessions',{requestId:randomUUID(),workspaceId:randomUUID(),title:'foreign'}),/WORKSPACE_NOT_ALLOWED/);
await assert.rejects(remote.request('POST',`/api/sessions/${id}/messages`,{requestId:randomUUID(),text:'/read notes.txt',workspaceId:cfg.workspaces[1].id}),/INVALID_FIELDS/);
await assert.rejects(remote.request('POST','/api/permissions',{mode:'execute'}),/NOT_FOUND/);
const wrongClient=new Remote({...cfg,cert:'/etc/anywhere-desktop2/desktop/unapproved.crt',key:'/etc/anywhere-desktop2/desktop/unapproved.key'});
await assert.rejects(wrongClient.request('GET','/api/sessions'),/CLIENT_IDENTITY_DENIED/);
const wrongServer=new Remote({...cfg,serverCert:'/etc/anywhere-desktop2/desktop/unapproved.crt'});
await assert.rejects(wrongServer.request('GET','/api/sessions'),/SERVER_PIN_MISMATCH/);
const requestId=randomUUID(),text='D2_DUPLICATE_'+requestId,body={requestId,text:'/append notes.txt '+text};
const [a,b]=await Promise.all([remote.request('POST',`/api/sessions/${id}/messages`,body),remote.request('POST',`/api/sessions/${id}/messages`,body)]);assert.deepEqual(a,b);
await assert.rejects(remote.request('POST',`/api/sessions/${id}/messages`,{...body,text:'/append notes.txt CHANGED'}),/REQUEST_CONFLICT/);
console.log(JSON.stringify({passed:true,turnId:a.turnId,marker:text,requestId}));
