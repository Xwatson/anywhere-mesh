import {element, icon, renderThread} from './thread.js';

const $ = id => document.getElementById(id);
const native = window.desktopDevice;
const narrow = matchMedia('(max-width: 720px)');
const modes = {
  revoked: ['未授权', '项目文件访问已关闭。'],
  read: ['只读', '允许读取本项目的文件。'],
  edit: ['编辑', '允许读取和修改本项目的文件。'],
  execute: ['完全访问', '允许读取、创建和修改本项目的文件，并在隔离环境中运行项目命令。']
};
const errors = {
  LOGIN_STORAGE_UNAVAILABLE: '暂时无法读取或保存本机登录凭据。请稍后重试。',
  DEVICE_OFFLINE: '执行设备已离线，草稿已保留。', LOGIN_REQUIRED: '请重新登录。',
  INVALID_CREDENTIALS: '账号或密码不正确。', DEVICE_DISABLED: '管理员已停用这台设备。',
  INCORRECT_CURRENT_PASSWORD: '当前密码不正确。', PASSWORD_UNCHANGED: '请输入与当前密码不同的新密码。',
  INVALID_NEW_PASSWORD: '新密码须为 8–200 个字符，且应包含非空格字符。', PASSWORD_THROTTLED: '尝试次数过多，请在 15 分钟后重试。',
  LOGIN_THROTTLED: '登录尝试过多，请稍后重试。', LOCAL_PERMISSION_REQUIRED: '请在执行设备上给项目授权。',
  WORKSPACE_NOT_READY: '项目正在同步或有任务在运行，请稍后重试。', READ_FILE_BEFORE_EDIT: '请先在本次会话中读取文件。',
  TOOL_UNAVAILABLE_ON_DEVICE: '这台设备暂不支持该操作。', UNSUPPORTED_DEVICE_PERMISSION: '这台设备不支持所选权限。',
  NETWORK_ENROLLMENT_UNAVAILABLE: '服务端暂时无法签发设备连接配置。',
  NETWORK_ADDRESS_LIMIT: '设备连接数已满。', WINDOWS_NETWORK_EXITED: '本机连接进程已中断。',
  WINDOWS_BOOTSTRAP_UNAVAILABLE: '暂时无法连接 awc.xbxbe.com 验证账号，请检查网络后重试。',
  WINDOWS_AUTH_UNAVAILABLE: '暂时无法通过设备连接验证账号，请稍后重试。',
  WINDOWS_NETWORK_CONFIG_UNAVAILABLE: '暂时无法领取设备连接配置。',
  WINDOWS_STATE_UNAVAILABLE: '设备已连接，暂时无法同步账号状态。',
  EADDRINUSE: '本机连接端口正在使用，请关闭其他实验客户端后重试。',
  WINDOWS_TUNNEL_NOT_READY: 'EasyTier 正在建立设备连接。', SESSION_LIMIT: '此账号已达到实验环境的会话上限。',
  WORKSPACE_LIMIT: '这台设备最多可登记 16 个项目。',
  WORKSPACE_ROOT_CHANGED: '项目目录已移动或被替换，请选择其他目录。',
  WORKSPACE_PATH_RESERVED: '请选择应用及其私有数据目录之外的项目文件夹。',
  LOCAL_PROJECT_REQUIRED: '请选择固定本机磁盘上的现有文件夹。',
  WORKSPACE_REGISTRATION_UNAVAILABLE: '当前服务端版本暂不支持添加文件夹。',
  DESKTOP_REQUEST_TIMEOUT: '连接超时，请重试。', SESSION_BUSY: '请等当前回复结束后再发送。'
};
const message = e => Object.entries(errors).find(([key]) => String(e.message).includes(key))?.[1] ?? String(e.message);

async function action(method, p = {}) {
  if (native) return native.request(method, p);
  let path, body;
  switch (method) {
    case 'login': path = '/api/auth/login'; body = p; break;
    case 'logout': path = '/api/auth/logout'; body = {}; break;
    case 'changePassword': path = '/api/auth/password'; body = p; break;
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
let rows = [], seq = 0, epoch, sidebarKey, searchKey, fleetKey, deviceKey, historyProblem = false, historyDirty = false;
let fleet = [], consent, projectSource, restoring = false;
const groups = new Map(), unfolded = new Set();
const canUseProject = p => isLocal(p) && (!state.workspacePicker || (p.localMode !== undefined && !p.localUnavailable));
const mine = () => state.projects.filter(canUseProject);
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
  historyProblem = historyDirty = false;
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
function loginView(localName, restore = false, detail) {
  if (state || !$('app').hidden) {
    activeDialog()?.close();
    drawer(false);
    resetHistory();
    selected = projectId = consent = null;
    sidebarKey = searchKey = fleetKey = deviceKey = null;
    groups.clear(); unfolded.clear(); fleet = [];
    for (const id of ['sessions','devices','fleet','search-results','signed-user','account','notice','session-title','project','mode','consent-copy']) $(id).replaceChildren();
    $('draft').value = '';
    $('password-form').reset();
    $('account-feedback').textContent = '';
    tab = 'chat';
  }
  state = null; online = false;
  restoring = restore;
  $('restoring').hidden = !restoring; $('login').hidden = restoring;
  $('restore-title').textContent = restore === 'connecting' ? '账号已验证' : '正在恢复登录';
  $('restore-status').textContent = detail ? detail + '稍后会自动重试。' :
    restore === 'connecting' ? '正在连接设备并同步账号状态…' :
    restore === 'waiting' ? '暂时无法恢复登录，稍后会自动重试。' : '正在检查本机登录状态…';
  $('forget-login').hidden = restore !== 'waiting' && !(restore === 'connecting' && detail);
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
  $('context').disabled = busy || (!p && !(state.workspacePicker && !selected));
  $('choose-workspace').disabled = busy || !online;
  $('logout').disabled = busy;
  $('change-password').disabled = busy;
  $('cancel-password').disabled = busy;
  $('save-password').disabled = busy;
  $('save-password').textContent = busy ? '正在保存…' : '保存密码';
  $('password-dialog').querySelector('.dialog-close').disabled = busy;
  $('allow-send').disabled = $('consent-mode').disabled = busy;
  $('cancel-consent').disabled = busy;
  $('apply').disabled = busy;
}

function renderNotice(s, p, d) {
  let notice = '';
  const other = Boolean(s && d && !isLocal(p));
  if (!online) notice = '暂时无法同步服务端状态，正在重试。草稿已保留。';
  else if (other) notice = '此会话只会操作「' + deviceName(d) + '」上的项目。';
  if (online && isLocal(p) && p.localUnavailable) notice += '本机项目目录已无法访问。';
  else if (online && d && !d.online && !connecting(d)) notice += '执行设备' + (d.disabled ? '已停用。' : '已离线。') + (s ? '仍可查看会话历史。' : '');
  else if (online && p && !p.ready && (s || !isLocal(p))) notice += '项目正在连接…';
  else if (online && other && p?.mode === 'revoked') notice += '请在该设备上授权。';
  else if (online && isLocal(p) && p.localMode && p.localMode !== p.mode) notice += '正在同步项目权限…';
  if (s && historyProblem) notice += '会话记录暂时无法同步，稍后会自动重试。';
  $('notice').textContent = notice;
  $('notice').hidden = !notice;
  $('notice').className = !historyProblem && other && online && d?.online && p?.mode !== 'revoked' ? 'remote' : '';
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
  $('settings-project').hidden = !state.workspacePicker && !mine().length;
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
  renderNotice(s,p,d);
  $('chat').classList.toggle('home',home);
  $('welcome').hidden = !home; $('welcome-title').textContent = webEmpty ? '从桌面开启对话' : '从哪里开始？';
  $('timeline').hidden = home; $('compose').hidden = webEmpty;
  $('web-empty').hidden = !webEmpty;
  $('web-devices').textContent = state.user.isAdmin ? '设备管理' : '查看设备';
  $('suggestions').hidden = !home || webEmpty;
  $('input-hint').hidden = home;
  $('project-label').textContent = s && p ? modes[p.localMode ?? p.mode]?.[0] ?? '项目权限' : p?.label ?? '选择项目文件夹';
  $('context').querySelector('use').setAttribute('href', s ? '#i-lock' : '#i-folder');
  $('context').title = !s && state.workspacePicker ? '选择本机项目文件夹' : p ? '查看「' + p.label + '」项目与权限' : '暂无本机项目';
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

function drawHistory(next, fromStart = false) {
  const selection = document.getSelection(), events = $('events'), view = $('timeline');
  // Preserve the selection until the user finishes copying, including during streamed replies.
  if (native && selection?.rangeCount && !selection.isCollapsed && selection.getRangeAt(0).intersectsNode(events)) return false;
  const pinned = fromStart || view.scrollHeight - view.clientHeight - view.scrollTop < 72;
  renderThread(events, next);
  if (pinned) view.scrollTop = view.scrollHeight;
  return true;
}
document.addEventListener('selectionchange', () => {
  if (historyDirty) historyDirty = !drawHistory(rows);
});

async function syncHistory() {
  const target = thread(), stamp = generation;
  if (!target || (target.lastSeq === seq && target.historyEpoch === epoch && !historyProblem)) return;
  const restart = epoch !== target.historyEpoch || target.lastSeq < seq;
  const afterSeq = restart ? 0 : seq;
  try {
    const page = await action('history',{sessionId:target.id,afterSeq});
    if (generation !== stamp || tab !== 'chat') return;
    if (page.sessionId !== target.id || page.workspaceId !== target.workspaceId || page.historyEpoch !== target.historyEpoch ||
        !Array.isArray(page.events) || page.throughSeq !== afterSeq + page.events.length ||
        !page.events.every((r,i) => r?.seq === afterSeq+i+1 && typeof r.event?.type === 'string' &&
          (r.event.type !== 'assistant_text' || typeof r.event.text === 'string'))) throw Error('INVALID_HISTORY_PAGE');
    const next = restart ? page.events : rows.concat(page.events);
    historyDirty = !drawHistory(next, !afterSeq);
    rows = next; epoch = page.historyEpoch; seq = page.throughSeq;
    historyProblem = false;
  } catch (error) {
    if (generation !== stamp || tab !== 'chat') return;
    if (error.message.includes('LOGIN_REQUIRED')) { loginView(); return; }
    historyProblem = true;
    console.warn('会话记录同步失败',error.message === 'INVALID_HISTORY_PAGE' ? 'INVALID_HISTORY_PAGE' : error.name);
  }
  const p = project();
  renderNotice(target,p,deviceById(p?.deviceId ?? state.deviceId));
}

async function sync() {
  const version = generation;
  let latest;
  try { latest = await action('state'); }
  catch (error) {
    if (version !== generation) return;
    if (error.message.includes('LOGIN_REQUIRED')) { loginView(); return; }
    online = false;
    if (state) render();
    else if (restoring) loginView(undefined,restoring === 'connecting' ? restoring : 'waiting',
      message(error) === error.message ? '暂时无法同步登录状态。' : message(error));
    return;
  }
  if (version !== generation) return;
  if (!latest.user) {
    loginView(latest.localName,latest.restoring && (restoring === 'connecting' ? restoring : 'waiting'),
      latest.connectionError && errors[latest.connectionError]);
    return;
  }
  restoring = false;
  const first = !state || state.user.id !== latest.user.id;
  if (first && state) loginView();
  state = latest; online = true;
  if (first) localConnectUntil = native ? Date.now() + 12000 : 0;
  if (deviceById(state.deviceId)?.online) localConnectUntil = 0;
  const projects = mine();
  if (!projects.some(p => p.id === projectId)) {
    projectId = projects[0]?.id;
    if (!selected) select(null);
  }
  if (first || (selected && !thread())) {
    select(!native ? state.sessions[0]?.id ?? null : null);
    if (first && !native && state.user.isAdmin && new URLSearchParams(location.search).get('view') === 'devices') tab = 'admin';
  }
  render();
  if (first && native && !narrow.matches) $('draft').focus({preventScroll:true});
  if (tab === 'chat') await syncHistory();
  else if (state.user.isAdmin) {
    const stamp = generation;
    try {
      const list = await action('admin');
      if (stamp !== generation || tab !== 'admin') return;
      fleet = list; renderFleet(); $('fleet-error').hidden = true;
    } catch (error) {
      if (stamp !== generation || tab !== 'admin') return;
      if (error.message.includes('LOGIN_REQUIRED')) { loginView(); return; }
      $('fleet-error').hidden = false;
    }
  }
}
async function refresh(force = false) {
  if (polling) { await polling; if (force) await refresh(); return; }
  polling = sync().catch(error => console.error('界面同步失败',error.name)).finally(() => { polling = null; });
  return polling;
}
async function perform(fn, {refreshState = true} = {}) {
  if (busy) return;
  busy = true; render(); notify();
  $('login-error').textContent = ''; $('login-submit').disabled = $('forget-login').disabled = true;
  try {
    await fn();
    if (refreshState) await refresh(true);
  } catch (error) {
    const field = activeDialog()?.querySelector('.dialog-error');
    if (!state) $('login-error').textContent = message(error);
    else if (field) field.textContent = message(error);
    else notify(message(error));
  } finally {
    busy = false; $('login-submit').disabled = $('forget-login').disabled = false; render();
  }
}

function openProject(fromAccount = false) {
  if (busy || !state) return;
  projectSource = fromAccount ? 'settings' : 'context';
  const bound = Boolean(thread() && !fromAccount);
  if (bound ? !project() : !state.workspacePicker && !mine().length) return;
  showDialog('project-dialog');
  projectChoices(bound, bound ? thread().workspaceId : projectId);
}
function projectChoices(bound, preferred) {
  const modalProjects = bound ? [project()].filter(Boolean) : mine();
  const initial = modalProjects.find(p => p.id === preferred) ?? modalProjects[0];
  $('project').replaceChildren(...modalProjects.map(p => new Option(p.label, p.id)));
  $('project').value = initial?.id ?? '';
  $('project').disabled = modalProjects.length < 2;
  $('project-caption').textContent = bound ? '会话绑定项目' : '本机项目';
  $('choose-workspace').hidden = bound || !state.workspacePicker;
  showProject(initial?.id);
}
async function chooseProject() {
  const picked = await action('chooseWorkspace');
  if (!picked) return;
  const index = state.projects.findIndex(p => p.id === picked.id);
  if (index < 0) state.projects.push(picked);
  else state.projects[index] = {...state.projects[index],...picked};
  if (!selected && projectSource === 'context') {
    projectId = picked.id;
    select(null);
  }
  projectChoices(false,picked.id);
}
function showProject(id) {
  const p = projectById(id), d = deviceById(p?.deviceId), usable = canUseProject(p);
  $('project-identity').textContent = p ? deviceName(d) + ' · ' + status(d) : '';
  $('project-path').textContent = p?.localPath ?? '';
  $('project-path').hidden = !p?.localPath;
  $('grant').hidden = !usable; $('remote-mode').hidden = !p || usable;
  $('remote-mode').textContent = isLocal(p) ? '本机项目目录已无法访问。' : '当前权限 · ' + (modes[p?.mode]?.[0] ?? '未知') + '。请在执行设备上更改。';
  const allowed = p?.localModes ?? Object.keys(modes);
  $('mode').replaceChildren(...allowed.map(m => new Option(modes[m][0], m)));
  $('mode').value = p?.localMode ?? p?.mode ?? 'revoked';
  updateMode();
}
function updateMode() {
  $('mode-description').textContent = modes[$('mode').value]?.[1] || '';
  const p = projectById($('project').value);
  $('apply').textContent = canUseProject(p) && $('mode').value !== (p.localMode ?? p.mode) ? ($('mode').value === 'execute' ? '授予完全访问' : '保存权限') : '完成';
}
async function saveProject() {
  const p = projectById($('project').value), mode = $('mode').value;
  if (canUseProject(p) && mode !== (p.localMode ?? p.mode)) {
    await action('permission',{workspaceId:p.id,mode});
  }
  if (!selected && p && projectSource === 'context' && projectId !== p.id) {
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
    const allowed = (p.localModes ?? Object.keys(modes)).filter(mode => mode !== 'revoked');
    $('consent-mode').replaceChildren(...allowed.map(mode => new Option(modes[mode][0],mode)));
    $('consent-mode').value = 'read';
    updateConsent();
    showDialog('consent-dialog');
  } else void perform(sendMessage);
}
function updateConsent() {
  const mode = $('consent-mode').value;
  $('consent-heading').textContent = mode === 'read' ? '允许读取这个项目？' : '授予「' + project().label + '」项目权限？';
  $('consent-copy').textContent = '项目「' + project().label + '」 · ' + modes[mode][1];
  $('allow-send').textContent = mode === 'read' ? '允许只读并发送' : '授予' + modes[mode][0] + '并发送';
}
async function allowAndSend() {
  const p = project(), approved = consent;
  if (!$('consent-dialog').open || !approved || approved.key !== keyFor() || approved.project !== p?.id || approved.user !== state.user.id || !isLocal(p)) throw Error('目标会话已改变，请重新发送。');
  const currentMode = p.localMode ?? p.mode;
  const requested = currentMode === 'revoked' ? $('consent-mode').value : currentMode;
  if (currentMode === 'revoked') await action('permission',{workspaceId:p.id,mode:requested});
  const end = Date.now() + 18000;
  do {
    const next = await action('state');
    if (next.user?.id !== approved.user || next.deviceId !== p.deviceId) throw Error('LOGIN_REQUIRED');
    const scope = next.projects.find(w => w.id === p.id);
    if (scope?.ready && scope.mode === requested && scope.localMode === requested) {
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
function showAccount(feedback = '') {
  if ($('password-dialog').open) $('password-form').reset();
  showDialog('account-dialog');
  $('account-feedback').textContent = feedback;
}
async function savePassword() {
  const userId = state.user.id;
  const current = $('current-password').value, password = $('new-password').value;
  if (password !== $('confirm-password').value) {
    $('confirm-password').focus();
    throw Error('两次输入的新密码不一致。');
  }
  if (!password.trim()) throw Error('INVALID_NEW_PASSWORD');
  if (password === current) throw Error('PASSWORD_UNCHANGED');
  try {
    await action('changePassword',{current,password});
  } catch (error) {
    if (error.message.includes('LOGIN_REQUIRED')) loginView();
    if (error.message.includes('INCORRECT_CURRENT_PASSWORD')) {
      $('current-password').value = '';
      $('current-password').focus();
    }
    if (error instanceof TypeError || /TIMEOUT|ECONNRESET|ERR_NETWORK|Failed to fetch/.test(error.message)) {
      throw Error('暂时无法确认保存结果。请在另一个浏览器中用新密码登录以确认。');
    }
    throw error;
  }
  if (state?.user.id === userId) showAccount('密码已更改。');
}
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
  void perform(async () => {
    generation++;
    await action('login',{username:$('username').value.trim(), password});
    loginView(undefined,'connecting');
  })
    .finally(() => { label.textContent = '登录'; });
};
$('logout').onclick = $('forget-login').onclick = () => perform(async () => {
  generation++;
  await action('logout');
  loginView();
});
$('account-menu').onclick = () => { if (!busy) showAccount(); };
$('change-password').onclick = () => {
  $('password-form').reset();
  $('password-user').value = state.user.username;
  showDialog('password-dialog');
  $('current-password').focus();
};
$('password-form').onsubmit = e => { e.preventDefault(); void perform(savePassword, {refreshState:false}); };
$('password-form').oninput = () => { $('password-error').textContent = ''; };
$('cancel-password').onclick = () => showAccount();
$('password-dialog').addEventListener('close', () => {
  if (!$('password-dialog').open) $('password-form').reset();
});
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
$('choose-workspace').onclick = () => perform(chooseProject);
$('mode').onchange = updateMode;
$('apply').onclick = () => perform(saveProject);
$('compose').onsubmit = e => { e.preventDefault(); requestSend(); };
$('draft').oninput = rememberInput;
$('draft').onkeydown = e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault(); requestSend();
  }
};
$('consent-mode').onchange = updateConsent;
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
loginView(undefined,Boolean(native)); void refresh();
setInterval(() => { if (!busy && (restoring || (state && !document.hidden))) void refresh(); }, 1500);
document.addEventListener('visibilitychange', () => { if (!document.hidden && !busy) void refresh(); });
