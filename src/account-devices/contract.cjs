'use strict';
const routes = {
  state: [], login: ['username','password'], changePassword: ['current','password'], logout: [], admin: [], disable: ['id','disabled'],
  quota: [],
  deleteDevice: ['id'], pruneDevices: [],
  adminUsers: [], adminUsage: [], createUser: ['username','password','isAdmin'],
  resetUserPassword: ['userId','password'], setUserAdmin: ['userId','isAdmin'], deleteUser: ['userId'],
  chooseWorkspace: [], removeWorkspace: ['workspaceId'], permission: ['workspaceId','mode'],
  create: ['workspaceId','requestId','title'],
  renameSession: ['sessionId','title'], deleteSession: ['sessionId'],
  setSessionOptions: ['sessionId'],
  compactSession: ['sessionId'],
  send: ['sessionId','requestId','text'], history: ['sessionId','afterSeq'], historyBefore: ['sessionId','beforeSeq'],
  stop: ['sessionId','requestId','turnId'],
  answerQuestion: ['sessionId','requestId','questionId'],
  subscribe: ['sessionId','afterSeq'], unsubscribe: [],
  reviewList: ['workspaceId'], reviewSubmit: ['workspaceId','requestId','operationId','expectedDigest','note'],
  chooseAttachment: ['sessionId'], uploadAttachment: ['sessionId','name','mime','dataBase64'],
  memoriesList: ['scope'], memoriesSave: ['scope','key','content'], memoriesDelete: ['scope','key'], memoriesClear: ['scope'],
  updateStatus: [], updateCheck: [], updateDownload: [], updateCancel: [], updateInstall: [], updateSettings: [], updateDismiss: ['version'],
  browserStatus: [], browserUpdateSettings: [], browserTestDaily: [], browserLaunchDaily: [], browserShowBuiltin: [], browserHideBuiltin: [], browserResetBuiltin: [],
};
const optional = {
  login: ['serverUrl'],
  quota: ['refresh'],
  adminUsage: ['range','refreshQuota'],
  create: ['options'],
  send: ['attachments'],
  answerQuestion: ['answers','skipped'],
  setSessionOptions: ['agent','model','effort'],
  memoriesList: ['workspaceId'],
  memoriesSave: ['workspaceId'],
  memoriesDelete: ['workspaceId'],
  memoriesClear: ['workspaceId'],
  updateCheck: ['manual'],
  updateInstall: ['relaunch'],
  updateSettings: ['autoCheck','autoDownload','installOnQuit'],
  browserUpdateSettings: ['builtin','daily'],
  browserTestDaily: ['cdpUrl'],
  browserLaunchDaily: ['port'],
};
const AGENTS = new Set(['codex','antigravity']);
const EFFORTS = new Set(['minimal','low','medium','high','xhigh','max']);
const UUID_RE = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

function validateOptionsObj(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw Error('INVALID_FIELDS');
  for (const k of Object.keys(o)) if (k !== 'agent' && k !== 'model' && k !== 'effort') throw Error('INVALID_FIELDS');
  if ('agent' in o && o.agent !== null && (typeof o.agent !== 'string' || !AGENTS.has(o.agent))) throw Error('INVALID_FIELDS');
  if ('model' in o && o.model !== null && (typeof o.model !== 'string' || !o.model.trim() || o.model.length > 100)) throw Error('INVALID_FIELDS');
  if ('effort' in o && o.effort !== null && (typeof o.effort !== 'string' || !EFFORTS.has(o.effort))) throw Error('INVALID_FIELDS');
}

function validate(method, p = {}) {
  if (!Object.hasOwn(routes, method) || !p || typeof p !== 'object' || Array.isArray(p)) throw Error('INVALID_FIELDS');
  const reqKeys = routes[method];
  const optKeys = optional[method] ?? [];
  const allowed = new Set([...reqKeys, ...optKeys]);
  if (Object.keys(p).some(k => !allowed.has(k)) || !reqKeys.every(k => Object.hasOwn(p, k))) throw Error('INVALID_FIELDS');
  for (const k of ['workspaceId','sessionId','turnId','requestId','operationId','id','questionId']) {
    if (k in p && (typeof p[k] !== 'string' || !UUID_RE.test(p[k]))) throw Error('INVALID_ID');
  }
  for (const [k, max] of [['title',80],['text',65536],['username',32],['current',200],['password',200],['note',2048],['name',200],['mime',120]]) {
    if (k in p && (typeof p[k] !== 'string' || !p[k].trim() || p[k].length > max)) throw Error('INVALID_TEXT');
  }
  if ('scope' in p) {
    if (p.scope !== 'workspace' && p.scope !== 'user') throw Error('INVALID_MEMORY_SCOPE');
    if (p.scope === 'workspace' && !('workspaceId' in p)) throw Error('INVALID_ID');
    if (p.scope === 'user' && 'workspaceId' in p) throw Error('INVALID_FIELDS');
  }
  if ('key' in p && (typeof p.key !== 'string' || !p.key.trim() || p.key.length > 80)) throw Error('INVALID_TEXT');
  if ('content' in p) {
    const maxLen = p.scope === 'user' ? 300 : 500;
    if (typeof p.content !== 'string' || !p.content.trim()) throw Error('INVALID_TEXT');
    if (p.content.trim().length > maxLen) throw Error('MEMORY_TOO_LARGE');
  }
  if ('expectedDigest' in p && (typeof p.expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(p.expectedDigest))) throw Error('INVALID_FIELDS');
  if ('dataBase64' in p && (typeof p.dataBase64 !== 'string' || !p.dataBase64.length || p.dataBase64.length > 14 * 1024 * 1024)) throw Error('BODY_LIMIT');
  if ('afterSeq' in p && (!Number.isSafeInteger(p.afterSeq) || p.afterSeq < 0)) throw Error('INVALID_CURSOR');
  if ('beforeSeq' in p && (!Number.isSafeInteger(p.beforeSeq) || p.beforeSeq < 1)) throw Error('INVALID_CURSOR');
  if ('userId' in p && (!Number.isSafeInteger(p.userId) || p.userId < 1)) throw Error('INVALID_ID');
  if ('disabled' in p && typeof p.disabled !== 'boolean') throw Error('INVALID_FIELDS');
  if ('isAdmin' in p && typeof p.isAdmin !== 'boolean') throw Error('INVALID_FIELDS');
  if ('refresh' in p && typeof p.refresh !== 'boolean') throw Error('INVALID_FIELDS');
  if ('refreshQuota' in p && typeof p.refreshQuota !== 'boolean') throw Error('INVALID_FIELDS');
  if ('skipped' in p && typeof p.skipped !== 'boolean') throw Error('INVALID_FIELDS');
  if ('answers' in p) {
    if (!p.answers || typeof p.answers !== 'object' || Array.isArray(p.answers)) throw Error('INVALID_FIELDS');
    const entries = Object.entries(p.answers);
    if (entries.length > 24) throw Error('INVALID_FIELDS');
    for (const [k, v] of entries) {
      if (!k || k.length > 1200) throw Error('INVALID_FIELDS');
      if (typeof v === 'string') {
        if (v.length > 4000) throw Error('INVALID_TEXT');
      } else if (Array.isArray(v)) {
        if (v.length > 16 || !v.every(item => typeof item === 'string' && item.length <= 4000)) throw Error('INVALID_FIELDS');
      } else {
        throw Error('INVALID_FIELDS');
      }
    }
  }
  if ('range' in p && !['24h','7d','30d','all'].includes(p.range)) throw Error('INVALID_FIELDS');
  for (const bk of ['manual','relaunch','autoCheck','autoDownload','installOnQuit']) {
    if (bk in p && typeof p[bk] !== 'boolean') throw Error('INVALID_FIELDS');
  }
  if ('version' in p && (typeof p.version !== 'string' || p.version.length > 40 || !SEMVER_RE.test(p.version.trim()))) throw Error('INVALID_FIELDS');
  if ('serverUrl' in p) {
    if (typeof p.serverUrl !== 'string' || !p.serverUrl.trim() || p.serverUrl.trim().length > 255 || /[\s\0-\x1f\x7f]/.test(p.serverUrl.trim())) {
      throw Error('INVALID_SERVER_URL');
    }
    const raw = p.serverUrl.trim();
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : 'https://' + raw;
    let parsed;
    try { parsed = new URL(withScheme); } catch { throw Error('INVALID_SERVER_URL'); }
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) {
      throw Error('INVALID_SERVER_URL');
    }
  }
  if ('mode' in p && !['revoked','read','edit','execute'].includes(p.mode)) throw Error('INVALID_PERMISSION');
  if ('port' in p && (!Number.isSafeInteger(p.port) || p.port < 1024 || p.port > 65535)) throw Error('INVALID_FIELDS');
  if ('cdpUrl' in p) {
    if (typeof p.cdpUrl !== 'string' || p.cdpUrl.length > 256 || /[\s\0-\x1f\x7f]/.test(p.cdpUrl)) throw Error('INVALID_CDP_URL');
  }
  if ('builtin' in p) {
    const b = p.builtin;
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw Error('INVALID_FIELDS');
    for (const k of Object.keys(b)) {
      if (k !== 'enabled' && k !== 'autoShow') throw Error('INVALID_FIELDS');
      if (typeof b[k] !== 'boolean') throw Error('INVALID_FIELDS');
    }
  }
  if ('daily' in p) {
    const d = p.daily;
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw Error('INVALID_FIELDS');
    for (const k of Object.keys(d)) {
      if (!['enabled', 'access', 'backend', 'cdpUrl'].includes(k)) throw Error('INVALID_FIELDS');
    }
    if ('enabled' in d && typeof d.enabled !== 'boolean') throw Error('INVALID_FIELDS');
    if ('access' in d && d.access !== 'full' && d.access !== 'read') throw Error('INVALID_FIELDS');
    if ('backend' in d && !['cdp', 'chrome-devtools-mcp', 'playwright-mcp'].includes(d.backend)) throw Error('INVALID_FIELDS');
    if ('cdpUrl' in d && (typeof d.cdpUrl !== 'string' || d.cdpUrl.length > 256 || /[\s\0-\x1f\x7f]/.test(d.cdpUrl))) throw Error('INVALID_CDP_URL');
  }
  if ('attachments' in p) {
    if (!Array.isArray(p.attachments) || p.attachments.length > 8 || !p.attachments.every(x => typeof x === 'string' && UUID_RE.test(x))) throw Error('INVALID_ID');
  }
  if ('options' in p && p.options !== undefined) validateOptionsObj(p.options);
  if (method === 'setSessionOptions') {
    const o = {};
    if ('agent' in p) o.agent = p.agent;
    if ('model' in p) o.model = p.model;
    if ('effort' in p) o.effort = p.effort;
    validateOptionsObj(o);
  }
}
function internalValidate(method, p) {
  if (method === 'registerWorkspace') {
    if (!p || typeof p !== 'object' || Object.keys(p).length !== 1 || !Object.hasOwn(p,'path') ||
        typeof p.path !== 'string' || !p.path.trim() || p.path.length > 1024 || p.path.includes('\0')) throw Error('INVALID_FIELDS');
    return;
  }
  if (method === 'uploadAttachmentFile') {
    if (!p || typeof p !== 'object' || Object.keys(p).length !== 2 || !Object.hasOwn(p,'sessionId') || !Object.hasOwn(p,'path') ||
        typeof p.sessionId !== 'string' || !UUID_RE.test(p.sessionId) ||
        typeof p.path !== 'string' || !p.path.trim() || p.path.length > 1024 || p.path.includes('\0')) throw Error('INVALID_FIELDS');
    return;
  }
  return validate(method, p);
}
module.exports = { validate, internalValidate, workspaceLimit: 16 };
