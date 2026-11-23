#!/usr/bin/env bash
set -euo pipefail

# AnywhereMesh Linux Headless Device Agent launcher.
# Works both from a source checkout and from an installed AnywhereMesh Linux package.
#
# Usage:
#   anywhere-mesh-agent --project /path/to/repo [--label my-repo] [--mode read|edit|execute]
#   anywhere-mesh-agent --logout
#
# Environment overrides:
#   ANYWHERE_MESH_URL       Server URL (default: https://awc.xbxbe.com)
#   ANYWHERE_MESH_CA        Deployment CA certificate path
#   ANYWHERE_MESH_EASYTIER  Path to easytier-core binary
#   ANYWHERE_MESH_NODE      Path to Node.js 24+ binary
#   ANYWHERE_MESH_STATE     State directory (default: ~/.anywhere-mesh/linux-agent)
#   ANYWHERE_MESH_MODE      Default permission mode (default: read)
#   ANYWHERE_MESH_NAME      Device display name (default: Linux · <hostname>)
#   ANYWHERE_MESH_USE_PROXY Set to 1 to keep shell proxy env vars

if [[ "${ANYWHERE_MESH_USE_PROXY:-0}" != "1" ]]; then
  unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
fi

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"

# Detect installed bundle layout vs source checkout layout
if [[ -f "$SCRIPT_DIR/../resources/app/src/account-devices/linux-agent.mjs" ]]; then
  APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
  AGENT_JS="$APP_ROOT/resources/app/src/account-devices/linux-agent.mjs"
  NODE_BIN="${ANYWHERE_MESH_NODE:-$APP_ROOT/resources/tools/node}"
  DEFAULT_EASYTIER="$APP_ROOT/resources/tools/easytier-core"
  DEFAULT_CA="$APP_ROOT/resources/tools/ca.crt"
else
  REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
  AGENT_JS="$REPO_ROOT/src/account-devices/linux-agent.mjs"
  NODE_BIN="${ANYWHERE_MESH_NODE:-$(command -v node)}"
  DEFAULT_EASYTIER="${ANYWHERE_MESH_EASYTIER:-$(command -v easytier-core 2>/dev/null || true)}"
  DEFAULT_CA="${ANYWHERE_MESH_CA:-${XDG_DATA_HOME:-$HOME/.local/share}/AnywhereMesh/ca.crt}"
fi

CA="${ANYWHERE_MESH_CA:-$DEFAULT_CA}"
EASYTIER="${ANYWHERE_MESH_EASYTIER:-$DEFAULT_EASYTIER}"
STATE_DIR="${ANYWHERE_MESH_STATE:-$HOME/.anywhere-mesh/linux-agent}"
MODE="${ANYWHERE_MESH_MODE:-read}"
NAME="${ANYWHERE_MESH_NAME:-Linux · $(hostname)}"

for arg in "$@"; do
  if [[ "$arg" == "--help" || "$arg" == "-h" ]]; then
    exec "$NODE_BIN" "$AGENT_JS" --help
  fi
done

if [[ "${1:-}" == "--logout" ]]; then
  exec "$NODE_BIN" "$AGENT_JS" --ca "$CA" --state "$STATE_DIR" --logout
fi

HAS_PROJECT=0
HAS_MODE=0
HAS_CA=0
HAS_ET=0
HAS_STATE=0
HAS_NAME=0
HAS_USER=0
HAS_DIRECT=0
for arg in "$@"; do
  case "$arg" in
    --project) HAS_PROJECT=1 ;;
    --mode) HAS_MODE=1 ;;
    --ca) HAS_CA=1 ;;
    --easytier) HAS_ET=1 ;;
    --state) HAS_STATE=1 ;;
    --name) HAS_NAME=1 ;;
    --username) HAS_USER=1 ;;
    --direct) HAS_DIRECT=1 ;;
  esac
done

ARGS=("$AGENT_JS")
[[ "$HAS_CA" -eq 0 ]] && [[ -n "$CA" ]] && ARGS+=(--ca "$CA")
[[ "$HAS_ET" -eq 0 && "$HAS_DIRECT" -eq 0 ]] && [[ -n "$EASYTIER" ]] && ARGS+=(--easytier "$EASYTIER")
[[ "$HAS_STATE" -eq 0 ]] && ARGS+=(--state "$STATE_DIR")
[[ "$HAS_NAME" -eq 0 ]] && ARGS+=(--name "$NAME")
[[ "$HAS_MODE" -eq 0 ]] && ARGS+=(--mode "$MODE")
[[ "$HAS_PROJECT" -eq 0 ]] && ARGS+=(--project "$PWD")
ARGS+=("$@")

if [[ ! -f "$STATE_DIR/login.json" && "$HAS_USER" -eq 0 && -t 0 ]]; then
  echo "=== AnywhereMesh Linux Agent First-Time Sign-In ==="
  read -r -p "Username: " MESH_USER
  read -r -s -p "Password: " MESH_PASS
  echo ""
  exec "$NODE_BIN" "${ARGS[@]}" --username "$MESH_USER" --password-stdin <<<"$MESH_PASS"
fi

exec "$NODE_BIN" "${ARGS[@]}"
