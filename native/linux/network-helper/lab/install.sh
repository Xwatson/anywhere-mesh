#!/usr/bin/env bash
set -euo pipefail
source /srv/anywhere-lab/scripts/guest-guard.sh
test "$(id -u)" = 0
source_dir=/srv/anywhere-lab/source/native/linux/network-helper
fixture=/srv/anywhere-lab/helper-a/config/topology
test -f "$fixture/compose.yaml"
# These accounts and services exist only in the isolated Ubuntu guest.
getent group anywhere-net >/dev/null || groupadd --system anywhere-net
getent group anywhere-net-clients >/dev/null || groupadd --system anywhere-net-clients
id anywhere-net >/dev/null 2>&1 || useradd --system --gid anywhere-net --no-create-home --shell /usr/sbin/nologin anywhere-net
usermod -aG anywhere-net-clients lab
export HELPER_UID
HELPER_UID=$(id -u anywhere-net)
test "$HELPER_UID" -gt 0
test "$HELPER_UID" != "$(id -u lab)"
for unit in anywhere-network@cn.socket anywhere-network@us.socket anywhere-network@cn.service anywhere-network@us.service; do
  if systemctl cat "$unit" >/dev/null 2>&1; then systemctl stop "$unit"; fi
done
install -d -o root -g root -m 0755 /usr/lib/anywhere-network /run/anywhere-network
install -d -o root -g anywhere-net -m 0750 /etc/anywhere-network
install -o root -g root -m 0644 "$source_dir/helper.py" /usr/lib/anywhere-network/helper.py
install -o root -g root -m 0644 "$source_dir/anywhere-network@.service" "$source_dir/anywhere-network@.socket" /etc/systemd/system/
install -d -o root -g root -m 0755 /usr/share/doc/anywhere-network
install -o root -g root -m 0644 "$source_dir"/licenses/*.txt /usr/share/doc/anywhere-network/
for binary in easytier-core easytier-cli; do
  install -o root -g root -m 0755 "/srv/anywhere-lab/config/topology/easytier/$binary" "/usr/lib/anywhere-network/$binary"
done
cd /usr/lib/anywhere-network
sha256sum -c <<'EOF'
35b854e0c5853c02733870488c977200f6aa06d09c08d5dc7f9f9e150e7be8d5  easytier-core
8da66644ec50dcf618fccf76780991f52dfbe2939797abc0efe0ef4d4c4d3383  easytier-cli
EOF
cd "$fixture"
docker compose --project-name anywhere-helper --env-file /dev/null up -d --no-build --pull never
for role in cn us; do
  install -o root -g anywhere-net -m 0640 "$fixture/runtime/$role.toml" "/etc/anywhere-network/$role.toml"
  container_pid=$(docker inspect -f '{{.State.Pid}}' "anywhere-helper-$role-1")
  test "$container_pid" -gt 1
  ln -sfn "/proc/$container_pid/ns/net" "/run/anywhere-network/$role.netns"
done
python3 - <<'PY'
import hashlib,json,pwd,grp,os
from pathlib import Path
for role,last in [('cn','1'),('us','2')]:
    p={'version':1,'allowed_uids':[pwd.getpwnam('lab').pw_uid],
       'core':'/usr/lib/anywhere-network/easytier-core','cli':'/usr/lib/anywhere-network/easytier-cli',
       'config':f'/etc/anywhere-network/{role}.toml','interface':'awtun',
       'virtual_ip':'10.126.10.'+last,'relay_hostname':'relay-helper-lab',
       'lease_seconds':10,'probe_seconds':1,'restart_limit':3,'restart_window_seconds':60}
    for key in ['core','cli','config']:
        p[key+'_sha256']=hashlib.sha256(Path(p[key]).read_bytes()).hexdigest()
    out=Path(f'/etc/anywhere-network/{role}.json')
    out.write_text(json.dumps(p,indent=2)+'\n')
    os.chown(out,0,grp.getgrnam('anywhere-net').gr_gid);out.chmod(0o640)
PY
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/anywhere-network@.service /etc/systemd/system/anywhere-network@.socket
systemctl reset-failed anywhere-network@cn.service anywhere-network@us.service 2>/dev/null || true
systemctl start anywhere-network@cn.socket anywhere-network@us.socket
echo 'Helper sockets ready. No tunnel starts until an authorized client acquires a lease.'
