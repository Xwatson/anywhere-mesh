"""Install only inside the isolated fnOS Ubuntu guest; retain identities and journals between runs."""
import json, os, pwd, secrets, shutil, subprocess
from pathlib import Path

root = Path('/srv/anywhere-lab/d3')
src = Path('/srv/anywhere-lab/source')
runtime = Path('/usr/lib/anywhere-d3-runtime')
etc = Path('/etc/anywhere-d3')
units = Path('/etc/systemd/system')
prior = Path('/usr/lib/anywhere-desktop2-runtime')
assert os.geteuid() == 0 and os.uname().nodename == 'anywhere-crossborder-lab'
assert Path('/etc/anywhere-crossborder-lab').exists() and (prior/'experimental/workspace/mcp.mjs').is_file()
def run(*args):
    subprocess.run(args, check=True)
def directory(p, user='root', group='root', mode=0o755):
    p.mkdir(parents=True,exist_ok=True)
    shutil.chown(p,user,group)
    p.chmod(mode)
def save(p,data,mode=0o644):
    p.write_text(data if isinstance(data,str) else json.dumps(data,ensure_ascii=False,indent=2)+'\n')
    p.chmod(mode)
def copy(source,target):
    directory(target.parent)
    shutil.copyfile(source,target)
    target.chmod(0o644)
def link(source,target):
    if target.is_symlink() and target.resolve()==source.resolve(): return
    target.symlink_to(source,target_is_directory=True)

for unit in ['host','client-a','client-b','ui-a','ui-b','network']:
    if subprocess.run(['systemctl','is-active','--quiet','anywhere-d3-'+unit]).returncode==0:
        raise SystemExit('Close the D3 lab before updating its runtime: '+unit)
directory(root); directory(etc); directory(runtime/'experimental')
for module in ['workspace','desktop-commander','execution']:
    link(prior/'experimental'/module,runtime/'experimental'/module)
for module in ['session-host','account-devices','desktop']:
    for p in (src/'experimental'/module).glob('*'):
        if p.is_file() and p.suffix in ['.cjs','.mjs','.json']:
            copy(p,runtime/'experimental'/module/p.name)
for p in (src/'experimental/account-devices/ui').iterdir():
    copy(p,runtime/'experimental/account-devices/ui'/p.name)
for p in (src/'experimental/account-devices/lab').glob('*.mjs'):
    copy(p,runtime/'experimental/account-devices/lab'/p.name)
copy(src/'native/linux/network-helper/client.mjs',runtime/'native/linux/network-helper/client.mjs')
for f in ['auth','db','config']:
    copy(src/('server/dist/'+f+'.js'),runtime/('server/dist/'+f+'.js'))
copy(src/'server/package.json',runtime/'server/package.json')
directory(root/'host','anywhere-exec-broker','anywhere-exec-broker',0o700)
directory(root/'test','lab','lab',0o700)
credentials=root/'test/accounts.json'
if not credentials.exists():
    users=[{'username':name,'password':secrets.token_urlsafe(24)} for name in ['lab-admin','lab-coder','lab-other']]
    with open(credentials,'x',opener=lambda path,flags: os.open(path,flags,0o600)) as f:
        json.dump(users,f)
    shutil.chown(credentials,'lab','lab')
subprocess.run(['runuser','-u','anywhere-exec-broker','--','env','DATA_DIR='+str(root/'host/auth'),
                '/usr/local/bin/node',str(runtime/'experimental/account-devices/lab/seed.mjs')],
               input=credentials.read_bytes(),check=True)
directory(root/'local')
for slot in ['a','b']:
    user='anywhere-d3-'+slot
    try: pwd.getpwnam(user)
    except KeyError: run('useradd','--system','--user-group','--no-create-home','--shell','/usr/sbin/nologin',user)
    directory(root/slot,user,user,0o700)
    directory(root/'local'/slot,user,'lab',0o2750)
    directory(root/('shell-'+slot),'lab','lab',0o700)
    project=root/('project-'+slot)
    directory(project,user,user,0o700)
    note=project/'notes.txt'
    if not note.exists():
        save(note,'ONLY_DEVICE_'+slot.upper()+'\n',0o600);shutil.chown(note,user,user)
    save(etc/(slot+'.json'),{'stateDir':str(root/slot),'name':'设备 '+slot.upper(),
         'url':'https://10.126.10.2:8443','ca':'/etc/anywhere-d3/ca.crt',
         'controlSocket':str(root/'local'/slot/'control.sock'),'projects':[{'label':'示例项目','path':str(project)}]})
# This CA authenticates the server. A fresh client needs only the public CA and its account login.
copy(Path('/etc/anywhere-desktop2/desktop/ca.crt'),etc/'ca.crt')
server={'host':'10.126.10.2','port':8443,'stateDir':str(root/'host'),
        'cert':'/etc/anywhere-desktop2/host/host.crt','key':'/etc/anywhere-desktop2/host/host.key',
        'mcpPath':str((runtime/'experimental/workspace/mcp.mjs').resolve())}
save(etc/'host.json',server)
module=runtime/'experimental/account-devices'
def service(name,user,ns,cmd,write,extra=''):
    save(units/('anywhere-d3-'+name+'.service'),f'''[Unit]
Description=Anywhere account MCP lab {name}
Requires=anywhere-d3-network.service
After=anywhere-d3-network.service
[Service]
Type=notify
NotifyAccess=all
User={user}
Group={user}
NetworkNamespacePath=/run/anywhere-network/{ns}.netns
ExecStart={cmd}
WorkingDirectory={root}
KillMode=control-group
TimeoutStopSec=18
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
CapabilityBoundingSet=
PrivateTmp=yes
ReadWritePaths={write}
UMask=0077
MemoryMax=640M
TasksMax=180
{extra}
''')
service('host','anywhere-exec-broker','us',f'/usr/local/bin/node {module}/main.mjs server {etc}/host.json',root/'host',
        f'Environment=DATA_DIR={root}/host/auth')
for slot in ['a','b']:
    user='anywhere-d3-'+slot
    service('client-'+slot,user,'cn',f'/usr/bin/flock --nonblock --no-fork {root}/{slot}/process.lock /usr/local/bin/node {module}/main.mjs client {etc}/{slot}.json',
            f'{root}/{slot} {root}/local/{slot} {root}/project-{slot}','SupplementaryGroups=anywhere-exec-agent')
    save(units/f'anywhere-d3-ui-{slot}.service',f'''[Unit]
Description=Anywhere Linux desktop device {slot.upper()}
Requires=anywhere-desktop-display.service anywhere-d3-client-{slot}.service
Wants=anywhere-d3-host.service
After=anywhere-desktop-display.service anywhere-d3-client-{slot}.service anywhere-d3-host.service
[Service]
User=lab
Group=lab
Environment=DISPLAY=:0
Environment=XAUTHORITY=/srv/anywhere-lab/desktop-d/display.Xauthority
Environment=LANG=zh_CN.UTF-8
WorkingDirectory={root}
ExecStart=/usr/bin/dbus-run-session /usr/lib/anywhere-desktop-electron/electron --disable-setuid-sandbox {runtime}/experimental/desktop --lab-device={slot}
KillMode=control-group
UMask=0077
''')
save(units/'anywhere-d3-network.service',f'''[Unit]
Description=Anywhere D3 isolated network leases
Conflicts=anywhere-desktop2-ui.service anywhere-desktop2-host.service
After=anywhere-network@cn.socket anywhere-network@us.socket
Requires=anywhere-network@cn.socket anywhere-network@us.socket
[Service]
Type=notify
NotifyAccess=all
User=lab
Group=lab
ExecStartPre=/usr/bin/docker stop -t 2 anywhere-helper-us-mock-1
ExecStart=/usr/local/bin/node {module}/lab/leases.mjs
ExecStopPost=/usr/bin/docker start anywhere-helper-us-mock-1
TimeoutStartSec=40
TimeoutStopSec=15
''')
run('systemctl','daemon-reload')
run('systemd-analyze','verify',*map(str,units.glob('anywhere-d3-*.service')))
