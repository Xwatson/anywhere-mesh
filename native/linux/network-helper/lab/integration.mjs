import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { NetworkClient } from '../client.mjs';

const exec = promisify(execFile);
const run = async (...args) => (await exec(args[0], args.slice(1), { timeout: 30000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const socketPath = (role) => `/run/anywhere-network/${role}.sock`;
const results = [];
const clients = [];
let killedClient, stalled, capturing = false;
const record = (name, detail = {}) => { const row = { name, passed: true, ...detail }; results.push(row); console.log(JSON.stringify(row)); };
async function client(role, acquire = false) {
  const c = await NetworkClient.connect(socketPath(role));
  clients.push(c);
  if (acquire) { await c.acquire(); await c.waitConnected(); }
  return c;
}
async function until(fn, timeout = 25000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await sleep(250); }
  throw new Error('CONDITION_TIMEOUT');
}
async function idle(role) {
  const observer = await client(role);
  try {
    await until(async () => { const s = await observer.status(); return s.phase === 'idle' && !s.interfacePresent && s.pid === null; });
    return await observer.status();
  } finally { await observer.close(); }
}
async function probe(...args) {
  return JSON.parse(await run('docker', 'exec', 'anywhere-helper-cn-probe-1', 'python', '/probe/probe.py', ...args));
}
async function healthy() {
  await until(async () => { try { return (await probe()).ok; } catch { return false; } });
}

await run('bash', '/srv/anywhere-lab/scripts/guest-guard.sh');
let failure;
try {
  // The socket's group permission is necessary but not sufficient: SO_PEERCRED
  // rejects even uid 0, which can bypass filesystem socket permissions.
  const rejected = await run('sudo', '-n', 'python3', '-c',
    'import socket;s=socket.socket(socket.AF_UNIX);s.connect("/run/anywhere-network/cn.sock");s.settimeout(2);print(len(s.recv(1)))');
  assert.equal(rejected, '0');
  await run('sudo', '-n', '-u', 'nobody', 'python3', '-c',
    'import socket\ns=socket.socket(socket.AF_UNIX)\ntry:s.connect("/run/anywhere-network/cn.sock")\nexcept PermissionError:pass\nelse:raise SystemExit("unexpected access")');
  record('socket_permissions_and_kernel_peer_uid');

  const cn = await client('cn');
  for (const extra of [{ config: '/tmp/untrusted.toml' }, { command: '/bin/sh' }, { env: {} }]) {
    await assert.rejects(cn.request('start', extra), /INVALID_REQUEST/);
  }
  assert.equal((await cn.status()).phase, 'idle');
  record('reject_client_paths_commands_and_environment');

  const holderPid = await run('docker', 'inspect', '-f', '{{.State.Pid}}', 'anywhere-helper-cn-1');
  await run('sudo', '-n', 'systemd-run', '--unit=anywhere-helper-capture', '--property=RuntimeMaxSec=240',
    '--property=MemoryMax=64M', '--property=UMask=0077',
    '/usr/bin/nsenter', '-t', holderPid, '-n', '/usr/bin/tcpdump', '-Z', 'root', '-U', '-nn', '-i', 'eth0', '-s', '96',
    '-w', '/srv/anywhere-lab/artifacts/helper-a-cn.pcap', 'ip or ip6');
  capturing = true;
  await sleep(400);
  await cn.acquire();
  const us = await client('us', true);
  await cn.waitConnected();
  await healthy();
  const initial = await cn.status();
  const processStatus = await readFile(`/proc/${initial.pid}/status`, 'utf8');
  assert.match(processStatus, /CapEff:\s+0000000000003000/);
  assert.match(processStatus, /NoNewPrivs:\s+1/);
  assert.doesNotMatch(processStatus, /Uid:\s+0\s/);
  assert.equal(await run('sudo', '-n', 'readlink', `/proc/${initial.pid}/ns/net`),
    await run('sudo', '-n', 'readlink', `/proc/${holderPid}/ns/net`));
  assert.match(await readFile(`/proc/${initial.pid}/cgroup`, 'utf8'), /anywhere-network@cn.service/);
  record('native_systemd_nonroot_bounded_capabilities_and_mtls', { initialCorePid: initial.pid });

  const contender = await client('cn');
  await assert.rejects(contender.acquire(), /BUSY/);
  await assert.rejects(contender.request('stop', { lease: 'not-the-owner' }), /NOT_OWNER/);
  await contender.close();
  assert.equal((await cn.status()).pid, initial.pid);
  // Calling start again on the owner is idempotent.
  await cn.acquire();
  assert.equal((await cn.status()).pid, initial.pid);
  record('single_owner_and_idempotent_start');

  assert.ok((await probe('--expect-failure', '--without-client-cert')).expected_failure);
  assert.ok((await probe('--expect-failure', '--tcp-only', '--url', 'https://172.31.20.10:8443/health')).expected_failure);
  assert.ok((await probe('--expect-failure', '--tcp-only', '--url', 'http://127.0.0.1:15888/')).expected_failure);
  assert.ok((await probe('--expect-failure', '--tcp-only', '--url', 'http://172.31.10.2:11011/')).expected_failure);
  // Prove that the forbidden overlay port really has a listener before asserting denial.
  await run('docker', 'exec', '-d', 'anywhere-helper-us-mock-1', 'python', '-c',
    'import socket,signal,os;s=socket.socket();s.bind(("0.0.0.0",2222));s.listen();open("/tmp/blocked-listener.pid","w").write(str(os.getpid()));signal.pause()');
  await sleep(200);
  await run('docker', 'exec', 'anywhere-helper-us-mock-1', 'python', '-c',
    'import socket;s=socket.create_connection(("127.0.0.1",2222),timeout=2);s.close()');
  assert.ok((await probe('--expect-failure', '--tcp-only', '--url', 'http://10.126.10.2:2222/')).expected_failure);
  await healthy();
  record('mtls_underlay_rpc_and_live_unapproved_overlay_port_denied');

  await run('docker', 'stop', '-t', '2', 'anywhere-helper-relay-1');
  await until(async () => (await cn.status()).phase === 'degraded');
  assert.equal((await cn.status()).pid, initial.pid);
  assert.ok((await probe('--expect-failure')).expected_failure);
  await run('docker', 'start', 'anywhere-helper-relay-1');
  await cn.waitConnected(25000); await us.waitConnected(25000); await healthy();
  assert.equal((await cn.status()).pid, initial.pid);
  record('relay_outage_and_recovery_without_duplicate_core');

  await run('sudo', '-n', 'kill', '-KILL', String(initial.pid));
  await until(async () => { const s = await cn.status(); return s.phase === 'connected' && s.pid !== initial.pid; });
  await healthy();
  record('core_crash_restarted_with_live_lease', { newPid: (await cn.status()).pid });

  await cn.close();
  await idle('cn');
  await assert.rejects(run('docker', 'exec', 'anywhere-helper-cn-1', 'ip', 'link', 'show', 'awtun'));
  const routes = JSON.parse(await run('docker', 'exec', 'anywhere-helper-cn-1', 'ip', '-j', 'route'));
  assert.ok(routes.every((r) => r.dev !== 'awtun'));
  record('explicit_quit_reaps_core_tun_and_routes');

  killedClient = spawn(process.execPath, [fileURLToPath(new URL('../cli.mjs', import.meta.url)), 'hold', socketPath('cn')],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const [line] = await once(killedClient.stdout, 'data');
  assert.equal(JSON.parse(line).phase, 'connected');
  const monitor = await client('cn');
  await sleep(11000); // Beyond one lease: real Node client must renew it.
  assert.equal((await monitor.status()).phase, 'connected');
  const started = Date.now();
  const exited = once(killedClient, 'exit');
  killedClient.kill('SIGKILL'); await exited; killedClient = undefined;
  await idle('cn');
  record('node_client_renewal_and_sigkill_disconnect_cleanup', { cleanupMs: Date.now() - started });
  await monitor.close();

  stalled = net.createConnection(socketPath('cn'));
  await once(stalled, 'connect');
  stalled.write(JSON.stringify({ version: 1, id: 'stalled', method: 'start' }) + '\n');
  const [first] = await once(stalled, 'data');
  assert.equal(JSON.parse(first).ok, true);
  const expiredAt = Date.now();
  const stalledObserver = await client('cn');
  await until(async () => (await stalledObserver.status()).phase === 'connected');
  await until(async () => (await stalledObserver.status()).phase === 'idle', 15000);
  assert.equal((await stalledObserver.status()).lastStopReason, 'lease_expired');
  assert.equal(stalled.destroyed, false); // Reclaimed before IPC disconnected.
  record('unresponsive_client_lease_expiry_cleanup', { expiryMs: Date.now() - expiredAt });
  stalled.destroy(); stalled = undefined; await stalledObserver.close();

  const crashOwner = await client('cn', true);
  const orphanPid = (await crashOwner.status()).pid;
  const lost = once(crashOwner, 'disconnected');
  await run('sudo', '-n', 'systemctl', 'kill', '--kill-whom=main', '--signal=KILL', 'anywhere-network@cn.service');
  await lost;
  await until(async () => { try { await readFile(`/proc/${orphanPid}/status`); return false; } catch { return true; } });
  await run('sudo', '-n', 'systemctl', 'reset-failed', 'anywhere-network@cn.service');
  await idle('cn');
  record('helper_sigkill_cgroup_cleanup_and_no_implicit_reconnect');
  await us.close(); await idle('us');

  await run('sudo', '-n', 'systemctl', 'stop', 'anywhere-helper-capture.service'); capturing = false;
  const trace = await run('sudo', '-n', 'tcpdump', '-nn', '-r', '/srv/anywhere-lab/artifacts/helper-a-cn.pcap');
  const packets = trace.split('\n').filter(Boolean);
  assert.ok(packets.length > 20);
  assert.ok(packets.every((line) => /IP 172\.31\.10\.10\.\d+ > 172\.31\.10\.2\.11011: Flags/.test(line)
    || /IP 172\.31\.10\.2\.11011 > 172\.31\.10\.10\.\d+: Flags/.test(line)), 'unexpected underlay traffic');
  assert.doesNotMatch(trace, /UDP|IP6/);
  await writeFile('/srv/anywhere-lab/artifacts/helper-a-packet-summary.txt', trace + '\n');
  record('startup_reconnect_crash_and_shutdown_capture_only_approved_tcp', { packets: packets.length, udpPackets: 0 });
} catch (error) {
  failure = { message: error.message, stack: error.stack };
  console.error(error);
} finally {
  if (killedClient) killedClient.kill('SIGKILL');
  stalled?.destroy();
  for (const c of clients) await c.close().catch(() => {});
  await run('docker', 'start', 'anywhere-helper-relay-1').catch(() => {});
  await run('docker', 'exec', 'anywhere-helper-us-mock-1', 'python', '-c',
    'import pathlib,os,signal\np=pathlib.Path("/tmp/blocked-listener.pid")\nif p.exists():\n pid=int(p.read_text());cmd=pathlib.Path(f"/proc/{pid}/cmdline")\n if pid!=os.getpid() and cmd.exists() and b"import socket,signal,os;s=socket.socket()" in cmd.read_bytes():os.kill(pid,signal.SIGTERM)\n p.unlink()').catch(() => {});
  if (capturing) await run('sudo', '-n', 'systemctl', 'stop', 'anywhere-helper-capture.service').catch(() => {});
  await writeFile('/srv/anywhere-lab/artifacts/helper-a-integration.json', JSON.stringify({
    checkedAt: new Date().toISOString(), passed: !failure, results, failure,
  }, null, 2) + '\n');
}
if (failure) process.exitCode = 1;
