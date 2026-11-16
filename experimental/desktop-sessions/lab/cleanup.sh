#!/usr/bin/env bash
set -euo pipefail
source /srv/anywhere-lab/scripts/guest-guard.sh
test "$(id -u)" = 0
systemctl stop anywhere-desktop2-agent-a.service anywhere-desktop2-agent-b.service anywhere-desktop2-bridge.service anywhere-desktop2-host.service
docker start anywhere-helper-us-mock-1 >/dev/null
