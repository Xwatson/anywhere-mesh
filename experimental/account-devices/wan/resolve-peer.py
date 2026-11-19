"""Resolve the public relay on the guest, outside the isolated client's network namespace."""
import fcntl
import ipaddress
import socket
import subprocess
import sys
from pathlib import Path

from wan_endpoint import endpoint

host, is_domain = endpoint(sys.argv[1])
if not is_domain:
    raise SystemExit('A relay DNS name is required')

config = Path('/etc/anywhere-wan-cn')
hosts = config / 'peer.hosts'
container = 'anywhere-wan-domain-cn'
with (config / 'peer-dns.lock').open('a') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    answers = socket.getaddrinfo(host, 443, socket.AF_INET, socket.SOCK_STREAM)
    addresses = sorted({ipaddress.IPv4Address(answer[4][0]) for answer in answers})
    if not addresses or any(not ip.is_global or ip.is_multicast for ip in addresses):
        raise SystemExit('Relay DNS must return public IPv4 addresses')
    content = ('127.0.0.1 localhost\n' + ''.join(f'{ip} {host}\n' for ip in addresses)).encode()
    prev = hosts.read_bytes() if hosts.exists() else b''
    if content == prev:
        sys.exit(0)
    inspect = subprocess.run(['docker', 'inspect', '-f', '{{.State.Running}}', container],
                             capture_output=True, text=True)
    if inspect.returncode == 0 and inspect.stdout.strip() == 'true':
        chain = 'AWC_WAN_PEERS'
        rules = ['*filter', f'-F {chain}', *(f'-A {chain} -d {ip}/32 -j ACCEPT' for ip in addresses), 'COMMIT']
        subprocess.run(['docker', 'exec', '-i', container, 'iptables-restore', '--wait', '5', '--noflush'],
                       input='\n'.join(rules)+'\n', text=True, check=True)
    # The container bind-mounts this inode. Publish only after the new destinations are allowed.
    with hosts.open('r+b' if hosts.exists() else 'w+b', buffering=0) as target:
        target.write(content.ljust(len(prev), b' '))
        target.truncate(len(content))
    hosts.chmod(0o644)
    print(f'{host}: {len(addresses)} authorized IPv4 addresses')
