import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { TextFileHandler } from './vendor/text.mjs';
import { fail } from '../../execution/protocol.mjs';

const run = promisify(execFile);
const textReader = new TextFileHandler();
const snapshotLimit = 1024 * 1024;
export function windowsReader(executable) {
  const options = { windowsHide: true, timeout: 3000, maxBuffer: snapshotLimit + 1024 };
  return {
    modes: ['revoked', 'read'],
    sandbox: { network: false, readOnly: true, guardedFileWrites: false, fileWriteProtection: null,
      supportedTools: ['workspace_read_file'], isolation: 'windows-local-file-handle' },
    identifyRoot(root) {
      const identity = execFileSync(executable, [root], { ...options, encoding: 'utf8' }).trim();
      if (!/^[A-F0-9]{8}:[A-F0-9]{16}$/.test(identity)) fail('WORKSPACE_ROOT_CHANGED');
      return identity;
    },
    launcher({ workspaceRoot, rootIdentity, stateDir }) {
      const scratch = join(stateDir, 'windows-read-snapshots');
      rmSync(scratch, { recursive: true, force: true });
      mkdirSync(scratch);
      return (op, grant) => {
        const r = op.request;
        if (grant.mode !== 'read' || r.kind !== 'dc.tool' || r.args.tool !== 'read_file' || r.cwdRelative !== '.') {
          fail('TOOL_UNAVAILABLE_ON_DEVICE');
        }
        const { path, offset = 0, length = 100 } = r.args.arguments;
        return { async read(signal) {
          let bytes;
          try {
            ({ stdout: bytes } = await run(executable, [workspaceRoot, rootIdentity, path], { ...options, signal, encoding: 'buffer' }));
          } catch (e) {
            const message = e.stderr?.toString().trim();
            fail(/^[A-Z_]{1,60}$/.test(message ?? '') ? message : 'FILE_READ_FAILED');
          }
          if (bytes.length > snapshotLimit) fail('FILE_SNAPSHOT_TOO_LARGE');
          try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('TEXT_FILE_REQUIRED'); }
          if (bytes.includes(0)) fail('TEXT_FILE_REQUIRED');
          signal.throwIfAborted();
          // Upstream reopens files for paging. Give it only a private immutable copy of the verified handle's bytes.
          const stage = await mkdtemp(join(scratch, 'read-'));
          try {
            const copy = join(stage, 'text.txt');
            await writeFile(copy, bytes, { flag: 'wx', signal });
            const { content } = await textReader.read(copy, { offset, length, signal });
            const revision = 'file-v1:' + createHash('sha256').update(bytes).digest('hex');
            return { version: 1, ok: true, calls: 1, response: { content: [{ type: 'text', text: content }] },
              fileVersions: [{ path, revision, size: bytes.length }] };
          } finally { await rm(stage, { recursive: true, force: true, maxRetries: 3 }); }
        } };
      };
    }
  };
}
