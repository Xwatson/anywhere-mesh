#!/usr/bin/env bash
set -euo pipefail
source /srv/anywhere-lab/scripts/guest-guard.sh
test "$(id -u)" = 0
for unit in anywhere-desktop-ui anywhere-desktop-agent anywhere-desktop-broker anywhere-desktop2-ui anywhere-desktop2-smoke anywhere-desktop2-crash-test anywhere-desktop2-host anywhere-desktop2-bridge anywhere-desktop2-agent-a anywhere-desktop2-agent-b anywhere-reliability-agent anywhere-workspace-agent; do
  if systemctl is-active --quiet "$unit"; then echo "Close experiment $unit before installation." >&2; exit 1; fi
done
src=/srv/anywhere-lab/source
runtime=/usr/lib/anywhere-desktop2-runtime
vendor=/srv/anywhere-lab/vendor/desktop-commander-0.3.3
test -f "$src/experimental/desktop-sessions/dist/index.html"
test -x /usr/lib/anywhere-desktop-electron/electron
for component in execution desktop-commander workspace desktop session-host desktop-sessions; do
  install -d -m 0755 "$runtime/experimental/$component"
  find "$src/experimental/$component" -maxdepth 1 -type f \( -name '*.mjs' -o -name '*.cjs' -o -name '*.py' -o -name '*.json' -o -name '*.d.ts' \) -exec install -o root -g root -m 0644 '{}' "$runtime/experimental/$component/" \;
done
install -d "$runtime/experimental/execution/node_modules" "$runtime/experimental/desktop-sessions/lab" "$runtime/native/linux/network-helper"
ln -sfn /usr/lib/anywhere-execution/node_modules/ws "$runtime/experimental/execution/node_modules/ws"
install -d "$src/experimental/execution/node_modules"
ln -sfn /usr/lib/anywhere-execution/node_modules/ws "$src/experimental/execution/node_modules/ws"
ln -sfn "$vendor/node_modules" "$runtime/experimental/workspace/node_modules"
ln -sfn "$vendor" "$runtime/experimental/desktop-commander/vendor"
install -m 0644 "$src/native/linux/network-helper/client.mjs" "$runtime/native/linux/network-helper/client.mjs"
install -m 0644 "$src/experimental/desktop-sessions/lab/"*.mjs "$runtime/experimental/desktop-sessions/lab/"
install -m 0755 "$src/experimental/desktop-sessions/lab/"*.sh "$runtime/experimental/desktop-sessions/lab/"
cp -a "$src/experimental/desktop-sessions/dist" "$runtime/experimental/desktop-sessions/"
chown -R root:root "$runtime"
find "$runtime/experimental/desktop-sessions/dist" -type d -exec chmod 0755 '{}' +
find "$runtime/experimental/desktop-sessions/dist" -type f -exec chmod 0644 '{}' +
python3 "$src/experimental/desktop-sessions/lab/provision.py"
systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/anywhere-desktop2-{host,bridge,agent-a,agent-b,ui,smoke,crash-test}.service
echo 'D2 installed with separate identities, two approved project roots and isolated session host.'
