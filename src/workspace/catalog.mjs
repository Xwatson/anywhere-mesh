import { exact, fail } from '../execution/protocol.mjs';
import { validate } from '../desktop-commander/adapter.mjs';

const path = { type: 'string', minLength: 1, maxLength: 512, description: 'Path relative to the authorized workspace root.' };
const text = { type: 'string', maxLength: 131072 };
const revision = { type: ['string', 'null'], pattern: '^file-v1:[a-f0-9]{64}$', description: 'Revision returned by the last file read. Null requires that the path does not exist.' };
const existingRevision = { type: 'string', pattern: '^file-v1:[a-f0-9]{64}$', description: 'Revision returned by the last file read for an existing file.' };
const count = (minimum, maximum, value) => ({ type: 'integer', minimum, maximum, ...(value === undefined ? {} : { default: value }) });
const schema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const file = (tool, args) => ({ kind: 'dc.tool', cwdRelative: '.', args: { tool, arguments: args } });

const browserTarget = {
  type: 'string',
  enum: ['builtin', 'daily'],
  description: 'Browser target: "builtin" (isolated Electron dev browser) or "daily" (user daily Chrome/Edge takeover, if enabled). Defaults to "builtin" when available.',
};
const tabIdProp = { type: 'string', minLength: 1, maxLength: 128, description: 'Optional tab ID from browser_tabs; defaults to the active tab.' };
const selectorProp = { type: 'string', minLength: 1, maxLength: 512, description: 'CSS selector fallback if ref is not provided.' };
const refProp = { type: 'string', minLength: 1, maxLength: 32, description: 'Element ref from browser_snapshot (e.g. "e12"). Preferred over selector.' };
const browserUrlProp = { type: 'string', minLength: 1, maxLength: 4096, description: 'Target http:// or https:// URL (or about:blank).' };
const processIdProp = { type: 'string', minLength: 1, maxLength: 64, description: 'Process ID returned by workspace_bg_start.' };

const WORKSPACE_DEFINITIONS = [
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
  ['workspace_run', 'Run a finite shell command on the bound workspace device (cwd defaults to the workspace root) and wait for completion.', 'execute', { command: { type: 'string', minLength: 1, maxLength: 32768 }, cwd: { ...path, default: '.' }, input: { type: 'string', maxLength: 65536 } }, ['command'],
    a => ({ kind: 'dc.run', cwdRelative: a.cwd ?? '.', args: { command: a.command, ...(a.input === undefined ? {} : { input: a.input }) } })],
];

const PROCESS_DEFINITIONS = [
  ['workspace_bg_start', 'Start a long-running background process (e.g. dev server, watcher) on the remote device. Waits briefly for startup output and returns a processId.', 'execute',
    { command: { type: 'string', minLength: 1, maxLength: 32768 }, cwd: { ...path, default: '.' }, waitMs: { ...count(0, 10000, 1500), description: 'Wait up to this many ms to capture initial startup logs or early exit.' } }, ['command'],
    a => file('bg_start', { command: a.command, ...(a.cwd !== undefined ? { cwd: a.cwd } : {}), ...(a.waitMs !== undefined ? { waitMs: a.waitMs } : {}) }),
    { domain: 'process', optIn: true, mutates: true }],
  ['workspace_bg_list', 'List managed background processes (running and recently exited) for the bound workspace.', 'execute',
    {}, [],
    () => file('bg_list', {}),
    { domain: 'process', optIn: true, mutates: false }],
  ['workspace_bg_output', 'Read incremental stdout/stderr and live status of a background process using its afterSeq cursor.', 'execute',
    { processId: processIdProp, afterSeq: { ...count(0, Number.MAX_SAFE_INTEGER, 0), description: 'Read chunks after this sequence number.' }, waitMs: { ...count(0, 5000, 0), description: 'Optional wait up to 5000ms for new output.' } }, ['processId'],
    a => file('bg_output', { processId: a.processId, ...(a.afterSeq !== undefined ? { afterSeq: a.afterSeq } : {}), ...(a.waitMs !== undefined ? { waitMs: a.waitMs } : {}) }),
    { domain: 'process', optIn: true, mutates: false }],
  ['workspace_bg_input', 'Write text input to stdin of a running background process.', 'execute',
    { processId: processIdProp, input: { type: 'string', minLength: 1, maxLength: 16384 } }, ['processId', 'input'],
    a => file('bg_input', { processId: a.processId, input: a.input }),
    { domain: 'process', optIn: true, mutates: true }],
  ['workspace_bg_stop', 'Terminate a managed background process (and its child process tree) and return its final status/output.', 'execute',
    { processId: processIdProp }, ['processId'],
    a => file('bg_stop', { processId: a.processId }),
    { domain: 'process', optIn: true, mutates: true }],
];

const BROWSER_DEFINITIONS = [
  ['browser_status', 'Inspect enabled browser targets on the remote device (builtin Electron dev browser and/or daily browser takeover), active tabs, and current URLs.', 'browser_read',
    {}, [],
    () => file('browser_status', {}),
    { domain: 'browser', optIn: true, mutates: false, browserAccess: 'read' }],
  ['browser_tabs', 'List open tabs for an enabled browser target ("builtin" or "daily").', 'browser_read',
    { target: browserTarget }, [],
    a => file('browser_tabs', { ...(a.target !== undefined ? { target: a.target } : {}) }),
    { domain: 'browser', optIn: true, mutates: false, browserAccess: 'read' }],
  ['browser_snapshot', 'Capture a compact Accessibility Tree snapshot of the active page with element refs (e.g. e1, e2) for browser_click/browser_type, plus URL and title.', 'browser_read',
    { target: browserTarget, tabId: tabIdProp, maxNodes: { ...count(20, 1000, 300), description: 'Maximum accessibility nodes to include.' } }, [],
    a => file('browser_snapshot', { ...(a.target !== undefined ? { target: a.target } : {}), ...(a.tabId !== undefined ? { tabId: a.tabId } : {}), ...(a.maxNodes !== undefined ? { maxNodes: a.maxNodes } : {}) }),
    { domain: 'browser', optIn: true, mutates: false, browserAccess: 'read' }],
  ['browser_screenshot', 'Capture a visual screenshot of the page (returned inline as an image) to inspect layout and styling.', 'browser_read',
    { target: browserTarget, tabId: tabIdProp, fullPage: { type: 'boolean', default: false }, selector: selectorProp }, [],
    a => file('browser_screenshot', { ...(a.target !== undefined ? { target: a.target } : {}), ...(a.tabId !== undefined ? { tabId: a.tabId } : {}), ...(a.fullPage !== undefined ? { fullPage: a.fullPage } : {}), ...(a.selector !== undefined ? { selector: a.selector } : {}) }),
    { domain: 'browser', optIn: true, mutates: false, browserAccess: 'read' }],
  ['browser_logs', 'Read recent browser console messages and network requests/errors captured for the tab.', 'browser_read',
    { target: browserTarget, tabId: tabIdProp, kind: { type: 'string', enum: ['all', 'console', 'network'], default: 'all' }, limit: count(1, 100, 40) }, [],
    a => file('browser_logs', { ...(a.target !== undefined ? { target: a.target } : {}), ...(a.tabId !== undefined ? { tabId: a.tabId } : {}), ...(a.kind !== undefined ? { kind: a.kind } : {}), ...(a.limit !== undefined ? { limit: a.limit } : {}) }),
    { domain: 'browser', optIn: true, mutates: false, browserAccess: 'read' }],
  ['browser_wait', 'Wait until specific text or a CSS selector appears on the page (or wait up to timeoutMs).', 'browser_read',
    { target: browserTarget, tabId: tabIdProp, text: { type: 'string', minLength: 1, maxLength: 512, description: 'Text substring to wait for.' }, selector: selectorProp, timeoutMs: count(50, 15000, 5000) }, [],
    a => file('browser_wait', { ...(a.target !== undefined ? { target: a.target } : {}), ...(a.tabId !== undefined ? { tabId: a.tabId } : {}), ...(a.text !== undefined ? { text: a.text } : {}), ...(a.selector !== undefined ? { selector: a.selector } : {}), ...(a.timeoutMs !== undefined ? { timeoutMs: a.timeoutMs } : {}) }),
    { domain: 'browser', optIn: true, mutates: false, browserAccess: 'read' }],
  ['browser_navigate', 'Navigate the browser tab to an http/https URL, or go back, forward, or reload.', 'browser_write',
    { target: browserTarget, tabId: tabIdProp, url: browserUrlProp, action: { type: 'string', enum: ['goto', 'back', 'forward', 'reload'], default: 'goto' }, waitUntil: { type: 'string', enum: ['load', 'domcontentloaded'], default: 'load' } }, [],
    a => file('browser_navigate', { ...(a.target !== undefined ? { target: a.target } : {}), ...(a.tabId !== undefined ? { tabId: a.tabId } : {}), ...(a.url !== undefined ? { url: a.url } : {}), ...(a.action !== undefined ? { action: a.action } : {}), ...(a.waitUntil !== undefined ? { waitUntil: a.waitUntil } : {}) }),
    { domain: 'browser', optIn: true, mutates: true, browserAccess: 'write' }],
  ['browser_click', 'Click an element on the page by snapshot ref (preferred), CSS selector, or viewport (x, y) coordinates.', 'browser_write',
    { target: browserTarget, tabId: tabIdProp, ref: refProp, selector: selectorProp, x: count(0, 10000), y: count(0, 10000), button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' }, doubleClick: { type: 'boolean', default: false } }, [],
    a => file('browser_click', { ...(a.target !== undefined ? { target: a.target } : {}), ...(a.tabId !== undefined ? { tabId: a.tabId } : {}), ...(a.ref !== undefined ? { ref: a.ref } : {}), ...(a.selector !== undefined ? { selector: a.selector } : {}), ...(a.x !== undefined ? { x: a.x } : {}), ...(a.y !== undefined ? { y: a.y } : {}), ...(a.button !== undefined ? { button: a.button } : {}), ...(a.doubleClick !== undefined ? { doubleClick: a.doubleClick } : {}) }),
    { domain: 'browser', optIn: true, mutates: true, browserAccess: 'write' }],
  ['browser_type', 'Focus and type text into an input, textarea, or editable element by snapshot ref or CSS selector.', 'browser_write',
    { target: browserTarget, tabId: tabIdProp, ref: refProp, selector: selectorProp, text: { type: 'string', maxLength: 32768 }, clear: { type: 'boolean', default: true, description: 'Clear existing value before typing.' }, submit: { type: 'boolean', default: false, description: 'Press Enter after typing.' } }, ['text'],
    a => file('browser_type', { ...(a.target !== undefined ? { target: a.target } : {}), ...(a.tabId !== undefined ? { tabId: a.tabId } : {}), ...(a.ref !== undefined ? { ref: a.ref } : {}), ...(a.selector !== undefined ? { selector: a.selector } : {}), text: a.text, ...(a.clear !== undefined ? { clear: a.clear } : {}), ...(a.submit !== undefined ? { submit: a.submit } : {}) }),
    { domain: 'browser', optIn: true, mutates: true, browserAccess: 'write' }],
  ['browser_press', 'Press a keyboard key or shortcut in the active page (e.g. Enter, Escape, Tab, ArrowDown, Control+a).', 'browser_write',
    { target: browserTarget, tabId: tabIdProp, key: { type: 'string', minLength: 1, maxLength: 64 } }, ['key'],
    a => file('browser_press', { ...(a.target !== undefined ? { target: a.target } : {}), ...(a.tabId !== undefined ? { tabId: a.tabId } : {}), key: a.key }),
    { domain: 'browser', optIn: true, mutates: true, browserAccess: 'write' }],
  ['browser_scroll', 'Scroll the page or a specific element vertically/horizontally, or jump to top/bottom.', 'browser_write',
    { target: browserTarget, tabId: tabIdProp, deltaY: count(-20000, 20000), deltaX: count(-20000, 20000), ref: refProp, selector: selectorProp, to: { type: 'string', enum: ['top', 'bottom'] } }, [],
    a => file('browser_scroll', { ...(a.target !== undefined ? { target: a.target } : {}), ...(a.tabId !== undefined ? { tabId: a.tabId } : {}), ...(a.deltaY !== undefined ? { deltaY: a.deltaY } : {}), ...(a.deltaX !== undefined ? { deltaX: a.deltaX } : {}), ...(a.ref !== undefined ? { ref: a.ref } : {}), ...(a.selector !== undefined ? { selector: a.selector } : {}), ...(a.to !== undefined ? { to: a.to } : {}) }),
    { domain: 'browser', optIn: true, mutates: true, browserAccess: 'write' }],
  ['browser_eval', 'Evaluate a JavaScript expression in the page context and return its JSON-serialized value.', 'browser_write',
    { target: browserTarget, tabId: tabIdProp, expression: { type: 'string', minLength: 1, maxLength: 32768 } }, ['expression'],
    a => file('browser_eval', { ...(a.target !== undefined ? { target: a.target } : {}), ...(a.tabId !== undefined ? { tabId: a.tabId } : {}), expression: a.expression }),
    { domain: 'browser', optIn: true, mutates: true, browserAccess: 'write' }],
  ['browser_tab_action', 'Open a new browser tab, switch active tab, or close a tab.', 'browser_write',
    { target: browserTarget, action: { type: 'string', enum: ['new', 'select', 'close'] }, tabId: tabIdProp, url: browserUrlProp }, ['action'],
    a => file('browser_tab_action', { ...(a.target !== undefined ? { target: a.target } : {}), action: a.action, ...(a.tabId !== undefined ? { tabId: a.tabId } : {}), ...(a.url !== undefined ? { url: a.url } : {}) }),
    { domain: 'browser', optIn: true, mutates: true, browserAccess: 'write' }],
];

const toEntry = ([name, description, permission, properties, required, translate, meta = {}]) => ({
  name,
  description,
  permission,
  domain: meta.domain ?? 'workspace',
  optIn: Boolean(meta.optIn),
  mutates: meta.mutates ?? (permission !== 'read'),
  ...(meta.browserAccess ? { browserAccess: meta.browserAccess } : {}),
  inputSchema: schema(properties, required),
  translate,
});

export const WORKSPACE_CATALOG = WORKSPACE_DEFINITIONS.map(toEntry);
export const PROCESS_CATALOG = PROCESS_DEFINITIONS.map(toEntry);
export const BROWSER_CATALOG = BROWSER_DEFINITIONS.map(toEntry);
export const CATALOG = [...WORKSPACE_CATALOG, ...PROCESS_CATALOG, ...BROWSER_CATALOG];
export const PROCESS_TOOL_NAMES = PROCESS_CATALOG.map(t => t.name);
export const BROWSER_READ_TOOL_NAMES = BROWSER_CATALOG.filter(t => t.browserAccess === 'read').map(t => t.name);
export const BROWSER_WRITE_TOOL_NAMES = BROWSER_CATALOG.filter(t => t.browserAccess === 'write').map(t => t.name);
export const BROWSER_TOOL_NAMES = BROWSER_CATALOG.map(t => t.name);

export const LIFECYCLE = [
  { name: 'workspace_capabilities', description: 'Inspect the bound workspace, current permissions, connection and limits.', inputSchema: schema({}, []) },
  { name: 'workspace_task_status', description: 'Read a task result. resultReady must be true before treating it as complete.', inputSchema: schema({ operationId: { type: 'string', maxLength: 128 } }, ['operationId']) },
  { name: 'workspace_task_output', description: 'Read ordered task output; follow nextSeq and report any truncation.', inputSchema: schema({ operationId: { type: 'string', maxLength: 128 }, afterSeq: count(0, Number.MAX_SAFE_INTEGER, 0) }, ['operationId']) },
  { name: 'workspace_task_cancel', description: 'Request cancellation; cancelling is pending until the device confirms termination.', inputSchema: schema({ operationId: { type: 'string', maxLength: 128 } }, ['operationId']) },
];

export function enabledBrowserTargets(sandbox) {
  const b = sandbox?.browser;
  if (!b || typeof b !== 'object') return [];
  const targets = [];
  if (b.builtin?.enabled) targets.push('builtin');
  if (b.daily?.enabled) targets.push('daily');
  return targets;
}

export function browserCanWrite(sandbox) {
  const b = sandbox?.browser;
  if (!b || typeof b !== 'object') return false;
  return Boolean(b.builtin?.enabled || (b.daily?.enabled && b.daily.access !== 'read'));
}

export function browserInstructions(sandbox) {
  const b = sandbox?.browser;
  if (!b || (!b.builtin?.enabled && !b.daily?.enabled)) return '';
  const parts = [];
  if (b.builtin?.enabled) {
    parts.push('target="builtin" controls the isolated built-in dev browser inside the desktop client (ideal for localhost/frontend testing and visual inspection)');
  }
  if (b.daily?.enabled) {
    const access = b.daily.access === 'read' ? 'read-only (snapshot/screenshot/logs only)' : 'full interactive control';
    parts.push(`target="daily" controls the user's daily browser (${access}; be mindful of logged-in sessions and avoid destructive actions without user intent)`);
  }
  return `Browser control is enabled on the remote device: ${parts.join('; ')}. Prefer browser_snapshot before browser_click/browser_type so you can target stable refs (e.g. e12), and use browser_screenshot to visually inspect pages.`;
}

export function normalize(name, args) {
  const tool = CATALOG.find(t => t.name === name) ?? fail('TOOL_NOT_FOUND');
  exact(args, Object.keys(tool.inputSchema.properties));
  for (const key of tool.inputSchema.required) if (!Object.hasOwn(args, key)) fail('MISSING_ARGUMENT');
  const request = tool.translate(args);
  // Validate shape independently of current permission so an old ticket can
  // still retrieve its recorded result after a local permission change.
  validate(request, { capabilities: ['dc.tool', 'dc.search', 'dc.run', 'workspace.exec', 'workspace.write'] });
  if (Buffer.byteLength(JSON.stringify(request)) > 262144) fail('REQUEST_TOO_LARGE');
  return request;
}

export function allowed(tool, grant, supportedTools, sandbox) {
  if (!tool || grant.revoked) return false;
  if (tool.optIn) {
    if (!(Array.isArray(supportedTools) && supportedTools.includes(tool.name))) return false;
  } else if (supportedTools !== undefined && !(Array.isArray(supportedTools) && supportedTools.includes(tool.name))) {
    return false;
  }
  if (tool.domain === 'browser') {
    if (!grant.capabilities.includes('dc.tool')) return false;
    if (sandbox?.browser) {
      const targets = enabledBrowserTargets(sandbox);
      if (!targets.length) return false;
      if (tool.browserAccess === 'write' && !browserCanWrite(sandbox)) return false;
    }
    return true;
  }
  if (tool.permission === 'write') return grant.capabilities.includes('workspace.write');
  if (tool.permission === 'execute') return grant.capabilities.includes('workspace.exec');
  return grant.capabilities.includes(tool.name === 'workspace_search' ? 'dc.search' : 'dc.tool');
}

export function isOfflineSandbox(sandbox) {
  return Boolean(sandbox && (sandbox.network === false || sandbox.isolation === 'windows-appcontainer' || sandbox.isolation === 'bwrap'));
}

export function workspaceRunDescription(sandbox) {
  if (isOfflineSandbox(sandbox)) {
    if (sandbox?.shell === 'cmd.exe') {
      return 'Run a finite Windows cmd.exe project command in an offline AppContainer (120s timeout). Normal exit writes project changes back. Node and npm are available.';
    }
    return 'Run a finite shell command in an offline workspace sandbox.';
  }
  const timeoutSec = Number.isFinite(sandbox?.timeoutMs) && sandbox.timeoutMs > 0 ? Math.round(sandbox.timeoutMs / 1000) : 120;
  if (sandbox?.platform === 'win32' || sandbox?.shell === 'cmd.exe') {
    return `Run a finite Windows cmd.exe command directly on the remote device as the current user (cwd defaults to the workspace root; full network and local toolchain access; ${timeoutSec}s timeout). Do not kill or restart the AnywhereMesh process hosting this session.`;
  }
  if (sandbox?.platform === 'linux' || sandbox?.shell === '/bin/bash') {
    return `Run a finite /bin/bash -lc command directly on the remote Linux device as the current user (cwd defaults to the workspace root; full network and local toolchain access; ${timeoutSec}s timeout). Do not kill or restart the AnywhereMesh process hosting this session.`;
  }
  return 'Run a finite shell command on the bound workspace device (cwd defaults to the workspace root) and wait for completion.';
}

function adaptBrowserSchema(tool, sandbox) {
  const targets = enabledBrowserTargets(sandbox);
  if (!targets.length || !tool.inputSchema?.properties?.target) return tool.inputSchema;
  const writeOnlyTargets = tool.browserAccess === 'write'
    ? targets.filter(t => t === 'builtin' || (t === 'daily' && sandbox.browser.daily?.access !== 'read'))
    : targets;
  const enumVals = writeOnlyTargets.length ? writeOnlyTargets : targets;
  return {
    ...tool.inputSchema,
    properties: {
      ...tool.inputSchema.properties,
      target: {
        ...tool.inputSchema.properties.target,
        enum: enumVals,
        default: enumVals[0],
      },
    },
  };
}

export function listTools(grant, executable = true, supportedTools, sandbox) {
  const runDesc = sandbox ? workspaceRunDescription(sandbox) : null;
  const offline = sandbox ? isOfflineSandbox(sandbox) : true;
  return [...CATALOG.filter(t => executable && allowed(t, grant, supportedTools, sandbox)).map(({ translate, permission, domain, optIn, mutates, browserAccess, ...t }) => ({
    ...t,
    ...(t.name === 'workspace_run' && runDesc ? { description: runDesc } : {}),
    ...(domain === 'browser' && sandbox?.browser ? { inputSchema: adaptBrowserSchema({ ...t, browserAccess }, sandbox) } : {}),
    annotations: {
      readOnlyHint: !mutates,
      destructiveHint: mutates,
      openWorldHint: (permission === 'execute' && !offline) || domain === 'browser',
    },
  })), ...LIFECYCLE];
}
