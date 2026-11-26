import { lstatSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerExecutor, exact, string, integer, fail } from '../execution/protocol.mjs';

export function relative(value) {
  string(value, 512);
  if (value.startsWith('/') || value.includes('\\') || value.includes(':') || /[\x00-\x1f]/.test(value) ||
      value.split('/').some((s) => !s || s === '..')) fail('PATH_DENIED');
  return value;
}
const text = (v, max = 131072) => { if (typeof v !== 'string' || v.length > max) fail('INVALID_TEXT'); };
const validRevision = (v) => v === null || (typeof v === 'string' && /^file-v1:[a-f0-9]{64}$/.test(v));
const validBrowserUrl = (v) => {
  string(v, 4096);
  if (v === 'about:blank') return;
  let u;
  try { u = new URL(v); } catch { fail('INVALID_URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') fail('URL_SCHEME_DENIED');
};
const validTarget = (v) => { if (v !== undefined && v !== 'builtin' && v !== 'daily') fail('INVALID_BROWSER_TARGET'); };
const validTabId = (v) => { if (v !== undefined) string(v, 128); };
const validBool = (v) => { if (v !== undefined && typeof v !== 'boolean') fail('INVALID_BOOLEAN'); };
const toolFields = {
  read_file: ['path', 'offset', 'length'], read_multiple_files: ['paths'],
  write_file: ['path', 'content', 'mode', 'expectedRevision'], edit_block: ['file_path', 'old_string', 'new_string', 'expected_replacements', 'expectedRevision'],
  delete_file: ['path', 'expectedRevision'],
  move_file: ['fromPath', 'toPath', 'expectedFromRevision', 'expectedToRevision'],
  apply_patch: ['patch', 'expectedRevisions'],
  list_directory: ['path', 'depth'], get_file_info: ['path'], create_directory: ['path'],
  // Managed background processes (execute permission)
  bg_start: ['command', 'cwd', 'waitMs'],
  bg_list: [],
  bg_output: ['processId', 'afterSeq', 'waitMs'],
  bg_input: ['processId', 'input'],
  bg_stop: ['processId'],
  // Browser control tools (gated additionally by local device browser settings)
  browser_status: [],
  browser_tabs: ['target'],
  browser_snapshot: ['target', 'tabId', 'maxNodes'],
  browser_screenshot: ['target', 'tabId', 'fullPage', 'selector'],
  browser_logs: ['target', 'tabId', 'kind', 'limit'],
  browser_wait: ['target', 'tabId', 'text', 'selector', 'timeoutMs'],
  browser_navigate: ['target', 'tabId', 'url', 'action', 'waitUntil'],
  browser_click: ['target', 'tabId', 'ref', 'selector', 'x', 'y', 'button', 'doubleClick'],
  browser_type: ['target', 'tabId', 'ref', 'selector', 'text', 'clear', 'submit'],
  browser_press: ['target', 'tabId', 'key'],
  browser_scroll: ['target', 'tabId', 'deltaY', 'deltaX', 'ref', 'selector', 'to'],
  browser_eval: ['target', 'tabId', 'expression'],
  browser_tab_action: ['target', 'action', 'tabId', 'url'],
};
const BG_TOOLS = new Set(['bg_start', 'bg_list', 'bg_output', 'bg_input', 'bg_stop']);
const BROWSER_TOOLS = new Set([
  'browser_status', 'browser_tabs', 'browser_snapshot', 'browser_screenshot', 'browser_logs', 'browser_wait',
  'browser_navigate', 'browser_click', 'browser_type', 'browser_press', 'browser_scroll', 'browser_eval', 'browser_tab_action',
]);
export function validate(request, grant) {
  relative(request.cwdRelative);
  const a = request.args;
  if (request.kind === 'dc.inspect') { exact(a, []); return; }
  if (request.kind === 'dc.run') {
    if (!grant.capabilities.includes('workspace.exec')) fail('EXEC_DENIED');
    exact(a, ['command', 'input']); string(a.command, 32768);
    if (a.input !== undefined) text(a.input, 65536);
    return;
  }
  if (request.kind === 'dc.search') {
    exact(a, ['path', 'pattern', 'searchType', 'literalSearch', 'maxResults']); relative(a.path); string(a.pattern, 1024);
    if (!['files', 'content'].includes(a.searchType)) fail('INVALID_SEARCH_TYPE');
    if (typeof a.literalSearch !== 'boolean') fail('INVALID_BOOLEAN');
    integer(a.maxResults, 1, 50); return;
  }
  exact(a, ['tool', 'arguments']);
  if (!Object.hasOwn(toolFields, a.tool)) fail('TOOL_DENIED');
  const p = a.arguments; exact(p, toolFields[a.tool]);
  if (BG_TOOLS.has(a.tool)) {
    if (!grant.capabilities.includes('workspace.exec')) fail('EXEC_DENIED');
    if (a.tool === 'bg_start') {
      string(p.command, 32768);
      if (p.cwd !== undefined) relative(p.cwd);
      if (p.waitMs !== undefined) integer(p.waitMs, 0, 10000);
    } else if (a.tool === 'bg_output') {
      string(p.processId, 64);
      if (p.afterSeq !== undefined) integer(p.afterSeq, 0, Number.MAX_SAFE_INTEGER);
      if (p.waitMs !== undefined) integer(p.waitMs, 0, 5000);
    } else if (a.tool === 'bg_input') {
      string(p.processId, 64);
      text(p.input, 16384);
      if (!p.input.length) fail('INVALID_TEXT');
    } else if (a.tool === 'bg_stop') {
      string(p.processId, 64);
    }
    if (Buffer.byteLength(JSON.stringify(request)) > 262144) fail('REQUEST_TOO_LARGE');
    return;
  }
  if (BROWSER_TOOLS.has(a.tool)) {
    validTarget(p.target);
    validTabId(p.tabId);
    if (a.tool === 'browser_snapshot' && p.maxNodes !== undefined) integer(p.maxNodes, 20, 1000);
    if (a.tool === 'browser_screenshot') {
      validBool(p.fullPage);
      if (p.selector !== undefined) string(p.selector, 512);
    }
    if (a.tool === 'browser_logs') {
      if (p.kind !== undefined && !['all', 'console', 'network'].includes(p.kind)) fail('INVALID_FIELDS');
      if (p.limit !== undefined) integer(p.limit, 1, 100);
    }
    if (a.tool === 'browser_wait') {
      if (p.text !== undefined) string(p.text, 512);
      if (p.selector !== undefined) string(p.selector, 512);
      if (p.timeoutMs !== undefined) integer(p.timeoutMs, 50, 15000);
    }
    if (a.tool === 'browser_navigate') {
      if (p.action !== undefined && !['goto', 'back', 'forward', 'reload'].includes(p.action)) fail('INVALID_FIELDS');
      if (p.waitUntil !== undefined && !['load', 'domcontentloaded'].includes(p.waitUntil)) fail('INVALID_FIELDS');
      if ((p.action ?? 'goto') === 'goto') {
        if (p.url === undefined) fail('INVALID_URL');
        validBrowserUrl(p.url);
      } else if (p.url !== undefined) validBrowserUrl(p.url);
    }
    if (a.tool === 'browser_click') {
      if (p.ref !== undefined) string(p.ref, 32);
      if (p.selector !== undefined) string(p.selector, 512);
      if (p.x !== undefined) integer(Math.round(p.x), 0, 10000);
      if (p.y !== undefined) integer(Math.round(p.y), 0, 10000);
      if (p.button !== undefined && !['left', 'right', 'middle'].includes(p.button)) fail('INVALID_FIELDS');
      validBool(p.doubleClick);
      if (p.ref === undefined && p.selector === undefined && (p.x === undefined || p.y === undefined)) fail('INVALID_FIELDS');
    }
    if (a.tool === 'browser_type') {
      if (p.ref !== undefined) string(p.ref, 32);
      if (p.selector !== undefined) string(p.selector, 512);
      text(p.text, 32768);
      validBool(p.clear);
      validBool(p.submit);
      if (p.ref === undefined && p.selector === undefined) fail('INVALID_FIELDS');
    }
    if (a.tool === 'browser_press') string(p.key, 64);
    if (a.tool === 'browser_scroll') {
      if (p.deltaY !== undefined) integer(Math.round(p.deltaY), -20000, 20000);
      if (p.deltaX !== undefined) integer(Math.round(p.deltaX), -20000, 20000);
      if (p.ref !== undefined) string(p.ref, 32);
      if (p.selector !== undefined) string(p.selector, 512);
      if (p.to !== undefined && !['top', 'bottom'].includes(p.to)) fail('INVALID_FIELDS');
    }
    if (a.tool === 'browser_eval') string(p.expression, 32768);
    if (a.tool === 'browser_tab_action') {
      if (!['new', 'select', 'close'].includes(p.action)) fail('INVALID_FIELDS');
      if (p.url !== undefined) validBrowserUrl(p.url);
      if ((p.action === 'select' || p.action === 'close') && !p.tabId) fail('INVALID_FIELDS');
    }
    if (Buffer.byteLength(JSON.stringify(request)) > 262144) fail('REQUEST_TOO_LARGE');
    return;
  }
  if (a.tool === 'read_multiple_files') {
    if (!Array.isArray(p.paths) || p.paths.length < 1 || p.paths.length > 5) fail('INVALID_PATHS');
    p.paths.forEach(relative);
  } else if (a.tool === 'move_file') {
    relative(p.fromPath); relative(p.toPath);
  } else if (a.tool === 'apply_patch') {
    string(p.patch, 131072);
    if (!p.expectedRevisions || typeof p.expectedRevisions !== 'object' || Array.isArray(p.expectedRevisions)) fail('INVALID_FILE_REVISION');
    const entries = Object.entries(p.expectedRevisions);
    if (entries.length < 1 || entries.length > 32) fail('INVALID_FILE_REVISION');
    for (const [k, v] of entries) { relative(k); if (!validRevision(v)) fail('INVALID_FILE_REVISION'); }
  } else relative(p.path ?? p.file_path);
  if (['write_file', 'edit_block', 'create_directory', 'delete_file', 'move_file', 'apply_patch'].includes(a.tool) && !grant.capabilities.includes('workspace.write')) fail('WRITE_DENIED');
  if (a.tool === 'write_file') { text(p.content); if (!['rewrite', 'append'].includes(p.mode)) fail('INVALID_WRITE_MODE'); }
  if (a.tool === 'edit_block') { string(p.old_string, 131072); text(p.new_string); integer(p.expected_replacements, 1, 20); }
  if (a.tool === 'delete_file' && (typeof p.expectedRevision !== 'string' || !/^file-v1:[a-f0-9]{64}$/.test(p.expectedRevision))) fail('INVALID_FILE_REVISION');
  if (a.tool === 'move_file' && (!validRevision(p.expectedFromRevision) || p.expectedFromRevision === null || !validRevision(p.expectedToRevision))) fail('INVALID_FILE_REVISION');
  if (p.expectedRevision !== undefined && !validRevision(p.expectedRevision)) fail('INVALID_FILE_REVISION');
  if (p.offset !== undefined) integer(p.offset, -10000, 1000000);
  if (p.length !== undefined) integer(p.length, 1, 500);
  if (p.depth !== undefined) integer(p.depth, 1, 4);
  if (Buffer.byteLength(JSON.stringify(request)) > 262144) fail('REQUEST_TOO_LARGE');
}
export function register() {
  for (const kind of ['dc.tool', 'dc.run', 'dc.search', 'dc.inspect']) registerExecutor(kind, validate);
}
export function makeLauncher(profile) {
  const root = realpathSync(profile.workspaceRoot);
  if (root !== profile.workspaceRoot || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) fail('WORKSPACE_ROOT_DENIED');
  return (op, grant) => {
    if (!op.request.kind.startsWith('dc.')) return;
    // The workspace root is installed by root, never selected by a tool argument.
    if (realpathSync(profile.workspaceRoot) !== root) fail('WORKSPACE_ROOT_CHANGED');
    return { command: process.execPath, args: [fileURLToPath(new URL('./worker.mjs', import.meta.url))],
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' },
      input: { request: op.request, operationId: op.operationId, profile: { workspaceRoot: root,
        readOnly: Boolean(profile.readOnly) || (grant && !grant.capabilities.includes('workspace.write')),
        guardedFiles: Boolean(profile.guardedFiles), stateDir: profile.stateDir } } };
  };
}
