import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const exec=promisify(execFile),run=async(...args)=>(await exec(args[0],args.slice(1),{timeout:20000})).stdout.trim();
export async function smoke({app,win,request,ready,pick}){
 const results=[],recovered=[],record=name=>{results.push({name,passed:true});console.log(name);},[a,b]=JSON.parse(await readFile('/etc/anywhere-desktop2/catalog.json','utf8'));
 const js=s=>win.webContents.executeJavaScript(s,true),state=()=>request('state',{});
 async function until(fn,ms=45000){const end=Date.now()+ms;while(Date.now()<end){const r=await fn();if(r)return r;await sleep(180);}throw Error('UI_WAIT_TIMEOUT');}
 const click=async id=>{await until(()=>js(`Boolean(document.querySelector('[data-testid="${id}"]')&&!document.querySelector('[data-testid="${id}"]').disabled)`));await js(`document.querySelector('[data-testid="${id}"]').click()`);};
 const fill=async(id,text)=>{await until(()=>js(`Boolean(document.querySelector('[data-testid="${id}"]'))`));await js(`{const el=document.querySelector('[data-testid="${id}"]');Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set.call(el,${JSON.stringify(text)});el.dispatchEvent(new Event('input',{bubbles:true}));}`);};
 const mode=async m=>{await click('mode-'+m);if(m==='execute')await click('confirm-execute');await until(async()=>{const s=await state(),p=s.projects.find(p=>p.id===s.selection.workspaceId);return p?.permission.mode===m&&(s.connection!=='connected'||p.permission.synced);});};
 async function create(title){await click('new-session');await fill('session-title',title);await click('create-session');return until(async()=>{const s=await state();return s.sessions.find(p=>p.id===s.selection.sessionId&&p.title===title);});}
 async function send(text){const before=await state(),id=before.selection.sessionId,prior=before.sessions.find(s=>s.id===id).lastSeq;await fill('composer',text);await click('send');await until(async()=>{const s=(await state()).sessions.find(s=>s.id===id);return s.lastSeq>prior;});return id;}
 async function done(id,expected='succeeded'){const p=await until(async()=>{const s=(await state()).sessions.find(s=>s.id===id);const p=await request('history',{sessionId:id,beforeSeq:0});return !s.activeTurn&&p.events.at(-1)?.event.type==='turn_end'&&p.events.at(-1).seq===s.lastSeq&&p;});
  const end=p.events.at(-1).event;assert.equal(end.ok,expected==='succeeded');if(expected==='cancelled')assert.equal(end.error,'已取消');if(expected==='reviewed')assert.equal(end.error,'已核对，结果未知');return p;}
 async function reviewUnknown(sessionId,turnId){
  await mode('revoked');
  const preview=await request('reviewPreview',{sessionId,turnId});
  assert.equal(preview.request.tool,'write_file');assert.equal(preview.starts,1);const args=preview.request.arguments;
  assert.equal(args.path,'notes.txt');assert.equal(args.mode,'append');assert.match(args.content,/^UI_UNKNOWN_\d+\n$/);
  const actual=await run('sudo','-n','-u','anywhere-exec-agent','cat',a.path+'/notes.txt');assert.equal(actual.split(args.content.trim()).length-1,1);
  await click('review-open');await fill('review-note','已直接检查本地 notes.txt：本次标记出现一次。保留未知结果，关闭待核对，不重新执行。');
  await until(()=>js(`[...document.querySelectorAll('button')].some(b=>b.textContent==='保存核对记录'&&!b.disabled)`));await sleep(250);
  await writeFile('/srv/anywhere-lab/artifacts/desktop-d2-review.png',(await win.webContents.capturePage()).toPNG());
  await js(`[...document.querySelectorAll('button')].find(b=>b.textContent==='保存核对记录').click()`);await done(sessionId,'reviewed');
  assert.equal(await run('sudo','-n','-u','anywhere-exec-agent','cat',a.path+'/notes.txt'),actual);
 }
 let failure;
 try{
  await until(ready);const prefs=win.webContents.getLastWebPreferences();assert.equal(prefs.sandbox,true);assert.equal(prefs.nodeIntegration,false);
  assert.deepEqual(await js(`({require:typeof window.require,process:typeof window.process})`),{require:'undefined',process:'undefined'});
  assert.equal(await js(`fetch('https://example.com').then(()=>false,()=>true)`),true);
  for(const w of [a,b]){pick(w.path);await click('add-workspace');await until(async()=>(await state()).projects.some(p=>p.id===w.id));}
  record('reused_sandboxed_shell_native_picker_boundary_adds_two_independent_local_projects');
  await click('connect');await until(async()=>(await state()).connection==='connected');
  // Preserve and explicitly inspect a prior interrupted test; never erase its journal.
  for(const s of (await state()).sessions.filter(s=>s.activeTurn)){
   assert.equal(s.workspaceId,a.id);await click('project-'+a.id);await click('session-'+s.id);
   const result=await until(async()=>{const t=(await state()).sessions.find(v=>v.id===s.id).activeTurn;return !t?{resolved:true}:t.state==='unknown'?{turn:t}:false;});
   if(result.turn){await reviewUnknown(s.id,result.turn.id);recovered.push({sessionId:s.id,turnId:result.turn.id});}
  }
  await click('project-'+a.id);await mode('read');const sa=await create('界面验证 A '+Date.now());await send('/read notes.txt');await done(sa.id);
  await until(()=>js(`document.querySelector('[data-testid="timeline"]')?.textContent.includes('workspace_read_file')`));
  const denied='UI_DENIED_'+Date.now(),marker='UI_EDIT_'+Date.now(),prior=(await state()).sessions.find(s=>s.id===sa.id).lastSeq;
  await fill('composer','/append notes.txt '+denied);await click('send');await until(()=>js(`document.querySelector('[role="alert"]')?.textContent.includes('本地权限不足')`));
  assert.equal((await state()).sessions.find(s=>s.id===sa.id).lastSeq,prior);
  await mode('edit');await send('/append notes.txt '+marker);await done(sa.id);await send('/read notes.txt');const edited=await done(sa.id);
  assert.match(JSON.stringify(edited),new RegExp(marker));
  const disk=await run('sudo','-n','-u','anywhere-exec-agent','cat',a.path+'/notes.txt');assert.equal(disk.split(marker).length-1,1);assert.ok(!disk.includes(denied));
  record('readonly_edit_is_rejected_in_UI_then_explicit_edit_permission_writes_exactly_once_and_readback_matches_disk');
  await mode('execute');
  await send('/build');await done(sa.id);await sleep(900);
  await js(`{const buttons=[...document.querySelectorAll('[data-testid="timeline"] button')];const b=buttons.find(x=>x.textContent.includes('workspace_run'));if(b)b.click();}`);
  await until(()=>js(`document.querySelector('[data-testid="timeline"]')?.textContent.includes('BUILD_ALPHA_OK')`));
  await js(`{const b=[...document.querySelectorAll('[data-testid="timeline"] button')].find(x=>x.textContent.includes('workspace_run'));b.parentElement.scrollIntoView({block:'center'});}`);await sleep(350);
  await writeFile('/srv/anywhere-lab/artifacts/desktop-d2-chat.png',(await win.webContents.capturePage()).toPNG());
  record('project_session_composer_reuses_existing_timeline_and_tool_cards_for_real_build_result');
  await send('/long');await until(async()=>(await state()).sessions.find(s=>s.id===sa.id).activeTurn?.state==='running');
  await fill('composer','A 尚未发送的草稿');
  await click('project-'+b.id);await mode('read');const sb=await create('界面验证 B '+Date.now());await send('/read notes.txt');await done(sb.id);
  const history=await request('history',{sessionId:sb.id,beforeSeq:0});assert.match(JSON.stringify(history),/PROJECT_BETA/);assert.doesNotMatch(JSON.stringify(history),/PROJECT_ALPHA/);
  await fill('composer','B 尚未发送的草稿');await click('project-'+a.id);await click('session-'+sa.id);
  await until(()=>js(`document.querySelector('[data-testid="composer"]')?.value==='A 尚未发送的草稿'`));
  await click('stop-turn');await done(sa.id,'cancelled');
  record('switching_to_B_does_not_retarget_A_and_returning_to_A_stops_only_its_turn');
  await click('project-'+b.id);await click('session-'+sb.id);await until(()=>js(`document.querySelector('[data-testid="composer"]')?.value==='B 尚未发送的草稿'`));
  record('unsent_drafts_survive_project_switch_without_overwriting_the_other_session');
  await click('project-'+a.id);await click('session-'+sa.id);await mode('edit');await send('/read notes.txt');await done(sa.id);
  const unknownMarker='UI_UNKNOWN_'+Date.now();
  await run('sudo','-n','-u','anywhere-exec-agent','python3','-c',`from pathlib import Path;Path('/srv/anywhere-lab/desktop-d2/agents/a/fault.json').write_text('{"point":"agent_before_result"}')`);
  await send('/append notes.txt '+unknownMarker);
  await until(async()=>await run('systemctl','show','--value','-p','ActiveState','anywhere-desktop2-agent-a.service')==='failed');
  await run('sudo','-n','systemctl','start','anywhere-desktop2-agent-a.service');await until(async()=>(await state()).sessions.find(s=>s.id===sa.id).activeTurn?.state==='unknown');
  assert.notEqual((await request('history',{sessionId:sa.id,beforeSeq:0})).events.at(-1).event.type,'turn_end');
  await reviewUnknown(sa.id,(await state()).sessions.find(s=>s.id===sa.id).activeTurn.id);
  record('unknown_write_is_inspected_locally_and_closed_through_actual_review_dialog_without_replay');
  await click('connect');await until(async()=>(await state()).connection==='disconnected');await click('project-'+b.id);await click('session-'+sb.id);
  await until(()=>js(`document.querySelector('[data-testid="timeline"]')?.textContent.includes('/read notes.txt')`));
  assert.ok((await state()).projects.every(p=>p.permission.mode==='revoked'));await mode('read');await mode('revoked');
  record('offline_project_switch_history_and_local_permissions_work_without_remote_session_service');
 }catch(e){failure=e;console.error(e.stack);}
 await writeFile('/srv/anywhere-lab/artifacts/desktop-d2-ui-smoke.json',JSON.stringify({passed:!failure,realCli:false,results,recoveredPriorTests:recovered,error:failure?.stack??null},null,2));app.quit();if(failure)throw failure;
}
