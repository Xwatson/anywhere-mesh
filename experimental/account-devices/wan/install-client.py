"""Configure a second, independent A/B experiment in the existing Ubuntu build guest."""
import json, os, pwd, shutil, subprocess, sys
from pathlib import Path
from wan_endpoint import endpoint

stage=Path(sys.argv[1]).resolve(); public,domain=endpoint(sys.argv[2])
base=Path('/srv/anywhere-lab/wan')
etc=Path('/etc/anywhere-wan-cn'); units=Path('/etc/systemd/system')
app=Path('/usr/lib/anywhere-d3-runtime/experimental')
shell=Path('/usr/lib/anywhere-wan-desktop/experimental')
source=Path('/srv/anywhere-lab/source/experimental')
assert os.geteuid()==0 and os.uname().nodename=='anywhere-crossborder-lab' and (app/'account-devices/main.mjs').exists()
run=lambda *a,**kw:subprocess.run(a,check=True,**kw)
def directory(p,user='root',group='root',mode=0o755):
    p.mkdir(parents=True,exist_ok=True);shutil.chown(p,user,group);p.chmod(mode)
def put(p,data,mode=0o644):
    p.write_text(data);p.chmod(mode)
def copy(src,dst,mode=0o644):
    shutil.copyfile(src,dst);dst.chmod(mode)
directory(etc);directory(base);directory(base/'local')
if (etc/'network.toml').exists() and (etc/'network.toml').read_bytes()!=(stage/'client.toml').read_bytes():
    raise SystemExit('A different WAN deployment already owns this profile.')
copy(stage/'client.toml',etc/'network.toml',0o600);copy(stage/'ca.crt',etc/'ca.crt')
copy(stage/'server.crt',etc/'server.crt')
copy(source/'account-devices/wan/client-net.sh',etc/'client-net.sh',0o755)
directory(base/'test','lab','lab',0o700)
copy(stage/'accounts.json',base/'test/accounts.json',0o600);shutil.chown(base/'test/accounts.json','lab','lab')
# Net and client units depend only on this disposable container. The original D3 network keeps its own leases.
image='sha256:504c7dee6f93249b73e401a50fbe0b153768bbcf031357a8a13edb71f3060d5b'
container='anywhere-wan-domain-cn' if domain else 'anywhere-wan-cn'
mounts=[]
net_wants=net_pre=''
if domain:
    for module in ['wan_endpoint.py','resolve-peer.py']:
        copy(source/'account-devices/wan'/module,etc/module)
    resolver=f'/usr/bin/python3 {etc}/resolve-peer.py {public}'
    run('/usr/bin/python3',etc/'resolve-peer.py',public)
    mounts=['--env','WAN_PORT=443','-v',str(etc/'peer.hosts')+':/etc/hosts:ro']
    net_pre='ExecStartPre='+resolver+'\n'
    net_wants='Wants=anywhere-wan-peer-dns.timer\n'
    put(units/'anywhere-wan-peer-dns.service',f'''[Unit]
Description=Refresh the WAN relay addresses on the VM
[Service]
Type=oneshot
ExecStart={resolver}
''')
    put(units/'anywhere-wan-peer-dns.timer','''[Unit]
Description=Follow DNS changes for the WAN relay while the test network is running
PartOf=anywhere-wan-cn.service
[Timer]
OnActiveSec=60s
OnUnitActiveSec=60s
AccuracySec=5s
''')
prior=subprocess.run(['docker','inspect','-f','{{index .Config.Labels "anywhere.wan-endpoint"}}',container],
                     capture_output=True,text=True)
if prior.returncode:
    run('docker','create','--pull','never','--name',container,'--label','anywhere.wan-endpoint='+public,
        '--network','bridge','--env','WAN_ENDPOINT='+public,'--read-only','--cap-drop','ALL','--cap-add','NET_ADMIN',
        '--device','/dev/net/tun','--security-opt','no-new-privileges','--pids-limit','96','--memory','192m',
        '--cpus','0.75','--tmpfs','/tmp:size=16m,mode=1777','--log-opt','max-size=3m','--log-opt','max-file=2',
        '--sysctl','net.ipv6.conf.all.disable_ipv6=1','-v',str(etc/'network.toml')+':/etc/wan.toml:ro',
        '-v',str(etc/'client-net.sh')+':/client-net.sh:ro',*mounts,'--entrypoint','/bin/sh',image,'/client-net.sh')
elif prior.stdout.strip()!=public:
    raise SystemExit('WAN container name already in use')
put(etc/'start-net.sh','''#!/bin/sh
set -eu
/usr/bin/docker start @CONTAINER@ >/dev/null
pid=$(/usr/bin/docker inspect -f '{{.State.Pid}}' @CONTAINER@)
test "$pid" -gt 1
ln -sfn "/proc/$pid/ns/net" /run/anywhere-wan-cn/netns
for i in $(seq 1 80); do
  nsenter --net=/run/anywhere-wan-cn/netns ip -4 addr show dev awwan0 2>/dev/null | grep -q 10.203.73.1/ && exit 0
  sleep 0.25
done
exit 1
'''.replace('@CONTAINER@',container),0o755)
put(units/'anywhere-wan-cn.service',f'''[Unit]
Description=Anywhere isolated WAN test network
Requires=docker.service
{net_wants}After=docker.service
[Service]
Type=oneshot
RemainAfterExit=yes
RuntimeDirectory=anywhere-wan-cn
{net_pre}ExecStart={etc}/start-net.sh
ExecStop=/usr/bin/docker stop -t 3 {container}
''')
for mod in ['desktop','account-devices']:
    directory(shell/mod)
for f in ['main.cjs','contract.cjs','package.json']:copy(source/'desktop'/f,shell/'desktop'/f)
for filename in ['main.mjs','controller.mjs']:
    copy(source/'account-devices'/filename,shell/'account-devices'/filename)
directory(shell/'account-devices/lab')
copy(source/'account-devices/lab/gui.mjs',shell/'account-devices/lab/gui.mjs')
run(sys.executable, str(source/'account-devices/wan/install-ui.py'), str(source/'account-devices/ui'))
preload=shell/'account-devices/preload.cjs'
if not preload.exists():preload.symlink_to(app/'account-devices/preload.cjs')
for module in ['execution','desktop-commander']:
    if not (shell/module).exists():(shell/module).symlink_to(app/module)
for slot in ('a','b'):
    user='anywhere-wan-'+slot
    try:pwd.getpwnam(user)
    except KeyError:run('useradd','--system','--user-group','--no-create-home','--shell','/usr/sbin/nologin',user)
    directory(base/slot,user,user,0o700);directory(base/'local'/slot,user,'lab',0o2750)
    directory(base/('shell-'+slot),'lab','lab',0o700)
    project=base/('project-'+slot);directory(project,user,user,0o700)
    note=project/'notes.txt'
    if not note.exists():put(note,'ONLY_DEVICE_'+slot.upper()+'\n',0o600);shutil.chown(note,user,user)
    put(etc/(slot+'.json'),json.dumps({'stateDir':str(base/slot),'name':'设备 '+slot.upper(),
        'url':'https://10.203.73.2:18443','ca':str(etc/'ca.crt'),'controlSocket':str(base/'local'/slot/'control.sock'),
        'projects':[{'label':'跨主机测试项目','path':str(project)}]},ensure_ascii=False)+'\n')
    put(units/f'anywhere-wan-client-{slot}.service',f'''[Unit]
Description=Anywhere WAN test client {slot.upper()}
Requires=anywhere-wan-cn.service
After=anywhere-wan-cn.service
[Service]
Type=notify
NotifyAccess=all
User={user}
Group={user}
SupplementaryGroups=anywhere-exec-agent
NetworkNamespacePath=/run/anywhere-wan-cn/netns
ExecStart=/usr/bin/flock --nonblock --no-fork {base}/{slot}/process.lock /usr/local/bin/node {shell}/account-devices/main.mjs client {etc}/{slot}.json
WorkingDirectory={base}
KillMode=control-group
NoNewPrivileges=yes
CapabilityBoundingSet=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths={base}/{slot} {base}/local/{slot} {project}
MemoryMax=640M
TasksMax=180
UMask=0077
''')
    put(units/f'anywhere-wan-ui-{slot}.service',f'''[Unit]
Description=Anywhere desktop on real WAN test service ({slot.upper()})
Requires=anywhere-desktop-display.service anywhere-wan-client-{slot}.service
After=anywhere-desktop-display.service anywhere-wan-client-{slot}.service
[Service]
User=lab
Group=lab
Environment=DISPLAY=:0
Environment=XAUTHORITY=/srv/anywhere-lab/desktop-d/display.Xauthority
Environment=LANG=zh_CN.UTF-8
WorkingDirectory={base}
ExecStart=/usr/bin/dbus-run-session /usr/lib/anywhere-desktop-electron/electron --disable-setuid-sandbox {shell}/desktop --lab-device={slot} --lab-wan
UMask=0077
''')
run('systemctl','daemon-reload')
run('systemd-analyze','verify',*map(str,units.glob('anywhere-wan-*.service')))
run('systemctl','start','anywhere-wan-client-a','anywhere-wan-client-b')
