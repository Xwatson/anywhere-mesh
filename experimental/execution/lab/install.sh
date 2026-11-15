#!/usr/bin/env bash
set -euo pipefail
source /srv/anywhere-lab/scripts/guest-guard.sh
test "$(id -u)" = 0
base=/srv/anywhere-lab/execution-b
source_dir=/srv/anywhere-lab/source/experimental/execution
for role in agent broker; do
  user=anywhere-exec-$role
  getent group "$user" >/dev/null || groupadd --system "$user"
  id "$user" >/dev/null 2>&1 || useradd --system --gid "$user" --no-create-home --shell /usr/sbin/nologin "$user"
  if systemctl cat "anywhere-execution-$role.service" >/dev/null 2>&1; then
    systemctl stop "anywhere-execution-$role.service"
  fi
done
install -d -o root -g root -m 0755 "$base" /etc/anywhere-execution
install -d -o anywhere-exec-agent -g anywhere-exec-agent -m 0700 "$base/agent"
install -d -o anywhere-exec-broker -g lab -m 0750 "$base/broker"
# Install only this module and its pinned WS dependency, not the development
# source tree (which also contains the independent web lab's private config).
install -d -o root -g root -m 0755 /usr/lib/anywhere-execution/node_modules/ws
install -o root -g root -m 0644 "$source_dir"/*.mjs "$source_dir/package.json" /usr/lib/anywhere-execution/
cp -a /srv/anywhere-lab/source/node_modules/ws/. /usr/lib/anywhere-execution/node_modules/ws/
chown -R root:root /usr/lib/anywhere-execution
find /usr/lib/anywhere-execution -type d -exec chmod 0755 {} +
find /usr/lib/anywhere-execution -type f -exec chmod 0644 {} +
# Installed code and dependencies are read-only under ProtectSystem=strict.
# The business users receive no network capabilities or Docker/helper access.
python3 - <<'PY'
import json,os,pwd,grp,shutil
from pathlib import Path
base=Path('/srv/anywhere-lab/execution-b')
fixture=Path('/srv/anywhere-lab/helper-a/config/topology/runtime')
grant=dict(accountId='lab-account',deviceId='lab-cn',workspaceId='lab-workspace',grantVersion=1,capabilities=['mock.task'])
for role,end,peer in [('agent','cn','us'),('broker','us','cn')]:
    user='anywhere-exec-'+role
    conf=Path('/etc/anywhere-execution')/role
    conf.mkdir(exist_ok=True);os.chown(conf,0,grp.getgrnam(user).gr_gid);conf.chmod(0o750)
    for src,dest in [('ca.crt','ca.crt'),(end+'.crt','self.crt'),(end+'.key','self.key'),(peer+'.crt','peer.crt')]:
        target=conf/dest;shutil.copyfile(fixture/src,target)
        os.chown(target,0,grp.getgrnam(user).gr_gid);target.chmod(0o640)
    cfg=dict(stateDir=str(base/role),grant=grant,cert=str(conf/'self.crt'),key=str(conf/'self.key'),
             ca=str(conf/'ca.crt'),peerCert=str(conf/'peer.crt'))
    if role=='agent':cfg['url']='wss://10.126.10.2:8443/device'
    else:cfg.update(host='10.126.10.2',port=8443)
    target=conf/'config.json';target.write_text(json.dumps(cfg,indent=2)+'\n')
    os.chown(target,0,grp.getgrnam(user).gr_gid);target.chmod(0o640)
    ns='cn' if role=='agent' else 'us'
    group=user if role=='agent' else 'lab'
    # Supplementary group lets the broker read its own root-protected key.
    unit=f'''[Unit]
Description=Anywhere stage B mock {role} (isolated VM only)
After=network.target

[Service]
Type=simple
User={user}
Group={group}
SupplementaryGroups={user}
NetworkNamespacePath=/run/anywhere-network/{ns}.netns
ExecStart=/usr/bin/flock --nonblock --no-fork {base}/{role}/process.lock /usr/local/bin/node /usr/lib/anywhere-execution/main.mjs {role} {conf}/config.json
WorkingDirectory={base}/{role}
KillMode=control-group
Restart=no
TimeoutStopSec=8
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
LockPersonality=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ReadWritePaths={base}/{role}
MemoryMax=256M
CPUQuota=50%
TasksMax=64
LimitNOFILE=512
LimitCORE=0
UMask=0077
'''
    Path('/etc/systemd/system/anywhere-execution-'+role+'.service').write_text(unit)
PY
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/anywhere-execution-{agent,broker}.service
echo 'Installed stage B services (not started/enabled); integration owns the test lifecycle.'
