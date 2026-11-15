import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import https from 'node:https';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { Journal } from './journal.mjs';
import { LocalAgent } from './agent.mjs';
import { Broker } from './broker.mjs';
import { Rpc } from './rpc.mjs';
import { serveControl } from './control.mjs';
import { CAPABILITIES } from './protocol.mjs';

// This is a VM experiment entry point, not a production daemon/installer.
if (hostname() !== 'anywhere-crossborder-lab' || !existsSync('/etc/anywhere-crossborder-lab')) throw new Error('LAB_GUEST_REQUIRED');
const role = process.argv[2];
if (!['agent', 'broker'].includes(role)) throw new Error('INVALID_ROLE');
const cfg = JSON.parse(readFileSync(process.argv[3], 'utf8'));
let launcher;
if (cfg.desktop) {
  const desktop = await import('../desktop-commander/adapter.mjs');
  desktop.register();
  if (role === 'agent') launcher = desktop.makeLauncher(cfg.desktop);
}
const store = new Journal(`${cfg.stateDir}/journal.sqlite`);
const certificate = readFileSync(cfg.cert), key = readFileSync(cfg.key), ca = readFileSync(cfg.ca);
const peerFingerprint = new X509Certificate(readFileSync(cfg.peerCert)).fingerprint256;
const takeFault = (point) => {
  const path = `${cfg.stateDir}/fault.json`;
  try {
    if (JSON.parse(readFileSync(path, 'utf8')).point !== point) return false;
    unlinkSync(path); return true;
  } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
};
let stopping = false, stop;
if (role === 'broker') {
  const broker = new Broker(store, cfg.grant);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
  const server = https.createServer({ key, cert: certificate, ca, requestCert: true,
    rejectUnauthorized: true, minVersion: 'TLSv1.3' }, (_req, res) => { res.writeHead(404); res.end(); });
  server.on('tlsClientError', () => {});
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/device' || !socket.authorized || socket.getPeerCertificate().fingerprint256 !== peerFingerprint) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const rpc = new Rpc(ws, (method, params, frame) => broker.peer(rpc, method, params, frame));
      const timer = setTimeout(() => { if (rpc.epoch === 0) rpc.close(); }, 5000);
      ws.on('close', () => clearTimeout(timer));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(cfg.port, cfg.host, resolve); });
  const control = await serveControl(`${cfg.stateDir}/control.sock`, broker);
  stop = async () => { broker.close(); wss.close(); server.close(); control.close(); };
  console.log(JSON.stringify({ role, listening: `${cfg.host}:${cfg.port}`, realCli: false }));
} else {
  const agent = new LocalAgent(store, cfg.grant, { stateDir: cfg.stateDir,
    launcher, maxChildren: cfg.desktop ? 1 : 4,
    fault: (point) => { if (takeFault(point)) process.kill(process.pid, 'SIGKILL'); } });
  let rpc, timer, failures = 0;
  const connect = () => {
    if (stopping) return;
    const ws = new WebSocket(cfg.url, { cert: certificate, key, ca, rejectUnauthorized: true,
      minVersion: 'TLSv1.3', handshakeTimeout: 5000, perMessageDeflate: false, maxPayload: 65536,
      checkServerIdentity: (name, cert) => tls.checkServerIdentity(name, cert) ||
        (cert.fingerprint256 === peerFingerprint ? undefined : new Error('BROKER_CERTIFICATE_MISMATCH')) });
    const connection = new Rpc(ws, (method, params, frame) => {
      if (connection !== rpc) throw new Error('STALE_CONNECTION');
      const result = agent.handle(method, params, frame.epoch);
      if (method === 'start' && takeFault('drop_start_reply')) connection.close();
      return result;
    });
    rpc = connection;
    let pingPending = false;
    // Detect a broken uplink independently: do not wait for the server's FIN
    // to make it through the same failed TCP tunnel.
    const heartbeat = setInterval(async () => {
      if (pingPending || connection.epoch === 0 || ws.readyState !== WebSocket.OPEN) return;
      pingPending = true;
      try { await connection.request('ping', {}); }
      catch { connection.close(); }
      finally { pingPending = false; }
    }, 3000);
    ws.on('open', async () => {
      try {
        const welcome = await connection.request('hello', { deviceId: cfg.grant.deviceId,
          instanceId: agent.instanceId, capabilities: CAPABILITIES });
        agent.attach(welcome.connectionEpoch); connection.epoch = welcome.connectionEpoch;
        await connection.request('ready', {}); failures = 0;
      } catch { connection.close(); }
    });
    connection.on('closed', () => {
      clearInterval(heartbeat);
      if (stopping) return;
      const delay = Math.min(5000, 250 * 2 ** Math.min(failures++, 5));
      timer = setTimeout(connect, delay + Math.floor(Math.random() * delay / 4));
    });
  };
  let noticeTimer;
  agent.on('changed', () => {
    if (!noticeTimer) noticeTimer = setTimeout(() => { noticeTimer = null; rpc?.notify('changed', {}); }, 50);
  });
  connect();
  stop = async () => { clearTimeout(timer); clearTimeout(noticeTimer); rpc?.close(); await agent.close(); };
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (stopping) return; stopping = true;
  await stop(); store.close(); process.exit(0);
});
