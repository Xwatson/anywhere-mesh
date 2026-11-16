#!/usr/bin/env bash
set -euo pipefail
source /srv/anywhere-lab/scripts/guest-guard.sh
test "$(id -u)" = 0
base=/srv/anywhere-lab/reliability-c
src=/srv/anywhere-lab/source/experimental
runtime=/usr/lib/anywhere-reliability-runtime
vendor=/srv/anywhere-lab/vendor/desktop-commander-0.3.3
for prefix in anywhere-execution anywhere-dc anywhere-workspace anywhere-reliability; do
  for role in agent broker; do
    if systemctl is-active --quiet "$prefix-$role.service"; then
      echo "Stop the active experiment $prefix-$role through its lifecycle first." >&2; exit 1
    fi
  done
done
test -x /usr/lib/anywhere-dc/bwrap
install -d -o root -g root -m 0755 "$base" "$runtime" "$runtime/execution" "$runtime/desktop-commander" "$runtime/workspace"
install -o root -g root -m 0644 "$src/execution/"*.mjs "$runtime/execution/"
install -o root -g root -m 0644 "$src/desktop-commander/"*.mjs "$src/desktop-commander/"*.py "$runtime/desktop-commander/"
install -o root -g root -m 0644 "$src/workspace/"*.mjs "$src/workspace/"*.json "$src/workspace/"*.d.ts "$runtime/workspace/"
install -d "$runtime/execution/node_modules"
ln -sfn /usr/lib/anywhere-execution/node_modules/ws "$runtime/execution/node_modules/ws"
ln -sfn "$vendor" "$runtime/desktop-commander/vendor"
ln -sfn "$vendor/node_modules" "$runtime/workspace/node_modules"
ln -sfn "$vendor/node_modules" "$src/workspace/node_modules"
ln -sfn "$vendor/node_modules" "$src/reliability/node_modules"
install -d -o anywhere-exec-agent -g anywhere-exec-agent -m 0700 "$base/agent" "$base/workspace"
install -d -o anywhere-exec-broker -g lab -m 0750 "$base/broker"
install -d -o anywhere-exec-agent -g lab -m 2750 "$base/local"
install -d -o lab -g lab -m 0700 "$base/facade"
python3 - <<'PY'
import json,os,grp
from pathlib import Path
base=Path('/srv/anywhere-lab/reliability-c')
for role in ['agent','broker']:
    user='anywhere-exec-'+role;conf=Path('/etc/anywhere-reliability')/role
    conf.mkdir(parents=True,exist_ok=True);os.chown(conf,0,grp.getgrnam(user).gr_gid);conf.chmod(0o750)
    cfg=json.loads((Path('/etc/anywhere-execution')/role/'config.json').read_text())
    cfg['stateDir']=str(base/role)
    cfg['grant'].update(workspaceId='reliability-c-fixture',capabilities=[],revoked=True)
    cfg['desktop']=dict(workspaceRoot=str(base/'workspace'),readOnly=False)
    cfg['workspace']=dict(label='Anywhere 可靠性实验',controlSocket=str(base/'local/control.sock'),reliability=True)
    target=conf/'config.json';target.write_text(json.dumps(cfg,indent=2)+'\n');os.chown(target,0,grp.getgrnam(user).gr_gid);target.chmod(0o640)
    unit=(Path('/etc/systemd/system')/f'anywhere-workspace-{role}.service').read_text()
    unit=unit.replace('Anywhere Workspace MCP validation','Anywhere reliability validation')
    unit=unit.replace('/srv/anywhere-lab/workspace-b2',str(base)).replace('/usr/lib/anywhere-workspace-runtime','/usr/lib/anywhere-reliability-runtime')
    unit=unit.replace(f'/etc/anywhere-workspace/{role}/config.json',str(target))
    (Path('/etc/systemd/system')/f'anywhere-reliability-{role}.service').write_text(unit)
PY
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/anywhere-reliability-{agent,broker}.service
echo 'Installed isolated reliability runtime; prior experiment states remain untouched.'
