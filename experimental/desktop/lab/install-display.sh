#!/usr/bin/env bash
set -euo pipefail
source /srv/anywhere-lab/scripts/guest-guard.sh
test "$(id -u)" = 0
auth=/srv/anywhere-lab/desktop-d/display.Xauthority
if test ! -f "$auth"; then
  touch "$auth"
  chmod 0600 "$auth"
  python3 - <<'PY'
import secrets,subprocess
subprocess.run(['xauth','-f','/srv/anywhere-lab/desktop-d/display.Xauthority','add',':0','.',secrets.token_hex(16)],check=True,stdout=subprocess.DEVNULL)
PY
  chown lab:lab "$auth"
fi
cat >/etc/systemd/system/anywhere-desktop-display.service <<'EOF'
[Unit]
Description=Isolated VM display for Anywhere Desktop
After=systemd-user-sessions.service
[Service]
Type=simple
ExecStart=/usr/lib/xorg/Xorg :0 vt7 -auth /srv/anywhere-lab/desktop-d/display.Xauthority -nolisten tcp -noreset
Restart=no
StandardOutput=journal
StandardError=journal
EOF
cat >/etc/systemd/system/anywhere-desktop-ui.service <<'EOF'
[Unit]
Description=Anywhere Linux desktop experiment
Requires=anywhere-desktop-display.service
After=anywhere-desktop-display.service
[Service]
Type=simple
User=lab
Group=lab
Environment=DISPLAY=:0
Environment=XAUTHORITY=/srv/anywhere-lab/desktop-d/display.Xauthority
Environment=LANG=zh_CN.UTF-8
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/dbus-run-session /usr/lib/anywhere-desktop-runtime/experimental/desktop/lab/start-desktop.sh
ExecStopPost=+/usr/lib/anywhere-desktop-runtime/experimental/desktop/lab/cleanup.sh
WorkingDirectory=/srv/anywhere-lab/desktop-d
Restart=no
TimeoutStopSec=60
KillMode=control-group
UMask=0077
MemoryMax=1G
TasksMax=256
EOF
python3 - <<'PY'
from pathlib import Path
unit=Path('/etc/systemd/system/anywhere-desktop-ui.service').read_text()
Path('/etc/systemd/system/anywhere-desktop-ui-smoke.service').write_text(unit.replace(
 'ExecStart=/usr/bin/dbus-run-session /usr/lib/anywhere-desktop-runtime/experimental/desktop/lab/start-desktop.sh',
 'ExecStart=/usr/bin/dbus-run-session /usr/lib/anywhere-desktop-runtime/experimental/desktop/lab/start-desktop.sh --lab-smoke'))
unit=unit.replace('Anywhere Linux desktop experiment','Anywhere desktop intentional crash validation')
unit=unit.replace('ExecStart=/usr/bin/dbus-run-session /usr/lib/anywhere-desktop-runtime/experimental/desktop/lab/start-desktop.sh',
 'ExecStart=/usr/bin/dbus-run-session /usr/lib/anywhere-desktop-electron/electron --disable-setuid-sandbox /usr/lib/anywhere-desktop-runtime/experimental/desktop --lab-crash-smoke')
Path('/etc/systemd/system/anywhere-desktop-crash-test.service').write_text(unit)
PY
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/anywhere-desktop-{display,ui}.service
echo 'Display and UI launch units installed; neither enabled for autostart.'
