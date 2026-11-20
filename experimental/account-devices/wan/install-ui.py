"""Publish the renderer and its matching device client to the isolated Linux WAN desktop."""
import hashlib
import os
from pathlib import Path
import sys
import tempfile

if os.geteuid() != 0 or os.uname().nodename != "anywhere-crossborder-lab":
    raise SystemExit("Run in the Linux lab guest as the installer")

source = Path(sys.argv[1]).resolve()
target = Path("/usr/lib/anywhere-wan-desktop/experimental/account-devices")
releases = target / "renderers"
releases.mkdir(exist_ok=True, mode=0o755)
releases.chmod(0o755)
with tempfile.TemporaryDirectory(dir=releases) as temp:
    work = Path(temp)
    output = work / "assets"
    output.mkdir(mode=0o755)
    output.chmod(0o755)
    digest = hashlib.sha256()
    for name in ("index.html", "app.js", "thread.js", "style.css"):
        data = (source / name).read_bytes()
        (output / name).write_bytes(data)
        (output / name).chmod(0o644)
        digest.update(hashlib.sha256(data).digest())
    revision = releases / digest.hexdigest()[:16]
    if not revision.exists():
        output.rename(revision)
    # Replace the old private runtime or D3 symlink without writing through the link.
    for name in ("contract.cjs", "remembered-login.mjs", "client.mjs", "controller.mjs", "main.mjs"):
        staged = work / name
        staged.write_bytes((source.parent / name).read_bytes())
        staged.chmod(0o644)
        staged.replace(target / name)
    link = work / "current"
    link.symlink_to(revision)
    link.replace(target / "ui")
print("Linux WAN desktop renderer", revision.name)
