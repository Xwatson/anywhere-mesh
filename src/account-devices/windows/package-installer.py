"""Prepare an offline NSIS payload from pinned archives and the two compiled Windows helpers."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import zipfile
from PIL import Image

parser = argparse.ArgumentParser()
for name in ("archives", "app", "native", "ca", "dest"):
    parser.add_argument("--" + name, required=True, type=Path)
args = parser.parse_args()
src = Path(__file__).resolve().parents[3]
dest = args.dest.resolve()
dest.mkdir(parents=True, exist_ok=True)
payload = dest / "payload"
payload.mkdir()
release = hashlib.sha256()
version = "0.4.5"

def pinned(name, expected):
    archive = args.archives / name
    with archive.open("rb") as f:
        digest = hashlib.file_digest(f, "sha256").hexdigest()
    if digest != expected:
        raise SystemExit("Archive checksum mismatch: " + name)
    release.update(bytes.fromhex(digest))
    return zipfile.ZipFile(archive)

with pinned("electron-v45.3.3-win32-x64.zip", "49dd2d3875944f08de03d34595cd30093c588b9edcabb41a0ac481028a3a5a8a") as z:
    z.extractall(payload)
(payload / "electron.exe").rename(payload / "AnywhereMesh.exe")
resources = payload / "resources"
tools = resources / "tools"
tools.mkdir()
with pinned("node-v24.21.0-win-x64.zip", "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541") as z:
    for source, target in [("node.exe", "node.exe"), ("LICENSE", "node-LICENSE")]:
        (tools / target).write_bytes(z.read("node-v24.21.0-win-x64/" + source))
    for name in z.namelist():
        prefix = "node-v24.21.0-win-x64/"
        relative = name.removeprefix(prefix)
        if not name.endswith("/") and (relative.startswith("node_modules/npm/") or relative in ("npm.cmd","npx.cmd")):
            target = tools / relative
            target.parent.mkdir(parents=True,exist_ok=True)
            target.write_bytes(z.read(name))
with pinned("easytier-windows-x86_64-v2.6.4.zip", "27af91e270e554709b048bd32327fefd2dfce5062ae1e8701af7550c6f525f84") as z:
    for name in ("easytier-core.exe", "Packet.dll"):
        (tools / name).write_bytes(z.read("easytier-windows-x86_64/" + name))
app = resources / "app"
with zipfile.ZipFile(args.app) as z:
    for entry in z.infolist():
        if not entry.filename.endswith((".cs", "/smoke.mjs")):
            z.extract(entry, app)
release.update(args.app.read_bytes())
(app / "package.json").write_text(json.dumps({"name":"anywhere-mesh","productName":"AnywhereMesh",
    "version":version,"main":"src/desktop/main.cjs"}))
release.update((app / "package.json").read_bytes())
native = app / "src/account-devices/windows"
for name in ("WorkspaceSnapshot.exe", "PeerHost.exe", "TaskHost.exe", "LoginProtection.exe"):
    binary = (args.native / name).read_bytes()
    if binary[:2] != b"MZ":
        raise SystemExit("Missing native helper: " + name)
    release.update(binary)
    (native / name).write_bytes(binary)
ca = args.ca.read_bytes()
if ca.count(b"-----BEGIN CERTIFICATE-----") != 1 or b"PRIVATE KEY" in ca:
    raise SystemExit("Expected a public deployment CA certificate")
(tools / "ca.crt").write_bytes(ca)
release.update(ca)
with Image.open(Path(__file__).with_name("icon-512.png")) as im:
    im.convert("RGBA").save(resources / "AnywhereMesh.ico", sizes=[(16,16),(32,32),(48,48),(128,128),(256,256)], bitmap_format="bmp")
release.update((resources / "AnywhereMesh.ico").read_bytes())
shutil.copyfile(Path(__file__).with_name("setup.nsi"),dest / "setup.nsi")
(dest / "release.nsh").write_text(f'!define RELEASE "{release.hexdigest()[:16]}"\n!define VERSION "{version}"\n')
