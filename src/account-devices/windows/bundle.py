"""Package the native Windows test desktop using the experiment's pinned npm artifacts."""
import base64
import hashlib
import json
from pathlib import Path
import sys
import tarfile
import zipfile

ws_archive, dc_archive, output = map(Path, sys.argv[1:])
root = Path(__file__).resolve().parents[3]
modules = root / "src"
WS_INTEGRITY = "sha512-Ydggc987+RO0AnWtZ/7Wq9FtNvcrL1b/RO0ud9mWjUPgDrsAAwQSF51sm2hm1XofbU/4jkpGEsLFsZZxU+1DOg=="
lock = root / "package-lock.json"
ws_integrity = json.loads(lock.read_text())["packages"]["node_modules/ws"]["integrity"] if lock.exists() else WS_INTEGRITY
vendor = json.loads((modules / "desktop-commander/vendor/provenance.json").read_text())
if "sha512-" + base64.b64encode(hashlib.sha512(ws_archive.read_bytes()).digest()).decode() != ws_integrity:
    raise SystemExit("ws archive checksum mismatch")
if hashlib.sha256(dc_archive.read_bytes()).hexdigest() != vendor["sha256"]:
    raise SystemExit("Desktop Commander archive checksum mismatch")

with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as bundle:
    def add(name, data):
        entry = zipfile.ZipInfo(name)
        entry.compress_type = zipfile.ZIP_DEFLATED
        entry.external_attr = 0o100644 << 16
        bundle.writestr(entry, data)

    files = {
        "desktop": ["main.cjs", "package.json", "contract.cjs", "updater-core.mjs", "updater.cjs", "apply-update.mjs"],
        "desktop-commander": ["adapter.mjs"],
        "execution": ["agent.mjs", "grants.mjs", "journal.mjs", "protocol.mjs", "retention.mjs", "rpc.mjs"],
        "workspace": ["patch.mjs"],
        "account-devices": ["client.mjs", "remembered-login.mjs", "contract.cjs", "preload.cjs", "ui/index.html", "ui/app.js", "ui/thread.js", "ui/session-cache.js", "ui/style.css", "ui/manifest.webmanifest", "ui/sw.js", "ui/icon-192.png", "ui/icon-512.png",
                            "windows/controller.mjs", "windows/client.mjs", "windows/network.mjs", "windows/read.mjs", "windows/tasks.mjs", "windows/WorkspaceTree.cs", "windows/TaskHost.cs", "windows/WorkspaceSnapshot.cs", "windows/PeerHost.cs", "windows/LoginProtection.cs", "windows/smoke.mjs"],
    }
    for module, names in files.items():
        for name in names:
            path = modules / module / name
            add(path.relative_to(root).as_posix(), path.read_bytes())
    with tarfile.open(ws_archive, "r:gz") as tar:
        for member in tar.getmembers():
            path = Path(member.name)
            if member.isfile() and path.parts[0] == "package" and ".." not in path.parts:
                add("src/execution/node_modules/ws/" + path.relative_to("package").as_posix(), tar.extractfile(member).read())
    with tarfile.open(dc_archive, "r:gz") as tar:
        for src, dest in [("dist/utils/files/text.js", "text.mjs"), ("LICENSE", "LICENSE")]:
            add("src/account-devices/windows/vendor/" + dest, tar.extractfile("package/" + src).read())
