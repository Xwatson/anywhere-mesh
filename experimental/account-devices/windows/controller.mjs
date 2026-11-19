import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import tls from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { DeviceClient } from '../client.mjs';
import { windowsReader } from './read.mjs';

if (process.platform !== 'win32') throw Error('WINDOWS_REQUIRED');
const root = join(process.env.LOCALAPPDATA, 'AnywhereCodingLab');
const cfg = { stateDir: join(root, 'state'), name: 'Windows · ' + hostname(), url: 'https://127.0.0.1:31844',
  ca: join(root, 'ca.crt'), projects: [{ label: 'Windows 本地项目', path: join(root, 'project') }] };
const client = new DeviceClient(cfg, windowsReader(fileURLToPath(new URL('./WorkspaceSnapshot.exe', import.meta.url))));
const ca = readFileSync(cfg.ca);
async function requireFreePort(port) {
  const s = createServer();
  await new Promise((resolve, reject) => s.once('error', reject).listen(port, '127.0.0.1', resolve));
  await new Promise(resolve => s.close(resolve));
}
await requireFreePort(31844);
await requireFreePort(31897);
const peer = spawn(fileURLToPath(new URL('./PeerHost.exe', import.meta.url)), [], {
  cwd: root, stdio: ['pipe','ignore','ignore'], windowsHide: true
});
peer.stdin.on('error',()=>{});
const peerDone = new Promise(resolve => { peer.once('error', resolve); peer.once('exit', resolve); });
const input = createInterface({input: process.stdin});
let closing = false;
peerDone.then(() => { if (!closing) { process.exitCode = 1; input.close(); process.stdin.destroy(); } });
function probe() {
  return new Promise(resolve => {
    const socket = tls.connect({ port: 31844, host: '127.0.0.1', servername: 'localhost', ca, minVersion: 'TLSv1.3' });
    const finish = ok => { clearTimeout(timer); socket.destroy(); resolve(ok); };
    const timer = setTimeout(() => finish(false), 6500);
    socket.once('error', () => finish(false));
    socket.once('secureConnect', () => finish(socket.authorized));
  });
}
async function ready() {
  const until = Date.now() + 23000;
  do {
    if (peer.exitCode !== null || peer.signalCode !== null) throw Error('WINDOWS_NETWORK_EXITED');
    if (await probe()) return;
    await delay(300);
  } while (Date.now() < until);
  throw Error('WINDOWS_TUNNEL_NOT_READY');
}

const reply = v => process.stdout.write(JSON.stringify(v) + '\n');
reply({event:'ready'});
try {
  for await (const line of input) {
    let id;
    try {
      if (line.length > 24000) throw Error('INVALID_FRAME');
      const frame = JSON.parse(line); id = frame.id;
      if (frame.method === 'login') await ready();
      reply({id, value:await client.control(frame.method,frame.params)});
    } catch (e) { reply({id, error:e.code ?? e.message}); }
  }
} finally {
  closing = true;
  try { await client.control('logout', {}); }
  finally {
    peer.stdin.end();
    await peerDone;
  }
}
