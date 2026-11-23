import { exact, fail } from '../execution/protocol.mjs';
import { validate } from '../desktop-commander/adapter.mjs';

const path = { type: 'string', minLength: 1, maxLength: 512, description: 'Path relative to the authorized workspace root.' };
const text = { type: 'string', maxLength: 131072 };
const revision = { type: ['string', 'null'], pattern: '^file-v1:[a-f0-9]{64}$', description: 'Revision returned by the last file read. Null requires that the path does not exist.' };
const existingRevision = { type: 'string', pattern: '^file-v1:[a-f0-9]{64}$', description: 'Revision returned by the last file read for an existing file.' };
const count = (minimum, maximum, value) => ({ type: 'integer', minimum, maximum, ...(value === undefined ? {} : { default: value }) });
const schema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const file = (tool, args) => ({ kind: 'dc.tool', cwdRelative: '.', args: { tool, arguments: args } });
const definitions = [
  ['workspace_read_file', 'Read lines of text (or a small project image). To read the first line, use offset 0 and length 1.', 'read',
    { path, offset: { ...count(-10000, 1000000, 0), description: 'Zero-based line offset; negative values count from the end.' },
      length: { ...count(1, 500, 100), description: 'Number of text lines to read, from 1 to 500. Defaults to 100 lines.' } }, ['path'],
    a => file('read_file', { path: a.path, offset: a.offset ?? 0, length: a.length ?? 100 })],
  ['workspace_read_files', 'Read up to five text files; per-file failures are reported.', 'read', { paths: { type: 'array', items: path, minItems: 1, maxItems: 5 } }, ['paths'],
    a => file('read_multiple_files', a)],
  ['workspace_list_directory', 'List files and subdirectories within a bounded depth.', 'read', { path, depth: count(1, 4, 2) }, ['path'],
    a => file('list_directory', { path: a.path, depth: a.depth ?? 2 })],
  ['workspace_file_info', 'Read file metadata.', 'read', { path }, ['path'], a => file('get_file_info', a)],
  ['workspace_write_file', 'Write text using its last read revision; changed files are refused. Explicit append/rewrite mode required.', 'write', { path, content: text, mode: { type: 'string', enum: ['rewrite', 'append'] }, expectedRevision: revision }, ['path', 'content', 'mode', 'expectedRevision'], a => file('write_file', a)],
  ['workspace_edit_file', 'Replace exact matching text at the last read revision; changes and ambiguous matches fail.', 'write', { path, oldText: { ...text, minLength: 1 }, newText: text, expectedMatches: count(1, 20, 1), expectedRevision: revision }, ['path', 'oldText', 'newText', 'expectedRevision'],
    a => file('edit_block', { file_path: a.path, old_string: a.oldText, new_string: a.newText, expected_replacements: a.expectedMatches ?? 1, expectedRevision: a.expectedRevision })],
  ['workspace_delete_file', 'Delete an existing file inside the workspace after verifying its last read revision.', 'write', { path, expectedRevision: existingRevision }, ['path', 'expectedRevision'],
    a => file('delete_file', a)],
  ['workspace_move_file', 'Move or rename an existing text file inside the workspace after verifying source and destination revisions.', 'write',
    { fromPath: path, toPath: path, expectedFromRevision: existingRevision, expectedToRevision: revision }, ['fromPath', 'toPath', 'expectedFromRevision', 'expectedToRevision'],
    a => file('move_file', a)],
  ['workspace_apply_patch', 'Apply a Codex-format multi-file patch (*** Begin Patch ... *** End Patch). Pre-validates all revisions and hunks before writing. Supply expectedRevisions for every touched path (null for newly added files).', 'write',
    { patch: { ...text, minLength: 1 }, expectedRevisions: { type: 'object', additionalProperties: revision, minProperties: 1, maxProperties: 32, description: 'Map of every relative path touched by the patch to its last read revision (or null if newly created).' } },
    ['patch', 'expectedRevisions'],
    a => file('apply_patch', a)],
  ['workspace_create_directory', 'Create a directory inside the workspace.', 'write', { path }, ['path'], a => file('create_directory', a)],
  ['workspace_search', 'Search file names or text. Results may be partial when limits are reached.', 'read', { path, pattern: { type: 'string', minLength: 1, maxLength: 1024 }, searchType: { type: 'string', enum: ['files', 'content'], default: 'content' }, literal: { type: 'boolean', default: true }, maxResults: count(1, 50, 50) }, ['path', 'pattern'],
    a => ({ kind: 'dc.search', cwdRelative: '.', args: { path: a.path, pattern: a.pattern, searchType: a.searchType ?? 'content', literalSearch: a.literal ?? true, maxResults: a.maxResults ?? 50 } })],
  ['workspace_run', 'Run a finite shell command in the offline workspace sandbox. Poll tasks that remain running; inspect output before continuing.', 'execute', { command: { type: 'string', minLength: 1, maxLength: 32768 }, cwd: { ...path, default: '.' }, input: { type: 'string', maxLength: 65536 } }, ['command'],
    a => ({ kind: 'dc.run', cwdRelative: a.cwd ?? '.', args: { command: a.command, ...(a.input === undefined ? {} : { input: a.input }) } })],
];
export const CATALOG = definitions.map(([name, description, permission, properties, required, translate]) => ({ name, description, permission, inputSchema: schema(properties, required), translate }));
export const LIFECYCLE = [
  { name: 'workspace_capabilities', description: 'Inspect the bound workspace, current permissions, connection and limits.', inputSchema: schema({}, []) },
  { name: 'workspace_task_status', description: 'Read a task result. resultReady must be true before treating it as complete.', inputSchema: schema({ operationId: { type: 'string', maxLength: 128 } }, ['operationId']) },
  { name: 'workspace_task_output', description: 'Read ordered task output; follow nextSeq and report any truncation.', inputSchema: schema({ operationId: { type: 'string', maxLength: 128 }, afterSeq: count(0, Number.MAX_SAFE_INTEGER, 0) }, ['operationId']) },
  { name: 'workspace_task_cancel', description: 'Request cancellation; cancelling is pending until the device confirms termination.', inputSchema: schema({ operationId: { type: 'string', maxLength: 128 } }, ['operationId']) },
];
export function normalize(name, args) {
  const tool = CATALOG.find(t => t.name === name) ?? fail('TOOL_NOT_FOUND');
  exact(args, Object.keys(tool.inputSchema.properties));
  for (const key of tool.inputSchema.required) if (!Object.hasOwn(args, key)) fail('MISSING_ARGUMENT');
  const request = tool.translate(args);
  // Validate shape independently of current permission so an old ticket can
  // still retrieve its recorded result after a local permission change.
  validate(request, { capabilities: ['workspace.exec', 'workspace.write'] });
  if (Buffer.byteLength(JSON.stringify(request)) > 262144) fail('REQUEST_TOO_LARGE');
  return request;
}
export function allowed(tool, grant, supportedTools) {
  if (grant.revoked) return false;
  if (supportedTools !== undefined && !(Array.isArray(supportedTools) && supportedTools.includes(tool.name))) return false;
  if (tool.permission === 'write') return grant.capabilities.includes('workspace.write');
  if (tool.permission === 'execute') return grant.capabilities.includes('workspace.exec');
  return grant.capabilities.includes(tool.name === 'workspace_search' ? 'dc.search' : 'dc.tool');
}
export function listTools(grant, executable = true, supportedTools) {
  return [...CATALOG.filter(t => executable && allowed(t, grant, supportedTools)).map(({ translate, permission, ...t }) => ({ ...t,
    annotations: { readOnlyHint: permission === 'read', destructiveHint: permission !== 'read', openWorldHint: false } })), ...LIFECYCLE];
}
