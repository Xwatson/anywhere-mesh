import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { BrowserManager } from '../../browser/manager.mjs';
import { linuxWorkspace } from '../linux-workspace.mjs';
import { loadSavedServerUrl, readDefaultServerUrl, saveServerUrl } from '../server-config.mjs';
import { LinuxClient } from './client.mjs';
import { LinuxPeer } from './network.mjs';

if (process.platform !== 'linux') throw Error('LINUX_REQUIRED');
process.umask(0o077);

const dataBase = process.env.ANYWHERE_MESH_DATA_DIR ||
  join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'AnywhereMesh');
mkdirSync(dataBase, { recursive: true, mode: 0o700 });
const root = realpathSync(dataBase);
const projectDir = join(root, 'project');
mkdirSync(projectDir, { recursive: true, mode: 0o700 });

const packageRoot = resolve(import.meta.dirname, '../../..');
const initialServerUrl = loadSavedServerUrl(root) || readDefaultServerUrl(packageRoot);
const easytierPath = process.env.ANYWHERE_MESH_EASYTIER || join(dirname(process.execPath), 'easytier-core');
if (!existsSync(easytierPath)) throw Error('EASYTIER_BINARY_NOT_FOUND');

const caPath = process.env.ANYWHERE_MESH_CA || join(root, 'ca.crt');
const cfg = {
  stateDir: join(root, 'state'),
  name: process.env.ANYWHERE_MESH_NAME || ('Linux 桌面 · ' + hostname()),
  url: 'https://127.0.0.1:31844',
  serverUrl: initialServerUrl,
  ca: caPath,
  projects: [{ label: 'Linux 本地项目', path: realpathSync(projectDir) }],
};

const input = createInterface({ input: process.stdin });
const peer = new LinuxPeer(root, easytierPath, readFileSync(cfg.ca), initialServerUrl);
const reply = value => process.stdout.write(JSON.stringify(value) + '\n');
let client = null;
const browserManager = new BrowserManager({
  stateDir: cfg.stateDir,
  builtinBridgeUrl: process.env.ANYWHERE_BUILTIN_BROWSER_URL || null,
  builtinBridgeToken: process.env.ANYWHERE_BUILTIN_BROWSER_TOKEN || null,
  onSettingsChange: () => {
    client?.notifyWorkspaceChanged();
    reply({ event: 'stream', data: { type: 'browser_state', payload: browserManager.publicState() } });
  },
});
const workspace = linuxWorkspace({ browserManager });
client = new LinuxClient(cfg, {
  ...workspace,
  browserManager,
  onStream: data => reply({ event: 'stream', data }),
}, {
  peer,
  serverUrl: initialServerUrl,
  saveServerUrl: url => saveServerUrl(root, url),
  privatePaths: [root, packageRoot, dirname(process.execPath)],
});

const repair = setInterval(() => {
  const signed = client.signed;
  if (!signed || client.repairPending) return;
  client.repairPending = client.enqueue(() => client.recover(signed)).catch(() => {}).finally(() => { client.repairPending = null; });
}, 30000);

reply({ event: 'ready' });
try {
  const inflight = new Set();
  for await (const line of input) {
    const task = (async () => {
      let id;
      try {
        if (line.length > 16 * 1024 * 1024) throw Error('INVALID_FRAME');
        const frame = JSON.parse(line);
        id = frame.id;
        reply({ id, value: await client.control(frame.method, frame.params) });
      } catch (error) {
        reply({ id, error: error.code ?? error.message });
      }
    })();
    inflight.add(task);
    task.finally(() => inflight.delete(task));
  }
  await Promise.allSettled([...inflight]);
} finally {
  clearInterval(repair);
  try { await browserManager.close(); } catch {}
  try { await client.suspend(); } finally { await peer.stop(); }
}
