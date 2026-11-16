import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function smoke({ app, win, request, ready }) {
  const results = [], record = name => { results.push({ name, passed: true }); console.log(name); };
  const js = script => win.webContents.executeJavaScript(script, true);
  async function until(fn, ms = 45000) { const end = Date.now() + ms; while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(200); } throw Error('UI_WAIT_TIMEOUT'); }
  const click = async id => { await until(() => js(`Boolean(document.querySelector('[data-testid="${id}"]') && !document.querySelector('[data-testid="${id}"]').disabled)`)); await js(`document.querySelector('[data-testid="${id}"]').click()`); };
  const setMode = async mode => { await click('mode-' + mode); if (mode === 'execute') await click('confirm-execute'); await until(async () => (await request('state', {})).permission.mode === mode); };
  const newJob = async action => {
    const previous = new Set((await request('state', {})).tasks.map(t => t.id)); await click('run-' + action);
    return until(async () => (await request('state', {})).tasks.find(t => !previous.has(t.id) && t.action === action));
  };
  const finish = async (task, expected = 'succeeded') => {
    const result = await until(async () => { const t = await request('task', { id: task.id });
      if (t.done && !['succeeded','cancelled','reviewed'].includes(t.state)) throw Error('TASK_FAILED: ' + JSON.stringify(t));
      return t.consumed && t;
    }); assert.equal(result.state, expected); return result;
  };
  let failure;
  try {
    await until(ready);
    const prefs = win.webContents.getLastWebPreferences();
    assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false);
    const rendererStatus = await readFile(`/proc/${win.webContents.getOSProcessId()}/status`, 'utf8');
    assert.match(rendererStatus, /^NoNewPrivs:\s+1$/m); assert.match(rendererStatus, /^Seccomp:\s+2$/m);
    assert.deepEqual(await js(`({node:typeof window.require,process:typeof window.process,bridge:Object.keys(window.desktop).sort()})`),
      { node: 'undefined', process: 'undefined', bridge: ['cancel','connect','disconnect','permission','review','reviewPreview','run','state','task'].sort() });
    assert.equal(await js(`fetch('https://example.com').then(()=>false,()=>true)`), true);
    record('renderer_sandbox_context_isolation_no_node_and_csp_blocks_network');
    await setMode('read'); await click('connect');
    await until(async () => (await request('state', {})).connection === 'connected');
    await finish(await newJob('read'));
    await setMode('edit'); await finish(await newJob('edit'));
    record('renderer_buttons_drive_real_mcp_read_and_edit');
    await setMode('execute'); const build = await newJob('build'); await finish(build);
    await until(() => js(`document.querySelector('[data-testid="task-output"]')?.textContent.includes('BUILD_OK')`));
    await until(() => js(`document.querySelector('[data-testid="task-${build.id}"]')?.textContent.includes('已完成')`));
    await until(() => js(`document.querySelector('[data-testid="task-state"]')?.textContent.includes('已完成 · 结果已保存')`));
    await writeFile('/srv/anywhere-lab/artifacts/desktop-d-build.png', (await win.webContents.capturePage()).toPNG());
    record('execute_confirmation_build_output_and_persisted_history_visible');
    const long = await newJob('long');
    await until(async () => (await request('task', { id: long.id })).state === 'running');
    await sleep(1500); await click('cancel');
    await finish(long, 'cancelled');
    record('renderer_cancel_confirms_completion');
    await finish(await newJob('read'));
    await exec('sudo',['-n','-u','anywhere-exec-agent','python3','-c',`from pathlib import Path;Path('/srv/anywhere-lab/desktop-d/agent/fault.json').write_text('{"point":"agent_before_result"}')`]);
    const unknown = await newJob('edit');
    await until(async () => (await exec('systemctl',['show','--value','-p','ActiveState','anywhere-desktop-agent.service'])).stdout.trim() === 'failed');
    await exec('sudo',['-n','systemctl','start','anywhere-desktop-agent.service']);
    await until(async () => (await request('task', { id: unknown.id })).state === 'unknown');
    const observed = (await exec('sudo',['-n','-u','anywhere-exec-agent','cat','/srv/anywhere-lab/desktop-d/workspace/notes.txt'])).stdout;
    assert.match(observed, /桌面编辑验证/);
    await setMode('revoked'); await click('review-open');
    await until(() => js(`Boolean(document.querySelector('[data-testid="review-note"]'))`));
    await js(`{const el=document.querySelector('[data-testid="review-note"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'已在本地检查 notes.txt，追加内容存在；保留未知结果，关闭记录，不重试。');el.dispatchEvent(new Event('input',{bubbles:true}));}`);
    await click('review-submit'); await finish(unknown, 'reviewed');
    await until(() => js(`!document.querySelector('[data-testid="review-note"]')`));
    await sleep(800); await writeFile('/srv/anywhere-lab/artifacts/desktop-d-review.png', (await win.webContents.capturePage()).toPNG());
    record('renderer_local_review_dialog_saves_observation_without_claiming_success');
    await click('connect');
    await until(async () => { const s = await request('state', {}); return s.connection === 'disconnected' && s.permission.mode === 'revoked'; });
    await setMode('read');
    assert.equal((await request('state', {})).permission.mode, 'read');
    await setMode('revoked');
    record('disconnect_revokes_and_offline_permission_controls_remain_usable');
  } catch (e) { failure = e; }
  await writeFile('/srv/anywhere-lab/artifacts/desktop-d-ui-smoke.json', JSON.stringify({ passed: !failure, realCli: false, results, error: failure?.stack ?? null }, null, 2));
  app.quit(); if (failure) throw failure;
}
