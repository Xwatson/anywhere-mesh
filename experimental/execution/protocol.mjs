import { createHash, randomUUID } from 'node:crypto';

export const VERSION = 1;
export const CAPABILITIES = ['mock.task.v1', 'journal.v1', 'cancel.v1', 'output.v1'];
const executors = new Map();
// Registration is local bootstrap code, never a module/path supplied by a caller.
export function registerExecutor(kind, validate) {
  if (executors.has(kind)) throw new Error('EXECUTOR_ALREADY_REGISTERED');
  executors.set(kind, validate); CAPABILITIES.push(`${kind}.v1`);
}
export const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'rejected']);
export const id = () => randomUUID();
export class ProtocolError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export const fail = (code) => { throw new ProtocolError(code); };
export function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((k) => !keys.includes(k))) fail('INVALID_FIELDS');
}
export function string(value, max = 128) {
  if (typeof value !== 'string' || !value.length || value.length > max) fail('INVALID_STRING');
  return value;
}
export function integer(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_INTEGER');
  return value;
}
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const hash = (value) => createHash('sha256').update(canonical(value)).digest('hex');
export const scopeKeys = ['accountId', 'deviceId', 'workspaceId', 'sessionId', 'turnId', 'turnEpoch', 'grantVersion'];
export function validateScope(scope, grant) {
  exact(scope, scopeKeys);
  for (const k of scopeKeys.slice(0, 5)) string(scope[k]);
  integer(scope.turnEpoch, 1, 1e9); integer(scope.grantVersion, 1, 1e9);
  for (const k of ['accountId', 'deviceId', 'workspaceId', 'grantVersion']) {
    if (scope[k] !== grant[k]) fail('SCOPE_DENIED');
  }
  if (grant.revoked) fail('GRANT_REVOKED');
}
export function validateRequest(request, grant) {
  exact(request, ['scope', 'toolCallId', 'kind', 'args', 'cwdRelative', 'expiresAt']);
  validateScope(request.scope, grant);
  string(request.toolCallId);
  if (!grant.capabilities.includes(request.kind)) fail('CAPABILITY_DENIED');
  integer(request.expiresAt, 1, Number.MAX_SAFE_INTEGER);
  if (request.expiresAt > Date.now() + 24 * 3600_000) fail('DEADLINE_TOO_FAR');
  if (executors.has(request.kind)) { executors.get(request.kind)(request, grant); return hash(request); }
  if (request.kind !== 'mock.task') fail('CAPABILITY_DENIED');
  // A fixed mock program is the entire advertised execution capability in B1.
  // Neither a command, path, environment nor arbitrary file operation is accepted.
  if (request.cwdRelative !== '.') fail('CWD_DENIED');
  integer(request.expiresAt, 1, Number.MAX_SAFE_INTEGER);
  if (request.expiresAt > Date.now() + 24 * 3600_000) fail('DEADLINE_TOO_FAR');
  exact(request.args, ['steps', 'intervalMs', 'bytesPerStep', 'exitCode', 'spawnChild']);
  integer(request.args.steps, 1, 5000);
  integer(request.args.intervalMs, 5, 1000);
  integer(request.args.bytesPerStep, 1, 2048);
  integer(request.args.exitCode, 0, 9);
  if (typeof request.args.spawnChild !== 'boolean') fail('INVALID_BOOLEAN');
  if (request.args.steps * request.args.intervalMs > 120_000) fail('RUNTIME_LIMIT');
  return hash(request);
}
export const callKey = (r) => canonical([r.scope.sessionId, r.scope.turnId, r.scope.turnEpoch, r.toolCallId]);
export const turnKey = (s) => canonical([s.sessionId, s.turnId, s.turnEpoch]);
export const sameTurn = (a, b) => turnKey(a) === turnKey(b);
export function summary(op) {
  return { operationId: op.operationId, taskId: op.taskId, requestHash: op.requestHash,
    state: op.state, lastSeq: op.lastSeq, result: op.result, reason: op.reason,
    starts: op.starts, cancelId: op.cancelId, pid: op.pid };
}
export const resultDigest = (op) => hash({ operationId: op.operationId, taskId: op.taskId,
  state: op.state, result: op.result, lastSeq: op.lastSeq, reason: op.reason });
