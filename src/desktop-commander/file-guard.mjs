import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash } from '../execution/protocol.mjs';

export function guardCall(params) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/python3', [fileURLToPath(new URL('./file-guard.py', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } });
    let output = '', bytes = 0; const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(params));
    child.stdout.on('data', data => { bytes += data.length; if (bytes > 3 * 1024 * 1024) child.kill('SIGKILL'); else output += data; });
    child.stderr.resume(); child.once('error', reject);
    child.once('close', code => { clearTimeout(timer); try { if (code !== 0) throw new Error('FILE_GUARD_INTERRUPTED'); resolve(JSON.parse(output)); } catch (error) { reject(error); } });
  });
}
const refusal = code => Object.assign(new Error(code), { beforeMutation: true });
export async function prepareFileGuard(request, profile, operationId) {
  const p = request.args.arguments, tool = request.args.tool;
  if (request.kind !== 'dc.tool' || !['read_file', 'read_multiple_files', 'write_file', 'edit_block'].includes(tool)) return;
  const targets = p.paths ?? [p.path ?? p.file_path], writing = ['write_file', 'edit_block'].includes(tool);
  if (writing && !Object.hasOwn(p, 'expectedRevision')) throw refusal('FILE_REVISION_REQUIRED');
  const snapshots = [];
  for (const target of targets) {
    const snap = await guardCall({ action: 'snapshot', root: profile.workspaceRoot, path: target });
    if (!snap.ok) throw refusal(snap.error);
    if (writing && snap.revision !== p.expectedRevision) throw refusal('FILE_VERSION_CONFLICT');
    if (tool === 'edit_block' && snap.revision === null) throw refusal('FILE_NOT_FOUND');
    snapshots.push({ ...snap, path: target });
  }
  const staging = await mkdtemp(path.join(tmpdir(), 'anywhere-file-'));
  try {
    for (const snap of snapshots) {
      const target = path.join(staging, snap.path); await mkdir(path.dirname(target), { recursive: true });
      if (snap.revision !== null) await writeFile(target, Buffer.from(snap.data, 'base64'), { mode: 0o600 });
    }
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
  return { staging, writing, versions: snapshots.map(s => ({ path: s.path, revision: s.revision, size: s.size })),
    close: () => rm(staging, { recursive: true, force: true }),
    async commit() {
      const content = await readFile(path.join(staging, targets[0]));
      const result = await guardCall({ action: 'commit', root: profile.workspaceRoot, path: targets[0], expectedRevision: p.expectedRevision,
        content: content.toString('base64'), backupRoot: path.join(profile.stateDir, 'file-backups'), backupId: hash(operationId) });
      if (result.uncertain) throw new Error(result.error);
      return result;
    } };
}
