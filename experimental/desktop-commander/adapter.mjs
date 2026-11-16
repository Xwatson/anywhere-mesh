import { lstatSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerExecutor, exact, string, integer, fail } from '../execution/protocol.mjs';

export function relative(value) {
  string(value, 512);
  if (value.startsWith('/') || value.includes('\\') || value.includes(':') || /[\x00-\x1f]/.test(value) ||
      value.split('/').some((s) => !s || s === '..')) fail('PATH_DENIED');
  return value;
}
const text = (v, max = 8192) => { if (typeof v !== 'string' || v.length > max) fail('INVALID_TEXT'); };
const toolFields = {
  read_file: ['path', 'offset', 'length'], read_multiple_files: ['paths'],
  write_file: ['path', 'content', 'mode', 'expectedRevision'], edit_block: ['file_path', 'old_string', 'new_string', 'expected_replacements', 'expectedRevision'],
  list_directory: ['path', 'depth'], get_file_info: ['path'], create_directory: ['path'],
};
export function validate(request, grant) {
  relative(request.cwdRelative);
  const a = request.args;
  if (request.kind === 'dc.inspect') { exact(a, []); return; }
  if (request.kind === 'dc.run') {
    if (!grant.capabilities.includes('workspace.exec')) fail('EXEC_DENIED');
    exact(a, ['command', 'input']); string(a.command, 8192);
    if (a.input !== undefined) text(a.input);
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
  if (a.tool === 'read_multiple_files') {
    if (!Array.isArray(p.paths) || p.paths.length < 1 || p.paths.length > 5) fail('INVALID_PATHS');
    p.paths.forEach(relative);
  } else relative(p.path ?? p.file_path);
  if (['write_file', 'edit_block', 'create_directory'].includes(a.tool) && !grant.capabilities.includes('workspace.write')) fail('WRITE_DENIED');
  if (a.tool === 'write_file') { text(p.content); if (!['rewrite', 'append'].includes(p.mode)) fail('INVALID_WRITE_MODE'); }
  if (a.tool === 'edit_block') { string(p.old_string, 8192); text(p.new_string); integer(p.expected_replacements, 1, 20); }
  if (p.expectedRevision !== undefined && p.expectedRevision !== null &&
      (typeof p.expectedRevision !== 'string' || !/^file-v1:[a-f0-9]{64}$/.test(p.expectedRevision))) fail('INVALID_FILE_REVISION');
  if (p.offset !== undefined) integer(p.offset, -10000, 1000000);
  if (p.length !== undefined) integer(p.length, 1, 200);
  if (p.depth !== undefined) integer(p.depth, 1, 4);
  if (Buffer.byteLength(JSON.stringify(request)) > 20000) fail('REQUEST_TOO_LARGE');
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
