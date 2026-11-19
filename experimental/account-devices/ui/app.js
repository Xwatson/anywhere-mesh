import {element, icon, renderThread} from './thread.js';

const $ = id => document.getElementById(id);
const native = window.desktopDevice;
const narrow = matchMedia('(max-width: 720px)');
const modes = {
  revoked: ['未授权', '项目文件访问已关闭。'],
  read: ['只读', '允许读取本项目的文件。'],
  edit: ['编辑', '允许读取和修改本项目的文件。'],
  execute: ['执行', '允许修改文件，并在本项目中运行命令。']
};
const errors = {
  DEVICE_OFFLINE: '执行设备已离线，草稿已保留。', LOGIN_REQUIRED: '请重新登录。',
  INVALID_CREDENTIALS: '账号或密码不正确。', DEVICE_DISABLED: '管理员已停用这台设备。',
  LOGIN_THROTTLED: '登录尝试过多，请稍后重试。', LOCAL_PERMISSION_REQUIRED: '请在执行设备上给项目授权。',
  WORKSPACE_NOT_READY: '项目正在同步或有任务在运行，请稍后重试。', READ_FILE_BEFORE_EDIT: '请先在本次会话中读取文件。',
  TOOL_UNAVAILABLE_ON_DEVICE: '这台设备暂不支持该操作。', UNSUPPORTED_DEVICE_PERMISSION: '这台设备不支持所选权限。',
  WINDOWS_TUNNEL_NOT_READY: '设备仍在连接服务端，请稍后重试。', SESSION_LIMIT: '此账号已达到实验环境的会话上限。',
  DESKTOP_REQUEST_TIMEOUT: '连接超时，请重试。', SESSION_BUSY: '请等当前回复结束后再发送。'
};
const message = e => Object.entries(errors).find(([key]) => String(e.message).includes(key))?.[1] ?? String(e.message);

async function action(method, p = {}) {
  if (native) return native.request(method, p);
  let path, body;
  switch (method) {
    case 'login': path = '/api/auth/login'; body = p; break;
    case 'logout': path = '/api/auth/logout'; body = {}; break;
    case 'state': path = '/api/state'; break;
    case 'admin': path = '/api/admin/devices'; break;
    case 'disable': path = '/api/admin/devices/' + p.id; body = {disabled: p.disabled}; break;
    case 'history': path = '/api/sessions/' + p.sessionId + '/events?afterSeq=' + p.afterSeq; break;
    case 'send': path = '/api/sessions/' + p.sessionId + '/messages'; body = {requestId: p.requestId, text: p.text}; break;
    case 'stop': path = '/api/sessions/' + p.sessionId + '/stop'; body = {requestId: p.requestId, turnId: p.turnId}; break;
    default: throw Error('请在桌面客户端操作。');
  }
  const response = await fetch(path, {method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
    ...(body ? {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)} : {})});
  const data = await response.json();
  if (!response.ok) throw Error(data.error || '连接失败。');
  return data;
}

let state, selected, projectId, tab = 'chat', online = false, busy = false, generation = 0, polling;
let localConnectUntil = 0;
let rows = [], seq = 0, epoch, sidebarKey, searchKey, fleetKey, deviceKey;
let fleet = [], consent, projectSource;
const groups = new Map(), unfolded = new Set();
const mine = () => state.projects.filter(p => native && p.deviceId === state.deviceId);
const projectById = id => state.projects.find(p => p.id === id);
const deviceById = id => state.devices.find(d => d.id === id);
const thread = () => state?.sessions.find(s => s.id === selected);
const project = () => projectById(thread()?.workspaceId ?? projectId);
const isLocal = p => Boolean(native && p && p.deviceId === state.deviceId);
const connecting = d => d && !d.disabled && !d.online && d.id === state?.deviceId && Date.now() < localConnectUntil;
const status = d => !online ? '状态未知' : !d ? '未连接' : d.disabled ? '已停用' : d.online ? '在线' : connecting(d) ? '连接中' : '离线';
const deviceName = d => d ? d.name + ' · ' + d.id.slice(0, 6) : '未知设备';
const lastSeen = d => d.lastSeen ? '最近在线 ' + new Date(d.lastSeen).toLocaleString('zh-CN', {hour12:false}) : '暂无在线记录';
const activeDialog = () => document.querySelector('dialog[open]');

function notify(text = '') {
  const box = $('error');
  box.textContent = text;
  box.hidden = !text;
}

function keyFor(id = selected, workspace = projectId) {
  if (!state?.user || (!id && !workspace)) return null;
  return 'device-draft:' + state.user.id + ':' + (id || 'new:' + workspace);
}
function draftAt(key) {
  try { return JSON.parse(sessionStorage.getItem(key)) || {}; } catch { return {}; }
}
function saveDraft(key, entry) {
  if (!key) return;
  if (entry.text || entry.createId) sessionStorage.setItem(key, JSON.stringify(entry));
  else sessionStorage.removeItem(key);
}
function resetHistory() {
  generation++;
  rows = []; seq = 0; epoch = null;
  $('events').replaceChildren();
}
function select(id) {
  if (id !== selected) resetHistory();
  selected = id;
  const s = thread();
  if (s && id) {
    groups.set(s.workspaceId, true);
    const index = state.sessions.filter(t => t.workspaceId === s.workspaceId).findIndex(t => t.id === id);
    if (index >= 4) unfolded.add(s.workspaceId);
  }
  $('draft').value = draftAt(keyFor()).text ?? '';
}

function drawer(open) {
  const isOpen = Boolean(open && narrow.matches);
  $('app').classList.toggle('drawer', isOpen);
  $('rail-scrim').hidden = !isOpen;
  document.querySelector('.workspace').inert = isOpen;
  if (isOpen) $('hide-rail').focus();
}
function openThread(id) {
  if (busy) return;
  activeDialog()?.close();
  drawer(false);
  tab = 'chat';
  select(id);
  notify();
  render();
  if (!narrow.matches && (id || native)) $('draft').focus({preventScroll:true});
  void refresh(true);
}
function showDialog(id) {
  activeDialog()?.close();
  drawer(false);
  const dialog = $(id);
  const error = dialog.querySelector('.dialog-error');
  if (error) error.textContent = '';
  dialog.showModal();
}
function loginView(localName) {
  if (state || !$('app').hidden) {
    activeDialog()?.close();
    drawer(false);
    resetHistory();
    selected = projectId = consent = null;
    sidebarKey = searchKey = fleetKey = deviceKey = null;
    groups.clear(); unfolded.clear(); fleet = [];
    for (const id of ['sessions','devices','fleet','search-results','signed-user','account','notice','session-title','project','mode','consent-copy']) $(id).replaceChildren();
    $('draft').value = '';
    tab = 'chat';
  }
  state = null; online = false;
  $('app').hidden = true; $('signin').hidden = false;
  $('entry').textContent = localName ? '连接设备 · ' + localName : native ? '登录后继续本机项目的对话。' : '使用你的 Anywhere 账号继续。';
}

function sidebar() {
  const fingerprint = JSON.stringify([selected, projectId, state.sessions.map(s => [s.id,s.title,s.workspaceId,Boolean(s.activeTurn)]),
    state.projects.map(p => [p.id,p.label,p.deviceId]), state.devices.map(d => [d.id,d.name]), [...groups], [...unfolded]]);
  if (fingerprint === sidebarKey) return;
  sidebarKey = fingerprint;
  const focus = document.activeElement?.closest('#sessions button')?.dataset;
  const parts = document.createDocumentFragment();
  const projects = [...state.projects].sort((a,b) => Number(isLocal(b)) - Number(isLocal(a)));
  const labels = projects.map(p => p.label);
  for (const p of projects) {
    const sessions = state.sessions.filter(s => s.workspaceId === p.id);
    if (!sessions.length && !isLocal(p)) continue;
    const group = element('section', undefined, 'project-group');
    const toggle = element('button', undefined, 'group-toggle');
    const open = groups.get(p.id) ?? (isLocal(p) || p.id === thread()?.workspaceId);
    toggle.dataset.group = p.id;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.title = p.label + ' · ' + deviceName(deviceById(p.deviceId));
    toggle.append(icon('folder'), element('span', p.label, 'group-title'));
    if (labels.filter(l => l === p.label).length > 1) toggle.append(element('span', deviceById(p.deviceId)?.name, 'group-host'));
    toggle.append(icon('down'));
    toggle.onclick = () => { groups.set(p.id, !open); sidebar(); };
    group.append(toggle);
    if (open) {
      const list = element('div', undefined, 'thread-list');
      const visible = unfolded.has(p.id) ? sessions : sessions.slice(0,4);
      for (const s of visible) {
        const b = element('button', undefined, 'thread-row');
        b.dataset.session = s.id; b.title = s.title;
        b.append(element('span', s.title));
        if (s.activeTurn) { const dot = element('i'); dot.setAttribute('aria-label','处理中'); b.append(dot); }
        if (selected === s.id && tab === 'chat') b.setAttribute('aria-current','page');
        b.onclick = () => openThread(s.id);
        list.append(b);
      }
      if (!sessions.length) list.append(element('p', '还没有会话', 'list-empty'));
      if (sessions.length > 4) {
        const more = element('button', unfolded.has(p.id) ? '收起' : '查看全部 ' + sessions.length + ' 个会话', 'group-more');
        more.dataset.more = p.id;
        more.onclick = () => { if (unfolded.has(p.id)) unfolded.delete(p.id); else unfolded.add(p.id); sidebar(); };
        list.append(more);
      }
      group.append(list);
    }
    parts.append(group);
  }
  if (!parts.childNodes.length) parts.append(element('p', '暂无项目会话', 'list-empty'));
  $('sessions').replaceChildren(parts);
  if (focus) for (const key of ['group','session','more']) {
    if (focus[key]) $('sessions').querySelector('[data-' + key + '="' + CSS.escape(focus[key]) + '"]')?.focus({preventScroll:true});
  }
}

function searchResults() {
  const query = $('search-input').value.trim().toLocaleLowerCase();
  const matches = state.sessions.filter(s => [s.title, projectById(s.workspaceId)?.label, deviceById(s.deviceId)?.name]
    .some(value => value?.toLocaleLowerCase().includes(query)));
  const key = JSON.stringify([query, matches.map(s => [s.id,s.title,projectById(s.workspaceId)?.label,deviceById(s.deviceId)?.name])]);
  if (key === searchKey) return;
  searchKey = key;
  const list = matches.map(s => {
    const result = element('button', undefined, 'result-row'), text = element('span');
    result.dataset.session = s.id;
    text.append(element('strong',s.title), element('small',[projectById(s.workspaceId)?.label,deviceById(s.deviceId)?.name].filter(Boolean).join(' · ')));
    result.append(icon('chat'),text);
    result.onclick = () => openThread(s.id);
    return result;
  });
  $('search-results').replaceChildren(...(list.length ? list : [element('p', query ? '没有找到匹配的会话。' : '还没有会话。', 'list-empty')]));
}
function openSearch() {
  if (!state || busy) return;
  $('search-input').value = ''; searchKey = null;
  searchResults(); showDialog('search-dialog'); $('search-input').focus();
}

function renderDevices() {
  const key = JSON.stringify([online,state.deviceId,state.devices.map(d => [d.id,d.name,status(d),d.online ? null : d.lastSeen])]);
  if (key === deviceKey) return;
  deviceKey = key;
  const entries = state.devices.map(d => {
    const box = element('div', undefined, 'device-row');
    const identity = element('div'), badge = element('span', undefined, 'device-state');
    identity.append(element('strong', d.name + (d.id === state.deviceId ? ' · 本机' : '')),
      element('small', d.online ? '设备 ' + d.id.slice(0,6) : lastSeen(d)));
    badge.append(element('i', undefined, 'dot ' + (d.online && online ? 'online' : 'offline')), document.createTextNode(status(d)));
    box.append(icon('dev'), identity, badge);
    return box;
  });
  $('devices').replaceChildren(...(entries.length ? entries : [element('p','还没有登录过的设备。','list-empty')]));
}
function renderFleet() {
  const key = JSON.stringify([online,busy,fleet.map(d => [d.id,d.name,d.username,d.disabled,d.online,d.online ? null : d.lastSeen,d.sessions])]);
  if (key === fleetKey) return;
  fleetKey = key;
  const table = element('table'), header = table.createTHead().insertRow(), body = table.createTBody();
  for (const text of ['账号','设备','状态','绑定会话','接入权限']) header.append(element('th',text));
  for (const d of fleet) {
    const row = body.insertRow(), presence = element('td', status(d));
    presence.append(element('small',lastSeen(d)));
    const button = element('button', d.disabled ? '恢复接入' : '停用接入', 'secondary');
    button.disabled = busy || !online;
    button.onclick = () => perform(() => action('disable',{id:d.id,disabled:!d.disabled}));
    const op = element('td'); op.append(button);
    row.append(element('td',d.username),element('td',deviceName(d)),presence,element('td',d.sessions.map(s => s.title).join('、') || '—'),op);
  }
  $('fleet').replaceChildren(fleet.length ? table : element('p','暂无设备记录。','list-empty'));
}

function controls() {
  const p = project(), d = p && deviceById(p.deviceId), t = thread()?.activeTurn;
  const localRevoked = isLocal(p) && (p.localMode ?? p.mode) === 'revoked';
  $('send').hidden = Boolean(t);
  $('stop').hidden = !t;
  $('stop').disabled = busy || !online || Boolean(t?.cancelRequested);
  $('draft').readOnly = busy;
  $('send').disabled = busy || !online || !d?.online || d.disabled || !p?.ready || Boolean(t) ||
    (!localRevoked && p.mode === 'revoked') || !$('draft').value.trim();
  $('context').disabled = busy || !p;
  $('logout').disabled = busy;
  $('allow-send').disabled = busy;
  $('cancel-consent').disabled = busy;
  $('apply').disabled = busy;
}

function render() {
  if (!state?.user) return;
  const s = thread(), p = project(), d = p ? deviceById(p.deviceId) : deviceById(state.deviceId);
  const webEmpty = !s && !native, home = !s;
  const engine = state.chatEngine === 'codex' ? 'Codex' : '项目助手';
  $('signin').hidden = true; $('app').hidden = false;
  $('account').textContent = state.user.username;
  $('avatar').textContent = [...state.user.username][0] || 'A';
  $('signed-user').textContent = state.user.username + ' · ' + (state.localName || '网页端');
  $('device-count').textContent = online ? state.devices.filter(d => d.online).length + ' 在线' : '';
  $('settings-project').hidden = !mine().length;
  $('admin-nav').hidden = !state.user.isAdmin;
  $('new-chat').hidden = !native;
  $('chat').hidden = tab !== 'chat'; $('management').hidden = tab !== 'admin';
  $('crumb-project').textContent = tab === 'chat' && s && p ? p.label : '工作区';
  $('session-title').textContent = tab === 'admin' ? '设备管理' : s?.title || (webEmpty ? '会话' : '新对话');
  $('session-title').title = $('session-title').textContent;
  $('target').textContent = d ? d.id === state.deviceId ? '本机' : d.name : '我的设备';
  $('presence').textContent = d ? status(d) : '';
  $('status-dot').className = 'dot ' + (d?.online && online ? 'online' : 'offline');
  $('status-dot').hidden = !d;
  $('device-status').title = d ? deviceName(d) + ' · ' + status(d) : '我的设备';
  let notice = '';
  const other = Boolean(s && d && !isLocal(p));
  if (!online) notice = '服务端暂时不可达，草稿已保留。';
  else if (other) notice = '此会话只会操作「' + deviceName(d) + '」上的项目。';
  if (online && d && !d.online && !connecting(d)) notice += '执行设备' + (d.disabled ? '已停用。' : '已离线。') + (s ? '仍可查看会话历史。' : '');
  else if (online && p && !p.ready && (s || !isLocal(p))) notice += '项目正在连接…';
  else if (online && other && p?.mode === 'revoked') notice += '请在该设备上授权。';
  else if (online && isLocal(p) && p.localMode && p.localMode !== p.mode) notice += '正在同步项目权限…';
  $('notice').textContent = notice;
  $('notice').hidden = !notice;
  $('notice').className = other && online && d?.online && p?.mode !== 'revoked' ? 'remote' : '';
  $('chat').classList.toggle('home',home);
  $('welcome').hidden = !home; $('welcome-title').textContent = webEmpty ? '从桌面开启对话' : '从哪里开始？';
  $('timeline').hidden = home; $('compose').hidden = webEmpty;
  $('web-empty').hidden = !webEmpty;
  $('web-devices').textContent = state.user.isAdmin ? '设备管理' : '查看设备';
  $('suggestions').hidden = !home || webEmpty;
  $('input-hint').hidden = home;
  $('project-label').textContent = s && p ? modes[p.localMode ?? p.mode]?.[0] ?? '项目权限' : p?.label ?? '暂无本机项目';
  $('context').querySelector('use').setAttribute('href', s ? '#i-lock' : '#i-folder');
  $('context').title = p ? '查看「' + p.label + '」项目与权限' : '暂无本机项目';
  $('engine-name').textContent = engine; $('recipient').textContent = '发给' + (state.chatEngine === 'codex' ? ' Codex' : engine);
  $('example-code').lastElementChild.textContent = state.chatEngine === 'codex' ? '解释代码' : '查看指令';
  $('draft').placeholder = home ? '描述任务，或问问项目里的代码…' : '继续对话…';
  $('working').hidden = !s?.activeTurn;
  $('working').lastElementChild.textContent = s?.activeTurn?.cancelRequested ? '正在停止…' : engine + ' 正在处理…';
  controls(); sidebar();
  if ($('devices-dialog').open) renderDevices();
  if ($('search-dialog').open) searchResults();
  if (tab === 'admin') renderFleet();
}

async function sync() {
  const version = generation;
  try {
    const latest = await action('state');
    if (version !== generation) return;
    if (!latest.user) { loginView(latest.localName); return; }
    const first = !state || state.user.id !== latest.user.id;
    if (first && state) loginView();
    state = latest; online = true;
    if (first) localConnectUntil = native ? Date.now() + 12000 : 0;
    if (deviceById(state.deviceId)?.online) localConnectUntil = 0;
    if (!mine().some(p => p.id === projectId)) projectId = mine()[0]?.id;
    if (first || (selected && !thread())) {
      select(!native ? state.sessions[0]?.id ?? null : null);
      if (first && !native && state.user.isAdmin && new URLSearchParams(location.search).get('view') === 'devices') tab = 'admin';
    }
    const id = selected, stamp = generation;
    render();
    if (first && native && !narrow.matches) $('draft').focus({preventScroll:true});
    if (tab === 'admin' && state.user.isAdmin) {
      const list = await action('admin');
      if (stamp === generation && tab === 'admin') { fleet = list; renderFleet(); }
    }
    const target = thread();
    if (!id || !target || tab !== 'chat' || (target.lastSeq === seq && target.historyEpoch === epoch)) return;
    if ((epoch && target.historyEpoch !== epoch) || target.lastSeq < seq) { rows = []; seq = 0; epoch = null; }
    const page = await action('history',{sessionId:id,afterSeq:seq});
    if (generation !== stamp || selected !== id) return;
    if (page.sessionId !== id || page.workspaceId !== target.workspaceId || page.historyEpoch !== target.historyEpoch ||
        !page.events.every((r,i) => r.seq === seq+i+1)) throw Error('会话记录正在重新同步。');
    const view = $('timeline');
    const pinned = !seq || view.scrollHeight - view.clientHeight - view.scrollTop < 72;
    epoch = page.historyEpoch; rows.push(...page.events); seq = page.throughSeq;
    renderThread($('events'), rows);
    if (pinned) view.scrollTop = view.scrollHeight;
  } catch (error) {
    if (version !== generation) return;
    if (error.message.includes('LOGIN_REQUIRED')) { loginView(); return; }
    online = false;
    if (state) render();
  }
}
async function refresh(force = false) {
  if (polling) { await polling; if (force) await refresh(); return; }
  polling = sync().finally(() => { polling = null; });
  return polling;
}
async function perform(fn) {
  if (busy) return;
  busy = true; render(); notify();
  $('login-error').textContent = ''; $('login-submit').disabled = true;
  try {
    await fn();
    await refresh(true);
  } catch (error) {
    const field = activeDialog()?.querySelector('.dialog-error');
    if (!state) $('login-error').textContent = message(error);
    else if (field) field.textContent = message(error);
    else notify(message(error));
  } finally {
    busy = false; $('login-submit').disabled = false; render();
  }
}

function openProject(fromAccount = false) {
  if (busy || !state) return;
  projectSource = fromAccount ? 'settings' : 'context';
  const bound = thread() && !fromAccount;
  const modalProjects = bound ? [project()].filter(Boolean) : mine();
  if (!modalProjects.length) return;
  const initial = modalProjects.find(p => p.id === (bound ? thread().workspaceId : projectId)) ?? modalProjects[0];
  $('project').replaceChildren(...modalProjects.map(p => new Option(p.label, p.id)));
  $('project').value = initial.id;
  $('project').disabled = modalProjects.length < 2;
  $('project-caption').textContent = bound ? '会话绑定项目' : '本机项目';
  showProject(initial.id); showDialog('project-dialog');
}
function showProject(id) {
  const p = projectById(id), local = isLocal(p), d = deviceById(p.deviceId);
  $('project-identity').textContent = deviceName(d) + ' · ' + status(d);
  $('grant').hidden = !local; $('remote-mode').hidden = local;
  $('remote-mode').textContent = '当前权限 · ' + (modes[p.mode]?.[0] ?? '未知') + '。请在执行设备上更改。';
  const allowed = p.localModes ?? Object.keys(modes);
  $('mode').replaceChildren(...allowed.map(m => new Option(modes[m][0], m)));
  $('mode').value = p.localMode ?? p.mode;
  updateMode();
}
function updateMode() {
  $('mode-description').textContent = modes[$('mode').value]?.[1] || '';
  const p = projectById($('project').value);
  $('apply').textContent = isLocal(p) && $('mode').value !== (p.localMode ?? p.mode) ? '保存权限' : '完成';
}
async function saveProject() {
  const p = projectById($('project').value), mode = $('mode').value;
  if (isLocal(p) && mode !== (p.localMode ?? p.mode)) {
    if (mode === 'execute' && !window.confirm('允许远端在此本机项目中执行命令并修改文件？')) return;
    await action('permission',{workspaceId:p.id,mode});
  }
  if (!selected && projectSource === 'context' && projectId !== p.id) {
    projectId = p.id; select(null);
  }
  $('project-dialog').close();
}

function rememberInput() {
  const key = keyFor(), old = draftAt(key);
  // A creation response can be lost. Keep its original id and title when the draft changes.
  saveDraft(key,{text:$('draft').value, ...(old.createId ? {createId:old.createId,title:old.title} : {}),
    ...(old.text === $('draft').value && old.requestId ? {requestId:old.requestId} : {})});
  controls();
}
function newTitle(text) {
  const first = text.trim().split(/\r?\n/,1)[0].replace(/\s+/g,' ');
  const chars = Array.from(first);
  return chars.length > 32 ? chars.slice(0,31).join('') + '…' : first;
}
async function sendMessage() {
  const p = project(), originalKey = keyFor(), text = $('draft').value;
  const entry = draftAt(originalKey);
  if (!p || !originalKey || !text.trim()) return;
  const requestId = entry.text === text && entry.requestId || crypto.randomUUID();
  let sessionId = selected;
  if (!sessionId) {
    if (!isLocal(p)) throw Error('请在桌面客户端新建对话。');
    const title = entry.title || newTitle(text), createId = entry.createId || crypto.randomUUID();
    saveDraft(originalKey,{text,requestId,title,createId});
    const s = await action('create',{requestId:createId,title,workspaceId:p.id});
    if (s.workspaceId !== p.id || s.deviceId !== state.deviceId) throw Error('会话绑定设备不一致。');
    state.sessions = [s,...state.sessions.filter(t => t.id !== s.id)];
    sessionId = s.id;
    saveDraft(keyFor(sessionId),{text,requestId});
    sessionStorage.removeItem(originalKey);
    select(sessionId); render();
  } else saveDraft(originalKey,{text,requestId});
  await action('send',{sessionId,requestId,text});
  sessionStorage.removeItem(keyFor(sessionId));
  if (selected === sessionId) $('draft').value = '';
  $('timeline').scrollTop = $('timeline').scrollHeight;
}
function requestSend() {
  if (busy || $('send').disabled || $('send').hidden) return;
  const p = project();
  if (isLocal(p) && (p.localMode ?? p.mode) === 'revoked') {
    consent = {key:keyFor(), project:p.id, user:state.user.id};
    $('consent-copy').textContent = '允许本次登录期间读取「' + p.label + '」中的文件。你可以随时在项目权限中撤销。';
    showDialog('consent-dialog');
  } else void perform(sendMessage);
}
async function allowAndSend() {
  const p = project(), approved = consent;
  if (!$('consent-dialog').open || !approved || approved.key !== keyFor() || approved.project !== p?.id || approved.user !== state.user.id || !isLocal(p)) throw Error('目标会话已改变，请重新发送。');
  const currentMode = p.localMode ?? p.mode;
  if (currentMode === 'revoked') await action('permission',{workspaceId:p.id,mode:'read'});
  const end = Date.now() + 18000;
  do {
    const next = await action('state');
    if (next.user?.id !== approved.user || next.deviceId !== p.deviceId) throw Error('LOGIN_REQUIRED');
    const scope = next.projects.find(w => w.id === p.id);
    if (scope?.ready && scope.mode !== 'revoked' && scope.localMode !== 'revoked') {
      state = next;
      $('consent-dialog').close();
      await sendMessage();
      return;
    }
    await new Promise(resolve => setTimeout(resolve,350));
  } while (Date.now() < end);
  throw Error('授权已保存，设备仍在同步。草稿已保留，请稍后发送。');
}

function showDevices() { if (!busy) { renderDevices(); showDialog('devices-dialog'); } }
function showAdmin() {
  if (!state?.user.isAdmin || busy) return;
  activeDialog()?.close(); drawer(false); tab = 'admin'; sidebarKey = null; render(); void refresh(true);
}
$('login').onsubmit = e => {
  e.preventDefault();
  if (busy) return;
  const password = $('password').value;
  $('password').value = '';
  const label = $('login-submit').querySelector('span');
  label.textContent = '登录中…';
  void perform(async () => { generation++; await action('login',{username:$('username').value.trim(), password}); })
    .finally(() => { label.textContent = '登录'; });
};
$('logout').onclick = () => perform(async () => { await action('logout'); loginView(); });
$('account-menu').onclick = () => { if (!busy) showDialog('account-dialog'); };
$('admin-nav').onclick = showAdmin;
$('back-chat').onclick = () => openThread(selected);
$('my-devices').onclick = $('device-status').onclick = showDevices;
$('web-devices').onclick = () => state.user.isAdmin ? showAdmin() : showDevices();
$('hide-rail').onclick = () => {
  if (narrow.matches) drawer(false); else $('app').classList.add('folded');
  $('show-rail').focus();
};
$('show-rail').onclick = () => {
  if (narrow.matches) drawer(true); else { $('app').classList.remove('folded'); $('hide-rail').focus(); }
};
$('rail-scrim').onclick = () => { drawer(false); $('show-rail').focus(); };
narrow.addEventListener('change', () => { if (!narrow.matches) drawer(false); });
$('new-chat').onclick = () => openThread(null);
$('find-chat').onclick = openSearch;
$('search-input').oninput = searchResults;
$('search-dialog').onkeydown = e => {
  const results = [...$('search-results').querySelectorAll('button')];
  if (e.key === 'Enter' && e.target === $('search-input') && results.length) { e.preventDefault(); results[0].click(); }
  if (!['ArrowDown','ArrowUp'].includes(e.key) || !results.length) return;
  e.preventDefault();
  const index = results.indexOf(document.activeElement);
  const focusedSearch = index < 0 ? (e.key === 'ArrowDown' ? 0 : results.length - 1) :
    (index + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
  results[focusedSearch].focus();
};
$('context').onclick = () => openProject(false);
$('settings-project').onclick = () => openProject(true);
$('project').onchange = () => showProject($('project').value);
$('mode').onchange = updateMode;
$('apply').onclick = () => perform(saveProject);
$('compose').onsubmit = e => { e.preventDefault(); requestSend(); };
$('draft').oninput = rememberInput;
$('draft').onkeydown = e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault(); requestSend();
  }
};
$('allow-send').onclick = () => perform(allowAndSend);
$('cancel-consent').onclick = () => $('consent-dialog').close();
$('consent-dialog').addEventListener('close', () => {
  // Chromium queues the close event. A new send can already have opened a fresh prompt.
  if (!$('consent-dialog').open) consent = null;
});
$('stop').onclick = () => {
  const turn = thread()?.activeTurn;
  if (turn) void perform(() => action('stop',{sessionId:selected,turnId:turn.id,requestId:crypto.randomUUID()}));
};
function example(text) {
  if (busy) return;
  if (!$('draft').value.trim()) { $('draft').value = text; rememberInput(); }
  $('draft').focus();
}
$('example-read').onclick = () => example(state.chatEngine === 'codex' ? '请读取 notes.txt 的第一行。' : '/read notes.txt');
$('example-code').onclick = () => example(state.chatEngine === 'codex' ? '请帮我解释下面这段代码：\n' : '/help');
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.querySelector('.dialog-close').onclick = () => { if (!busy) dialog.close(); };
  dialog.addEventListener('cancel', e => { if (busy) e.preventDefault(); });
  dialog.addEventListener('click', e => {
    if (e.target !== dialog || busy) return;
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
  });
}
document.addEventListener('keydown', e => {
  if (!state || busy || e.isComposing) return;
  if (e.key === 'Escape' && $('app').classList.contains('drawer')) { drawer(false); $('show-rail').focus(); return; }
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
  if (e.key.toLowerCase() === 'k') { e.preventDefault(); if (!activeDialog()) openSearch(); }
  if (e.key.toLowerCase() === 'n' && native && !activeDialog()) { e.preventDefault(); openThread(null); }
});
loginView(); void refresh();
setInterval(() => { if (state && !busy && !document.hidden) void refresh(); }, 1500);
document.addEventListener('visibilitychange', () => { if (!document.hidden && !busy) void refresh(); });
