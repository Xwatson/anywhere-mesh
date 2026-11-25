"""Deploy the test host and an EasyTier endpoint into a dedicated systemd network namespace."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tomllib
from tempfile import TemporaryDirectory
from wan_endpoint import endpoint

stage=Path(sys.argv[1]).resolve()
public,domain=endpoint(sys.argv[2])
root=Path('/opt/anywhere-wan')
etc=Path('/etc/anywhere-wan')
units=Path('/etc/systemd/system')
state='/var/lib/anywhere-wan'
appuser='anywhere-wan'
netuser='anywhere-wan-net'
assert os.geteuid()==0 and os.uname().machine=='x86_64'
run=lambda *a,**kw:subprocess.run(a,check=True,**kw)
def digest(p):
    with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def copy(src,dst,mode=0o644):
    shutil.copyfile(src,dst);dst.chmod(mode)
def config(p,data,mode=0o644):
    p.write_text(data);p.chmod(mode)
def account(name):
    if subprocess.run(['getent','passwd',name],stdout=subprocess.DEVNULL).returncode:
        run('useradd','--system','--user-group','--no-create-home','--shell','/usr/sbin/nologin',name)
for name,sha in {
    'node.tar.xz':'fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6',
    'easytier-core':'35b854e0c5853c02733870488c977200f6aa06d09c08d5dc7f9f9e150e7be8d5',
    'easytier-cli':'8da66644ec50dcf618fccf76780991f52dfbe2939797abc0efe0ef4d4c4d3383',
}.items():
    if digest(stage/name)!=sha:raise SystemExit('Binary checksum mismatch: '+name)
run('sha256sum','--strict','--check','app.sha256',cwd=stage)
for name in (appuser,netuser):account(name)
for p in [root,root/'bin',root/'releases',etc]:p.mkdir(mode=0o755,parents=True,exist_ok=True)
node=root/'bin/node-v24.21.0'
if not node.exists():
    with tarfile.open(stage/'node.tar.xz','r:xz') as tar, node.with_suffix('.partial').open('wb') as f:
        shutil.copyfileobj(tar.extractfile('node-v24.21.0-linux-x64/bin/node'),f)
    node.with_suffix('.partial').chmod(0o755);node.with_suffix('.partial').replace(node)
for name in ['easytier-core','easytier-cli']:
    if not (root/'bin'/name).exists():copy(stage/name,root/'bin'/name,0o755)
release=root/'releases'/digest(stage/'app.sha256')[:16]
if not release.exists():
    with TemporaryDirectory(dir=root/'releases') as tmp:
        dest=Path(tmp)/'app';shutil.copytree(stage/'app',dest)
        for p in [dest,*dest.rglob('*')]:p.chmod(0o755 if p.is_dir() else 0o644)
        dest.rename(release)
if (etc/'network.toml').exists() and digest(etc/'network.toml')!=digest(stage/'server.toml'):
    raise SystemExit('An existing WAN network has a different identity.')
copy(stage/'server.toml',etc/'network.toml',0o640);shutil.chown(etc/'network.toml','root',netuser)
pki=etc/'pki';pki.mkdir(mode=0o700,exist_ok=True)
def ssl(*args):run('openssl',*map(str,args),stdout=subprocess.DEVNULL)
if not (pki/'ca.key').exists():
    ssl('req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-days','365','-sha256',
        '-subj','/CN=Anywhere WAN Test CA','-keyout',pki/'ca.key','-out',etc/'ca.crt',
        '-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign')
if not (etc/'server.crt').exists():
    ssl('req','-new','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-subj','/CN=Anywhere WAN Test',
        '-keyout',pki/'server.key','-out',pki/'server.csr')
    config(pki/'server.ext','basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:10.203.73.2,IP:127.0.0.1,DNS:localhost\n')
    ssl('x509','-req','-in',pki/'server.csr','-CA',etc/'ca.crt','-CAkey',pki/'ca.key','-CAcreateserial',
        '-days','90','-sha256','-extfile',pki/'server.ext','-out',etc/'server.crt')
copy(pki/'server.key',etc/'server.key',0o640);shutil.chown(etc/'server.key','root',appuser)
(etc/'ca.crt').chmod(0o644);(etc/'server.crt').chmod(0o644)
host_config={'host':'10.203.73.2','port':18443,'stateDir':state,'cert':str(etc/'server.crt'),'key':str(etc/'server.key')}
if domain:
    host_config['directTransport'] = True
    wire=tomllib.loads((etc/'network.toml').read_text())
    if wire['secure_mode']['enabled']:
        host_config['windowsNetwork']={'name':wire['network_identity']['network_name'],
                                       'serverKey':wire['secure_mode']['local_public_key']}
config(etc/'host.json',json.dumps(host_config)+'\n')
Path(state).mkdir(mode=0o700,exist_ok=True);shutil.chown(state,appuser,appuser)
common='NoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=yes\nPrivateTmp=yes\nUMask=0077\nRestart=on-failure\nRestartSec=2\n'
config(units/'anywhere-wan-net.service',f'''[Unit]
Description=Anywhere WAN test private EasyTier endpoint
[Service]
Type=exec
User={netuser}
Group={netuser}
PrivateNetwork=yes
StandardOutput=null
StandardError=null
ExecStart={root}/bin/easytier-core --disable-env-parsing --config-file {etc}/network.toml --rpc-portal 127.0.0.1:15897
ExecStartPost=/bin/sh -ec 'for i in $(seq 1 60); do /usr/sbin/ip -4 addr show dev awwan0 2>/dev/null | /bin/grep -q 10.203.73.2/ && exit 0; sleep 0.25; done; exit 1'
AmbientCapabilities=CAP_NET_ADMIN
CapabilityBoundingSet=CAP_NET_ADMIN
DevicePolicy=closed
DeviceAllow=/dev/net/tun rw
MemoryMax=192M
{common}''')
joined='Requires=anywhere-wan-net.service\nAfter=anywhere-wan-net.service\nJoinsNamespaceOf=anywhere-wan-net.service\n'
config(units/'anywhere-wan-host.service',f'''[Unit]
Description=Anywhere WAN authenticated session host (mock CLI)
{joined}[Service]
Type=exec
User={appuser}
Group={appuser}
PrivateNetwork=yes
StateDirectory=anywhere-wan
StateDirectoryMode=0700
Environment=DATA_DIR={state}/auth
ExecStart={node} {release}/server.mjs {etc}/host.json
WorkingDirectory={state}
CapabilityBoundingSet=
MemoryMax=640M
TasksMax=512
{common}''')
wire_host='127.0.0.1' if domain else public
for suffix,listen,target in [('wire',wire_host+':31483','127.0.0.1:31483'),('admin','127.0.0.1:18443','10.203.73.2:18443')]:
    name='anywhere-wan-'+suffix
    config(units/(name+'.socket'),f'[Unit]\nDescription=Anywhere WAN {suffix} listener\n[Socket]\nListenStream={listen}\nNoDelay=true\n')
    config(units/(name+'.service'),f'''[Unit]
Description=Anywhere WAN {suffix} socket proxy
{joined}[Service]
Type=exec
DynamicUser=yes
PrivateNetwork=yes
CapabilityBoundingSet=
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ExecStart=/usr/lib/systemd/systemd-socket-proxyd {target}
''')
run('systemctl','daemon-reload')
run('systemd-analyze','verify',*map(str,units.glob('anywhere-wan-*')))
# Credentials arrive over administrative stdin and are hashed into the isolated account database.
run('runuser','-u',appuser,'--','env','DATA_DIR='+state+'/auth',node,release/'server.mjs',etc/'host.json','--bootstrap')
run('systemctl','start','anywhere-wan-net.service','anywhere-wan-wire.socket','anywhere-wan-admin.socket')
run('systemctl','restart','anywhere-wan-host.service')
print('Installed server release '+release.name)
