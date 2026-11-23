import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LinuxClient } from './client.mjs';
import { sessionConfig } from './network.mjs';
import { linuxWorkspace } from '../linux-workspace.mjs';

function makeCert(dir) {
  const certPath = join(dir, 'cert.pem');
  const keyPath = join(dir, 'key.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ], { stdio: 'ignore' });
  return { certPath, keyPath };
}

test('LinuxClient workspacePath protects root and private paths, and sessionConfig validates profile', t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'anywhere-linux-client-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'data');
  const defaultProj = join(root, 'project');
  const userRepo = join(dir, 'my-repo');
  const secretSub = join(root, 'state');
  mkdirSync(defaultProj, { recursive: true });
  mkdirSync(userRepo, { recursive: true });
  mkdirSync(secretSub, { recursive: true });
  const { certPath } = makeCert(dir);

  const client = new LinuxClient(
    { name: 'Linux Test', url: 'https://awc.xbxbe.com', ca: certPath, stateDir: secretSub, projects: [{ label: 'Default', path: defaultProj }] },
    linuxWorkspace(),
    { peer: { child: null, stop: async () => {} }, privatePaths: [root] },
  );

  // Default project and ordinary user repo are allowed
  assert.equal(client.workspacePath(defaultProj), defaultProj);
  assert.equal(client.workspacePath(userRepo), userRepo);

  // Filesystem root, relative paths, private data root and parent dir of private root are rejected
  assert.throws(() => client.workspacePath('/'), /WORKSPACE_PATH_RESERVED/);
  assert.throws(() => client.workspacePath('relative/dir'), /LOCAL_PROJECT_REQUIRED/);
  assert.throws(() => client.workspacePath(root), /WORKSPACE_PATH_RESERVED/);
  assert.throws(() => client.workspacePath(secretSub), /WORKSPACE_PATH_RESERVED/);
  assert.throws(() => client.workspacePath(dir), /WORKSPACE_PATH_RESERVED/);

  // sessionConfig produces valid EasyTier config with no_tun and WSS peer
  const key = 'A'.repeat(43) + '=';
  const toml = sessionConfig(
    { name: 'mesh-net', serverKey: key, credential: key, ipv4: '10.203.73.10/24', expiresAt: Date.now() + 60000 },
    '11111111-2222-3333-4444-555555555555',
    41234,
    'https://awc.xbxbe.com',
  );
  assert.match(toml, /uri = "wss:\/\/awc\.xbxbe\.com\/easytier"/);
  assert.match(toml, /no_tun = true/);
  assert.match(toml, /bind_addr = "127\.0\.0\.1:41234"/);
});
