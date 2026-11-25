"""Build a self-contained offline Linux x64 release archive (Desktop GUI + Headless CLI Agent)."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import tarfile
import tempfile
import zipfile

REPO_PKG_VERSION = json.loads((Path(__file__).resolve().parents[3] / "package.json").read_text(encoding="utf-8"))["version"]
VERSION = REPO_PKG_VERSION
RUNTIME_ABI = "e45.3.3-n24.21.0-et2.6.4-lin"
WS_INTEGRITY = "sha512-Ydggc987+RO0AnWtZ/7Wq9FtNvcrL1b/RO0ud9mWjUPgDrsAAwQSF51sm2hm1XofbU/4jkpGEsLFsZZxU+1DOg=="
PINNED = {
    "electron-v45.3.3-linux-x64.zip": "0a63ce0e2b6a69d6ced7194949934b8414a6dadeca82910f88dc8720a1433269",
    "node-v24.21.0-linux-x64.tar.xz": "fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6",
    "easytier-linux-x86_64-v2.6.4.zip": "61b659eaedba658fa66fe47d17e1426cdd77e5d02fa15fed447bb4357c09dfd6",
}

APP_FILES = {
    "desktop": ["main.cjs", "package.json", "contract.cjs", "updater-core.mjs", "updater.cjs", "apply-update.mjs"],
    "desktop-commander": ["adapter.mjs"],
    "execution": ["agent.mjs", "grants.mjs", "journal.mjs", "protocol.mjs", "retention.mjs", "rpc.mjs"],
    "workspace": ["patch.mjs", "catalog.mjs"],
    "account-devices": [
        "client.mjs", "remembered-login.mjs", "contract.cjs", "preload.cjs",
        "linux-agent.mjs", "linux-workspace.mjs",
        "linux/network.mjs", "linux/client.mjs", "linux/controller.mjs",
        "linux/agent.sh", "linux/anywhere-mesh-agent.service.example",
        "ui/index.html", "ui/app.js", "ui/thread.js", "ui/session-cache.js", "ui/style.css", "ui/manifest.webmanifest", "ui/sw.js", "ui/icon-192.png", "ui/icon-512.png",
    ],
}

DESKTOP_LAUNCHER = """#!/usr/bin/env bash
set -euo pipefail
APP_DIR="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
if [[ "${ANYWHERE_MESH_USE_PROXY:-0}" != "1" ]]; then
  unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
fi
EXTRA_FLAGS=()
if [[ -f "$APP_DIR/chrome-sandbox" ]]; then
  PERM="$(stat -c '%a' "$APP_DIR/chrome-sandbox" 2>/dev/null || echo 0)"
  OWNER="$(stat -c '%u' "$APP_DIR/chrome-sandbox" 2>/dev/null || echo 1)"
  if [[ "$OWNER" != "0" || "$PERM" != "4755" ]]; then
    EXTRA_FLAGS+=(--no-sandbox)
  fi
fi
exec "$APP_DIR/AnywhereMesh" "${EXTRA_FLAGS[@]}" "$@"
"""

INSTALL_SH = """#!/usr/bin/env bash
set -euo pipefail

# Installs AnywhereMesh (Desktop GUI + Headless CLI Agent) into ~/.local/opt/AnywhereMesh
# No root privileges required.

SRC_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
INSTALL_DIR="${ANYWHERE_MESH_INSTALL_DIR:-$HOME/.local/opt/AnywhereMesh}"
BIN_DIR="${HOME}/.local/bin"
APPS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICONS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/512x512/apps"

echo "Installing AnywhereMesh into $INSTALL_DIR ..."
mkdir -p "$(dirname "$INSTALL_DIR")" "$BIN_DIR" "$APPS_DIR" "$ICONS_DIR"

TMP_DIR="${INSTALL_DIR}.staging.$$"
rm -rf "$TMP_DIR"
mkdir -p "$TMP_DIR"
cp -a "$SRC_DIR/app/." "$TMP_DIR/"

if [[ -d "$INSTALL_DIR" ]]; then
  rm -rf "${INSTALL_DIR}.old.$$"
  mv "$INSTALL_DIR" "${INSTALL_DIR}.old.$$"
  mv "$TMP_DIR" "$INSTALL_DIR"
  rm -rf "${INSTALL_DIR}.old.$$"
else
  mv "$TMP_DIR" "$INSTALL_DIR"
fi

ln -sfn "$INSTALL_DIR/bin/anywhere-mesh" "$BIN_DIR/anywhere-mesh"
ln -sfn "$INSTALL_DIR/bin/anywhere-mesh-agent" "$BIN_DIR/anywhere-mesh-agent"
cp "$INSTALL_DIR/resources/AnywhereMesh.png" "$ICONS_DIR/anywhere-mesh.png"

cat > "$APPS_DIR/anywhere-mesh.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=AnywhereMesh
Comment=One AI host, every machine you own
Exec=$BIN_DIR/anywhere-mesh %U
Icon=anywhere-mesh
Terminal=false
Categories=Development;IDE;Network;
StartupWMClass=AnywhereMesh
EOF
chmod 644 "$APPS_DIR/anywhere-mesh.desktop"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
fi

echo ""
echo "AnywhereMesh installed successfully!"
echo "  Desktop GUI:   $BIN_DIR/anywhere-mesh  (also added to your application menu)"
echo "  Headless CLI:  $BIN_DIR/anywhere-mesh-agent --project /path/to/repo --mode execute"
echo "  Uninstall:     $INSTALL_DIR/uninstall.sh"
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  echo ""
  echo "Note: $BIN_DIR is not currently in your PATH. Add it in ~/.bashrc or run full path above."
fi
"""

UNINSTALL_SH = """#!/usr/bin/env bash
set -euo pipefail
INSTALL_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
rm -f "$HOME/.local/bin/anywhere-mesh" "$HOME/.local/bin/anywhere-mesh-agent"
rm -f "${XDG_DATA_HOME:-$HOME/.local/share}/applications/anywhere-mesh.desktop"
rm -f "${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/512x512/apps/anywhere-mesh.png"
if [[ "${1:-}" == "--purge" ]]; then
  rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/AnywhereMesh" "$HOME/.anywhere-mesh"
fi
rm -rf "$INSTALL_DIR"
echo "AnywhereMesh uninstalled."
"""


def check_sha256(path: Path, expected: str):
    with path.open("rb") as f:
        actual = hashlib.file_digest(f, "sha256").hexdigest()
    if actual != expected:
        raise SystemExit(f"Archive checksum mismatch for {path.name}: got {actual}")


def extract_zip_preserving_mode(zip_path: Path, dest: Path):
    with zipfile.ZipFile(zip_path) as z:
        for info in z.infolist():
            target = dest / info.filename
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            mode = info.external_attr >> 16
            if stat.S_ISLNK(mode):
                link_target = z.read(info).decode("utf-8")
                if target.exists() or target.is_symlink():
                    target.unlink()
                os.symlink(link_target, target)
            else:
                with z.open(info) as src_f, target.open("wb") as dst_f:
                    shutil.copyfileobj(src_f, dst_f)
                if mode & 0o777:
                    target.chmod(mode & 0o777)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archives", required=True, type=Path)
    parser.add_argument("--ws", required=True, type=Path)
    parser.add_argument("--ca", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[3]
    modules = repo_root / "src"

    ws_integrity = "sha512-" + base64.b64encode(hashlib.sha512(args.ws.read_bytes()).digest()).decode()
    if ws_integrity != WS_INTEGRITY:
        raise SystemExit("ws archive checksum mismatch")
    for name, expected in PINNED.items():
        check_sha256(args.archives / name, expected)

    ca_bytes = args.ca.read_bytes()
    if ca_bytes.count(b"-----BEGIN CERTIFICATE-----") != 1 or b"PRIVATE KEY" in ca_bytes:
        raise SystemExit("Expected a public deployment CA certificate")

    with tempfile.TemporaryDirectory(prefix="anywhere-mesh-linux-") as tmp:
        stage = Path(tmp) / f"AnywhereMesh-{VERSION}-linux-x64"
        app_dir = stage / "app"
        app_dir.mkdir(parents=True)

        # 1. Extract Electron Linux x64
        extract_zip_preserving_mode(args.archives / "electron-v45.3.3-linux-x64.zip", app_dir)
        (app_dir / "electron").rename(app_dir / "AnywhereMesh")
        (app_dir / "AnywhereMesh").chmod(0o755)

        resources = app_dir / "resources"
        tools = resources / "tools"
        tools.mkdir(parents=True, exist_ok=True)

        # 2. Extract Node 24 Linux x64 binary
        with tarfile.open(args.archives / "node-v24.21.0-linux-x64.tar.xz", "r:xz") as tar:
            for src_rel, dst_name, mode in [
                ("node-v24.21.0-linux-x64/bin/node", "node", 0o755),
                ("node-v24.21.0-linux-x64/LICENSE", "node-LICENSE", 0o644),
            ]:
                out_file = tools / dst_name
                with tar.extractfile(src_rel) as sf, out_file.open("wb") as df:
                    shutil.copyfileobj(sf, df)
                out_file.chmod(mode)

        # 3. Extract EasyTier Linux x64 binaries
        with zipfile.ZipFile(args.archives / "easytier-linux-x86_64-v2.6.4.zip") as z:
            for member in z.namelist():
                base = Path(member).name
                if base in ("easytier-core", "easytier-cli") and not member.endswith("/"):
                    out_file = tools / base
                    out_file.write_bytes(z.read(member))
                    out_file.chmod(0o755)

        # 4. Copy deployment CA cert & app icon
        (tools / "ca.crt").write_bytes(ca_bytes)
        (tools / "ca.crt").chmod(0o644)
        shutil.copyfile(modules / "account-devices/windows/icon-512.png", resources / "AnywhereMesh.png")

        # 5. Populate resources/app with JS sources + ws
        app_src = resources / "app"
        for module, names in APP_FILES.items():
            for name in names:
                src_path = modules / module / name
                dst_path = app_src / "src" / module / name
                dst_path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(src_path, dst_path)
                if name.endswith(".sh") or name == "linux-agent.mjs":
                    dst_path.chmod(0o755)

        with tarfile.open(args.ws, "r:gz") as tar:
            for member in tar.getmembers():
                p = Path(member.name)
                if member.isfile() and p.parts[0] == "package" and ".." not in p.parts:
                    dst = app_src / "src/execution/node_modules/ws" / p.relative_to("package")
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    with tar.extractfile(member) as sf, dst.open("wb") as df:
                        shutil.copyfileobj(sf, df)

        (app_src / "package.json").write_text(json.dumps({
            "name": "anywhere-mesh",
            "productName": "AnywhereMesh",
            "version": VERSION,
            "runtimeAbi": RUNTIME_ABI,
            "main": "src/desktop/main.cjs",
        }, indent=2) + "\n")

        # 6. Install launchers & install/uninstall scripts
        bin_dir = app_dir / "bin"
        bin_dir.mkdir(parents=True, exist_ok=True)
        (bin_dir / "anywhere-mesh").write_text(DESKTOP_LAUNCHER)
        (bin_dir / "anywhere-mesh").chmod(0o755)
        shutil.copyfile(modules / "account-devices/linux/agent.sh", bin_dir / "anywhere-mesh-agent")
        (bin_dir / "anywhere-mesh-agent").chmod(0o755)

        (app_dir / "uninstall.sh").write_text(UNINSTALL_SH)
        (app_dir / "uninstall.sh").chmod(0o755)
        (stage / "install.sh").write_text(INSTALL_SH)
        (stage / "install.sh").chmod(0o755)
        shutil.copyfile(modules / "account-devices/linux/anywhere-mesh-agent.service.example",
                        stage / "anywhere-mesh-agent.service.example")

        args.output.parent.mkdir(parents=True, exist_ok=True)
        with tarfile.open(args.output, "w:gz") as out_tar:
            out_tar.add(stage, arcname=stage.name)
        print(f"Built {args.output} ({args.output.stat().st_size / (1024*1024):.1f} MB)")


if __name__ == "__main__":
    main()
