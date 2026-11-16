'use strict';
const ID = /^[a-f0-9-]{36}$/;
const MODES = ['revoked', 'read', 'edit', 'execute'];
const ACTIONS = ['read', 'edit', 'build', 'long'];
function validate(method, params = {}) {
  const fields = { state: [], connect: [], disconnect: [], permission: ['mode'], run: ['action'],
    task: ['id'], cancel: ['id'], reviewPreview: ['id'], review: ['id', 'digest', 'note'] };
  if (!Object.hasOwn(fields, method) || !params || typeof params !== 'object' || Array.isArray(params) ||
      Object.keys(params).some(k => !fields[method].includes(k)) || fields[method].some(k => !Object.hasOwn(params, k))) throw Error('INVALID_DESKTOP_REQUEST');
  if (params.id !== undefined && (typeof params.id !== 'string' || !ID.test(params.id))) throw Error('INVALID_TASK_ID');
  if (method === 'permission' && !MODES.includes(params.mode)) throw Error('INVALID_PERMISSION');
  if (method === 'run' && !ACTIONS.includes(params.action)) throw Error('INVALID_ACTION');
  if (method === 'review' && (typeof params.digest !== 'string' || !/^[a-f0-9]{64}$/.test(params.digest) ||
      typeof params.note !== 'string' || !params.note.trim() || params.note.length > 2048)) throw Error('INVALID_REVIEW');
  return { method, params };
}
function trustedSender(event, contents) {
  return Boolean(contents && event.sender === contents && event.senderFrame === contents.mainFrame &&
    event.senderFrame.url === 'anywhere-desktop://app/index.html');
}
module.exports = { validate, trustedSender };
