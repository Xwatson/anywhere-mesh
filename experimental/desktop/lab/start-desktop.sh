#!/usr/bin/env bash
set -euo pipefail
source /srv/anywhere-lab/scripts/guest-guard.sh
test "$(id -u)" != 0
openbox --sm-disable &
exec /usr/lib/anywhere-desktop-electron/electron --disable-setuid-sandbox /usr/lib/anywhere-desktop-runtime/experimental/desktop "$@"
