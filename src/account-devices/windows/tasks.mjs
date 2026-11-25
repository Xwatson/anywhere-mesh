import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fail } from '../../execution/protocol.mjs';
import { relative } from '../../desktop-commander/adapter.mjs';

export const WINDOWS_TOOLS = [
  'workspace_read_file', 'workspace_read_files', 'workspace_file_info', 'workspace_list_directory',
  'workspace_search', 'workspace_create_directory', 'workspace_write_file', 'workspace_edit_file',
  'workspace_delete_file', 'workspace_move_file', 'workspace_apply_patch', 'workspace_run',
];

export const WINDOWS_SANDBOX = {
  platform: 'win32',
  network: true,
  isolation: 'none',
  timeoutMs: 120000,
  guardedFileWrites: true,
  fileWriteProtection: 'optimistic-version-check-with-preimage',
  supportedTools: WINDOWS_TOOLS,
  shell: 'cmd.exe',
};

export function resolveTaskCwd(workspaceRoot, cwdRelative = '.') {
  relative(cwdRelative);
  let realRoot;
  try { realRoot = realpathSync(workspaceRoot); }
  catch { fail('WORKSPACE_ROOT_CHANGED'); }
  const candidate = cwdRelative === '.' ? realRoot : resolve(realRoot, cwdRelative);
  let st, realCwd;
  try {
    st = statSync(candidate);
    realCwd = realpathSync(candidate);
  } catch (err) {
    if (err.code === 'ENOENT') fail('FILE_NOT_FOUND');
    throw err;
  }
  if (!st.isDirectory()) fail('NOT_A_DIRECTORY');
  const normRoot = process.platform === 'win32' ? realRoot.toLowerCase() : realRoot;
  const normCwd = process.platform === 'win32' ? realCwd.toLowerCase() : realCwd;
  if (normCwd !== normRoot && !normCwd.startsWith(normRoot.endsWith(sep) ? normRoot : normRoot + sep)) {
    fail('PATH_DENIED');
  }
  return realCwd;
}

export function buildTaskEnv(baseEnv = process.env, runtimeDir = dirname(process.execPath), isWin = process.platform === 'win32') {
  const env = { ...baseEnv };
  const delim = isWin ? ';' : ':';
  const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH';
  const currentPath = env[pathKey] ?? '';
  const parts = currentPath ? currentPath.split(delim).filter(Boolean) : [];
  const hasRuntime = parts.some(p => (isWin ? p.trim().toLowerCase() === runtimeDir.toLowerCase() : p.trim() === runtimeDir));
  if (runtimeDir && !hasRuntime) {
    env[pathKey] = currentPath ? `${currentPath}${delim}${runtimeDir}` : runtimeDir;
  }
  return env;
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => {});
    } catch {}
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch {}
  }
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const err = Error('Aborted');
  err.name = 'AbortError';
  return err;
}

export async function runTask({ stateDir, workspaceRoot, rootIdentity, identifyRoot, request, signal, output, timeoutMs = 120000 }) {
  signal?.throwIfAborted();
  if (identifyRoot && identifyRoot(workspaceRoot) !== rootIdentity) fail('WORKSPACE_ROOT_CHANGED');
  const cwd = resolveTaskCwd(workspaceRoot, request.cwdRelative ?? '.');
  const tasksDir = join(stateDir, 'tasks');
  await mkdir(tasksDir, { recursive: true });
  const batchFile = join(tasksDir, `${randomUUID()}.cmd`);
  const env = buildTaskEnv(process.env, dirname(process.execPath), process.platform === 'win32');
  try {
    const script = '@echo off\r\nchcp 65001 >nul\r\n' + request.args.command.replace(/\r?\n/g, '\r\n') + '\r\n';
    await writeFile(batchFile, script, { flag: 'wx', signal });
    const comspec = env.ComSpec || env.COMSPEC || 'cmd.exe';
    return await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(comspec, ['/D', '/S', '/C', `""${batchFile}""`], {
        cwd,
        env,
        windowsHide: true,
        windowsVerbatimArguments: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let settled = false;
      let aborted = false;
      let timedOut = false;
      let abortWatch = null;
      const terminate = () => {
        killTree(child.pid);
        try { child.kill(); } catch {}
      };
      const onAbort = () => {
        aborted = true;
        terminate();
        if (!abortWatch) {
          abortWatch = setTimeout(() => {
            if (!settled) { settled = true; rejectPromise(abortError(signal)); }
          }, 3000);
          abortWatch.unref?.();
        }
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });

      let combined = '';
      const appendOut = (kind, chunk) => {
        if (!chunk) return;
        output?.(kind, chunk);
        if (combined.length < 48000) combined += chunk;
      };
      for (const [kind, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
        const decoder = new StringDecoder('utf8');
        stream.on('data', buf => {
          for (let i = 0; i < buf.length; i += 2048) appendOut(kind, decoder.write(buf.subarray(i, i + 2048)));
        });
        stream.on('end', () => appendOut(kind, decoder.end()));
      }
      child.stdin.on('error', () => {});
      if (request.args.input !== undefined) child.stdin.end(String(request.args.input));
      else child.stdin.end();

      const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        if (abortWatch) clearTimeout(abortWatch);
        signal?.removeEventListener('abort', onAbort);
      };
      child.once('error', err => {
        cleanup();
        if (settled) return;
        settled = true;
        if (aborted || signal?.aborted) { rejectPromise(abortError(signal)); return; }
        resolvePromise({
          version: 1, ok: false, committed: true, calls: 1, error: err.code || 'SPAWN_FAILED',
          response: { isError: true, content: [{ type: 'text', text: `Command spawn failed: ${err.message}` }] },
        });
      });
      child.once('close', (code, sig) => {
        cleanup();
        if (settled) return;
        settled = true;
        if (aborted || signal?.aborted) { rejectPromise(abortError(signal)); return; }
        const ok = !timedOut && code === 0 && !sig;
        const timeoutSec = Math.round(timeoutMs / 1000);
        const summary = timedOut
          ? (combined.trim() ? `${combined.trim()}\n[Command timed out after ${timeoutSec}s]` : `Command timed out after ${timeoutSec}s`)
          : (combined.trim() || (ok ? '(command succeeded with no output)' : `Command exited with code=${code ?? 'null'} signal=${sig ?? 'none'}`));
        resolvePromise({
          version: 1, ok, committed: true, calls: 1,
          process: { exitCode: code, signal: sig ?? null, ...(timedOut ? { timedOut: true } : {}) },
          response: { isError: !ok, content: [{ type: 'text', text: summary.slice(-32000) }] },
        });
      });
    });
  } finally {
    await rm(batchFile, { force: true, maxRetries: 3 }).catch(() => {});
  }
}
