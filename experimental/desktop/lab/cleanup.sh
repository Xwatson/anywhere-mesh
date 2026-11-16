#!/usr/bin/env bash
# systemd fallback if the UI or controller crashes. Only this experiment's units.
set -euo pipefail
source /srv/anywhere-lab/scripts/guest-guard.sh
test "$(id -u)" = 0
systemctl stop anywhere-desktop-agent.service anywhere-desktop-broker.service
docker start anywhere-helper-us-mock-1 >/dev/null
