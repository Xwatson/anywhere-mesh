import json,os,pwd,grp,subprocess,uuid,shutil
from pathlib import Path

assert os.geteuid()==0 and Path('/etc/anywhere-crossborder-lab').exists()
base=Path('/srv/anywhere-lab/desktop-d2');root=Path('/etc/anywhere-desktop2');runtime='/usr/lib/anywhere-desktop2-runtime/experimental'
def directory(p,user='root',group='root',mode=0o755):
 p.mkdir(parents=True,exist_ok=True);os.chown(p,pwd.getpwnam(user).pw_uid,grp.getgrnam(group).gr_gid);p.chmod(mode)
def save(p,data,group='root',mode=0o640):
 p.write_text(json.dumps(data,indent=2,ensure_ascii=False)+'\n' if not isinstance(data,str) else data);os.chown(p,0,grp.getgrnam(group).gr_gid);p.chmod(mode)
def cmd(*a):subprocess.run(a,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
directory(base);directory(root);directory(base/'projects');directory(base/'host','anywhere-exec-broker','anywhere-exec-broker',0o700)
directory(base/'cache','lab','lab',0o700);directory(base/'shell-profile','lab','lab',0o700);directory(base/'local','lab','lab',0o711)
pki=root/'pki';directory(pki,mode=0o700)
if not (pki/'ca.key').exists():
 cmd('openssl','genpkey','-algorithm','EC','-pkeyopt','ec_paramgen_curve:P-256','-out',str(pki/'ca.key'))
 cmd('openssl','req','-new','-x509','-key',str(pki/'ca.key'),'-sha256','-days','90','-subj','/CN=Anywhere D2 Lab CA','-out',str(pki/'ca.crt'))
for role in ['host','desktop','agent-a','agent-b','unapproved']:
 if not (pki/(role+'.crt')).exists():
  cmd('openssl','genpkey','-algorithm','EC','-pkeyopt','ec_paramgen_curve:P-256','-out',str(pki/(role+'.key')))
  cmd('openssl','req','-new','-key',str(pki/(role+'.key')),'-subj','/CN=anywhere-d2-'+role,'-out',str(pki/(role+'.csr')))
  ext='basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage='+('serverAuth\nsubjectAltName=IP:10.126.10.2\n' if role=='host' else 'clientAuth\n')
  (pki/(role+'.ext')).write_text(ext)
  cmd('openssl','x509','-req','-in',str(pki/(role+'.csr')),'-CA',str(pki/'ca.crt'),'-CAkey',str(pki/'ca.key'),'-CAcreateserial','-out',str(pki/(role+'.crt')),'-days','90','-sha256','-extfile',str(pki/(role+'.ext')))
for p in pki.iterdir():p.chmod(0o600)
for role,group in [('host','anywhere-exec-broker'),('desktop','lab'),('agent-a','anywhere-exec-agent'),('agent-b','anywhere-exec-agent')]:
 d=root/role;directory(d,group=group,mode=0o750)
 for name in [role+'.key',role+'.crt','ca.crt','host.crt']:
  shutil.copyfile(pki/name,d/name);os.chown(d/name,0,grp.getgrnam(group).gr_gid);(d/name).chmod(0o640)
for name in ['desktop.crt','agent-a.crt','agent-b.crt']:
 shutil.copyfile(pki/name,root/'host'/name);os.chown(root/'host'/name,0,grp.getgrnam('anywhere-exec-broker').gr_gid);(root/'host'/name).chmod(0o640)
# A valid CA-signed but unpinned client is only a negative test fixture.
for name in ['unapproved.key','unapproved.crt']:
 shutil.copyfile(pki/name,root/'desktop'/name);os.chown(root/'desktop'/name,0,grp.getgrnam('lab').gr_gid);(root/'desktop'/name).chmod(0o640)
previous=json.loads((root/'catalog.json').read_text()) if (root/'catalog.json').exists() else []
workspaces=[]
for slot,tag,label in [('a','alpha','项目 A · 示例服务'),('b','beta','项目 B · 示例库')]:
 path=base/'projects'/('project-'+tag);directory(path,'anywhere-exec-agent','lab',0o2770)
 existing=next((w for w in previous if w['slot']==slot),None);wid=existing['id'] if existing else str(uuid.uuid4())
 st=path.stat();w={'id':wid,'slot':slot,'label':label,'path':str(path),'dev':str(st.st_dev),'ino':str(st.st_ino),'localSocket':str(base/'local'/slot/'control.sock'),'brokerDir':str(base/'host'/wid)}
 if existing:assert existing['path']==w['path'] and existing['dev']==w['dev'] and existing['ino']==w['ino'],'Root identity changed; explicit reprovision required'
 workspaces.append(w);directory(base/'local'/slot,'anywhere-exec-agent','lab',0o2750);directory(base/'agents'/slot,'anywhere-exec-agent','anywhere-exec-agent',0o700);directory(base/'host'/wid,'anywhere-exec-broker','anywhere-exec-broker',0o700)
 fixtures={'notes.txt':f'PROJECT_{tag.upper()}\n这是 {label} 的独立文件。\n','math.mjs':'export const add=(a,b)=>a+b;\n',
  'build.mjs':f"import{{mkdirSync,copyFileSync}}from'node:fs';mkdirSync('dist',{{recursive:true}});copyFileSync('math.mjs','dist/math.mjs');console.log('BUILD_{tag.upper()}_OK');\n",
  'test.mjs':"import test from 'node:test';import assert from 'node:assert/strict';import {add} from './dist/math.mjs';test('sum',()=>assert.equal(add(2,3),5));test('negative',()=>assert.equal(add(-2,3),1));\n",
  'long.mjs':f"import{{appendFileSync}}from'node:fs';appendFileSync('long.starts','once\\n');let n=0;const t=setInterval(()=>console.log('{tag.upper()} working '+(++n)),500);setTimeout(()=>{{clearInterval(t);console.log('LONG_DONE');}},18000);\n"}
 for name,contents in fixtures.items():
  file=path/name
  if not file.exists():file.write_text(contents);os.chown(file,pwd.getpwnam('anywhere-exec-agent').pw_uid,grp.getgrnam('lab').gr_gid);file.chmod(0o660)
 certDir=root/('agent-'+slot)
 grant={'accountId':'lab-account-d2','deviceId':'lab-cn-d2','workspaceId':wid,'grantVersion':1,'capabilities':[],'revoked':True}
 w['grant']=grant;w['agentCert']=str(root/'host'/('agent-'+slot+'.crt'))
 cfg={'stateDir':str(base/'agents'/slot),'grant':grant,'url':'wss://10.126.10.2:8443/device/'+wid,'key':str(certDir/('agent-'+slot+'.key')),'cert':str(certDir/('agent-'+slot+'.crt')),'ca':str(certDir/'ca.crt'),'peerCert':str(certDir/'host.crt'),'desktop':{'workspaceRoot':str(path),'readOnly':False},'workspace':{'label':label,'controlSocket':w['localSocket'],'reliability':True}}
 save(certDir/'config.json',cfg,'anywhere-exec-agent')
 unit=Path('/etc/systemd/system/anywhere-desktop-agent.service').read_text().replace('/usr/lib/anywhere-desktop-runtime/experimental',runtime).replace('/srv/anywhere-lab/desktop-d/agent',str(base/'agents'/slot)).replace('/srv/anywhere-lab/desktop-d/workspace',str(path)).replace('/srv/anywhere-lab/desktop-d/local',str(base/'local'/slot)).replace('/etc/anywhere-desktop/agent/config.json',str(certDir/'config.json'))
 save(Path('/etc/systemd/system')/f'anywhere-desktop2-agent-{slot}.service',unit,mode=0o644)
save(root/'catalog.json',workspaces,mode=0o644)
host={'stateDir':str(base/'host'),'host':'10.126.10.2','port':8443,'accountId':'lab-account-d2','deviceId':'lab-cn-d2','workspaces':workspaces,'cert':str(root/'host/host.crt'),'key':str(root/'host/host.key'),'ca':str(root/'host/ca.crt'),'desktopCert':str(root/'host/desktop.crt'),'mcpPath':runtime+'/workspace/mcp.mjs'}
save(root/'host/config.json',host,'anywhere-exec-broker')
bridge={'stateDir':str(base/'cache'),'controlSocket':str(base/'local/bridge.sock'),'accountId':host['accountId'],'deviceId':host['deviceId'],'workspaces':workspaces,'url':'https://10.126.10.2:8443','cert':str(root/'desktop/desktop.crt'),'key':str(root/'desktop/desktop.key'),'ca':str(root/'desktop/ca.crt'),'serverCert':str(root/'desktop/host.crt')}
save(root/'desktop/config.json',bridge,'lab')
def service(role,user,namespace,entry,config,write,mem):
 return f'''[Unit]
Description=Anywhere D2 {role} (isolated VM)
After=network.target
[Service]
Type=simple
User={user}
Group={user}
NetworkNamespacePath=/run/anywhere-network/{namespace}.netns
ExecStart=/usr/local/bin/node {runtime}/{entry} {config}
WorkingDirectory={base}
Restart=no
KillMode=control-group
TimeoutStopSec=20
NoNewPrivileges=yes
CapabilityBoundingSet=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths={write}
MemoryMax={mem}
CPUQuota=75%
TasksMax=192
UMask=0077
'''
save(Path('/etc/systemd/system/anywhere-desktop2-host.service'),service('host','anywhere-exec-broker','us','session-host/main.mjs',root/'host/config.json',base/'host','512M'),mode=0o644)
save(Path('/etc/systemd/system/anywhere-desktop2-bridge.service'),service('bridge','lab','cn','desktop-sessions/bridge.mjs',root/'desktop/config.json',str(base/'cache')+' '+str(base/'local'),'256M'),mode=0o644)
ui=Path('/etc/systemd/system/anywhere-desktop-ui.service').read_text().replace('/usr/lib/anywhere-desktop-runtime/experimental/desktop/lab/start-desktop.sh',runtime+'/desktop-sessions/lab/start.sh').replace('/usr/lib/anywhere-desktop-runtime/experimental/desktop/lab/cleanup.sh',runtime+'/desktop-sessions/lab/cleanup.sh').replace('WorkingDirectory=/srv/anywhere-lab/desktop-d','WorkingDirectory='+str(base))
save(Path('/etc/systemd/system/anywhere-desktop2-ui.service'),ui,mode=0o644)
save(Path('/etc/systemd/system/anywhere-desktop2-smoke.service'),ui.replace('/desktop-sessions/lab/start.sh','/desktop-sessions/lab/start.sh --lab-sessions-smoke'),mode=0o644)
save(Path('/etc/systemd/system/anywhere-desktop2-crash-test.service'),ui.replace('/desktop-sessions/lab/start.sh','/desktop-sessions/lab/start.sh --lab-sessions-crash-smoke'),mode=0o644)
