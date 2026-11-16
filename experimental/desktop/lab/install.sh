#!/usr/bin/env bash
set -euo pipefail
source /srv/anywhere-lab/scripts/guest-guard.sh
test "$(id -u)" = 0
base=/srv/anywhere-lab/desktop-d
src=/srv/anywhere-lab/source
runtime=/usr/lib/anywhere-desktop-runtime
vendor=/srv/anywhere-lab/vendor/desktop-commander-0.3.3
for prefix in anywhere-execution anywhere-dc anywhere-workspace anywhere-reliability anywhere-desktop; do
  for role in agent broker; do
    if systemctl is-active --quiet "$prefix-$role.service"; then
      echo "Close the active experiment $prefix-$role before installing." >&2; exit 1
    fi
  done
done
if systemctl is-active --quiet anywhere-desktop-ui.service; then echo 'Close the desktop before installing.' >&2; exit 1; fi
test -x /usr/lib/anywhere-dc/bwrap
test -f "$src/experimental/desktop/dist/index.html"
install -d -o root -g root -m 0755 "$base" "$runtime" "$runtime/experimental" "$runtime/native/linux/network-helper"
for component in execution desktop-commander workspace desktop; do
  install -d -o root -g root -m 0755 "$runtime/experimental/$component"
  find "$src/experimental/$component" -maxdepth 1 -type f \( -name '*.mjs' -o -name '*.cjs' -o -name '*.py' -o -name '*.json' -o -name '*.d.ts' \) -exec install -o root -g root -m 0644 '{}' "$runtime/experimental/$component/" \;
done
install -o root -g root -m 0644 "$src/native/linux/network-helper/client.mjs" "$runtime/native/linux/network-helper/client.mjs"
install -d "$runtime/experimental/execution/node_modules" "$runtime/experimental/desktop/lab"
ln -sfn /usr/lib/anywhere-execution/node_modules/ws "$runtime/experimental/execution/node_modules/ws"
ln -sfn "$vendor" "$runtime/experimental/desktop-commander/vendor"
ln -sfn "$vendor/node_modules" "$runtime/experimental/workspace/node_modules"
ln -sfn "$vendor/node_modules" "$src/experimental/workspace/node_modules"
cp -a "$src/experimental/desktop/dist" "$runtime/experimental/desktop/"
chown -R root:root "$runtime/experimental/desktop/dist"
find "$runtime/experimental/desktop/dist" -type d -exec chmod 0755 '{}' +
find "$runtime/experimental/desktop/dist" -type f -exec chmod 0644 '{}' +
install -o root -g root -m 0644 "$src/experimental/desktop/lab/"*.mjs "$runtime/experimental/desktop/lab/"
install -o root -g root -m 0755 "$src/experimental/desktop/lab/"*.sh "$runtime/experimental/desktop/lab/"
install -d -o anywhere-exec-agent -g anywhere-exec-agent -m 0700 "$base/agent" "$base/workspace"
install -d -o anywhere-exec-broker -g lab -m 0750 "$base/broker"
install -d -o anywhere-exec-agent -g lab -m 2750 "$base/local"
install -d -o lab -g lab -m 0700 "$base/facade" "$base/shell-profile"
python3 - <<'PY'
import json,os,grp,pwd
from pathlib import Path
base=Path('/srv/anywhere-lab/desktop-d');runtime='/usr/lib/anywhere-desktop-runtime/experimental'
for role in ['agent','broker']:
    user='anywhere-exec-'+role;conf=Path('/etc/anywhere-desktop')/role
    conf.mkdir(parents=True,exist_ok=True);os.chown(conf,0,grp.getgrnam(user).gr_gid);conf.chmod(0o750)
    cfg=json.loads((Path('/etc/anywhere-reliability')/role/'config.json').read_text())
    cfg['stateDir']=str(base/role)
    cfg['grant'].update(workspaceId='desktop-d-fixture',capabilities=[],revoked=True)
    cfg['desktop']=dict(workspaceRoot=str(base/'workspace'),readOnly=False)
    cfg['workspace']=dict(label='Linux 示例项目',controlSocket=str(base/'local/control.sock'),reliability=True)
    target=conf/'config.json';target.write_text(json.dumps(cfg,indent=2)+'\n');os.chown(target,0,grp.getgrnam(user).gr_gid);target.chmod(0o640)
    unit=(Path('/etc/systemd/system')/f'anywhere-reliability-{role}.service').read_text()
    unit=unit.replace('Anywhere reliability validation','Anywhere Linux desktop validation')
    unit=unit.replace('/srv/anywhere-lab/reliability-c',str(base)).replace('/usr/lib/anywhere-reliability-runtime',runtime)
    unit=unit.replace(f'/etc/anywhere-reliability/{role}/config.json',str(target))
    (Path('/etc/systemd/system')/f'anywhere-desktop-{role}.service').write_text(unit)
fixtures={
 'notes.txt':'Anywhere Linux 示例项目\n文件留在国内工作区；远端通过 Workspace MCP 请求操作。\n',
 'math.mjs':'export const add = (a, b) => a + b;\n',
 'build.mjs':"import {mkdirSync,copyFileSync} from 'node:fs';mkdirSync('dist',{recursive:true});copyFileSync('math.mjs','dist/math.mjs');console.log('BUILD_OK — dist/math.mjs');\n",
 'test.mjs':"import test from 'node:test';import assert from 'node:assert/strict';import {add} from './dist/math.mjs';test('sum is correct',()=>assert.equal(add(2,3),5));test('negative input',()=>assert.equal(add(-2,3),1));\n",
 'long.mjs':"import {appendFileSync} from 'node:fs';appendFileSync('long.starts','once\\n');let n=0;const timer=setInterval(()=>console.log('working '+(++n)),500);setTimeout(()=>{clearInterval(timer);console.log('LONG_DONE');},20000);\n"
}
for name,text in fixtures.items():
 p=base/'workspace'/name
 if not p.exists():
  p.write_text(text);os.chown(p,pwd.getpwnam('anywhere-exec-agent').pw_uid,grp.getgrnam('anywhere-exec-agent').gr_gid);p.chmod(0o600)
PY
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/anywhere-desktop-{agent,broker}.service
echo 'Installed D runtime with separate workspace, grant history and receipts; no autostart.'
