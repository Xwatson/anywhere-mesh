import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { X509Certificate, randomUUID } from 'node:crypto';
import { control } from '../../execution/control.mjs';

export async function smoke({app,win,BrowserWindow,session,wan=false}) {
  const profile=wan?'wan':'d3';
  const base='/srv/anywhere-lab/'+profile,art='/srv/anywhere-lab/artifacts/'+profile+'-';
  const url=new URL(wan?'https://10.203.73.2:18443/':'https://10.126.10.2:8443/');
  const [admin,member]=JSON.parse(readFileSync(base+'/test/accounts.json')).map(({username,password})=>({username,password}));
  const A=(m,p={})=>control(base+'/local/a/control.sock',m,p);
  const B=(m,p={})=>control(base+'/local/b/control.sock',m,p);
  const wait=async(fn,ms=wan?60000:30000)=>{
    const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,200));}throw Error('UI timeout '+fn.toString().slice(0,120));
  };
  const js=(w,s)=>w.webContents.executeJavaScript(s,true);
  const screenshot=async(w,file)=>writeFileSync(art+file,(await w.webContents.capturePage()).toPNG());
  const formLogin=(w,u)=>js(w,`document.getElementById('username').value=${JSON.stringify(u.username)};
    document.getElementById('password').value=${JSON.stringify(u.password)};
    document.getElementById('login').requestSubmit();void 0`);
  const checks=[];let browser;
  try {
    await A('logout');await B('logout');const a=await A('login',member);
    const pa=(await A('state')).projects.find(p=>p.deviceId===a.deviceId);
    await A('permission',{workspaceId:pa.id,mode:'read'});
    await wait(async()=>(await A('state')).projects.some(p=>p.id===pa.id&&p.ready&&p.mode==='read'));
    const s=await A('create',{workspaceId:pa.id,requestId:randomUUID(),title:'A 上的开发会话 · '+new Date().toISOString().slice(11,19)});
    await wait(()=>js(win,"document.getElementById('entry').textContent.includes('设备 B')"));
    await formLogin(win,member);
    const select=JSON.stringify('[data-session="'+s.id+'"]');
    await wait(()=>js(win,'!!document.querySelector('+select+')'));
    await js(win,'document.querySelector('+select+').click()');
    await wait(()=>js(win,"document.getElementById('notice').textContent.includes('当前在「设备 B') && document.getElementById('target').textContent.includes('设备 A') && document.getElementById('presence').textContent==='在线'"));
    assert.equal(await js(win,"document.getElementById('mode').value"),'revoked');
    await js(win,"const draft=document.getElementById('draft');draft.value='/read notes.txt';draft.dispatchEvent(new Event('input'));void 0");
    await wait(()=>js(win,"!document.getElementById('send').disabled"));
    await js(win,"document.getElementById('send').click()");
    await wait(()=>js(win,"document.getElementById('events').textContent.includes('ONLY_DEVICE_A')"));
    assert.ok(!await js(win,"document.getElementById('events').textContent.includes('ONLY_DEVICE_B')"));
    await screenshot(win,'device-b-online.png');checks.push('B 登录后从会话页读取 A 的文件，提示和在线状态可见');
    await A('logout');
    await wait(()=>js(win,"document.getElementById('presence').textContent==='离线' && document.getElementById('events').textContent.includes('ONLY_DEVICE_A')"));
    await js(win,"document.getElementById('draft').value='/read notes.txt';document.getElementById('draft').dispatchEvent(new Event('input'))");
    assert.ok(await js(win,"document.getElementById('send').disabled"));
    await screenshot(win,'device-b-offline.png');checks.push('A 离线后会话页保留历史，非空指令禁止发送');
    const cert=wan?'/etc/anywhere-wan-cn/server.crt':'/etc/anywhere-desktop2/desktop/host.crt';
    const isolated=session.fromPartition('device-admin-test'),pin=new X509Certificate(readFileSync(cert)).fingerprint256;
    isolated.setCertificateVerifyProc((req,cb)=>{
      cb(req.hostname===url.hostname && new X509Certificate(req.certificate.data).fingerprint256===pin ? 0 : -2);
    });
    browser=new BrowserWindow({show:false,width:1180,height:780,webPreferences:{session:isolated,sandbox:true,contextIsolation:true,nodeIntegration:false}});
    await browser.loadURL(url.href);
    await formLogin(browser,admin);
    await wait(()=>js(browser,"!document.getElementById('management').hidden && document.getElementById('fleet').textContent.includes('lab-coder')"));
    assert.ok(await js(browser,"document.getElementById('fleet').textContent.includes('最近在线') && document.getElementById('fleet').textContent.includes('A 上的开发会话')"));
    await screenshot(browser,'server-management.png');
    const rowCode=`[...document.querySelectorAll('#fleet tr')].find(r=>r.innerText.includes('lab-coder') && r.innerText.includes('设备 A'))`;
    await js(browser,rowCode+".querySelector('button').click()");
    await wait(()=>js(browser,rowCode+".textContent.includes('恢复接入')"));
    await js(browser,rowCode+".querySelector('button').click()");
    await wait(()=>js(browser,rowCode+".textContent.includes('停用接入')"));
    checks.push('用独立浏览器身份登录服务端管理页，查看账号、设备、会话并停用和恢复接入');
    await js(browser,"document.getElementById('logout').click()");
    await js(win,"document.getElementById('logout').click()");
    await wait(()=>js(win,"!document.getElementById('signin').hidden"));
    writeFileSync(art+'gui.json',JSON.stringify({passed:true,at:new Date().toISOString(),checks},null,2)+'\n');
  } catch(e) {
    writeFileSync(art+'gui.json',JSON.stringify({passed:false,error:e.message,checks},null,2)+'\n');
    await screenshot(browser??win,'gui-diagnostic.png').catch(()=>{});throw e;
  } finally {
    browser?.destroy();await Promise.allSettled([A('logout'),B('logout')]);app.quit();
  }
}
