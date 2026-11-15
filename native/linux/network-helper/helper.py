#!/usr/bin/env python3
"""Linux EasyTier supervisor. Fixed administrator profile; connection-scoped lease."""
import argparse
import asyncio
from collections import deque
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import stat
import struct
import time
import tomllib

MAX_FRAME = 4096
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'}


class Fault(Exception):
    pass


def trusted_file(path, digest=None):
    p = Path(path)
    if not p.is_absolute() or '..' in p.parts:
        raise Fault('UNTRUSTED_PATH')
    for parent in [*reversed(p.parents), p]:
        s = parent.lstat()
        if stat.S_ISLNK(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o022:
            raise Fault('UNTRUSTED_FILE')
    if not stat.S_ISREG(p.stat().st_mode):
        raise Fault('UNTRUSTED_FILE')
    data = p.read_bytes()
    if digest and hashlib.sha256(data).hexdigest() != digest:
        raise Fault('HASH_MISMATCH')
    return data


def load_profile(path):
    p = json.loads(trusted_file(path))
    expected = {'version', 'allowed_uids', 'core', 'core_sha256', 'cli', 'cli_sha256',
                'config', 'config_sha256', 'interface', 'virtual_ip', 'relay_hostname',
                'lease_seconds', 'probe_seconds', 'restart_limit', 'restart_window_seconds'}
    if set(p) != expected or p['version'] != 1:
        raise Fault('INVALID_PROFILE')
    if not p['allowed_uids'] or any(type(v) is not int or v < 1 for v in p['allowed_uids']):
        raise Fault('INVALID_UID')
    if not 5 <= p['lease_seconds'] <= 60 or not 0.2 <= p['probe_seconds'] <= 5:
        raise Fault('INVALID_TIMEOUT')
    if not 1 <= p['restart_limit'] <= 5 or not 10 <= p['restart_window_seconds'] <= 300:
        raise Fault('INVALID_RESTART_POLICY')
    if not p['interface'].startswith('aw') or not p['interface'].isalnum() or len(p['interface']) > 15:
        raise Fault('INVALID_INTERFACE')
    ipaddress.IPv4Address(p['virtual_ip'])
    for key in ['core', 'cli']:
        trusted_file(p[key], p[key+'_sha256'])
    c = tomllib.loads(trusted_file(p['config'], p['config_sha256']).decode())
    flags = c.get('flags', {})
    required = {'dev_name': p['interface'], 'disable_p2p': True, 'need_p2p': False,
                'disable_udp_hole_punching': True, 'disable_tcp_hole_punching': True,
                'disable_sym_hole_punching': True, 'disable_upnp': True,
                'enable_kcp_proxy': False, 'disable_kcp_input': True, 'disable_relay_kcp': True,
                'enable_quic_proxy': False, 'disable_quic_input': True, 'disable_relay_quic': True,
                'enable_ipv6': False, 'accept_dns': False, 'enable_exit_node': False,
                'enable_encryption': True, 'private_mode': True, 'no_tun': False}
    peers = c.get('peer', [])
    if (any(flags.get(k) != v for k, v in required.items()) or c.get('listeners') != []
            or c.get('stun_servers') != [] or c.get('stun_servers_v6') != []
            or c.get('secure_mode', {}).get('enabled') is not True
            or not peers or any(not v['uri'].startswith('wss://') or not v.get('peer_public_key') for v in peers)
            or str(ipaddress.ip_interface(c['ipv4']).ip) != p['virtual_ip']):
        raise Fault('UNSAFE_NETWORK_CONFIG')
    return p


async def terminate(proc):
    # Always signal the process group, even if its leader has already exited.
    for sig in [signal.SIGTERM, signal.SIGKILL]:
        try:
            os.killpg(proc.pid, sig)
        except ProcessLookupError:
            pass
        try:
            await asyncio.wait_for(proc.wait(), 2)
        except asyncio.TimeoutError:
            continue
        if sig == signal.SIGTERM:
            # Descendants may outlive the leader; they cannot retain our TUN.
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        return


async def command_json(*args):
    spawning = asyncio.create_task(asyncio.create_subprocess_exec(*args, env=ENV, cwd='/',
             stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, start_new_session=True))
    try:
        proc = await asyncio.shield(spawning)
    except asyncio.CancelledError:
        await terminate(await spawning)
        raise
    async def read():
        data = bytearray()
        while chunk := await proc.stdout.read(8192):
            data.extend(chunk)
            if len(data) > 65536:
                raise Fault('PROBE_TOO_LARGE')
        if await proc.wait() != 0:
            raise Fault('PROBE_FAILED')
        return json.loads(data)
    try:
        return await asyncio.wait_for(read(), 2)
    finally:
        await terminate(proc)


class Supervisor:
    def __init__(self, profile, spawn=None, probe=None, interface_present=None):
        self.p = profile
        self.spawn = spawn or self._spawn
        self.probe = probe or self._probe
        def present():
            try:
                socket.if_nametoindex(self.p['interface'])
                return True
            except OSError:
                return False
        self.interface_present = interface_present or present
        self.lock = asyncio.Lock()
        self.owner = None
        self.lease = None
        self.deadline = 0
        self.worker = None
        self.process = None
        self.phase = 'idle'
        self.error = None
        self.stop_reason = None
        self.restart_count = 0
        self.crashes = deque()

    def status(self):
        return {'phase': self.phase, 'pid': self.process.pid if self.process and self.process.returncode is None else None,
                'interface': self.p['interface'], 'interfacePresent': self.interface_present(),
                'virtualIp': self.p['virtual_ip'], 'restartCount': self.restart_count,
                'error': self.error, 'lastStopReason': self.stop_reason,
                'leaseRemainingMs': max(0, round((self.deadline-time.monotonic())*1000)) if self.owner else 0}

    async def _spawn(self):
        for key in ['core', 'cli', 'config']:
            trusted_file(self.p[key], self.p[key+'_sha256'])
        return await asyncio.create_subprocess_exec(self.p['core'], '--disable-env-parsing',
            '--config-file', self.p['config'], '--rpc-portal', '127.0.0.1:15888', '--console-log-level', 'warn',
            env=ENV, cwd='/', stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL, start_new_session=True)

    async def _probe(self):
        addrs = await command_json('/usr/sbin/ip', '-j', 'address', 'show', 'dev', self.p['interface'])
        if not any(a.get('local') == self.p['virtual_ip'] for link in addrs for a in link.get('addr_info', [])):
            return False
        peers = await command_json(self.p['cli'], '--rpc-portal', '127.0.0.1:15888', '--output', 'json', 'peer')
        direct = [v for v in peers if v.get('cost') == 'p2p']
        if any(v.get('hostname') != self.p['relay_hostname'] or v.get('tunnel_proto') != 'wss' for v in direct):
            raise Fault('UNAPPROVED_PEER')
        return any(v.get('hostname') == self.p['relay_hostname'] for v in direct)

    async def start(self, owner):
        async with self.lock:
            if self.owner is not None:
                if self.owner is not owner:
                    raise Fault('BUSY')
                return self.lease
            if self.interface_present():
                raise Fault('INTERFACE_IN_USE')
            self.owner, self.lease = owner, secrets.token_urlsafe(32)
            self.deadline = time.monotonic()+self.p['lease_seconds']
            self.error, self.stop_reason, self.phase = None, None, 'starting'
            self.worker = asyncio.create_task(self._run())
            return self.lease

    async def renew(self, owner, lease):
        async with self.lock:
            if self.owner is not owner or not secrets.compare_digest(lease, self.lease or ''):
                raise Fault('NOT_OWNER')
            # An expired lease cannot be revived by beating the watchdog tick.
            if time.monotonic() >= self.deadline:
                raise Fault('LEASE_EXPIRED')
            self.deadline = time.monotonic()+self.p['lease_seconds']

    async def stop(self, owner=None, lease=None, reason='explicit_stop', force=False):
        async with self.lock:
            if not force and (self.owner is not owner or (lease is not None and not secrets.compare_digest(lease, self.lease or ''))):
                raise Fault('NOT_OWNER')
            if reason == 'lease_expired' and time.monotonic() < self.deadline:
                return
            self.owner, self.lease, self.deadline = None, None, 0
            self.phase = 'stopping'
            if self.worker:
                self.worker.cancel()
                try:
                    await self.worker
                except asyncio.CancelledError:
                    pass
                self.worker = None
            self.stop_reason = reason
            self.error = 'CLEANUP_FAILED' if self.interface_present() else None
            self.phase = 'failed' if self.error else 'idle'

    async def _run(self):
        try:
            while True:
                now = time.monotonic()
                while self.crashes and now-self.crashes[0] >= self.p['restart_window_seconds']:
                    self.crashes.popleft()
                if len(self.crashes) > self.p['restart_limit']:
                    self.phase, self.error = 'failed', 'RESTART_LIMIT'
                    return
                spawning = asyncio.create_task(self.spawn())
                try:
                    self.process = await asyncio.shield(spawning)
                except asyncio.CancelledError:
                    self.process = await spawning
                    raise
                self.phase = 'starting'
                while self.process.returncode is None:
                    try:
                        ready = await self.probe()
                        self.phase, self.error = ('connected', None) if ready else ('degraded', 'RELAY_UNAVAILABLE')
                    except Fault as e:
                        if str(e) == 'UNAPPROVED_PEER':
                            raise
                        self.phase, self.error = 'degraded', 'PROBE_UNAVAILABLE'
                    except (OSError, ValueError, asyncio.TimeoutError):
                        self.phase, self.error = 'degraded', 'PROBE_UNAVAILABLE'
                    try:
                        await asyncio.wait_for(self.process.wait(), self.p['probe_seconds'])
                    except asyncio.TimeoutError:
                        pass
                await terminate(self.process)
                self.process = None
                self.crashes.append(time.monotonic())
                self.restart_count += 1
                self.phase, self.error = 'restarting', 'CORE_EXITED'
                await asyncio.sleep(min(0.5 * 2**(len(self.crashes)-1), 4))
        except asyncio.CancelledError:
            raise
        except Exception as e:
            self.phase, self.error = 'failed', str(e) if isinstance(e, Fault) else 'SUPERVISOR_FAILED'
        finally:
            if self.process:
                await terminate(self.process)
                self.process = None

    async def watchdog(self):
        while True:
            await asyncio.sleep(0.2)
            if self.owner and time.monotonic() >= self.deadline:
                try:
                    await self.stop(self.owner, reason='lease_expired')
                except Fault:
                    pass


def parse_request(raw):
    try:
        q = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise Fault('INVALID_REQUEST') from None
    if (not isinstance(q, dict) or type(q.get('version')) is not int or q.get('version') != 1 or not isinstance(q.get('id'), str)
            or not 1 <= len(q['id']) <= 64 or q.get('method') not in ['start','renew','status','stop']):
        raise Fault('INVALID_REQUEST')
    fields = {'version','id','method'} | ({'lease'} if q['method'] in ['renew','stop'] else set())
    if set(q) != fields or ('lease' in q and (not isinstance(q['lease'], str) or not q['lease'].isascii() or not 1 <= len(q['lease']) <= 128)):
        raise Fault('INVALID_REQUEST')
    return q


class Server:
    def __init__(self, supervisor):
        self.s = supervisor
        self.connections = set()

    async def connection(self, reader, writer):
        owner = object()
        sock = writer.get_extra_info('socket')
        _, uid, _ = struct.unpack('3i', sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if uid not in self.s.p['allowed_uids'] or len(self.connections) >= 8:
            writer.close()
            await writer.wait_closed()
            return
        self.connections.add(writer)
        try:
            while raw := await asyncio.wait_for(reader.readline(), self.s.p['lease_seconds']+5):
                if len(raw) > MAX_FRAME or not raw.endswith(b'\n'):
                    break
                q = None
                try:
                    q = parse_request(raw)
                    extra = {}
                    if q['method'] == 'start':
                        extra = {'lease': await self.s.start(owner), 'leaseSeconds': self.s.p['lease_seconds']}
                    elif q['method'] == 'renew':
                        await self.s.renew(owner, q['lease'])
                    elif q['method'] == 'stop':
                        await self.s.stop(owner, q['lease'])
                    result = {'version':1, 'id':q['id'], 'ok':True, 'status':self.s.status(), **extra}
                except Fault as e:
                    try:
                        candidate = json.loads(raw)
                        request_id = candidate.get('id') if isinstance(candidate, dict) else None
                    except (ValueError, UnicodeDecodeError):
                        request_id = None
                    if not isinstance(request_id, str) or len(request_id) > 64:
                        request_id = None
                    result = {'version':1, 'id':request_id, 'ok':False, 'error':str(e)}
                writer.write(json.dumps(result).encode()+b'\n')
                await asyncio.wait_for(writer.drain(), 2)
        except (ConnectionError, ValueError, asyncio.TimeoutError):
            pass
        finally:
            self.connections.discard(writer)
            if self.s.owner is owner:
                await self.s.stop(owner, reason='client_disconnected')
            writer.close()
            try:
                await writer.wait_closed()
            except ConnectionError:
                pass


async def main(profile):
    if os.environ.get('LISTEN_PID') != str(os.getpid()) or os.environ.get('LISTEN_FDS') != '1':
        raise Fault('SYSTEMD_SOCKET_REQUIRED')
    inherited = socket.socket(fileno=3)
    if inherited.family != socket.AF_UNIX or inherited.type != socket.SOCK_STREAM:
        raise Fault('UNIX_SOCKET_REQUIRED')
    supervisor = Supervisor(load_profile(profile))
    server = Server(supervisor)
    listener = await asyncio.start_unix_server(server.connection, sock=inherited, limit=MAX_FRAME)
    watchdog = asyncio.create_task(supervisor.watchdog())
    done = asyncio.Event()
    for sig in [signal.SIGTERM, signal.SIGINT]:
        asyncio.get_running_loop().add_signal_handler(sig, done.set)
    try:
        await done.wait()
    finally:
        listener.close()
        await listener.wait_closed()
        watchdog.cancel()
        await supervisor.stop(force=True, reason='service_stopped')
        for writer in list(server.connections):
            writer.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--profile', required=True)
    args = parser.parse_args()
    try:
        asyncio.run(main(args.profile))
    except Exception:
        # Never put profile contents, subprocess logs or identity material in journald.
        raise SystemExit('network helper startup failed; validate administrator profile and service configuration')
