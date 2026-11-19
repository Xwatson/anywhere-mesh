const el=id=>document.getElementById(id);
const native=window.desktopDevice;
function node(tag,value,cls) {
  const n=document.createElement(tag);if(value!==undefined) n.textContent=value;if(cls)n.className=cls;return n;
}
const errors={DEVICE_OFFLINE:'绑定设备已离线。设备上线后可继续此会话。',LOGIN_REQUIRED:'请重新登录。',INVALID_CREDENTIALS:'账号或密码错误。',DEVICE_DISABLED:'此设备已由管理员停用。',LOGIN_THROTTLED:'登录尝试过多，请稍后重试。',LOCAL_PERMISSION_REQUIRED:'请在执行设备上授予此项目所需的权限。',WORKSPACE_NOT_READY:'项目正在同步或有未完成任务。',READ_FILE_BEFORE_EDIT:'请先在当前会话读取这个文件。'};
errors.TOOL_UNAVAILABLE_ON_DEVICE='这台设备尚未支持此工具。';
errors.UNSUPPORTED_DEVICE_PERMISSION='这台设备当前支持只读授权。';
errors.WINDOWS_TUNNEL_NOT_READY='Windows 客户端尚未连上服务端，请稍后再登录。';
const msg=e=>Object.entries(errors).find(([k])=>String(e.message).includes(k))?.[1]??String(e.message);
async function action(method,p={}) {
  if(native) return native.request(method,p);
  let path,body;
  switch(method) {
    case 'login':path='/api/auth/login';body=p;break;
    case 'logout':path='/api/auth/logout';body={};break;
    case 'state':path='/api/state';break;
    case 'admin':path='/api/admin/devices';break;
    case 'disable':path='/api/admin/devices/'+p.id;body={disabled:p.disabled};break;
    case 'history':path='/api/sessions/'+p.sessionId+'/events?afterSeq='+p.afterSeq;break;
    case 'send':path='/api/sessions/'+p.sessionId+'/messages';body={requestId:p.requestId,text:p.text};break;
    case 'stop':path='/api/sessions/'+p.sessionId+'/stop';body={requestId:p.requestId,turnId:p.turnId};break;
    default:throw Error('此操作需要桌面客户端。');
  }
  const res=await fetch(path,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',
    ...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
  const value=await res.json();if(!res.ok)throw Error(value.error);return value;
}
let state=null,selected=null,tab=native?'sessions':'admin',online=false,busy=false,refreshing=false,generation=0;
let fleet=[],history=[],seq=0,epoch=null;
let proposedMode=null;
const nameOf=d=>d.name+' · '+d.id.slice(0,6);
const status=d=>!online?'状态未知':d.disabled?'已停用':d.online?'在线':'离线';
const seen=d=>d.lastSeen?'最近在线 '+new Date(d.lastSeen).toLocaleString():'暂无在线记录';
function notify(message='') {el('error').hidden=!message;el('error').textContent=message;}
function clearConversation() {generation++;history=[];seq=0;epoch=null;el('events').replaceChildren();}
function draftKey() {return state?.user && selected ? 'device-draft:'+state.user.id+':'+selected : null;}
function draft() {try{return JSON.parse(sessionStorage.getItem(draftKey()))??{};}catch{return {};}}
function choose(id) {if(id===selected)return;selected=id;clearConversation();el('draft').value=draft().text??'';}
function loginView(localName) {
  state=null;online=false;fleet=[];proposedMode=null;choose(null);clearConversation();tab=native?'sessions':'admin';
  el('signin').hidden=false;el('app').hidden=true;el('account').textContent='';
  el('entry').textContent=localName?'登录后将连接本机 MCP · '+localName:native?'登录后将连接本机 MCP':'服务端管理';
  for(const id of ['fleet','devices','sessions','session-title','target','notice']) el(id).replaceChildren();
}
function renderFleet() {
  const t=node('table'),h=node('tr');for(const x of ['账号','设备','状态','绑定会话','接入权限'])h.append(node('th',x));t.append(h);
  for(const d of fleet) {
    const r=node('tr'), identity=node('td',nameOf(d)),s=node('td',status(d),d.online?'online':'offline');
    s.append(node('small',seen(d),'small line'));
    const button=node('button',d.disabled?'恢复接入':'停用接入');
    button.disabled=busy || !online;
    button.onclick=()=>run(()=>action('disable',{id:d.id,disabled:!d.disabled}));
    const op=node('td');op.append(button);
    r.append(node('td',d.username),identity,s,node('td',d.sessions.map(x=>x.title).join('、')||'—'),op);t.append(r);
  }
  el('fleet').className='scroll';el('fleet').replaceChildren(fleet.length?t:node('p','还没有登录过的设备。'));
}
function render() {
  if(!state?.user)return;
  const device=state.devices.find(d=>d.id===state.deviceId);
  el('signin').hidden=true;el('app').hidden=false;
  el('account').textContent=state.user.username+(device?' · '+device.name:' · 网页端');
  el('logout').disabled=busy;
  el('admin-nav').hidden=!state.user.isAdmin;
  if(tab==='admin'&&!state.user.isAdmin)tab='sessions';
  el('management').hidden=tab!=='admin';el('chat').hidden=tab==='admin';
  el('devices').replaceChildren(...state.devices.map(d=>{
    const li=node('li',nameOf(d));li.append(node('small',status(d)+(d.id===state.deviceId?' · 本机':''),'line '+(online&&d.online?'online':'offline')));
    li.title=seen(d);if(!d.online)li.append(node('small',seen(d),'small line'));return li;
  }));
  el('sessions').replaceChildren(...state.sessions.map(s=>{
    const d=state.devices.find(d=>d.id===s.deviceId),li=node('li'),b=node('button',s.title,'row'+(s.id===selected?' selected':''));
    b.dataset.session=s.id;b.append(node('small',d?nameOf(d)+' · '+status(d):'设备未知','small line'));
    b.onclick=()=>{tab='sessions';choose(s.id);render();void refresh();};li.append(b);return li;
  }));
  const mine=state.projects.filter(p=>p.deviceId===state.deviceId);
  const previous=el('project').value;
  el('project').replaceChildren(...mine.map(p=>new Option(p.label,p.id)));
  if(mine.some(p=>p.id===previous))el('project').value=previous;
  el('create').hidden=!native||!mine.length;el('grant').hidden=el('create').hidden;
  const local=mine.find(p=>p.id===el('project').value);
  for(const option of el('mode').options) option.disabled=Boolean(local?.localModes && !local.localModes.includes(option.value));
  const appliedMode=local?.localMode??local?.mode;
  if(local)el('mode').value=proposedMode?.id===local.id?proposedMode.mode:appliedMode;
  el('apply').disabled=!local||busy||el('mode').value===appliedMode;
  el('create').querySelector('button').disabled=busy||!online;
  const s=state.sessions.find(s=>s.id===selected);
  const d=s && state.devices.find(d=>d.id===s.deviceId),w=s && state.projects.find(p=>p.id===s.workspaceId);
  el('empty').hidden=Boolean(s);el('conversation').hidden=!s;
  if(s && d) {
    el('recipient').textContent=state.chatEngine==='codex'?'发给 Codex':'发给模拟宿主';
    el('draft').placeholder=state.chatEngine==='codex'?'例如：请读取 notes.txt 的第一行':'/read notes.txt';
    el('session-title').textContent=s.title;
    el('target').textContent='执行设备 · '+nameOf(d)+'  /  '+(w?.label??'未知项目');
    el('presence').textContent=status(d);el('presence').className=online&&d.online?'online':'offline';el('presence').title=seen(d);
    const other=device?.id!==d.id;
    el('notice').textContent=!online?'服务端暂时不可达，设备状态待确认。':
      '此会话只能操作「'+nameOf(d)+'」。'+(other?(device?'你当前在「'+nameOf(device)+'」。':'你当前在网页端。'):'')+
      (!d.online?(d.disabled?'设备已停用。':'设备离线。')+'可查看历史，上线后可继续。':
        !w?.ready?'项目正在连接。':w.mode==='revoked'?'请在执行设备上授权项目。':'');
    el('notice').hidden=!other&&online&&d.online&&w?.ready&&w.mode!=='revoked';
    el('send').disabled=busy||!online||!d.online||!w?.ready||w.mode==='revoked'||Boolean(s.activeTurn)||!el('draft').value.trim();
    el('stop').hidden=!s.activeTurn;el('stop').disabled=busy||!online||s.activeTurn?.cancelRequested;
  }
  if(tab==='admin')renderFleet();
}
function renderHistory() {
  const items=history.filter(r=>['user_message','tool_call','assistant_text'].includes(r.event.type)||(r.event.type==='turn_end'&&!r.event.ok));
  const lastTool=new Map(items.filter(r=>r.event.type==='tool_call').map(r=>[r.event.id,r.seq]));
  el('events').replaceChildren(...items.filter(r=>r.event.type!=='tool_call'||lastTool.get(r.event.id)===r.seq).map(({event:e})=>{
    const n=node('article');n.dataset.type=e.type;
    n.append(node('strong',e.type==='user_message'?'你':e.type==='tool_call'?e.name:e.type==='turn_end'?'回合状态':e.engine==='codex'?'Codex':'助手'));
    n.append(node('pre',e.type==='tool_call'?(e.output??e.status):(e.text??e.error??'')));return n;
  }));
}
async function refresh() {
  if(refreshing)return;refreshing=true;const started=generation;
  try {
    const s=await action('state');
    if(started!==generation)return;
    if(!s.user){loginView(s.localName);return;}
    state=s;online=true;
    if(selected&&!s.sessions.some(x=>x.id===selected))choose(null);
    if(!selected&&s.sessions.length)choose(s.sessions[0].id);
    const id=selected,version=generation;
    if(tab==='admin'&&s.user.isAdmin) {const list=await action('admin');if(version!==generation)return;fleet=list;}
    render();
    if(id && tab==='sessions') {
      const target=s.sessions.find(s=>s.id===id);
      if(target.lastSeq===seq && target.historyEpoch===epoch)return;
      const p=await action('history',{sessionId:id,afterSeq:seq});
      if(version!==generation || selected!==id)return;
      if(p.sessionId!==id || p.workspaceId!==target.workspaceId || p.historyEpoch!==target.historyEpoch ||
          (epoch&&p.historyEpoch!==epoch) || !p.events.every((r,i)=>r.seq===seq+i+1)) throw Error('会话历史需要重新同步');
      epoch=p.historyEpoch;history.push(...p.events);seq=p.throughSeq;renderHistory();
    }
  } catch(e) {
    if(started!==generation)return;
    if(e.message.includes('LOGIN_REQUIRED')) {loginView();return;}
    online=false;render();if(state)notify(msg(e));
  } finally {refreshing=false;}
}
async function run(fn) {
  if(busy)return;busy=true;render();notify();el('login-error').textContent='';
  try {await fn();await refresh();}
  catch(e){if(!state)el('login-error').textContent=msg(e);else notify(msg(e));}
  finally{busy=false;render();}
}
el('login').onsubmit=e=>{e.preventDefault();void run(async()=>{
  const password=el('password').value;el('password').value='';generation++;
  await action('login',{username:el('username').value.trim(),password});
});};
el('logout').onclick=()=>run(async()=>{await action('logout');loginView();});
for(const t of ['sessions','admin'])el(t+'-nav').onclick=()=>{tab=t;render();void refresh();};
el('project').onchange=()=>{proposedMode=null;render();};
el('mode').onchange=()=>{proposedMode={id:el('project').value,mode:el('mode').value};render();};
el('apply').onclick=()=>run(async()=>{
  const mode=el('mode').value;
  if(mode==='execute'&&!window.confirm('允许远端在此本机项目中执行命令并修改文件？'))return;
  await action('permission',{workspaceId:el('project').value,mode});
  proposedMode=null;
});
el('create').onsubmit=e=>{e.preventDefault();void run(async()=>{
  const s=await action('create',{workspaceId:el('project').value,title:el('title').value.trim(),requestId:crypto.randomUUID()});
  el('title').value='';choose(s.id);
});};
el('draft').oninput=()=>{
  if(selected)sessionStorage.setItem(draftKey(),JSON.stringify({text:el('draft').value}));render();
};
el('compose').onsubmit=e=>{e.preventDefault();if(el('send').disabled)return;void run(async()=>{
  const id=selected,key=draftKey(),p=draft(),requestId=p.requestId??crypto.randomUUID(),text=el('draft').value;
  sessionStorage.setItem(key,JSON.stringify({requestId,text}));
  await action('send',{sessionId:id,requestId,text});sessionStorage.removeItem(key);if(selected===id)el('draft').value='';
});};
el('stop').onclick=()=>run(()=>action('stop',{sessionId:selected,turnId:state.sessions.find(s=>s.id===selected).activeTurn.id,requestId:crypto.randomUUID()}));
loginView();void refresh();setInterval(refresh,1250);
