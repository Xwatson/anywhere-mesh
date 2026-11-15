#!/usr/bin/env bash
set -euo pipefail
source /srv/anywhere-lab/scripts/guest-guard.sh
test "$(id -u)" = 0
base=/srv/anywhere-lab/desktop-c
src=/srv/anywhere-lab/source/experimental
runtime=/usr/lib/anywhere-dc-runtime
vendor=/srv/anywhere-lab/vendor/desktop-commander-0.3.3
for role in agent broker; do
  if systemctl is-active --quiet "anywhere-execution-$role.service"; then
    echo 'Stage B1 must be idle before installing the separate DC experiment.' >&2; exit 1
  fi
  if systemctl is-active --quiet "anywhere-dc-$role.service"; then
    echo 'DC experiment is active; stop it through its test lifecycle first.' >&2; exit 1
  fi
done
test -x /usr/bin/rg
test -f "$vendor/package-lock.json"
install -d -o root -g root -m 0755 "$base" "$runtime" "$runtime/execution" "$runtime/desktop-commander" /usr/lib/anywhere-dc
install -o root -g anywhere-exec-agent -m 0750 /usr/bin/bwrap /usr/lib/anywhere-dc/bwrap
install -o root -g root -m 0644 "$src/desktop-commander/lab/anywhere-dc-bwrap.apparmor" /etc/apparmor.d/anywhere-dc-bwrap
apparmor_parser -r /etc/apparmor.d/anywhere-dc-bwrap
install -o root -g root -m 0644 "$src/execution/"*.mjs "$runtime/execution/"
install -o root -g root -m 0644 "$src/desktop-commander/"*.mjs "$runtime/desktop-commander/"
install -d "$runtime/execution/node_modules"
ln -sfn /usr/lib/anywhere-execution/node_modules/ws "$runtime/execution/node_modules/ws"
ln -sfn "$vendor" "$runtime/desktop-commander/vendor"
python3 "$src/desktop-commander/lab/patch-vendor.py" "$vendor" > "$base/vendor-patches.next.json"
mv "$base/vendor-patches.next.json" "$base/vendor-patches.json"
chown -R root:root "$vendor"
chmod -R a+rX,go-w "$vendor"
install -d -o anywhere-exec-agent -g anywhere-exec-agent -m 0700 "$base/agent"
install -d -o anywhere-exec-broker -g lab -m 0750 "$base/broker"
# Root owns the parent; tasks may modify contents, not replace the mounted root.
install -d -o anywhere-exec-agent -g anywhere-exec-agent -m 0700 "$base/workspace"
python3 - <<'PY'
import json,os,grp
from pathlib import Path
base=Path('/srv/anywhere-lab/desktop-c')
for role in ['agent','broker']:
    user='anywhere-exec-'+role
    conf=Path('/etc/anywhere-dc')/role
    conf.mkdir(parents=True,exist_ok=True)
    os.chown(conf,0,grp.getgrnam(user).gr_gid);conf.chmod(0o750)
    cfg=json.loads((Path('/etc/anywhere-execution')/role/'config.json').read_text())
    cfg['stateDir']=str(base/role)
    cfg['grant']['workspaceId']='desktop-commander-fixture'
    cfg['grant']['capabilities']=['dc.tool','dc.run','dc.search','dc.inspect','workspace.exec','workspace.write']
    cfg['desktop']=dict(workspaceRoot=str(base/'workspace'),readOnly=False)
    target=conf/'config.json';target.write_text(json.dumps(cfg,indent=2)+'\n')
    os.chown(target,0,grp.getgrnam(user).gr_gid);target.chmod(0o640)
    unit=(Path('/etc/systemd/system')/f'anywhere-execution-{role}.service').read_text()
    unit=unit.replace('Anywhere stage B mock','Anywhere Desktop Commander validation')
    unit=unit.replace('/srv/anywhere-lab/execution-b',str(base))
    unit=unit.replace('/usr/lib/anywhere-execution/main.mjs','/usr/lib/anywhere-dc-runtime/execution/main.mjs')
    unit=unit.replace(f'/etc/anywhere-execution/{role}/config.json',str(target))
    unit=unit.replace('MemoryMax=256M','MemoryMax=768M').replace('CPUQuota=50%','CPUQuota=75%').replace('TasksMax=64','TasksMax=128')
    if role=='agent':
        unit=unit.replace(f'ReadWritePaths={base}/agent',f'ReadWritePaths={base}/agent {base}/workspace')
        # bwrap needs a netlink socket to bring up loopback in its NEW network
        # namespace. The outer agent still has zero network capabilities.
        unit=unit.replace('RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6','RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK')
        # systemd's masked /proc mounts prevent an unprivileged child userns
        # mounting its own PID-scoped proc. DAC, NNP and zero host capabilities
        # still prohibit this UID from changing host kernel tunables.
        unit=unit.replace('ProtectKernelTunables=yes','ProtectKernelTunables=no')
    (Path('/etc/systemd/system')/f'anywhere-dc-{role}.service').write_text(unit)
PY
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/anywhere-dc-{agent,broker}.service
echo 'Installed separate DC experiment; services remain stopped and disabled.'
