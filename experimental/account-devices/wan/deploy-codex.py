"""Upgrade only the isolated WAN host. Run on the US lab machine with the built app directory."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile

if os.geteuid() != 0:
    raise SystemExit("Run as the deployment administrator")
stage = Path(sys.argv[1]).resolve()
unitdir = Path("/etc/systemd/system")
prefix = Path("/opt/anywhere-wan")
service = "anywhere-wan-host.service"
control = lambda *args: subprocess.run(["systemctl", *args], check=True)
files = ("server.mjs", "mcp.mjs", "ui/app.js", "ui/index.html", "ui/style.css")
sha = hashlib.sha256()
for name in files:
    sha.update((stage / name).read_bytes())
release = prefix / "releases" / sha.hexdigest()[:16]
release.parent.mkdir(parents=True, exist_ok=True)
for db in Path("/var/lib/anywhere-wan").glob("u*/history.sqlite"):
    with sqlite3.connect(f"file:{db}?mode=ro", uri=True) as con:
        if con.execute("SELECT 1 FROM records WHERE bucket='sessions' AND json_extract(value,'$.activeTurnId') IS NOT NULL LIMIT 1").fetchone():
            raise SystemExit("A lab turn is still active; retry after it finishes")
if not release.exists():
    with tempfile.TemporaryDirectory(dir=release.parent) as tmp:
        app = Path(tmp) / "app"
        (app / "ui").mkdir(parents=True)
        for name in files:
            shutil.copyfile(stage / name, app / name)
            (app / name).chmod(0o644)
        app.chmod(0o755)
        (app / "ui").chmod(0o755)
        app.rename(release)
def install(src, target):
    partial = target.with_suffix(target.suffix + ".new")
    shutil.copyfile(src, partial)
    partial.chmod(0o644)
    partial.replace(target)

for name in ("anywhere-wan-codex.socket", "anywhere-wan-codex@.service"):
    install(stage / name, unitdir / name)
install(stage / "codex-service.py", prefix / "bin/codex-service.py")
cfg = json.loads(Path("/etc/anywhere-wan/host.json").read_text())
cfg.update(codexSocket="/run/anywhere-wan-codex.sock", codexCwd="/var/lib/anywhere-wan-codex")
config = release / "host.json"
config.write_text(json.dumps(cfg) + "\n")
config.chmod(0o644)
dropdir = unitdir / (service + ".d")
dropdir.mkdir(exist_ok=True)
override = dropdir / "50-codex.conf"
old = override.read_bytes() if override.exists() else None
override.write_text(f"[Unit]\nWants=anywhere-wan-codex.socket\nAfter=anywhere-wan-codex.socket\nDescription=Anywhere WAN authenticated session host with Codex\n[Service]\nExecStart=\nExecStart={prefix}/bin/node-v24.21.0 {release}/server.mjs {config}\n")
try:
    control("daemon-reload")
    control("enable", "--now", "anywhere-wan-codex.socket")
    control("restart", service)
    subprocess.run(["curl", "-fsS", "--retry", "12", "--retry-all-errors", "--retry-delay", "1", "--max-time", "4",
                    "--cacert", "/etc/anywhere-wan/ca.crt", "-o", "/dev/null", "https://127.0.0.1:18443/"], check=True)
except BaseException:
    if old is None:
        override.unlink(missing_ok=True)
    else:
        override.write_bytes(old)
    control("daemon-reload")
    control("restart", service)
    raise
print("Active WAN release", release.name)
