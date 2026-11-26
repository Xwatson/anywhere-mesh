#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../../.."
output_dir=${1:?Output directory required}
mkdir -p "$output_dir"
output_dir=$(cd "$output_dir" && pwd)

case "$(uname -m)" in
  arm64)
    arch=arm64
    easytier_arch=aarch64
    electron_sha=25ae0ce40ee462433c1029b8fcc485949fc8a89394b62b70887d7793898edc89
    node_sha=6239d4cf92d864487ec8cd3615038f7b67e7f58b77b21cd2f09ea9fbd68065fe
    easytier_sha=4be1882d1aa36d31c1d6ba0596f2cf8a097e371f8da124212324b2e0f8df7e4b
    ;;
  x86_64)
    arch=x64
    easytier_arch=x86_64
    electron_sha=151d249b646eb8b99f1bea40aff217b10d8e21246ad8c07bb3a5982e2722660f
    node_sha=0ae5a24c24bb7d015cd816c5036b3f90f2945aa872fcf54e58da054753b3a299
    easytier_sha=89fc28a6e6995259d76ce3f11775220e8a21c760e94df91a6a9db30a69b6982e
    ;;
  *) exit 1 ;;
esac

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
download() {
  local file="$stage/${1##*/}"
  curl --fail --silent --show-error --location --retry 3 "$1" --output "$file"
  printf '%s  %s\n' "$2" "$file" | shasum -a 256 --check
}

electron=electron-v45.3.3-darwin-$arch.zip
node_dist=node-v24.21.0-darwin-$arch
easytier=easytier-macos-$easytier_arch-v2.6.4.zip
download "https://github.com/electron/electron/releases/download/v45.3.3/$electron" "$electron_sha"
download "https://nodejs.org/dist/v24.21.0/$node_dist.tar.xz" "$node_sha"
download "https://github.com/EasyTier/EasyTier/releases/download/v2.6.4/$easytier" "$easytier_sha"
npm pack ws@8.22.0 --pack-destination "$stage" --silent
ditto -x -k "$stage/$electron" "$stage"
tar -xf "$stage/$node_dist.tar.xz" -C "$stage" "$node_dist/bin/node" "$node_dist/LICENSE"
unzip -q "$stage/$easytier" -d "$stage/easytier"

bundle="$stage/AnywhereMesh.app"
mv "$stage/Electron.app" "$bundle"
resources="$bundle/Contents/Resources"
tools="$resources/tools"
mkdir -p "$tools"
rm -f "$resources/default_app.asar"
install -m 755 "$stage/$node_dist/bin/node" "$tools/node"
install -m 644 "$stage/$node_dist/LICENSE" "$tools/node-LICENSE"
install -m 755 "$(find "$stage/easytier" -type f -name easytier-core)" "$tools/easytier-core"

version=$("$tools/node" -p 'require("./package.json").version')
python3 - "$resources/app" "$stage/ws-8.22.0.tgz" "$version" <<'PY'
import base64
import hashlib
import json
from pathlib import Path
import runpy
import shutil
import sys
import tarfile

app, archive = map(Path, sys.argv[1:3])
version = sys.argv[3]
manifest = runpy.run_path("src/account-devices/linux/package-linux.py")
integrity = "sha512-" + base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode()
if integrity != manifest["WS_INTEGRITY"]:
    raise SystemExit("ws archive checksum mismatch")

for module, filenames in manifest["APP_FILES"].items():
    for filename in filenames:
        source = Path("src") / module / filename
        target = app / source
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)

with tarfile.open(archive, "r:gz") as tar:
    for member in tar.getmembers():
        path = Path(member.name)
        if member.isfile() and path.parts[0] == "package" and ".." not in path.parts:
            target = app / "src/execution/node_modules/ws" / path.relative_to("package")
            target.parent.mkdir(parents=True, exist_ok=True)
            with tar.extractfile(member) as source, target.open("wb") as dest:
                shutil.copyfileobj(source, dest)

(app / "package.json").write_text(json.dumps({
    "name": "anywhere-mesh",
    "productName": "AnywhereMesh",
    "version": version,
    "main": "src/desktop/main.cjs",
}, indent=2) + "\n")
PY

plist="$bundle/Contents/Info.plist"
mv "$bundle/Contents/MacOS/Electron" "$bundle/Contents/MacOS/AnywhereMesh"
plutil -replace CFBundleExecutable -string AnywhereMesh "$plist"
plutil -replace CFBundleName -string AnywhereMesh "$plist"
plutil -replace CFBundleDisplayName -string AnywhereMesh "$plist"
plutil -replace CFBundleIdentifier -string com.anywheremesh.desktop "$plist"
plutil -replace CFBundleShortVersionString -string "$version" "$plist"
plutil -replace CFBundleVersion -string "$version" "$plist"

codesign --force --deep --sign - "$bundle"
codesign --verify --deep --strict "$bundle"

test "$("$tools/node" -p process.arch)" = "$arch"
"$tools/easytier-core" --version
smoke_log="$stage/smoke.log"
ANYWHERE_MESH_DATA_DIR="$stage/smoke" "$bundle/Contents/MacOS/AnywhereMesh" --macos-package-smoke > "$smoke_log" 2>&1 || {
  cat "$smoke_log"
  exit 1
}
cat "$smoke_log"
grep -Fx 'macOS desktop smoke passed' "$smoke_log"

archive="$output_dir/AnywhereMesh-$version-macos-$arch.zip"
ditto -c -k --keepParent "$bundle" "$archive"
(cd "$output_dir" && shasum -a 256 "$(basename "$archive")" > "$(basename "$archive").sha256")
