import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

export async function smoke({win,root}) {
  const runId = process.argv.find(arg=>arg.startsWith('--lab-smoke-id='))?.slice('--lab-smoke-id='.length);
  assert.match(runId,/^[a-f0-9-]{36}$/);
  const pipe = createConnection('\\\\.\\pipe\\AnywhereLab-'+runId);
  pipe.setTimeout(10000,()=>pipe.destroy(Error('Smoke input timeout')));
  let input = '';
  for await (const chunk of pipe) {
    input += chunk.toString();
    if (input.length > 2000) throw Error('Invalid Windows smoke input');
  }
  const {username,password,runId:expected} = JSON.parse(input);
  assert.equal(username,'lab-coder');
  assert.equal(expected,runId);
  const file = 'verify-' + runId + '.txt', path = join(root,'project',file);
  const artifacts = join(root,'artifacts'), reportPath = join(artifacts,'smoke-'+runId+'.json');
  const data = { runId, file, checks: [], phase: 'started' };
  const save = () => {
    writeFileSync(reportPath+'.partial',JSON.stringify(data,null,2));
    renameSync(reportPath+'.partial',reportPath);
  };
  const js = source => win.webContents.executeJavaScript(source,true);
  const api = (method,params={}) => js('window.desktopDevice.request('+JSON.stringify(method)+','+JSON.stringify(params)+')');
  const wait = async (stage,check,timeout=50000) => {
    const end = Date.now()+timeout;
    do {
      const value = await check(); if (value) return value;
      await delay(280);
    } while (Date.now()<end);
    throw Error('Timed out: '+stage);
  };
  const first = 'WINDOWS_LOCAL_'+randomUUID(), second = 'WINDOWS_LOCAL_'+randomUUID();
  const proof = marker => createHash('sha256').update(marker).digest('hex');
  const command = '/read '+file;
  const title = 'Windows VM 只读验收';
  const view = (id,field) => 'document.getElementById('+JSON.stringify(id)+').'+field;
  const screenshot = async name => {
    const img = await win.webContents.capturePage();
    if (!img.isEmpty()) writeFileSync(join(artifacts,runId+'-'+name+'.png'),img.toPNG());
  };
  writeFileSync(path,first+'\r\n',{flag:'wx'}); save();
  try {
    await wait('desktop sign-in',()=>js(view('entry','textContent')+".includes('Windows')"));
    await js(view('username','value')+'='+JSON.stringify(username)+';'+view('password','value')+'='+JSON.stringify(password)+";document.querySelector('#login').requestSubmit();void 0");
    const initial = await wait('signed-in Windows device',async()=>{
      const error=await js(view('login-error','textContent')); if(error) throw Error('Desktop login: '+error);
      const s=await api('state');return s.user && s.projects.find(p=>p.deviceId===s.deviceId)?.ready ? s : null;
    });
    const project=initial.projects.find(p=>p.deviceId===initial.deviceId);
    data.deviceId=initial.deviceId; data.workspaceId=project.id; data.deviceName=initial.localName;
    assert.equal(project.localMode,'revoked');
    assert.deepEqual(project.localModes,['revoked','read']);
    await assert.rejects(api('permission',{workspaceId:project.id,mode:'execute'}),/UNSUPPORTED_DEVICE_PERMISSION/);
    const applyMode = async mode => {
      await wait('project button',()=>js("!document.querySelector('#app').hidden && !document.querySelector('#context').disabled"));
      await js("document.querySelector('#context').click()");
      await wait('project settings',()=>js("document.querySelector('#project-dialog').open && document.querySelector('#project').value==="+JSON.stringify(project.id)));
      await js("(()=>{const m=document.querySelector('#mode');m.value="+JSON.stringify(mode)+";m.dispatchEvent(new Event('change'));document.querySelector('#apply').click();})()");
      await wait('project settings saved',()=>js("!document.querySelector('#project-dialog').open && !document.querySelector('#context').disabled"));
    };
    await applyMode('read');
    await wait('remote read grant',async()=>(await api('state')).projects.some(p=>p.id===project.id&&p.ready&&p.mode==='read'));
    data.checks.push('desktop-login','read-only-local-grant');
    let s=initial.sessions.find(s=>s.title===title && s.workspaceId===project.id && s.deviceId===initial.deviceId);
    if(!s) s=await api('create',{requestId:randomUUID(),workspaceId:project.id,title});
    data.sessionId=s.id;
    await js("document.querySelector('#find-chat').click()");
    const selector='#search-results [data-session="'+s.id+'"]';
    await wait('session row',()=>js('!!document.querySelector('+JSON.stringify(selector)+')'));
    await js('document.querySelector('+JSON.stringify(selector)+').click();void 0');
    await wait('online target',()=>js(view('device-status','title')+".includes('Windows') && "+view('presence','textContent')+"==='在线'"));
    await js(view('draft','value')+'='+JSON.stringify(command)+";document.querySelector('#draft').dispatchEvent(new Event('input'));void 0");
    await wait('send ready',()=>js('!'+view('send','disabled')));
    await js("document.querySelector('#send').click();void 0");
    const completed = marker => js(view('events','textContent')+'.includes('+JSON.stringify(marker)+')');
    await wait('workspace_read_file from Windows',()=>completed(first));
    await wait('first read committed',async()=>!(await api('state')).sessions.find(row=>row.id===s.id)?.activeTurn);
    await assert.rejects(api('send',{sessionId:s.id, requestId:randomUUID(), text:'/append '+file+' denied'}),/LOCAL_PERMISSION_REQUIRED/);
    assert.equal(readFileSync(path,'utf8'),first+'\r\n');
    data.checks.push('bound-session','workspace_read_file','append-denied');
    writeFileSync(path,second+'\r\n');
    data.secondDigest=proof(second);
    data.phase='awaiting-linux';save();
    await wait('Linux caller reading the updated Windows file',()=>completed(second),110000);
    await wait('second read committed',async()=>!(await api('state')).sessions.find(row=>row.id===s.id)?.activeTurn);
    await screenshot('online');
    data.checks.push('same-session-fresh-content-from-linux');
    await applyMode('revoked');
    await wait('remote grant revoked',async()=>(await api('state')).projects.find(p=>p.id===project.id)?.mode==='revoked');
    await assert.rejects(api('send',{sessionId:s.id,requestId:randomUUID(),text:command}),/LOCAL_PERMISSION_REQUIRED/);
    await js("document.querySelector('#account-menu').click();document.querySelector('#logout').click();void 0");
    await wait('signed out',()=>js('!'+view('signin','hidden')+' && '+view('app','hidden')));
    data.checks.push('revocation','desktop-signout'); data.phase='passed'; data.at=new Date().toISOString();save();
  } catch (e) {
    data.phase='failed';data.error=e.message;save();await screenshot('diagnostic').catch(()=>{});throw e;
  } finally {
    await api('logout').catch(()=>{});
    unlinkSync(path);
  }
}
