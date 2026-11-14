#!/usr/bin/env bash
# 安装为 systemd 用户服务：开机自启、崩溃自动重启。
# 用法: bash deploy/install-service.sh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node)"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/anywhere-coding.service"

mkdir -p "$UNIT_DIR"
cat > "$UNIT" <<UNIT
[Unit]
Description=Anywhere Coding
After=network-online.target

[Service]
WorkingDirectory=$PROJECT_DIR
ExecStart=$NODE_BIN $PROJECT_DIR/server/dist/index.js
Restart=on-failure
RestartSec=3
# claude / codex 等命令需要在 PATH 中（终端模式会直接调用它们）
Environment=PATH=$(dirname "$NODE_BIN"):$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
UNIT

echo "已写入 $UNIT"
(cd "$PROJECT_DIR" && npm run build)
systemctl --user daemon-reload
systemctl --user enable --now anywhere-coding
systemctl --user --no-pager status anywhere-coding | head -5

if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
  echo
  echo "提示：要让服务在你退出登录/重启后仍然运行，请执行一次："
  echo "  sudo loginctl enable-linger $USER"
fi
