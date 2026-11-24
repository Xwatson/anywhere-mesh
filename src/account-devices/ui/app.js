import { element, icon, renderLive, renderThread } from './thread.js';

const $ = id => document.getElementById(id);
const native = window.desktopDevice;
const narrow = matchMedia('(max-width: 720px)');
const modes = {
  revoked: ['未授权', '项目文件访问已关闭。'],
  read: ['只读', '允许读取本项目的文件。'],
  edit: ['编辑', '允许读取和修改本项目的文件。'],
  execute: ['完全访问', '允许读取、创建和修改本项目的文件，并在隔离环境中运行项目命令。']
};
const EFFORT_LABELS = { minimal: '极简', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大' };
const ENGINE_LABELS = { codex: 'Codex', antigravity: 'Antigravity', mock: '项目助手' };
const errors = {
  LOGIN_STORAGE_UNAVAILABLE: '暂时无法读取或保存本机登录凭据。请稍后重试。',
  DEVICE_OFFLINE: '执行设备已离线，草稿已保留。', LOGIN_REQUIRED: '请重新登录。',
  INVALID_CREDENTIALS: '账号或密码不正确。', DEVICE_DISABLED: '管理员已停用这台设备。',
  INCORRECT_CURRENT_PASSWORD: '当前密码不正确。', PASSWORD_UNCHANGED: '请输入与当前密码不同的新密码。',
  INVALID_NEW_PASSWORD: '新密码须为 8–200 个字符，且应包含非空格字符。', PASSWORD_THROTTLED: '尝试次数过多，请在 15 分钟后重试。',
  LOGIN_THROTTLED: '登录尝试过多，请稍后重试。', LOCAL_PERMISSION_REQUIRED: '请在执行设备上给项目授权。',
  WORKSPACE_NOT_READY: '项目正在同步或存在未核对/运行中任务，请先检查或稍后重试。', READ_FILE_BEFORE_EDIT: '请先在本次会话中读取文件。',
  TOOL_UNAVAILABLE_ON_DEVICE: '这台设备暂不支持该操作。', UNSUPPORTED_DEVICE_PERMISSION: '这台设备不支持所选权限。',
  NETWORK_ENROLLMENT_UNAVAILABLE: '服务端暂时无法签发设备连接配置。',
  NETWORK_ADDRESS_LIMIT: '设备连接数已满。', WINDOWS_NETWORK_EXITED: '本机连接进程已中断。',
  WINDOWS_BOOTSTRAP_UNAVAILABLE: '暂时无法连接 awc.xbxbe.com 验证账号，请检查网络后重试。',
  WINDOWS_AUTH_UNAVAILABLE: '暂时无法通过设备连接验证账号，请稍后重试。',
  WINDOWS_NETWORK_CONFIG_UNAVAILABLE: '暂时无法领取设备连接配置。',
  WINDOWS_STATE_UNAVAILABLE: '设备已连接，暂时无法同步账号状态。',
  LINUX_NETWORK_EXITED: '本机连接进程已中断。',
  LINUX_BOOTSTRAP_UNAVAILABLE: '暂时无法连接 awc.xbxbe.com 验证账号，请检查网络后重试。',
  LINUX_NETWORK_CONFIG_UNAVAILABLE: '暂时无法领取设备连接配置。',
  LINUX_STATE_UNAVAILABLE: '设备已连接，暂时无法同步账号状态。',
  LINUX_TUNNEL_NOT_READY: 'EasyTier 正在建立设备连接。',
  EASYTIER_BINARY_NOT_FOUND: '未找到本机 EasyTier 组件，请重新安装客户端。',
  EADDRINUSE: '本机连接端口正在使用，请关闭其他实验客户端后重试。',
  WINDOWS_TUNNEL_NOT_READY: 'EasyTier 正在建立设备连接。', SESSION_LIMIT: '此账号已达到实验环境的会话上限。',
  WORKSPACE_LIMIT: '这台设备最多可登记 16 个项目。',
  WORKSPACE_ROOT_CHANGED: '项目目录已移动或被替换，请选择其他目录。',
  WORKSPACE_PATH_RESERVED: '请选择应用及其私有数据目录之外的项目文件夹。',
  DEFAULT_WORKSPACE_PROTECTED: '默认项目不能移除。',
  LOCAL_PROJECT_REQUIRED: '请选择固定本机磁盘上的现有文件夹。',
  WORKSPACE_REGISTRATION_UNAVAILABLE: '当前服务端版本暂不支持添加文件夹。',
  DESKTOP_REQUEST_TIMEOUT: '连接超时，请重试。', SESSION_BUSY: '请等当前回复结束后再发送。',
  BODY_LIMIT: '文件或内容超出大小限制。', REVOKE_BEFORE_REVIEW: '请先撤销本项目权限再提交核对。',
  REVIEW_STALE: '核对证据已变化，请刷新后重试。',
  USERNAME_TAKEN: '该用户名已存在，请换一个。',
  INVALID_USERNAME: '用户名须为 2–32 个字符，以字母、数字或汉字开头，只能用字母、数字、汉字和 _ . @ -。',
  LAST_ADMIN_PROTECTED: '至少需要保留一名超级管理员，无法执行此操作。',
  CANNOT_DELETE_SELF: '不能删除当前正在登录的管理员账号。',
  DEVICE_BUSY: '该设备或账号仍有运行中的任务，请等待任务结束后重试。',
};
const message = e => Object.entries(errors).find(([key]) => String(e.message).includes(key))?.[1] ?? String(e.message);

async function action(method, p = {}) {
  if (native) return native.request(method, p);
  let path, body, httpMethod = 'GET';
  switch (method) {
    case 'login': path = '/api/auth/login'; body = p; httpMethod = 'POST'; break;
    case 'logout': path = '/api/auth/logout'; body = {}; httpMethod = 'POST'; break;
    case 'changePassword': path = '/api/auth/password'; body = p; httpMethod = 'POST'; break;
    case 'state': path = '/api/state'; break;
    case 'quota': path = '/api/quota' + (p.refresh ? '?refresh=1' : ''); break;
    case 'create': path = '/api/sessions'; body = p; httpMethod = 'POST'; break;
    case 'admin': path = '/api/admin/devices'; break;
    case 'disable': path = '/api/admin/devices/' + p.id; body = { disabled: p.disabled }; httpMethod = 'POST'; break;
    case 'deleteDevice': path = '/api/admin/devices/' + p.id; httpMethod = 'DELETE'; break;
    case 'pruneDevices': path = '/api/admin/devices/prune'; body = {}; httpMethod = 'POST'; break;
    case 'adminUsers': path = '/api/admin/users'; break;
    case 'createUser': path = '/api/admin/users'; body = p; httpMethod = 'POST'; break;
    case 'resetUserPassword': path = '/api/admin/users/' + p.userId + '/password'; body = { password: p.password }; httpMethod = 'POST'; break;
    case 'setUserAdmin': path = '/api/admin/users/' + p.userId + '/role'; body = { isAdmin: p.isAdmin }; httpMethod = 'POST'; break;
    case 'deleteUser': path = '/api/admin/users/' + p.userId; httpMethod = 'DELETE'; break;
    case 'renameSession': path = '/api/sessions/' + p.sessionId; body = { title: p.title }; httpMethod = 'PATCH'; break;
    case 'deleteSession': path = '/api/sessions/' + p.sessionId; httpMethod = 'DELETE'; break;
    case 'setSessionOptions': {
      path = '/api/sessions/' + p.sessionId;
      const options = {};
      if ('agent' in p) options.agent = p.agent;
      if ('model' in p) options.model = p.model;
      if ('effort' in p) options.effort = p.effort;
      body = { options }; httpMethod = 'PATCH'; break;
    }
    case 'history': path = '/api/sessions/' + p.sessionId + '/events?afterSeq=' + p.afterSeq; break;
    case 'historyBefore': path = '/api/sessions/' + p.sessionId + '/events?beforeSeq=' + p.beforeSeq; break;
    case 'send': path = '/api/sessions/' + p.sessionId + '/messages'; body = { requestId: p.requestId, text: p.text, ...(p.attachments?.length ? { attachments: p.attachments } : {}) }; httpMethod = 'POST'; break;
    case 'stop': path = '/api/sessions/' + p.sessionId + '/stop'; body = { requestId: p.requestId, turnId: p.turnId }; httpMethod = 'POST'; break;
    case 'uploadAttachment': path = '/api/sessions/' + p.sessionId + '/attachments'; body = { name: p.name, mime: p.mime, dataBase64: p.dataBase64 }; httpMethod = 'POST'; break;
    default: throw Error('请在桌面客户端操作。');
  }
  const response = await fetch(path, {
    method: httpMethod, credentials: 'same-origin', cache: 'no-store',
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || '连接失败。');
  return data;
}

let state, selected, projectId, tab = 'chat', online = false, busy = false, generation = 0, polling, syncFailures = 0;
let knownUiVersion = null;
const CONNECT_STEPS = [
  ['authentication', '验证账号'],
  ['network_enrollment', '领取网络配置'],
  ['peer_start', '启动本机隧道'],
  ['tunnel_readiness', '建立加密连接'],
  ['state_sync', '同步设备与项目状态'],
];
let connectState = new Map();
let localConnectUntil = 0;
let rows = [], seq = 0, firstSeq = 0, hasOlder = false, epoch, sidebarKey, searchKey, fleetKey, usersKey, deviceKey, historyProblem = false, historyDirty = false;
let fleet = [], adminUsers = [], adminTab = 'users', resetTargetUser = null, consent, projectSource, restoring = false, reviewWorkspaceId = null;
let pendingAgent = null, pendingModel = null, pendingEffort = null;
let quotaData = null, quotaLoading = false, quotaError = '', quotaAutoLoaded = false;
// Pending attachments with local preview, upload status & progress.
let pendingAttachments = [];
let pasteCounter = 0;
let live = { text: '', thinking: '', toolOutput: new Map() };
let eventSource = null, subscribedSessionId = null;
let deferredInstallPrompt = null;
let pwaBannerDismissed = (() => { try { return localStorage.getItem('anywhere-pwa-dismissed') === '1'; } catch { return false; } })();

const MIME_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'image/avif': 'avif',
  'application/pdf': 'pdf', 'text/plain': 'txt', 'application/json': 'json',
};
const selectSizer = element('span', '', 'pill-select-sizer');
selectSizer.setAttribute('aria-hidden', 'true');
document.body.append(selectSizer);

function fmtSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}
function fitSelectWidth(sel) {
  if (!sel || sel.hidden || !sel.options.length) return;
  const opt = sel.selectedOptions?.[0] ?? sel.options[sel.selectedIndex] ?? sel.options[0];
  const label = opt?.textContent ?? '';
  selectSizer.textContent = label;
  const textWidth = selectSizer.getBoundingClientRect().width;
  const cs = getComputedStyle(sel);
  const padLeft = parseFloat(cs.paddingLeft) || 8;
  const padRight = parseFloat(cs.paddingRight) || 22;
  const border = (parseFloat(cs.borderLeftWidth) || 1) + (parseFloat(cs.borderRightWidth) || 1);
  sel.style.width = Math.ceil(textWidth + padLeft + padRight + border + 2) + 'px';
  if (sel === $('model-select')) sel.title = label ? '模型：' + label : '选择模型';
}
function fitAllModelSelects() {
  fitSelectWidth($('engine-select'));
  fitSelectWidth($('model-select'));
  fitSelectWidth($('effort-select'));
}

const isStandalonePwa = () => Boolean(window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true);
const isIOSBrowser = () => /iP(?:hone|ad|od)/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isMobileBrowser = () => Boolean(
  /Android|iPhone|iPad|iPod|Mobile|HarmonyOS|MicroMessenger/i.test(navigator.userAgent) ||
  (navigator.maxTouchPoints > 1 && window.matchMedia?.('(max-width: 900px)').matches)
);
function updatePwaInstallUI() {
  const banner = $('pwa-install-bar');
  const menuRow = $('install-pwa-menu');
  const signinBtn = $('signin-install-pwa');
  if (native || isStandalonePwa()) {
    banner.hidden = true;
    menuRow.hidden = true;
    signinBtn.hidden = true;
    return;
  }
  const canPrompt = Boolean(deferredInstallPrompt);
  const available = canPrompt || isMobileBrowser();
  menuRow.hidden = !available;
  signinBtn.hidden = !available;
  $('install-pwa-menu-label').textContent = canPrompt ? '安装应用到桌面' : '添加到手机桌面';
  signinBtn.lastElementChild.textContent = canPrompt ? '安装 AnywhereMesh 到桌面' : '安装 AnywhereMesh 到手机桌面';
  banner.hidden = !available || pwaBannerDismissed || $('app').hidden;
  $('pwa-install-btn').textContent = canPrompt ? '安装' : '添加到桌面';
  $('pwa-banner-desc').textContent = canPrompt
    ? '一键安装到桌面，全屏快速启动'
    : isIOSBrowser()
      ? '在 Safari 点底部分享按钮，选择「添加到主屏幕」'
      : '添加到主屏幕，像原生 App 一样全屏使用';
}
function openInstallGuide() {
  const steps = isIOSBrowser()
    ? [
        '请确保在 Safari 浏览器中打开本页面（若在微信等内置浏览器中，请先点击右上角选择「在 Safari 中打开」）。',
        '点击浏览器底部工具栏的「分享」按钮（带向上箭头的方框图标）。',
        '向上滑动菜单，点击「添加到主屏幕」，再点击右上角「添加」即可在手机桌面看到 AnywhereMesh 图标。',
      ]
    : [
        '若当前在微信、QQ 等内置浏览器中，请先点击右上角选择「在默认浏览器 / Chrome 中打开」。',
        '点击浏览器右上角或底部的菜单按钮（⋮ 或 ≡）。',
        '选择「安装应用」或「添加到主屏幕」，确认后即可从手机桌面全屏打开 AnywhereMesh。',
      ];
  $('install-pwa-steps').replaceChildren(...steps.map(t => element('li', t)));
  showDialog('install-pwa-dialog');
}
async function triggerPwaInstall() {
  if (deferredInstallPrompt) {
    const promptEvent = deferredInstallPrompt;
    deferredInstallPrompt = null;
    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      if (choice?.outcome === 'accepted') pwaBannerDismissed = true;
    } catch {}
    updatePwaInstallUI();
    return;
  }
  openInstallGuide();
}

const groups = new Map(), unfolded = new Set();
const canUseProject = p => isLocal(p) && (!state.workspacePicker || (p.localMode !== undefined && !p.localUnavailable));
const mine = () => state.projects.filter(canUseProject);
const projectById = id => state.projects.find(p => p.id === id);
const deviceById = id => state.devices.find(d => d.id === id);
const thread = () => state?.sessions.find(s => s.id === selected);
const project = () => projectById(thread()?.workspaceId ?? projectId);
const isLocal = p => Boolean(native && p && p.deviceId === state.deviceId);
const isRemoteAuthorized = p => Boolean(p && !isLocal(p) && p.ready && p.mode && p.mode !== 'revoked' && deviceById(p.deviceId)?.online && !deviceById(p.deviceId)?.disabled);
const selectableProjects = () => [...mine(), ...state.projects.filter(isRemoteAuthorized)];
const connecting = d => d && !d.disabled && !d.online && d.id === state?.deviceId && Date.now() < localConnectUntil;
const status = d => !online ? '状态未知' : !d ? '未连接' : d.disabled ? '已停用' : d.online ? '在线' : connecting(d) ? '连接中' : '离线';
const deviceName = d => d ? d.name + ' · ' + d.id.slice(0, 6) : '未知设备';
const lastSeen = d => d.lastSeen ? '最近在线 ' + new Date(d.lastSeen).toLocaleString('zh-CN', { hour12: false }) : '暂无在线记录';
const activeDialog = () => document.querySelector('dialog[open]');
function availableEngines() {
  if (Array.isArray(state?.engines) && state.engines.length) return state.engines;
  return state?.chatEngine && state.chatEngine !== 'mock' ? [state.chatEngine] : [];
}
function activeEngine() {
  const list = availableEngines();
  if (!list.length) return 'mock';
  const chosen = thread()?.options?.agent ?? pendingAgent;
  return chosen && list.includes(chosen) ? chosen : list[0];
}
function engineLabel(eng = activeEngine()) {
  return ENGINE_LABELS[eng] ?? eng;
}
function modelsForEngine(eng = activeEngine()) {
  if (state?.engineModels && Array.isArray(state.engineModels[eng])) return state.engineModels[eng];
  if (eng === state?.chatEngine && Array.isArray(state?.models)) return state.models;
  return [];
}

function notify(text = '') {
  const box = $('error');
  box.textContent = text;
  box.hidden = !text;
}
function clearLive() {
  live = { text: '', thinking: '', toolOutput: new Map() };
  renderLive($('live'), live);
}
function stopStream() {
  if (eventSource) { eventSource.close(); eventSource = null; }
  if (native && subscribedSessionId) { void action('unsubscribe').catch(() => {}); }
  subscribedSessionId = null;
}
function ensureStream() {
  const target = thread();
  if (!state || tab !== 'chat' || !target || !online) { stopStream(); return; }
  if (subscribedSessionId === target.id) return;
  stopStream();
  subscribedSessionId = target.id;
  if (native) {
    void action('subscribe', { sessionId: target.id, afterSeq: seq }).catch(() => { subscribedSessionId = null; });
  } else {
    const es = new EventSource(`/api/sessions/${target.id}/stream?afterSeq=${seq}`);
    es.addEventListener('events', e => {
      try { applyStreamMessage({ type: 'events', payload: JSON.parse(e.data) }); } catch {}
    });
    es.addEventListener('delta', e => {
      try { applyStreamMessage({ type: 'delta', payload: JSON.parse(e.data) }); } catch {}
    });
    es.onerror = () => { if (eventSource === es) { es.close(); eventSource = null; subscribedSessionId = null; } };
    eventSource = es;
  }
}

function applyEventPage(page, target) {
  if (!target || page.sessionId !== target.id || page.workspaceId !== target.workspaceId) return;
  const restart = epoch !== page.historyEpoch || (page.events.length && page.events[0].seq <= seq);
  if (!restart && page.events.length && page.events[0].seq !== seq + 1) return;
  const next = restart ? page.events : rows.concat(page.events);
  if (page.events.some(r => r.event.type === 'assistant_text' || r.event.type === 'turn_end')) {
    live.text = '';
    live.thinking = '';
  }
  for (const r of page.events) {
    if (r.event.type === 'tool_call' && r.event.status !== 'running') live.toolOutput.delete(r.event.id);
  }
  rows = next;
  epoch = page.historyEpoch;
  seq = Math.max(seq, page.throughSeq);
  if (!firstSeq || restart) firstSeq = rows[0]?.seq ?? 0;
  hasOlder = firstSeq > 1;
  $('load-older').hidden = !hasOlder;
  historyDirty = !drawHistory(rows, restart);
  renderLive($('live'), live, engineLabel());
  historyProblem = false;
  if (page.events.some(r => r.event.type === 'turn_end')) void refresh();
}

function renderConnectProgress() {
  const box = $('connect-progress');
  const show = Boolean(native && restoring);
  box.hidden = !show;
  if (!show) return;
  let doneCount = 0;
  let activeLabel = '准备连接…';
  let activePercent = 5;
  const items = CONNECT_STEPS.map(([id, label], idx) => {
    const info = connectState.get(id);
    const st = info?.status ?? 'pending';
    if (st === 'done') doneCount++;
    const li = element('li', undefined, 'connect-step ' + (st === 'running' ? 'active' : st));
    li.append(element('i'));
    li.append(element('span', label));
    const badge = st === 'done' ? '完成' : st === 'running' ? '进行中…' : st === 'failed' ? '重试中' : '';
    if (badge) li.append(element('small', badge));
    if (st === 'running') {
      activeLabel = `步骤 ${idx + 1}/${CONNECT_STEPS.length}：正在${label}…`;
      activePercent = Math.round(((idx + 0.5) / CONNECT_STEPS.length) * 100);
    } else if (st === 'failed') {
      activeLabel = `步骤 ${idx + 1}/${CONNECT_STEPS.length}：${label}重试中…`;
      activePercent = Math.round(((idx + 0.3) / CONNECT_STEPS.length) * 100);
    }
    return li;
  });
  if (doneCount === CONNECT_STEPS.length) {
    activeLabel = '连接就绪，正在进入工作区…';
    activePercent = 100;
  } else if (doneCount > 0 && !CONNECT_STEPS.some(([id]) => ['running', 'failed'].includes(connectState.get(id)?.status))) {
    const nextIdx = Math.min(doneCount, CONNECT_STEPS.length - 1);
    activeLabel = `步骤 ${nextIdx + 1}/${CONNECT_STEPS.length}：准备${CONNECT_STEPS[nextIdx][1]}…`;
    activePercent = Math.round((doneCount / CONNECT_STEPS.length) * 100);
  }
  $('progress-step-label').textContent = activeLabel;
  $('progress-percent').textContent = activePercent + '%';
  $('progress-bar').setAttribute('aria-valuenow', String(activePercent));
  $('progress-fill').style.width = activePercent + '%';
  $('connect-steps').replaceChildren(...items);
}

function updateConnectProgress(payload) {
  if (!payload?.phase) return;
  const idx = CONNECT_STEPS.findIndex(([id]) => id === payload.phase);
  if (idx < 0) return;
  if (payload.status === 'running') {
    for (let i = 0; i < idx; i++) {
      const prevId = CONNECT_STEPS[i][0];
      if (connectState.get(prevId)?.status !== 'done') connectState.set(prevId, { status: 'done' });
    }
    for (let i = idx + 1; i < CONNECT_STEPS.length; i++) connectState.delete(CONNECT_STEPS[i][0]);
  }
  connectState.set(payload.phase, { status: payload.status, code: payload.code });
  if (restoring) {
    renderConnectProgress();
    if (payload.status === 'failed' && payload.code && errors[payload.code]) {
      $('restore-status').textContent = errors[payload.code] + '稍后会自动重试。';
      $('forget-login').hidden = false;
    } else if (payload.status === 'running') {
      $('restore-status').textContent = '正在建立到服务端的加密连接，请稍候…';
    }
  }
}

function applyStreamMessage(msg) {
  if (msg?.type === 'connect_progress') { updateConnectProgress(msg.payload); return; }
  const target = thread();
  if (!target || tab !== 'chat') return;
  if (msg.type === 'events' && msg.payload?.sessionId === target.id) {
    applyEventPage(msg.payload, target);
  } else if (msg.type === 'delta' && msg.payload?.sessionId === target.id) {
    const d = msg.payload.delta;
    if (!d) return;
    const view = $('timeline');
    const pinned = view.scrollHeight - view.clientHeight - view.scrollTop < 72;
    if (d.kind === 'text' && typeof d.text === 'string') {
      live.text += d.text;
      renderLive($('live'), live, engineLabel());
    } else if (d.kind === 'thinking' && typeof d.text === 'string') {
      live.thinking += d.text;
      renderLive($('live'), live, engineLabel());
    } else if (d.kind === 'tool_output' && d.id && typeof d.text === 'string') {
      const prev = live.toolOutput.get(d.id) ?? '';
      live.toolOutput.set(d.id, (prev + d.text).slice(-12000));
      const pre = $('events').querySelector(`details.tool-step[data-call="${CSS.escape(d.id)}"] pre`);
      if (pre) pre.textContent = live.toolOutput.get(d.id);
    }
    if (pinned) view.scrollTop = view.scrollHeight;
  }
}
if (native?.onEvent) native.onEvent(applyStreamMessage);

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
  stopStream();
  clearLive();
  rows = []; seq = 0; firstSeq = 0; hasOlder = false; epoch = null;
  historyProblem = historyDirty = false;
  $('events').replaceChildren();
  $('load-older').hidden = true;
}
function renderPendingAttachments() {
  const strip = $('pending-attachments');
  strip.hidden = !pendingAttachments.length;
  strip.replaceChildren(...pendingAttachments.map(att => {
    const isUploading = att.status === 'uploading';
    const isError = att.status === 'error';
    const pct = Math.max(0, Math.min(100, Math.round(att.progress || 0)));
    const tip = `${att.name}${att.size ? ' (' + fmtSize(att.size) + ')' : ''}${isError && att.error ? ' · ' + att.error : ''}`;
    if (att.isImage && att.previewUrl) {
      const card = element('div', undefined, 'att-card' + (isError ? ' error' : ''));
      card.dataset.attId = att.localId;
      const wrap = element('div', undefined, 'att-thumb-wrap');
      const thumbBtn = element('button', undefined, 'att-thumb-btn');
      thumbBtn.type = 'button';
      thumbBtn.title = `点击预览 ${tip}`;
      thumbBtn.setAttribute('aria-label', `预览图片 ${att.name}`);
      const img = element('img', undefined, 'att-thumb');
      img.src = att.previewUrl; img.alt = att.name;
      thumbBtn.append(img);
      thumbBtn.onclick = () => openImagePreview({ url: att.previewUrl, name: att.name, size: att.size });
      wrap.append(thumbBtn);
      if (isUploading) {
        const overlay = element('div', undefined, 'att-overlay');
        overlay.append(element('span', pct > 0 ? pct + '%' : '上传中', 'att-overlay-text'));
        const bar = element('div', undefined, 'att-overlay-bar');
        const fill = element('div', undefined, 'att-overlay-fill');
        fill.style.width = pct + '%';
        bar.append(fill);
        overlay.append(bar);
        wrap.append(overlay);
      } else if (isError) {
        const overlay = element('div', undefined, 'att-overlay error');
        const retry = element('button', undefined, 'att-retry-btn');
        retry.type = 'button';
        retry.title = att.error || '重新上传';
        retry.append(icon('refresh'), element('span', '重试'));
        retry.onclick = e => { e.stopPropagation(); retryAttachment(att); };
        overlay.append(element('span', '失败'), retry);
        wrap.append(overlay);
      }
      const del = element('button', undefined, 'att-remove');
      del.type = 'button'; del.title = '移除附件'; del.setAttribute('aria-label', '移除 ' + att.name);
      del.append(icon('close'));
      del.onclick = e => { e.stopPropagation(); removePendingAttachment(att.localId); };
      wrap.append(del);
      const cap = element('span', att.name, 'att-card-name');
      cap.title = tip;
      card.append(wrap, cap);
      return card;
    }
    const chip = element('span', undefined, 'att-chip' + (isError ? ' error' : ''));
    chip.dataset.attId = att.localId;
    chip.title = tip;
    chip.append(icon('paperclip'), element('span', att.name, 'att-chip-name'));
    if (isUploading) {
      chip.append(element('span', pct > 0 ? pct + '%' : '上传中', 'att-chip-pct'));
      const bar = element('div', undefined, 'att-chip-bar');
      const fill = element('div', undefined, 'att-chip-fill');
      fill.style.width = pct + '%';
      bar.append(fill);
      chip.append(bar);
    } else if (isError) {
      const retry = element('button', '重试', 'att-chip-retry');
      retry.type = 'button';
      retry.onclick = () => retryAttachment(att);
      chip.append(retry);
    }
    const del = element('button', undefined, 'att-chip-del');
    del.type = 'button'; del.title = '移除附件'; del.setAttribute('aria-label', '移除 ' + att.name);
    del.append(icon('close'));
    del.onclick = () => removePendingAttachment(att.localId);
    chip.append(del);
    return chip;
  }));
}
function updateAttachmentProgressDom(att) {
  const node = $('pending-attachments').querySelector(`[data-att-id="${CSS.escape(att.localId)}"]`);
  if (!node) return;
  const pct = Math.max(0, Math.min(100, Math.round(att.progress || 0)));
  const label = pct > 0 ? pct + '%' : '上传中';
  const textEl = node.querySelector('.att-overlay-text, .att-chip-pct');
  if (textEl) textEl.textContent = label;
  const fillEl = node.querySelector('.att-overlay-fill, .att-chip-fill');
  if (fillEl) fillEl.style.width = pct + '%';
}
function disposeAttachment(att) {
  if (att.xhr) { try { att.xhr.abort(); } catch {} att.xhr = null; }
  if (att.previewUrl && att.previewUrl.startsWith('blob:')) {
    try { URL.revokeObjectURL(att.previewUrl); } catch {}
  }
}
function clearPendingAttachments() {
  for (const att of pendingAttachments) disposeAttachment(att);
  pendingAttachments = [];
  renderPendingAttachments();
}
function removePendingAttachment(localId) {
  const idx = pendingAttachments.findIndex(a => a.localId === localId);
  if (idx < 0) return;
  disposeAttachment(pendingAttachments[idx]);
  pendingAttachments.splice(idx, 1);
  renderPendingAttachments();
  controls();
}
function openImagePreview({ url, name, size }) {
  if (!url) return;
  const img = $('image-preview-img');
  $('image-preview-title').textContent = name || '图片预览';
  $('image-preview-info').textContent = size ? fmtSize(size) : '';
  img.onload = () => {
    const dims = img.naturalWidth && img.naturalHeight ? `${img.naturalWidth} × ${img.naturalHeight}` : '';
    $('image-preview-info').textContent = [dims, size ? fmtSize(size) : ''].filter(Boolean).join(' · ');
  };
  img.src = url;
  img.alt = name || '图片预览';
  showDialog('image-preview-dialog');
}
function select(id) {
  if (id !== selected) {
    resetHistory();
    clearPendingAttachments();
  }
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
  if (!narrow.matches && (id || native)) $('draft').focus({ preventScroll: true });
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
    clearPendingAttachments();
    sidebarKey = searchKey = fleetKey = deviceKey = null;
    groups.clear(); unfolded.clear(); fleet = []; adminUsers = []; usersKey = null; fleetKey = null;
    quotaData = null; quotaLoading = false; quotaError = ''; quotaAutoLoaded = false;
    for (const id of ['sessions', 'devices', 'fleet', 'search-results', 'signed-user', 'account', 'notice', 'session-title', 'project', 'mode', 'consent-copy']) $(id).replaceChildren();
    $('draft').value = '';
    $('password-form').reset();
    $('account-feedback').textContent = '';
    tab = 'chat';
  }
  state = null; online = false; syncFailures = 0;
  if (!restore) connectState.clear();
  restoring = restore;
  $('restoring').hidden = !restoring; $('login').hidden = restoring;
  $('restore-title').textContent = restore === 'connecting' ? '正在建立连接' : '正在恢复登录';
  $('restore-status').textContent = detail ? detail + '稍后会自动重试。' :
    restore === 'connecting' ? '账号已验证，正在配置并连接加密隧道…' :
    restore === 'waiting' ? '暂时无法恢复登录，稍后会自动重试。' : '正在检查本机登录状态…';
  $('forget-login').hidden = restore !== 'waiting' && !(restore === 'connecting' && detail);
  renderConnectProgress();
  $('app').hidden = true; $('signin').hidden = false;
  $('entry').textContent = localName ? '连接设备 · ' + localName : native ? '登录后继续本机项目的对话。' : '使用你的 AnywhereMesh 账号继续。';
  updatePwaInstallUI();
}

function sidebar() {
  const fingerprint = JSON.stringify([selected, projectId, state.sessions.map(s => [s.id, s.title, s.workspaceId, Boolean(s.activeTurn)]),
    state.projects.map(p => [p.id, p.label, p.deviceId]), state.devices.map(d => [d.id, d.name]), [...groups], [...unfolded]]);
  if (fingerprint === sidebarKey) return;
  sidebarKey = fingerprint;
  const focus = document.activeElement?.closest('#sessions button')?.dataset;
  const parts = document.createDocumentFragment();
  const projects = [...state.projects].sort((a, b) => Number(isLocal(b)) - Number(isLocal(a)));
  const labels = projects.map(p => p.label);
  for (const p of projects) {
    const sessions = state.sessions.filter(s => s.workspaceId === p.id);
    if (!sessions.length && !isLocal(p) && !isRemoteAuthorized(p)) continue;
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
      const visible = unfolded.has(p.id) ? sessions : sessions.slice(0, 4);
      for (const s of visible) {
        const b = element('button', undefined, 'thread-row');
        b.dataset.session = s.id; b.title = s.title;
        b.append(element('span', s.title));
        if (s.activeTurn) { const dot = element('i'); dot.setAttribute('aria-label', '处理中'); b.append(dot); }
        if (selected === s.id && tab === 'chat') b.setAttribute('aria-current', 'page');
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
  if (focus) for (const key of ['group', 'session', 'more']) {
    if (focus[key]) $('sessions').querySelector('[data-' + key + '="' + CSS.escape(focus[key]) + '"]')?.focus({ preventScroll: true });
  }
}

function searchResults() {
  const query = $('search-input').value.trim().toLocaleLowerCase();
  const matches = state.sessions.filter(s => [s.title, projectById(s.workspaceId)?.label, deviceById(s.deviceId)?.name]
    .some(value => value?.toLocaleLowerCase().includes(query)));
  const key = JSON.stringify([query, matches.map(s => [s.id, s.title, projectById(s.workspaceId)?.label, deviceById(s.deviceId)?.name])]);
  if (key === searchKey) return;
  searchKey = key;
  const list = matches.map(s => {
    const result = element('button', undefined, 'result-row'), text = element('span');
    result.dataset.session = s.id;
    text.append(element('strong', s.title), element('small', [projectById(s.workspaceId)?.label, deviceById(s.deviceId)?.name].filter(Boolean).join(' · ')));
    result.append(icon('chat'), text);
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
  const key = JSON.stringify([online, state.deviceId, state.devices.map(d => [d.id, d.name, status(d), d.online ? null : d.lastSeen])]);
  if (key === deviceKey) return;
  deviceKey = key;
  const entries = state.devices.map(d => {
    const box = element('div', undefined, 'device-row');
    const identity = element('div'), badge = element('span', undefined, 'device-state');
    identity.append(element('strong', d.name + (d.id === state.deviceId ? ' · 本机' : '')),
      element('small', d.online ? '设备 ' + d.id.slice(0, 6) : lastSeen(d)));
    badge.append(element('i', undefined, 'dot ' + (d.online && online ? 'online' : 'offline')), document.createTextNode(status(d)));
    box.append(icon('dev'), identity, badge);
    return box;
  });
  $('devices').replaceChildren(...(entries.length ? entries : [element('p', '还没有登录过的设备。', 'list-empty')]));
}
function formatResetTime(ts) {
  if (!ts) return '';
  const diff = ts - Date.now();
  const abs = new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  if (diff <= 0) return `即将重置（${abs}）`;
  const mins = Math.ceil(diff / 60000);
  if (mins < 60) return `${mins} 分钟后重置（${abs}）`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return `${hours} 小时${remMins ? ` ${remMins} 分钟` : ''}后重置（${abs}）`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return `${days} 天${remHours ? ` ${remHours} 小时` : ''}后重置（${abs}）`;
}
function quotaTone(remainingPercent) {
  if (remainingPercent <= 10) return 'danger';
  if (remainingPercent <= 25) return 'warn';
  return '';
}
function formatPercent(val) {
  const rounded = Math.round(val * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}
function renderQuotaSummary() {
  const btn = $('usage-quota');
  const badge = $('quota-summary');
  const engines = availableEngines();
  btn.hidden = !engines.length;
  if (!engines.length) return;
  const list = quotaData?.engines ?? [];
  const active = list.find(e => e.engine === activeEngine() && e.status === 'ok' && e.groups?.length);
  const pool = active ? [active] : list.filter(e => e.status === 'ok' && e.groups?.length);
  const remaining = pool.flatMap(e => e.groups.flatMap(g => g.windows.map(w => w.remainingPercent))).filter(n => typeof n === 'number');
  if (!remaining.length) {
    badge.textContent = quotaLoading ? '…' : '';
    badge.className = 'foot-state';
    return;
  }
  const minRemain = Math.min(...remaining);
  const tone = quotaTone(minRemain);
  badge.textContent = '余 ' + formatPercent(minRemain);
  badge.className = 'foot-state' + (tone ? ' ' + tone : '');
}
function renderQuotaDialog() {
  const body = $('quota-body');
  const refreshBtn = $('refresh-quota');
  refreshBtn.disabled = quotaLoading || !online;
  refreshBtn.classList.toggle('spinning', quotaLoading);
  $('quota-updated').textContent = quotaLoading
    ? '正在查询使用额度…'
    : quotaData?.fetchedAt
      ? '更新于 ' + new Date(quotaData.fetchedAt).toLocaleTimeString('zh-CN', { hour12: false })
      : '';
  if (quotaLoading && !quotaData) {
    body.replaceChildren(element('p', '正在向服务端查询 Codex 与 Antigravity 的使用额度…', 'list-empty'));
    return;
  }
  if (quotaError && !quotaData) {
    body.replaceChildren(element('p', quotaError, 'inline-error'));
    return;
  }
  const engines = quotaData?.engines ?? [];
  if (!engines.length) {
    body.replaceChildren(element('p', '当前服务端未启用 Codex 或 Antigravity 引擎。', 'list-empty'));
    return;
  }
  const cards = engines.map(item => {
    const card = element('section', undefined, 'quota-card');
    const head = element('div', undefined, 'quota-card-head');
    const title = element('div', undefined, 'quota-engine-title');
    title.append(icon('spark'), element('span', item.label || engineLabel(item.engine)));
    const badges = element('div', undefined, 'quota-badges');
    if (item.plan) badges.append(element('span', item.plan, 'quota-badge'));
    if (item.credits) {
      const creditText = item.credits.unlimited ? '无限额度'
        : item.credits.balance != null ? `余额 ${item.credits.balance}`
        : '含积分额度';
      badges.append(element('span', creditText, 'quota-badge subtle'));
    }
    head.append(title, badges);
    card.append(head);
    if (item.status === 'error') {
      card.append(element('p', item.error || '暂时无法获取该引擎的额度信息。', 'quota-status-msg error'));
      return card;
    }
    if (item.rawSummary) {
      card.append(element('pre', item.rawSummary, 'quota-raw'));
      return card;
    }
    const groups = item.groups ?? [];
    if (!groups.length) {
      card.append(element('p', '当前账号暂无可展示的窗口额度数据。', 'quota-status-msg'));
      return card;
    }
    for (const g of groups) {
      const groupEl = element('div', undefined, 'quota-group');
      if (groups.length > 1 || (g.name && g.name !== 'Codex 通用额度')) {
        groupEl.append(element('div', g.name, 'quota-group-name'));
      }
      for (const w of g.windows ?? []) {
        const tone = quotaTone(w.remainingPercent);
        const winEl = element('div', undefined, 'quota-window');
        const row = element('div', undefined, 'quota-window-head');
        row.append(element('span', w.label, 'quota-window-label'));
        const pctEl = element('span', undefined, 'quota-window-pct' + (tone ? ' ' + tone : ''));
        pctEl.append(document.createTextNode('剩余 ' + formatPercent(w.remainingPercent)), element('small', '已用 ' + formatPercent(w.usedPercent)));
        row.append(pctEl);
        const bar = element('div', undefined, 'quota-bar');
        const fill = element('div', undefined, 'quota-bar-fill' + (tone ? ' ' + tone : ''));
        fill.style.width = Math.max(0, Math.min(100, w.remainingPercent)) + '%';
        bar.append(fill);
        winEl.append(row, bar);
        if (w.resetsAt) winEl.append(element('span', formatResetTime(w.resetsAt), 'quota-reset'));
        groupEl.append(winEl);
      }
      card.append(groupEl);
    }
    return card;
  });
  body.replaceChildren(...cards);
}
async function fetchQuota(force = false) {
  if (quotaLoading || !state?.user || !availableEngines().length) return;
  quotaLoading = true;
  quotaError = '';
  renderQuotaSummary();
  if ($('quota-dialog').open) renderQuotaDialog();
  try {
    quotaData = await action('quota', force ? { refresh: true } : {});
    quotaError = '';
  } catch (err) {
    if (String(err.message).includes('LOGIN_REQUIRED')) { loginView(); return; }
    quotaError = message(err);
  } finally {
    quotaLoading = false;
    renderQuotaSummary();
    if ($('quota-dialog').open) renderQuotaDialog();
  }
}
function openQuota() {
  if (!state || !availableEngines().length) return;
  showDialog('quota-dialog');
  renderQuotaDialog();
  const stale = !quotaData || Date.now() - (quotaData.fetchedAt ?? 0) > 60000;
  if (stale && online) void fetchQuota(false);
}
function showAdminFeedback(text = '') {
  const box = $('admin-feedback');
  box.textContent = text;
  box.hidden = !text;
}
function formatDateTime(ts) {
  return ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '暂无记录';
}
function renderAdminTabs() {
  const isUsers = adminTab === 'users';
  $('admin-tab-users').classList.toggle('active', isUsers);
  $('admin-tab-users').setAttribute('aria-selected', String(isUsers));
  $('admin-tab-devices').classList.toggle('active', !isUsers);
  $('admin-tab-devices').setAttribute('aria-selected', String(!isUsers));
  $('admin-users-panel').hidden = !isUsers;
  $('admin-devices-panel').hidden = isUsers;
  $('new-user-btn').disabled = busy || !online;
}
function renderUsers() {
  const adminTotal = adminUsers.filter(u => u.isAdmin).length;
  $('users-summary').textContent = `共 ${adminUsers.length} 个账号（其中超级管理员 ${adminTotal} 名）`;
  const key = JSON.stringify([online, busy, state?.user?.id, adminUsers]);
  if (key === usersKey) return;
  usersKey = key;
  const table = element('table'), header = table.createTHead().insertRow(), body = table.createTBody();
  for (const text of ['账号', '设备数', '创建时间', '最近登录', '操作']) header.append(element('th', text));
  for (const u of adminUsers) {
    const row = body.insertRow();
    const isSelf = u.id === state?.user?.id;
    const soleAdmin = u.isAdmin && adminTotal <= 1;
    const nameCell = element('td');
    nameCell.append(element('strong', u.username));
    const roleBadge = element('span', u.isAdmin ? '超级管理员' : '普通用户', 'role-badge' + (u.isAdmin ? ' admin' : ''));
    nameCell.append(roleBadge);
    if (isSelf) nameCell.append(element('span', '当前账号', 'role-badge self'));
    const devCell = element('td', `${u.onlineDevices ?? 0} 在线 / ${u.deviceCount ?? 0} 台`);
    const ops = element('div', undefined, 'row-actions');
    const resetBtn = element('button', '重置密码', 'secondary');
    resetBtn.type = 'button';
    resetBtn.disabled = busy || !online;
    resetBtn.onclick = () => openResetPassword(u);
    const roleBtn = element('button', u.isAdmin ? '取消管理员' : '设为管理员', 'secondary');
    roleBtn.type = 'button';
    roleBtn.disabled = busy || !online || soleAdmin;
    if (soleAdmin) roleBtn.title = '至少需保留一名超级管理员';
    roleBtn.onclick = () => {
      const verb = u.isAdmin ? '取消超级管理员权限' : '授予超级管理员权限';
      if (!confirm(`确定要为账号「${u.username}」${verb}？`)) return;
      void perform(async () => {
        await action('setUserAdmin', { userId: u.id, isAdmin: !u.isAdmin });
        showAdminFeedback(`已更新「${u.username}」的管理员权限。`);
      });
    };
    const delBtn = element('button', '删除', 'secondary danger-btn');
    delBtn.type = 'button';
    delBtn.disabled = busy || !online || isSelf || soleAdmin;
    if (isSelf) delBtn.title = '不能删除当前登录账号';
    else if (soleAdmin) delBtn.title = '至少需保留一名超级管理员';
    delBtn.onclick = () => {
      if (!confirm(`确定删除账号「${u.username}」？其登录会话与设备登记记录将被移除，此操作不可撤销。`)) return;
      void perform(async () => {
        await action('deleteUser', { userId: u.id });
        showAdminFeedback(`已删除账号「${u.username}」。`);
      });
    };
    ops.append(resetBtn, roleBtn, delBtn);
    const opCell = element('td'); opCell.append(ops);
    row.append(nameCell, devCell, element('td', formatDateTime(u.createdAt)), element('td', formatDateTime(u.lastLoginAt)), opCell);
  }
  $('users-table').replaceChildren(adminUsers.length ? table : element('p', '暂无账号记录。', 'list-empty'));
}
function renderFleet() {
  const onlineCount = fleet.filter(d => d.online).length;
  const prunableCount = fleet.filter(d => !d.online && !(d.sessions?.length)).length;
  $('devices-summary').textContent = `共 ${fleet.length} 台设备（${onlineCount} 在线，${prunableCount} 台离线无会话可清理）`;
  $('prune-devices-btn').disabled = busy || !online || prunableCount === 0;
  $('prune-devices-btn').textContent = prunableCount ? `清理离线无会话设备 (${prunableCount})` : '清理离线无会话设备';
  const key = JSON.stringify([online, busy, fleet.map(d => [d.id, d.name, d.username, d.disabled, d.online, d.online ? null : d.lastSeen, d.sessions])]);
  if (key === fleetKey) return;
  fleetKey = key;
  const table = element('table'), header = table.createTHead().insertRow(), body = table.createTBody();
  for (const text of ['账号', '设备', '状态', '绑定会话', '操作']) header.append(element('th', text));
  for (const d of fleet) {
    const row = body.insertRow(), presence = element('td', status(d));
    presence.append(element('small', lastSeen(d)));
    const ops = element('div', undefined, 'row-actions');
    const button = element('button', d.disabled ? '恢复接入' : '停用接入', 'secondary');
    button.type = 'button';
    button.disabled = busy || !online;
    button.onclick = () => perform(() => action('disable', { id: d.id, disabled: !d.disabled }));
    const delBtn = element('button', '删除', 'secondary danger-btn');
    delBtn.type = 'button';
    delBtn.disabled = busy || !online;
    delBtn.onclick = () => {
      const warn = d.sessions?.length ? `该设备仍关联 ${d.sessions.length} 个历史会话，` : '';
      if (!confirm(`确定删除设备「${deviceName(d)}」？${warn}删除后若需使用请在该设备重新登录。`)) return;
      void perform(async () => {
        await action('deleteDevice', { id: d.id });
        showAdminFeedback(`已删除设备「${deviceName(d)}」。`);
      });
    };
    ops.append(button, delBtn);
    const op = element('td'); op.append(ops);
    row.append(element('td', d.username), element('td', deviceName(d)), presence, element('td', d.sessions.map(s => s.title).join('、') || '—'), op);
  }
  $('fleet').replaceChildren(fleet.length ? table : element('p', '暂无设备记录。', 'list-empty'));
}

function renderModelControls() {
  const engines = availableEngines();
  const eng = activeEngine();
  const hasAI = eng !== 'mock';
  const multiEngine = engines.length > 1;
  const models = modelsForEngine(eng);
  const s = thread();
  const curModel = (s ? s.options?.model : pendingModel) ?? '';
  const curEffort = (s ? s.options?.effort : pendingEffort) ?? '';
  $('engine').hidden = multiEngine;
  $('engine-select').hidden = !multiEngine;
  if (multiEngine) {
    const engineOpts = engines.map(e => new Option(engineLabel(e), e));
    const prevKey = [...$('engine-select').options].map(o => o.value).join('|');
    const nextKey = engineOpts.map(o => o.value).join('|');
    if (prevKey !== nextKey) $('engine-select').replaceChildren(...engineOpts);
    $('engine-select').value = eng;
  }
  $('model-select').hidden = !hasAI || !models.length;
  $('effort-select').hidden = !hasAI;
  if (hasAI && models.length) {
    const modelOpts = [new Option('默认模型', ''), ...models.map(m => new Option(m.name || m.id, m.id))];
    const prevKey = [...$('model-select').options].map(o => o.value).join('|');
    const nextKey = modelOpts.map(o => o.value).join('|');
    if (prevKey !== nextKey) $('model-select').replaceChildren(...modelOpts);
    $('model-select').value = models.some(m => m.id === curModel) ? curModel : '';
  }
  if (hasAI) {
    const chosen = models.find(m => m.id === curModel) ?? models.find(m => m.isDefault) ?? models[0];
    const efforts = chosen?.efforts?.length ? chosen.efforts : ['low', 'medium', 'high', 'xhigh'];
    const effortOpts = [new Option('推理: 默认', ''), ...efforts.map(e => new Option('推理: ' + (EFFORT_LABELS[e] ?? e), e))];
    const prevKey = [...$('effort-select').options].map(o => o.value).join('|');
    const nextKey = effortOpts.map(o => o.value).join('|');
    if (prevKey !== nextKey) $('effort-select').replaceChildren(...effortOpts);
    $('effort-select').value = efforts.includes(curEffort) ? curEffort : '';
  }
  const locked = busy || !online || Boolean(s?.activeTurn);
  $('engine-select').disabled = locked;
  $('model-select').disabled = locked;
  $('effort-select').disabled = locked;
  fitAllModelSelects();
}

function controls() {
  const p = project(), d = p && deviceById(p.deviceId), t = thread()?.activeTurn;
  const localRevoked = isLocal(p) && (p.localMode ?? p.mode) === 'revoked';
  const uploadingAtt = pendingAttachments.some(a => a.status === 'uploading');
  const failedAtt = pendingAttachments.some(a => a.status === 'error');
  $('send').hidden = Boolean(t);
  $('stop').hidden = !t;
  $('stop').disabled = busy || !online || Boolean(t?.cancelRequested);
  $('draft').readOnly = busy;
  $('send').disabled = busy || uploadingAtt || failedAtt || !online || !d?.online || d.disabled || !p?.ready || Boolean(t) ||
    (!localRevoked && p.mode === 'revoked') || (!$('draft').value.trim() && !pendingAttachments.length);
  $('attach-file').disabled = busy || !online || Boolean(t) || pendingAttachments.length >= 8;
  $('context').disabled = busy || (!p && !(state.workspacePicker && !selected) && !selectableProjects().length);
  $('choose-workspace').disabled = busy || !online;
  $('rename-session').disabled = busy || !online || !selected;
  $('delete-session').disabled = busy || !online || !selected || Boolean(t);
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
  const hasLocalUnknown = Boolean(isLocal(p) && (p.unknownCount ?? 0) > 0);
  if (!online) notice = '暂时无法同步服务端状态，正在重试。草稿已保留。';
  else if (other) notice = '此会话只会操作「' + deviceName(d) + '」上的项目。';
  if (hasLocalUnknown) notice += (notice ? ' ' : '') + `本项目有 ${p.unknownCount} 条结果未知的任务阻塞新操作，请先在本地核对。`;
  else if (online && isLocal(p) && p.localUnavailable) notice += '本机项目目录已无法访问。';
  else if (online && d && !d.online && !connecting(d)) notice += '执行设备' + (d.disabled ? '已停用。' : '已离线。') + (s ? '仍可查看会话历史。' : '');
  else if (online && p && !p.ready && (s || !isLocal(p))) notice += '项目正在连接…';
  else if (online && other && p?.mode === 'revoked') notice += '请在该设备上授权。';
  else if (online && isLocal(p) && p.localMode && p.localMode !== p.mode) notice += '正在同步项目权限…';
  if (s && historyProblem) notice += '会话记录暂时无法同步，稍后会自动重试。';
  $('notice').textContent = notice;
  $('notice-bar').hidden = !notice;
  $('review-banner-btn').hidden = !hasLocalUnknown;
  $('notice-bar').className = !hasLocalUnknown && !historyProblem && other && online && d?.online && p?.mode !== 'revoked' ? 'remote' : '';
}

function render() {
  if (!state?.user) return;
  const s = thread(), p = project(), d = p ? deviceById(p.deviceId) : deviceById(state.deviceId);
  const canStart = Boolean(native || selectableProjects().length);
  const webEmpty = !s && !canStart, home = !s;
  const eng = activeEngine();
  const hasAI = eng !== 'mock';
  const engine = engineLabel(eng);
  $('signin').hidden = true; $('app').hidden = false;
  $('account').textContent = state.user.username;
  $('avatar').textContent = [...state.user.username][0] || 'A';
  $('signed-user').textContent = state.user.username + ' · ' + (state.localName || '网页端');
  $('device-count').textContent = online ? state.devices.filter(d => d.online).length + ' 在线' : '';
  $('settings-project').hidden = !state.workspacePicker && !mine().length;
  $('admin-nav').hidden = !state.user.isAdmin;
  $('new-chat').hidden = !canStart;
  $('chat').hidden = tab !== 'chat'; $('management').hidden = tab !== 'admin';
  $('crumb-project').textContent = tab === 'chat' && s && p ? p.label : '工作区';
  $('session-title').textContent = tab === 'admin' ? '系统管理' : s?.title || (webEmpty ? '会话' : '新对话');
  $('session-title').title = $('session-title').textContent;
  $('session-actions').hidden = tab !== 'chat' || !s;
  $('target').textContent = d ? d.id === state.deviceId ? '本机' : d.name : '我的设备';
  $('presence').textContent = d ? status(d) : '';
  $('status-dot').className = 'dot ' + (d?.online && online ? 'online' : 'offline');
  $('status-dot').hidden = !d;
  $('device-status').title = d ? deviceName(d) + ' · ' + status(d) : '我的设备';
  renderNotice(s, p, d);
  $('chat').classList.toggle('home', home);
  $('welcome').hidden = !home; $('welcome-title').textContent = webEmpty ? '从桌面开启对话' : '从哪里开始？';
  $('timeline').hidden = home; $('compose').hidden = webEmpty;
  $('web-empty').hidden = !webEmpty;
  $('web-devices').textContent = state.user.isAdmin ? '系统管理' : '查看设备';
  $('suggestions').hidden = !home || webEmpty;
  $('input-hint').hidden = home;
  const fullProjectLabel = p ? (isLocal(p) ? p.label : p.label + ' · ' + (deviceById(p.deviceId)?.name ?? '远程')) : '选择项目文件夹';
  $('project-label').textContent = s && p ? modes[p.localMode ?? p.mode]?.[0] ?? '项目权限' : fullProjectLabel;
  $('context').querySelector('use').setAttribute('href', s ? '#i-lock' : '#i-folder');
  $('context').title = !s ? (p ? `目标项目：${fullProjectLabel}（点击切换）` : '选择本机或在线远程设备项目') : p ? '查看「' + p.label + '」项目与权限' : '暂无可用项目';
  $('engine-name').textContent = engine; $('recipient').textContent = '发给' + (hasAI ? ' ' + engine : engine);
  $('example-code').lastElementChild.textContent = hasAI ? '解释代码' : '查看指令';
  $('draft').placeholder = home ? '描述任务，或问问项目里的代码…' : '继续对话…';
  $('working').hidden = !s?.activeTurn;
  $('working').lastElementChild.textContent = s?.activeTurn?.cancelRequested ? '正在停止…' : engine + ' 正在处理…';
  if (!s?.activeTurn && (live.text || live.thinking)) clearLive();
  renderModelControls();
  controls(); sidebar();
  renderQuotaSummary();
  updatePwaInstallUI();
  if ($('devices-dialog').open) renderDevices();
  if ($('search-dialog').open) searchResults();
  if ($('quota-dialog').open) renderQuotaDialog();
  if (online && !quotaAutoLoaded && availableEngines().length) {
    quotaAutoLoaded = true;
    void fetchQuota(false);
  }
  if (tab === 'admin') { renderAdminTabs(); renderUsers(); renderFleet(); }
  ensureStream();
}

function drawHistory(next, fromStart = false) {
  const selection = document.getSelection(), events = $('events'), view = $('timeline');
  if (native && selection?.rangeCount && !selection.isCollapsed && selection.getRangeAt(0).intersectsNode(events)) return false;
  const pinned = fromStart || view.scrollHeight - view.clientHeight - view.scrollTop < 72;
  renderThread(events, next, { sessionId: selected, isWeb: !native, liveToolOutput: live.toolOutput });
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
    const page = await action('history', { sessionId: target.id, afterSeq });
    if (generation !== stamp || tab !== 'chat') return;
    if (page.sessionId !== target.id || page.workspaceId !== target.workspaceId || page.historyEpoch !== target.historyEpoch ||
        !Array.isArray(page.events) || page.throughSeq !== afterSeq + page.events.length ||
        !page.events.every((r, i) => r?.seq === afterSeq + i + 1 && typeof r.event?.type === 'string' &&
          (r.event.type !== 'assistant_text' || typeof r.event.text === 'string'))) throw Error('INVALID_HISTORY_PAGE');
    const next = restart ? page.events : rows.concat(page.events);
    historyDirty = !drawHistory(next, !afterSeq);
    rows = next; epoch = page.historyEpoch; seq = page.throughSeq;
    firstSeq = rows[0]?.seq ?? 0;
    hasOlder = firstSeq > 1;
    $('load-older').hidden = !hasOlder;
    historyProblem = false;
  } catch (error) {
    if (generation !== stamp || tab !== 'chat') return;
    if (error.message.includes('LOGIN_REQUIRED')) { loginView(); return; }
    historyProblem = true;
    console.warn('会话记录同步失败', error.message === 'INVALID_HISTORY_PAGE' ? 'INVALID_HISTORY_PAGE' : error.name);
  }
  const p = project();
  renderNotice(target, p, deviceById(p?.deviceId ?? state.deviceId));
}

async function loadOlderHistory() {
  const target = thread(), stamp = generation;
  if (!target || !hasOlder || firstSeq <= 1) return;
  const view = $('timeline'), prevHeight = view.scrollHeight;
  const page = await action('historyBefore', { sessionId: target.id, beforeSeq: firstSeq });
  if (generation !== stamp || tab !== 'chat') return;
  if (page.historyEpoch !== epoch) { resetHistory(); await syncHistory(); return; }
  rows = page.events.concat(rows);
  firstSeq = page.firstSeq;
  hasOlder = page.hasMore;
  $('load-older').hidden = !hasOlder;
  renderThread($('events'), rows, { sessionId: selected, isWeb: !native, liveToolOutput: live.toolOutput });
  view.scrollTop += view.scrollHeight - prevHeight;
}

async function sync() {
  const version = generation;
  let latest;
  try { latest = await action('state'); }
  catch (error) {
    if (version !== generation) return;
    if (error.message.includes('LOGIN_REQUIRED')) { loginView(); return; }
    syncFailures++;
    if (state) {
      if (syncFailures >= 3) { online = false; stopStream(); render(); }
    } else if (restoring) {
      online = false; stopStream();
      loginView(undefined, restoring === 'connecting' ? restoring : 'waiting',
        message(error) === error.message ? '暂时无法同步登录状态。' : message(error));
    }
    return;
  }
  if (version !== generation) return;
  if (!latest.user) {
    loginView(latest.localName, latest.restoring && (restoring === 'connecting' ? restoring : 'waiting'),
      latest.connectionError && errors[latest.connectionError]);
    return;
  }
  if (!native && latest.uiVersion) {
    if (knownUiVersion && knownUiVersion !== latest.uiVersion && !$('draft').value.trim()) {
      location.reload();
      return;
    }
    knownUiVersion = latest.uiVersion;
  }
  restoring = false; syncFailures = 0; connectState.clear();
  const first = !state || state.user.id !== latest.user.id;
  if (first && state) loginView();
  state = latest; online = true;
  if (first) localConnectUntil = native ? Date.now() + 12000 : 0;
  if (deviceById(state.deviceId)?.online) localConnectUntil = 0;
  const projects = selectableProjects();
  if (!projects.some(p => p.id === projectId)) {
    projectId = projects[0]?.id;
    if (!selected) select(null);
  }
  if (first || (selected && !thread())) {
    select(!native ? state.sessions[0]?.id ?? null : null);
    if (first && !native && state.user.isAdmin && new URLSearchParams(location.search).get('view') === 'devices') tab = 'admin';
  }
  render();
  if (first && native && !narrow.matches) $('draft').focus({ preventScroll: true });
  if (tab === 'chat') await syncHistory();
  else if (state.user.isAdmin) {
    renderAdminTabs();
    const stamp = generation;
    try {
      const [list, users] = await Promise.all([action('admin'), action('adminUsers')]);
      if (stamp !== generation || tab !== 'admin') return;
      fleet = list; adminUsers = users;
      renderUsers(); renderFleet(); $('fleet-error').hidden = true;
    } catch (error) {
      if (stamp !== generation || tab !== 'admin') return;
      if (error.message.includes('LOGIN_REQUIRED')) { loginView(); return; }
      $('fleet-error').hidden = false;
    }
  }
}
async function refresh(force = false) {
  if (polling) { await polling; if (force) await refresh(); return; }
  polling = sync().catch(error => console.error('界面同步失败', error.name)).finally(() => { polling = null; });
  return polling;
}
async function perform(fn, { refreshState = true } = {}) {
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
  const available = fromAccount ? mine() : selectableProjects();
  if (bound ? !project() : !state.workspacePicker && !available.length) return;
  showDialog('project-dialog');
  projectChoices(bound, bound ? thread().workspaceId : projectId);
}
function projectChoices(bound, preferred) {
  const modalProjects = bound ? [project()].filter(Boolean) : projectSource === 'settings' ? mine() : selectableProjects();
  const initial = modalProjects.find(p => p.id === preferred) ?? modalProjects[0];
  const optionLabel = p => isLocal(p) ? p.label : `${p.label} · ${deviceById(p.deviceId)?.name ?? '远程设备'}（${modes[p.mode]?.[0] ?? '已授权'}）`;
  $('project').replaceChildren(...modalProjects.map(p => new Option(optionLabel(p), p.id)));
  $('project').value = initial?.id ?? '';
  $('project').disabled = modalProjects.length < 2;
  $('project-caption').textContent = bound ? '会话绑定项目' : projectSource === 'settings' ? '本机项目' : '对话目标项目（本机或在线远程设备）';
  $('choose-workspace').hidden = bound || !native || !state.workspacePicker;
  showProject(initial?.id);
}
async function chooseProject() {
  const picked = await action('chooseWorkspace');
  if (!picked) return;
  const index = state.projects.findIndex(p => p.id === picked.id);
  if (index < 0) state.projects.push(picked);
  else state.projects[index] = { ...state.projects[index], ...picked };
  if (!selected && projectSource === 'context') {
    projectId = picked.id;
    select(null);
  }
  projectChoices(false, picked.id);
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
  const hasUnknown = Boolean(isLocal(p) && (p.unknownCount ?? 0) > 0);
  $('project-unknown-box').hidden = !hasUnknown;
  if (hasUnknown) $('project-unknown-text').textContent = `存在 ${p.unknownCount} 条结果未知的任务，需核对后才能继续操作本项目。`;
  $('remove-workspace').hidden = !(isLocal(p) && p.canRemove && !thread());
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
    await action('permission', { workspaceId: p.id, mode });
  }
  if (!selected && p && projectSource === 'context' && projectId !== p.id) {
    projectId = p.id; select(null);
  }
  $('project-dialog').close();
}
async function removeCurrentWorkspace() {
  const p = projectById($('project').value);
  if (!p || !p.canRemove) return;
  if (!confirm(`确定从设备移除项目「${p.label}」？（不会删除本地文件夹）`)) return;
  await action('removeWorkspace', { workspaceId: p.id });
  $('project-dialog').close();
}

async function openReviewDialog(workspaceId) {
  if (!workspaceId || !native) return;
  reviewWorkspaceId = workspaceId;
  showDialog('review-dialog');
  await refreshReviewList();
}
async function refreshReviewList() {
  if (!reviewWorkspaceId) return;
  const info = await action('reviewList', { workspaceId: reviewWorkspaceId });
  $('review-revoke-row').hidden = info.revoked || !info.items.length;
  const list = $('review-list');
  if (!info.items.length) {
    list.replaceChildren(element('p', '本项目当前没有待核对的未知任务。', 'list-empty'));
    return;
  }
  list.replaceChildren(...info.items.map(item => {
    const card = element('div', undefined, 'review-card');
    card.append(
      element('strong', `${item.tool} · 任务 ${item.operationId.slice(0, 8)}`),
      element('small', `原因：${item.reason || 'unknown'} · 启动次数：${item.starts}`),
      element('pre', JSON.stringify(item.args ?? {}, null, 2)),
    );
    if (item.needsRevoke) {
      card.append(element('p', '请先点击上方「立即撤销权限」以生成核对摘要。', 'muted'));
    } else if (item.error) {
      card.append(element('p', message({ message: item.error }), 'inline-error'));
    } else {
      const noteInput = element('textarea');
      noteInput.placeholder = '记录你在本地核实的文件状态（例如：已检查 notes.txt，内容完整）…';
      noteInput.maxLength = 2048;
      const submitBtn = element('button', '确认已核对（保留未知结论，解除阻塞）', 'primary');
      submitBtn.type = 'button';
      submitBtn.onclick = () => perform(async () => {
        const note = noteInput.value.trim();
        if (!note) throw Error('请先填写本地核对说明。');
        await action('reviewSubmit', {
          workspaceId: reviewWorkspaceId,
          requestId: crypto.randomUUID(),
          operationId: item.operationId,
          expectedDigest: item.expectedDigest,
          note,
        });
        await refreshReviewList();
      });
      card.append(noteInput, submitBtn);
    }
    return card;
  }));
}

function readFileAsBase64(file, onProgress) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    if (onProgress) {
      reader.onprogress = e => {
        if (e.lengthComputable && e.total > 0) onProgress(Math.round((e.loaded / e.total) * 100));
      };
    }
    reader.onload = () => {
      const str = String(reader.result || '');
      const comma = str.indexOf(',');
      resolve(comma >= 0 ? str.slice(comma + 1) : str);
    };
    reader.onerror = () => reject(Error('无法读取所选文件。'));
    reader.readAsDataURL(file);
  });
}
function normalizeAttachmentName(file, { pasted = false } = {}) {
  const mime = (file.type || 'application/octet-stream').toLowerCase();
  const raw = (file.name || '').trim();
  const extFromRaw = raw.includes('.') ? raw.slice(raw.lastIndexOf('.') + 1).toLowerCase() : '';
  const ext = MIME_EXT[mime] || extFromRaw || (mime.startsWith('image/') ? 'png' : 'bin');
  const genericPaste = !raw || (pasted && /^(?:image|blob|clipboard|screenshot|pasted?)(?:\.[a-z0-9]+)?$/i.test(raw));
  let candidate = raw;
  if (genericPaste) {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const stamp = `${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    candidate = `paste-${stamp}-${++pasteCounter}.${ext}`;
  }
  const existing = new Set(pendingAttachments.map(a => a.name.toLowerCase()));
  if (!existing.has(candidate.toLowerCase())) return candidate;
  const dot = candidate.lastIndexOf('.');
  const base = dot > 0 ? candidate.slice(0, dot) : candidate;
  const suffix = dot > 0 ? candidate.slice(dot) : '';
  let n = 2;
  while (existing.has(`${base}-${n}${suffix}`.toLowerCase())) n++;
  return `${base}-${n}${suffix}`;
}
function uploadAttachmentWeb(sessionId, item, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    item.xhr = xhr;
    xhr.open('POST', `/api/sessions/${sessionId}/attachments`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', item.mime || 'application/octet-stream');
    xhr.setRequestHeader('X-Filename', encodeURIComponent(item.name));
    xhr.upload.onprogress = e => {
      if (e.lengthComputable && e.total > 0) onProgress(Math.min(99, Math.round((e.loaded / e.total) * 100)));
    };
    xhr.onload = () => {
      item.xhr = null;
      let data = {};
      try { data = JSON.parse(xhr.responseText || '{}'); } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && data.id) {
        onProgress(100);
        resolve(data);
      } else {
        reject(Error(data.error || '附件上传失败。'));
      }
    };
    xhr.onerror = () => { item.xhr = null; reject(Error('网络异常，附件上传失败。')); };
    xhr.onabort = () => { item.xhr = null; reject(Error('UPLOAD_ABORTED')); };
    xhr.send(item.file);
  });
}
async function uploadPendingItem(item, sessionId) {
  if (!item || !sessionId || !item.file) return item?.id ? item : null;
  item.status = 'uploading';
  item.progress = 2;
  item.error = '';
  renderPendingAttachments();
  controls();
  let ticker = null;
  try {
    let uploaded;
    if (!native) {
      uploaded = await uploadAttachmentWeb(sessionId, item, pct => {
        item.progress = Math.max(2, pct);
        updateAttachmentProgressDom(item);
      });
    } else {
      const dataBase64 = await readFileAsBase64(item.file, pct => {
        item.progress = Math.max(2, Math.round(pct * 0.4));
        updateAttachmentProgressDom(item);
      });
      item.progress = 45;
      updateAttachmentProgressDom(item);
      ticker = setInterval(() => {
        if (item.progress < 92) {
          item.progress = Math.min(92, item.progress + 7);
          updateAttachmentProgressDom(item);
        }
      }, 180);
      uploaded = await action('uploadAttachment', { sessionId, name: item.name, mime: item.mime, dataBase64 });
    }
    if (!pendingAttachments.includes(item)) return null;
    item.id = uploaded.id;
    item.name = uploaded.name || item.name;
    item.size = uploaded.size ?? item.size;
    item.status = 'ready';
    item.progress = 100;
    item.error = '';
    renderPendingAttachments();
    controls();
    return uploaded;
  } catch (err) {
    if (err.message === 'UPLOAD_ABORTED' || !pendingAttachments.includes(item)) return null;
    item.status = 'error';
    item.error = message(err);
    renderPendingAttachments();
    controls();
    notify(item.error);
    return null;
  } finally {
    if (ticker) clearInterval(ticker);
  }
}
function retryAttachment(item) {
  if (!item || !pendingAttachments.includes(item)) return;
  if (selected) {
    void uploadPendingItem(item, selected);
  } else {
    item.status = 'staged';
    item.error = '';
    item.progress = 0;
    renderPendingAttachments();
    controls();
  }
}
function attachLocalFiles(files, { pasted = false } = {}) {
  const list = [...(files || [])].filter(Boolean);
  if (!list.length) return;
  const targetSession = selected;
  const added = [];
  for (const file of list) {
    if (pendingAttachments.length >= 8) {
      notify('最多可同时附加 8 个文件。');
      break;
    }
    if (file.size > 10 * 1024 * 1024) {
      notify(errors.BODY_LIMIT);
      continue;
    }
    const name = normalizeAttachmentName(file, { pasted });
    const mime = file.type || 'application/octet-stream';
    const isImage = /^image\//.test(mime);
    const item = {
      localId: crypto.randomUUID(),
      id: null,
      name,
      mime,
      size: file.size,
      file,
      previewUrl: isImage ? URL.createObjectURL(file) : null,
      isImage,
      status: targetSession ? 'uploading' : 'staged',
      progress: targetSession ? 2 : 0,
      error: '',
      xhr: null,
    };
    pendingAttachments.push(item);
    added.push(item);
  }
  renderPendingAttachments();
  controls();
  if (targetSession) {
    for (const item of added) void uploadPendingItem(item, targetSession);
  }
}

function rememberInput() {
  const key = keyFor(), old = draftAt(key);
  saveDraft(key, { text: $('draft').value, ...(old.createId ? { createId: old.createId, title: old.title } : {}),
    ...(old.text === $('draft').value && old.requestId ? { requestId: old.requestId } : {}) });
  controls();
}
function newTitle(text) {
  const first = text.trim().split(/\r?\n/, 1)[0].replace(/\s+/g, ' ');
  const chars = Array.from(first);
  return chars.length > 32 ? chars.slice(0, 31).join('') + '…' : first;
}
async function sendMessage() {
  const p = project(), originalKey = keyFor();
  const rawText = $('draft').value;
  const text = rawText.trim() ? rawText : (pendingAttachments.length ? '请查看附件。' : '');
  const entry = draftAt(originalKey);
  if (!p || !originalKey || !text.trim()) return;
  const requestId = entry.text === rawText && entry.requestId || crypto.randomUUID();
  let sessionId = selected;
  if (!sessionId) {
    if (!isLocal(p) && !isRemoteAuthorized(p)) throw Error('请先在目标设备上给项目授权。');
    const title = entry.title || newTitle(text), createId = entry.createId || crypto.randomUUID();
    saveDraft(originalKey, { text: rawText, requestId, title, createId });
    const options = {};
    if (pendingAgent) options.agent = pendingAgent;
    if (pendingModel) options.model = pendingModel;
    if (pendingEffort) options.effort = pendingEffort;
    const s = await action('create', { requestId: createId, title, workspaceId: p.id, ...(Object.keys(options).length ? { options } : {}) });
    if (s.workspaceId !== p.id || s.deviceId !== p.deviceId) throw Error('会话绑定设备不一致。');
    state.sessions = [s, ...state.sessions.filter(t => t.id !== s.id)];
    sessionId = s.id;
    saveDraft(keyFor(sessionId), { text: rawText, requestId });
    sessionStorage.removeItem(originalKey);
    selected = sessionId;
    groups.set(s.workspaceId, true);
    render();
  } else saveDraft(originalKey, { text: rawText, requestId });

  const attIds = [];
  for (let i = 0; i < pendingAttachments.length; i++) {
    const att = pendingAttachments[i];
    if (att.id) attIds.push(att.id);
    else {
      const uploaded = await uploadPendingItem(att, sessionId);
      if (!uploaded?.id) throw Error(att.error || '附件上传失败，请重试。');
      attIds.push(uploaded.id);
    }
  }
  await action('send', { sessionId, requestId, text, ...(attIds.length ? { attachments: attIds } : {}) });
  sessionStorage.removeItem(keyFor(sessionId));
  clearPendingAttachments();
  if (selected === sessionId) $('draft').value = '';
  $('timeline').scrollTop = $('timeline').scrollHeight;
}
function requestSend() {
  if (busy || $('send').disabled || $('send').hidden) return;
  const p = project();
  if (isLocal(p) && (p.localMode ?? p.mode) === 'revoked') {
    consent = { key: keyFor(), project: p.id, user: state.user.id };
    const allowed = (p.localModes ?? Object.keys(modes)).filter(mode => mode !== 'revoked');
    $('consent-mode').replaceChildren(...allowed.map(mode => new Option(modes[mode][0], mode)));
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
  if (currentMode === 'revoked') await action('permission', { workspaceId: p.id, mode: requested });
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
    await new Promise(resolve => setTimeout(resolve, 350));
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
    await action('changePassword', { current, password });
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
function showAdmin(initialSubTab) {
  if (!state?.user.isAdmin || busy) return;
  if (initialSubTab) adminTab = initialSubTab;
  showAdminFeedback();
  activeDialog()?.close(); drawer(false); stopStream(); tab = 'admin'; sidebarKey = null; renderAdminTabs(); render(); void refresh(true);
}
function openCreateUser() {
  if (busy || !state?.user.isAdmin) return;
  $('create-user-form').reset();
  $('create-user-error').textContent = '';
  showDialog('create-user-dialog');
  $('create-username').focus();
}
async function submitCreateUser() {
  const username = $('create-username').value.trim();
  const password = $('create-password').value;
  const confirmPw = $('create-password-confirm').value;
  const isAdmin = $('create-is-admin').checked;
  if (password !== confirmPw) {
    $('create-password-confirm').focus();
    throw Error('两次输入的密码不一致。');
  }
  await action('createUser', { username, password, isAdmin });
  $('create-user-dialog').close();
  showAdminFeedback(`已创建账号「${username}」（${isAdmin ? '超级管理员' : '普通用户'}）。`);
}
function openResetPassword(userObj) {
  if (busy || !state?.user.isAdmin || !userObj) return;
  resetTargetUser = userObj;
  $('reset-password-form').reset();
  $('reset-password-error').textContent = '';
  $('reset-password-note').textContent = `正在为「${userObj.username}」设置新密码。重置后该账号的所有设备和浏览器需要用新密码重新登录。`;
  showDialog('reset-password-dialog');
  $('reset-new-password').focus();
}
async function submitResetPassword() {
  if (!resetTargetUser) return;
  const password = $('reset-new-password').value;
  const confirmPw = $('reset-confirm-password').value;
  if (password !== confirmPw) {
    $('reset-confirm-password').focus();
    throw Error('两次输入的新密码不一致。');
  }
  const targetName = resetTargetUser.username;
  await action('resetUserPassword', { userId: resetTargetUser.id, password });
  $('reset-password-dialog').close();
  showAdminFeedback(`已重置「${targetName}」的密码。`);
}

$('login').onsubmit = e => {
  e.preventDefault();
  if (busy) return;
  const password = $('password').value;
  $('password').value = '';
  const label = $('login-submit').querySelector('span');
  label.textContent = '正在验证账号…';
  void perform(async () => {
    generation++;
    connectState.clear();
    connectState.set('authentication', { status: 'running' });
    await action('login', { username: $('username').value.trim(), password });
    connectState.set('authentication', { status: 'done' });
    loginView(undefined, 'connecting');
  }).finally(() => { label.textContent = '登录'; });
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
$('password-form').onsubmit = e => { e.preventDefault(); void perform(savePassword, { refreshState: false }); };
$('password-form').oninput = () => { $('password-error').textContent = ''; };
$('cancel-password').onclick = () => showAccount();
$('password-dialog').addEventListener('close', () => {
  if (!$('password-dialog').open) $('password-form').reset();
});
$('admin-nav').onclick = () => showAdmin();
$('admin-tab-users').onclick = () => { adminTab = 'users'; renderAdminTabs(); renderUsers(); };
$('admin-tab-devices').onclick = () => { adminTab = 'devices'; renderAdminTabs(); renderFleet(); };
$('new-user-btn').onclick = openCreateUser;
$('cancel-create-user').onclick = () => $('create-user-dialog').close();
$('create-user-form').oninput = () => { $('create-user-error').textContent = ''; };
$('create-user-form').onsubmit = e => { e.preventDefault(); void perform(submitCreateUser); };
$('create-user-dialog').addEventListener('close', () => { if (!$('create-user-dialog').open) $('create-user-form').reset(); });
$('cancel-reset-password').onclick = () => $('reset-password-dialog').close();
$('reset-password-form').oninput = () => { $('reset-password-error').textContent = ''; };
$('reset-password-form').onsubmit = e => { e.preventDefault(); void perform(submitResetPassword); };
$('reset-password-dialog').addEventListener('close', () => {
  if (!$('reset-password-dialog').open) { $('reset-password-form').reset(); resetTargetUser = null; }
});
$('prune-devices-btn').onclick = () => {
  const count = fleet.filter(d => !d.online && !(d.sessions?.length)).length;
  if (!count || busy) return;
  if (!confirm(`确定清理 ${count} 台离线且无绑定会话的历史设备记录？在线设备与已有会话的设备不会被影响。`)) return;
  void perform(async () => {
    const res = await action('pruneDevices');
    showAdminFeedback(`已清理 ${res.removed ?? 0} 台离线无会话设备。`);
  });
};
$('back-chat').onclick = () => openThread(selected);
$('usage-quota').onclick = openQuota;
$('refresh-quota').onclick = () => void fetchQuota(true);
$('close-quota').onclick = () => $('quota-dialog').close();
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
narrow.addEventListener('change', () => { if (!narrow.matches) drawer(false); fitAllModelSelects(); });
window.addEventListener('resize', fitAllModelSelects);
document.fonts?.ready.then(fitAllModelSelects);
$('new-chat').onclick = () => openThread(null);
$('find-chat').onclick = openSearch;
$('search-input').oninput = searchResults;
$('search-dialog').onkeydown = e => {
  const results = [...$('search-results').querySelectorAll('button')];
  if (e.key === 'Enter' && e.target === $('search-input') && results.length) { e.preventDefault(); results[0].click(); }
  if (!['ArrowDown', 'ArrowUp'].includes(e.key) || !results.length) return;
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
$('remove-workspace').onclick = () => perform(removeCurrentWorkspace);
$('open-review').onclick = () => perform(() => openReviewDialog($('project').value), { refreshState: false });
$('review-banner-btn').onclick = () => { const p = project(); if (p) void perform(() => openReviewDialog(p.id), { refreshState: false }); };
$('review-revoke-btn').onclick = () => perform(async () => {
  if (!reviewWorkspaceId) return;
  await action('permission', { workspaceId: reviewWorkspaceId, mode: 'revoked' });
  await refreshReviewList();
});
$('close-review').onclick = () => $('review-dialog').close();
$('mode').onchange = updateMode;
$('apply').onclick = () => perform(saveProject);
$('load-older').onclick = () => perform(loadOlderHistory, { refreshState: false });

$('rename-session').onclick = () => {
  const s = thread();
  if (!s || busy) return;
  $('rename-input').value = s.title;
  showDialog('rename-dialog');
  $('rename-input').focus();
  $('rename-input').select();
};
$('cancel-rename').onclick = () => $('rename-dialog').close();
$('rename-form').onsubmit = e => {
  e.preventDefault();
  const title = $('rename-input').value.trim();
  if (!title || !selected) return;
  void perform(async () => {
    await action('renameSession', { sessionId: selected, title });
    $('rename-dialog').close();
  });
};
$('delete-session').onclick = () => {
  const s = thread();
  if (!s || busy) return;
  if (!confirm(`确定删除会话「${s.title}」？此操作不可撤销。`)) return;
  void perform(async () => {
    const id = s.id;
    await action('deleteSession', { sessionId: id });
    select(null);
  });
};

$('engine-select').onchange = () => {
  fitSelectWidth($('engine-select'));
  const val = $('engine-select').value || null;
  if (selected) void perform(() => action('setSessionOptions', { sessionId: selected, agent: val, model: null, effort: null }));
  else { pendingAgent = val; pendingModel = null; pendingEffort = null; render(); }
};
$('model-select').onchange = () => {
  fitSelectWidth($('model-select'));
  const val = $('model-select').value || null;
  if (selected) void perform(() => action('setSessionOptions', { sessionId: selected, model: val }));
  else { pendingModel = val; renderModelControls(); }
};
$('effort-select').onchange = () => {
  fitSelectWidth($('effort-select'));
  const val = $('effort-select').value || null;
  if (selected) void perform(() => action('setSessionOptions', { sessionId: selected, effort: val }));
  else { pendingEffort = val; renderModelControls(); }
};

$('attach-file').onclick = () => {
  if (busy) return;
  $('file-input').value = '';
  $('file-input').click();
};
$('file-input').onchange = () => {
  const files = $('file-input').files;
  if (files?.length) attachLocalFiles(files, { pasted: false });
};
$('draft').addEventListener('paste', e => {
  const files = [];
  for (const item of e.clipboardData?.items ?? []) {
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (!files.length && e.clipboardData?.files?.length) {
    files.push(...e.clipboardData.files);
  }
  if (files.length) {
    e.preventDefault();
    attachLocalFiles(files, { pasted: true });
  }
});
$('events').addEventListener('click', e => {
  const btn = e.target.closest('.msg-att-img-btn');
  if (!btn) return;
  openImagePreview({
    url: btn.dataset.previewUrl,
    name: btn.dataset.previewName,
    size: Number(btn.dataset.previewSize || 0),
  });
});
$('image-preview-dialog').addEventListener('close', () => {
  $('image-preview-img').removeAttribute('src');
});
$('pwa-install-btn').onclick = () => void triggerPwaInstall();
$('signin-install-pwa').onclick = () => void triggerPwaInstall();
$('install-pwa-menu').onclick = () => { $('account-dialog').close(); void triggerPwaInstall(); };
$('close-install-pwa').onclick = () => $('install-pwa-dialog').close();
$('pwa-dismiss-btn').onclick = () => {
  pwaBannerDismissed = true;
  try { localStorage.setItem('anywhere-pwa-dismissed', '1'); } catch {}
  updatePwaInstallUI();
};
if (!native) {
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredInstallPrompt = e;
    updatePwaInstallUI();
  });
  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    pwaBannerDismissed = true;
    updatePwaInstallUI();
  });
  window.matchMedia?.('(display-mode: standalone)').addEventListener?.('change', updatePwaInstallUI);
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => {}); });
  }
}

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
  if (!$('consent-dialog').open) consent = null;
});
$('stop').onclick = () => {
  const turn = thread()?.activeTurn;
  if (turn) void perform(() => action('stop', { sessionId: selected, turnId: turn.id, requestId: crypto.randomUUID() }));
};
function example(text) {
  if (busy) return;
  if (!$('draft').value.trim()) { $('draft').value = text; rememberInput(); }
  $('draft').focus();
}
$('example-read').onclick = () => example(activeEngine() !== 'mock' ? '请读取 notes.txt 的第一行。' : '/read notes.txt');
$('example-code').onclick = () => example(activeEngine() !== 'mock' ? '请帮我解释下面这段代码：\n' : '/help');
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
  if (e.key.toLowerCase() === 'n' && (native || selectableProjects().length) && !activeDialog()) { e.preventDefault(); openThread(null); }
});
loginView(undefined, Boolean(native)); void refresh();
setInterval(() => { if (!busy && (restoring || (state && !document.hidden))) void refresh(); }, 1500);
document.addEventListener('visibilitychange', () => { if (!document.hidden && !busy) void refresh(); });
