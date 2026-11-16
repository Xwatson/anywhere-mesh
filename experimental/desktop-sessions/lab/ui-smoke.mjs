import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function smoke({app,win,request,ready,pick}){
 const results=[],record=name=>{results.push({name,passed:true});console.log(name);},[a,b]=JSON.parse(await readFile('/etc/anywhere-desktop2/catalog.json','utf8'));
 const js=s=>win.webContents.executeJavaScript(s,true),state=()=>request('state',{});
 async function until(fn,ms=45000){const end=Date.now()+ms;while(Date.now()<end){const r=await fn();if(r)return r;await sleep(180);}throw Error('UI_WAIT_TIMEOUT');}
 const click=async id=>{await until(()=>js(`Boolean(document.querySelector('[data-testid="${id}"]')&&!document.querySelector('[data-testid="${id}"]').disabled)`));await js(`document.querySelector('[data-testid="${id}"]').click()`);};
 const fill=async(id,text)=>{await js(`{const el=document.querySelector('[data-testid="${id}"]');Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set.call(el,${JSON.stringify(text)});el.dispatchEvent(new Event('input',{bubbles:true}));}`);};
 const mode=async m=>{await click('mode-'+m);if(m==='execute')await click('confirm-execute');await until(async()=>{const s=await state();return s.projects.find(p=>p.id===s.selection.workspaceId)?.permission.mode===m;});};
 async function create(title){await click('new-session');await fill('session-title',title);await click('create-session');return until(async()=>{const s=await state();return s.sessions.find(p=>p.id===s.selection.sessionId&&p.title===title);});}
 async function send(text){const before=await state(),id=before.selection.sessionId,prior=before.sessions.find(s=>s.id===id).lastSeq;await fill('composer',text);await click('send');await until(async()=>{const s=(await state()).sessions.find(s=>s.id===id);return s.lastSeq>prior;});return id;}
 async function done(id){await until(async()=>{const s=(await state()).sessions.find(s=>s.id===id);const p=await request('history',{sessionId:id,beforeSeq:0});return !s.activeTurn&&p.events.at(-1)?.event.type==='turn_end'&&p.events.at(-1).seq===s.lastSeq;});}
 let failure;
 try{
  await until(ready);const prefs=win.webContents.getLastWebPreferences();assert.equal(prefs.sandbox,true);assert.equal(prefs.nodeIntegration,false);
  assert.deepEqual(await js(`({require:typeof window.require,process:typeof window.process})`),{require:'undefined',process:'undefined'});
  assert.equal(await js(`fetch('https://example.com').then(()=>false,()=>true)`),true);
  for(const w of [a,b]){pick(w.path);await click('add-workspace');await until(async()=>(await state()).projects.some(p=>p.id===w.id));}
  record('reused_sandboxed_shell_native_picker_boundary_adds_two_independent_local_projects');
  await click('connect');await until(async()=>(await state()).connection==='connected');
  await click('project-'+a.id);await mode('execute');const sa=await create('界面验证 A '+Date.now());await send('/read notes.txt');await done(sa.id);
  await until(()=>js(`document.querySelector('[data-testid="timeline"]')?.textContent.includes('workspace_read_file')`));
  await send('/build');await done(sa.id);await sleep(900);
  await js(`{const buttons=[...document.querySelectorAll('[data-testid="timeline"] button')];const b=buttons.find(x=>x.textContent.includes('workspace_run'));if(b)b.click();}`);
  await until(()=>js(`document.querySelector('[data-testid="timeline"]')?.textContent.includes('BUILD_ALPHA_OK')`));
  await js(`{const b=[...document.querySelectorAll('[data-testid="timeline"] button')].find(x=>x.textContent.includes('workspace_run'));b.parentElement.scrollIntoView({block:'center'});}`);await sleep(350);
  await writeFile('/srv/anywhere-lab/artifacts/desktop-d2-chat.png',(await win.webContents.capturePage()).toPNG());
  record('project_session_composer_reuses_existing_timeline_and_tool_cards_for_real_build_result');
  await send('/long');await until(async()=>(await state()).sessions.find(s=>s.id===sa.id).activeTurn?.state==='running');
  await click('project-'+b.id);await mode('read');const sb=await create('界面验证 B '+Date.now());await send('/read notes.txt');await done(sb.id);
  const history=await request('history',{sessionId:sb.id,beforeSeq:0});assert.match(JSON.stringify(history),/PROJECT_BETA/);assert.doesNotMatch(JSON.stringify(history),/PROJECT_ALPHA/);
  await click('project-'+a.id);await click('session-'+sa.id);await click('stop-turn');await done(sa.id);
  record('switching_to_B_does_not_retarget_A_and_returning_to_A_stops_only_its_turn');
  await click('connect');await until(async()=>(await state()).connection==='disconnected');await click('project-'+b.id);await click('session-'+sb.id);
  await until(()=>js(`document.querySelector('[data-testid="timeline"]')?.textContent.includes('/read notes.txt')`));
  assert.ok((await state()).projects.every(p=>p.permission.mode==='revoked'));await mode('read');await mode('revoked');
  record('offline_project_switch_history_and_local_permissions_work_without_remote_session_service');
 }catch(e){failure=e;console.error(e.stack);}
 await writeFile('/srv/anywhere-lab/artifacts/desktop-d2-ui-smoke.json',JSON.stringify({passed:!failure,realCli:false,results,error:failure?.stack??null},null,2));app.quit();if(failure)throw failure;
}
