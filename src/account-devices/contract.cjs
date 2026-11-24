'use strict';
const routes = {
  state: [], login: ['username','password'], changePassword: ['current','password'], logout: [], admin: [], disable: ['id','disabled'],
  quota: [],
  deleteDevice: ['id'], pruneDevices: [],
  adminUsers: [], createUser: ['username','password','isAdmin'],
  resetUserPassword: ['userId','password'], setUserAdmin: ['userId','isAdmin'], deleteUser: ['userId'],
  chooseWorkspace: [], removeWorkspace: ['workspaceId'], permission: ['workspaceId','mode'],
  create: ['workspaceId','requestId','title'],
  renameSession: ['sessionId','title'], deleteSession: ['sessionId'],
  setSessionOptions: ['sessionId'],
  send: ['sessionId','requestId','text'], history: ['sessionId','afterSeq'], historyBefore: ['sessionId','beforeSeq'],
  stop: ['sessionId','requestId','turnId'],
  subscribe: ['sessionId','afterSeq'], unsubscribe: [],
  reviewList: ['workspaceId'], reviewSubmit: ['workspaceId','requestId','operationId','expectedDigest','note'],
  chooseAttachment: ['sessionId'], uploadAttachment: ['sessionId','name','mime','dataBase64'],
};
const optional = {
  quota: ['refresh'],
  create: ['options'],
  send: ['attachments'],
  setSessionOptions: ['agent','model','effort'],
};
const AGENTS = new Set(['codex','antigravity']);
const EFFORTS = new Set(['minimal','low','medium','high','xhigh','max']);
const UUID_RE = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;

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
  for (const k of ['workspaceId','sessionId','turnId','requestId','operationId','id']) {
    if (k in p && (typeof p[k] !== 'string' || !UUID_RE.test(p[k]))) throw Error('INVALID_ID');
  }
  for (const [k, max] of [['title',80],['text',65536],['username',32],['current',200],['password',200],['note',2048],['name',200],['mime',120]]) {
    if (k in p && (typeof p[k] !== 'string' || !p[k].trim() || p[k].length > max)) throw Error('INVALID_TEXT');
  }
  if ('expectedDigest' in p && (typeof p.expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(p.expectedDigest))) throw Error('INVALID_FIELDS');
  if ('dataBase64' in p && (typeof p.dataBase64 !== 'string' || !p.dataBase64.length || p.dataBase64.length > 14 * 1024 * 1024)) throw Error('BODY_LIMIT');
  if ('afterSeq' in p && (!Number.isSafeInteger(p.afterSeq) || p.afterSeq < 0)) throw Error('INVALID_CURSOR');
  if ('beforeSeq' in p && (!Number.isSafeInteger(p.beforeSeq) || p.beforeSeq < 1)) throw Error('INVALID_CURSOR');
  if ('userId' in p && (!Number.isSafeInteger(p.userId) || p.userId < 1)) throw Error('INVALID_ID');
  if ('disabled' in p && typeof p.disabled !== 'boolean') throw Error('INVALID_FIELDS');
  if ('isAdmin' in p && typeof p.isAdmin !== 'boolean') throw Error('INVALID_FIELDS');
  if ('refresh' in p && typeof p.refresh !== 'boolean') throw Error('INVALID_FIELDS');
  if ('mode' in p && !['revoked','read','edit','execute'].includes(p.mode)) throw Error('INVALID_PERMISSION');
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
