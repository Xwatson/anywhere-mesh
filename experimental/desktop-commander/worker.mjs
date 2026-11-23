import { Client } from './vendor/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from './vendor/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { prepareFileGuard } from './file-guard.mjs';
const started = Date.now();
let data = '';
for await (const chunk of process.stdin) { data += chunk; if (data.length > 300000) throw new Error('INPUT_LIMIT'); }
const { request, profile, operationId } = JSON.parse(data);
let fileGuard, guardFailure;
try { if (profile.guardedFiles) fileGuard = await prepareFileGuard(request, profile, operationId); }
catch (error) { guardFailure = error; }
const vendor = fileURLToPath(new URL('./vendor', import.meta.url));
const entry = fileURLToPath(new URL('./sandbox-entry.mjs', import.meta.url));
const args = ['--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts',
  '--die-with-parent', '--new-session', '--clearenv', '--ro-bind', '/usr', '/usr',
  '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
  '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/home', '--dir', '/home/worker',
  '--ro-bind', vendor, '/opt/vendor', '--ro-bind', entry, '/opt/sandbox-entry.mjs',
  profile.readOnly ? '--ro-bind' : '--bind', fileGuard?.staging ?? profile.workspaceRoot, '/workspace',
  '--setenv', 'HOME', '/home/worker', '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin',
  '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'ANYWHERE_DC_MINIMAL', '1', '--setenv', 'UV_THREADPOOL_SIZE', '4',
  '/usr/local/bin/node', '/opt/sandbox-entry.mjs', request.cwdRelative];
const transport = new StdioClientTransport({ command: '/usr/lib/anywhere-dc/bwrap', args,
  env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' }, stderr: 'pipe' });
const client = new Client({ name: 'anywhere-dc-validation', version: '0.1.0' });
let calls = 0, initMs, result, uncertain = false;
const textOf = (r) => (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const log = (r) => { const s = textOf(r); if (s) process.stdout.write(s + '\n'); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function call(name, parameters) {
  calls++;
  const r = await client.callTool({ name, arguments: parameters }, undefined, { timeout: 15000 });
  if (process.env.ANYWHERE_DC_TRACE === '1') process.stderr.write(JSON.stringify({ name, result: r }) + '\n');
  // A declared MCP error is a result, not a reason to blindly repeat an operation.
  return r;
}
function paths(parameters) {
  const p = { ...parameters };
  delete p.expectedRevision;
  for (const key of ['path', 'file_path']) if (p[key] !== undefined) p[key] = `/workspace/${p[key]}`;
  if (p.paths) p.paths = p.paths.map((x) => `/workspace/${x}`);
  return p;
}
try {
  if (guardFailure) throw guardFailure;
  const connecting = client.connect(transport);
  // stderr is capped; credentials are not present in the child environment.
  let diagnosticBytes = 0;
  transport.stderr?.on('data', (chunk) => { if ((diagnosticBytes += chunk.length) <= 2048) process.stderr.write(chunk); });
  await connecting; initMs = Date.now() - started;
  if (request.kind === 'dc.inspect') {
    const list = await client.listTools();
    result = { ok: true, server: client.getServerVersion(), tools: list.tools.map((t) => ({ name: t.name,
      fields: Object.keys(t.inputSchema.properties ?? {}), required: t.inputSchema.required ?? [] })) };
  } else if (request.kind === 'dc.tool') {
    const response = await call(request.args.tool, paths(request.args.arguments));
    result = { ok: !response.isError, response };
  } else if (request.kind === 'dc.search') {
    const first = await call('start_search', { ...paths(request.args), timeout_ms: 10000, contextLines: 0 });
    if (first.isError) result = { ok: false, response: first };
    else {
      const sessionId = first.structuredContent?.sessionId;
      if (!sessionId) throw new Error('SEARCH_STATE_MISSING');
      let page;
      do { page = await call('get_more_search_results', { sessionId, offset: 0, length: 50 });
        if (page.isError) break;
        if (!page.structuredContent?.isComplete) await sleep(100);
      } while (!page.structuredContent?.isComplete);
      result = { ok: !page.isError, response: page, incomplete: page.structuredContent?.outcome !== 'completed' };
    }
  } else if (request.kind === 'dc.run') {
    const first = await call('start_process', { command: request.args.command, timeout_ms: 100, shell: '/bin/bash' });
    if (first.isError) result = { ok: false, response: first };
    else {
      const pid = first.structuredContent?.pid;
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('PROCESS_STATE_MISSING');
      // First/start output is a preview. Replay from zero exactly once via the output API.
      if (request.args.input !== undefined) {
        const input = await call('interact_with_process', { pid, input: request.args.input, timeout_ms: 100, wait_for_prompt: false });
        if (input.isError) throw new Error('INPUT_FAILED');
        // wait_for_prompt:false only sends input; read_process_output is the
        // sole output consumer. Mixing both readers would duplicate/skip text.
        if (input.structuredContent?.pid !== pid) throw new Error('INPUT_STATE_MISSING');
      }
      let state;
      do {
        const response = await call('read_process_output', { pid, timeout_ms: 300, offset: 0, length: 200 });
        if (response.isError) throw new Error('PROCESS_OUTPUT_LOST');
        state = response.structuredContent;
        if (!state || typeof state.isComplete !== 'boolean') throw new Error('PROCESS_PATCH_MISSING');
        if (state.output) process.stdout.write(state.output + '\n');
        if (state.evictedLines) process.stdout.write(`[upstream output truncated: ${state.evictedLines} lines]\n`);
        if (!state.isComplete && !state.remaining) await sleep(100);
      } while (!state.isComplete || state.remaining > 0);
      result = { ok: state.exitCode === 0 && !state.signal, process: { exitCode: state.exitCode, signal: state.signal ?? null,
        outputTruncated: Boolean(state.evictedLines) } };
    }
  } else throw new Error('UNKNOWN_KIND');
  if (fileGuard && result.ok) {
    result.fileVersions = fileGuard.versions;
    if (fileGuard.writing) {
      const committed = await fileGuard.commit();
      if (!committed.ok) result = { ok: false, response: { isError: true, content: [{ type: 'text', text: committed.error }] } };
      else { result.fileGuard = committed; result.fileVersions = [{ path: fileGuard.versions[0].path, revision: committed.revision, size: committed.size }]; }
    }
    if (result.fileVersions) result.response?.content?.push({ type: 'text', text: 'File versions (use expectedRevision for writes): ' + JSON.stringify(result.fileVersions) });
  }
} catch (error) {
  // Transport failure after dispatch can hide a completed write/command. No result
  // on fd 3 makes B1 retain unknown and block automatic retries in that workspace.
  uncertain = calls > 0 && !error.beforeMutation;
  result = { ok: false, error: error.message, beforeDispatch: !calls };
  process.stderr.write(`adapter: ${error.message}\n`);
} finally {
  await client.close().catch(() => {});
  await fileGuard?.close().catch(() => {});
}
if (uncertain) process.exit(70);
result = { version: 1, ...result, timing: { initMs: initMs ?? null, elapsedMs: Date.now() - started }, calls };
let encoded = JSON.stringify(result);
if (Buffer.byteLength(encoded) > 196608) {
  const readOnly = ['dc.search', 'dc.inspect'].includes(request.kind) || (request.kind === 'dc.tool' &&
    ['read_file', 'read_multiple_files', 'list_directory', 'get_file_info'].includes(request.args.tool));
  if (readOnly) {
    result = { version: 1, ok: false, error: 'RESULT_TOO_LARGE', noWorkspaceMutation: true,
      response: { isError: true, content: [{ type: 'text', text: 'RESULT_TOO_LARGE: reduce the read page, file count, directory depth or search result limit. No workspace files were modified.' }] } };
    encoded = JSON.stringify(result);
  } else {
    // A mutating invocation may have completed. Never invite automatic replay.
    process.stderr.write('adapter: RESULT_TOO_LARGE; manual reconciliation required\n'); process.exit(70);
  }
}
await new Promise((resolve) => process.stdout.write('', resolve));
writeSync(3, encoded);
process.exit(result.ok ? 0 : 1);
