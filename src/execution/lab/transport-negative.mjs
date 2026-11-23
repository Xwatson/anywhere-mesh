import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import { Rpc } from '../rpc.mjs';
import { CAPABILITIES } from '../protocol.mjs';

const dir = '/srv/anywhere-lab/helper-a/config/topology/runtime';
const ca = readFileSync(`${dir}/ca.crt`), cert = readFileSync(`${dir}/cn.crt`), key = readFileSync(`${dir}/cn.key`);
await new Promise((resolve, reject) => {
  const ws = new WebSocket('wss://10.126.10.2:8443/device', { ca, handshakeTimeout: 4000 });
  ws.on('error', () => resolve()); ws.on('open', () => { ws.terminate(); reject(new Error('NO_CERT_ACCEPTED')); });
});
for (const params of [{ deviceId: 'wrong-device', instanceId: 'negative-test', capabilities: CAPABILITIES },
  { deviceId: 'lab-cn', instanceId: 'negative-test', capabilities: [] }]) {
  const ws = new WebSocket('wss://10.126.10.2:8443/device', { ca, cert, key, handshakeTimeout: 4000 });
  const rpc = new Rpc(ws, () => ({}));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await assert.rejects(rpc.request('hello', params), /CAPABILITY_MISMATCH/); rpc.close();
}
console.log(JSON.stringify({ missingCertificateDenied: true, wrongDeviceDenied: true, missingCapabilitiesDenied: true }));
