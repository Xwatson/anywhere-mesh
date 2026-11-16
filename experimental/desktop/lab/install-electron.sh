#!/usr/bin/env bash
set -euo pipefail
source /srv/anywhere-lab/scripts/guest-guard.sh
test "$(id -u)" = 0
python3 - <<'PY'
import hashlib,zipfile,stat
from pathlib import Path
p=Path('/srv/anywhere-lab/vendor/electron-v45.3.3-linux-x64.zip')
assert hashlib.sha256(p.read_bytes()).hexdigest()=='0a63ce0e2b6a69d6ced7194949934b8414a6dadeca82910f88dc8720a1433269'
target=Path('/usr/lib/anywhere-desktop-electron');target.mkdir(exist_ok=True,mode=0o755)
with zipfile.ZipFile(p) as z:
 for info in z.infolist():
  out=(target/info.filename).resolve();assert out.is_relative_to(target)
  z.extract(info,target)
  out.chmod(0o755 if info.is_dir() or (info.external_attr>>16)&0o111 else 0o644)
PY
cat > /etc/apparmor.d/anywhere-desktop-electron <<'EOF'
abi <abi/4.0>,
include <tunables/global>
# Fixed root-owned Electron binary only; Chromium renderer sandbox stays enabled.
profile anywhere-desktop-electron /usr/lib/anywhere-desktop-electron/electron flags=(unconfined) {
  userns,
}
EOF
apparmor_parser -r /etc/apparmor.d/anywhere-desktop-electron
test ! -u /usr/lib/anywhere-desktop-electron/chrome-sandbox
test "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns)" = 1
echo 'Electron 45.3.3 verified and installed root-owned; no setuid or global sandbox relaxation.'
