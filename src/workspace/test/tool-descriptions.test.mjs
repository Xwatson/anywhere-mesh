import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listTools, workspaceRunDescription } from '../catalog.mjs';
import { linuxWorkspace } from '../../account-devices/linux-workspace.mjs';
import { buildTaskEnv, resolveTaskCwd, WINDOWS_SANDBOX } from '../../account-devices/windows/tasks.mjs';

const execGrant = {
  revoked: false,
  mode: 'execute',
  capabilities: ['dc.tool', 'dc.search', 'workspace.write', 'workspace.exec'],
};

test('workspace_run description accurately reflects direct Linux/Windows vs legacy offline sandboxes', () => {
  const linux = linuxWorkspace();
  assert.equal(linux.sandbox.platform, 'linux');
  assert.equal(linux.sandbox.network, true);
  assert.equal(linux.sandbox.isolation, 'none');
  assert.equal(linux.sandbox.timeoutMs, 120000);

  const linuxRun = listTools(execGrant, true, linux.sandbox.supportedTools, linux.sandbox).find(t => t.name === 'workspace_run');
  assert.match(linuxRun.description, /\/bin\/bash -lc/);
  assert.match(linuxRun.description, /full network/i);
  assert.doesNotMatch(linuxRun.description, /offline/i);
  assert.equal(linuxRun.annotations.openWorldHint, true);

  // Backwards-compatible with older Linux 0.4.11 clients that omitted network/isolation fields
  const legacyLinuxDesc = workspaceRunDescription({ platform: 'linux', shell: '/bin/bash' });
  assert.match(legacyLinuxDesc, /\/bin\/bash -lc/);
  assert.doesNotMatch(legacyLinuxDesc, /offline/i);

  assert.equal(WINDOWS_SANDBOX.platform, 'win32');
  assert.equal(WINDOWS_SANDBOX.shell, 'cmd.exe');
  assert.equal(WINDOWS_SANDBOX.network, true);
  assert.equal(WINDOWS_SANDBOX.isolation, 'none');
  assert.equal(WINDOWS_SANDBOX.timeoutMs, 120000);

  const winReadSrc = readFileSync(fileURLToPath(new URL('../../account-devices/windows/read.mjs', import.meta.url)), 'utf8');
  assert.match(winReadSrc, /WINDOWS_SANDBOX/);
  assert.doesNotMatch(winReadSrc, /windows-appcontainer|TaskHost\.exe/);

  const winRun = listTools(execGrant, true, WINDOWS_SANDBOX.supportedTools, WINDOWS_SANDBOX).find(t => t.name === 'workspace_run');
  assert.match(winRun.description, /cmd\.exe/);
  assert.match(winRun.description, /full network/i);
  assert.doesNotMatch(winRun.description, /offline|AppContainer/i);
  assert.equal(winRun.annotations.openWorldHint, true);

  // Backwards-compatible with older Windows <=0.4.11 clients still running offline AppContainer
  const legacyWin = { network: false, isolation: 'windows-appcontainer', shell: 'cmd.exe', supportedTools: WINDOWS_SANDBOX.supportedTools };
  const legacyWinRun = listTools(execGrant, true, legacyWin.supportedTools, legacyWin).find(t => t.name === 'workspace_run');
  assert.match(legacyWinRun.description, /offline AppContainer/i);
  assert.equal(legacyWinRun.annotations.openWorldHint, false);

  // Explicit offline bwrap sandbox still reports offline
  const bwrapDesc = workspaceRunDescription({ platform: 'linux', shell: '/bin/bash', network: false, isolation: 'bwrap' });
  assert.match(bwrapDesc, /offline/i);
});

test('Windows direct task helpers preserve user PATH, append bundled runtime, and validate cwd inside workspace', t => {
  const env1 = buildTaskEnv({ Path: 'C:\\Windows\\System32;C:\\Program Files\\Git\\cmd' }, 'C:\\App\\tools', true);
  assert.equal(env1.Path, 'C:\\Windows\\System32;C:\\Program Files\\Git\\cmd;C:\\App\\tools');
  assert.equal(env1.PATH, undefined);
  assert.equal(env1.NPM_CONFIG_OFFLINE, undefined);

  // Does not duplicate runtime dir when already present (case-insensitive on Windows)
  const env2 = buildTaskEnv({ Path: 'C:\\Windows\\System32;c:\\app\\tools' }, 'C:\\App\\tools', true);
  assert.equal(env2.Path, 'C:\\Windows\\System32;c:\\app\\tools');

  const dir = mkdtempSync(join(tmpdir(), 'anywhere-win-task-cwd-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'project');
  const sub = join(root, 'sub');
  const outside = join(dir, 'outside');
  mkdirSync(sub, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, 'a.txt'), 'hi');
  symlinkSync(outside, join(root, 'escape'));

  assert.equal(resolveTaskCwd(root, '.'), root);
  assert.equal(resolveTaskCwd(root, 'sub'), sub);
  assert.throws(() => resolveTaskCwd(root, '../outside'), /PATH_DENIED/);
  assert.throws(() => resolveTaskCwd(root, 'escape'), /PATH_DENIED/);
  assert.throws(() => resolveTaskCwd(root, 'a.txt'), /NOT_A_DIRECTORY/);
  assert.throws(() => resolveTaskCwd(root, 'missing'), /FILE_NOT_FOUND/);
});
