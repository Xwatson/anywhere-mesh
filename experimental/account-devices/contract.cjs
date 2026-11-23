'use strict';
const routes = {
  state: [], login: ['username','password'], changePassword: ['current','password'], logout: [], admin: [], disable: ['id','disabled'],
  chooseWorkspace: [], permission: ['workspaceId','mode'], create: ['workspaceId','requestId','title'],
  send: ['sessionId','requestId','text'], history: ['sessionId','afterSeq'], stop: ['sessionId','requestId','turnId']
};
function validate(method, p = {}) {
  if (!Object.hasOwn(routes,method) || !p || typeof p!=='object' || Array.isArray(p) ||
      Object.keys(p).length!==routes[method].length || !routes[method].every(k=>Object.hasOwn(p,k))) throw Error('INVALID_FIELDS');
  for (const k of ['workspaceId','sessionId','turnId','requestId','id']) {
    if (k in p && (typeof p[k]!=='string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(p[k]))) throw Error('INVALID_ID');
  }
  for (const [k,max] of [['title',80],['text',8192],['username',32],['current',200],['password',200]]) {
    if (k in p && (typeof p[k]!=='string'||!p[k].trim()||p[k].length>max)) throw Error('INVALID_TEXT');
  }
  if ('afterSeq' in p && (!Number.isSafeInteger(p.afterSeq)||p.afterSeq<0)) throw Error('INVALID_CURSOR');
  if ('disabled' in p && typeof p.disabled!=='boolean') throw Error('INVALID_FIELDS');
  if ('mode' in p && !['revoked','read','edit','execute'].includes(p.mode)) throw Error('INVALID_PERMISSION');
}
function internalValidate(method, p) {
  if (method !== 'registerWorkspace') return validate(method, p);
  if (!p || typeof p !== 'object' || Object.keys(p).length !== 1 || !Object.hasOwn(p,'path') ||
      typeof p.path !== 'string' || !p.path.trim() || p.path.length > 1024 || p.path.includes('\0')) throw Error('INVALID_FIELDS');
}
module.exports={validate,internalValidate,workspaceLimit:16};
