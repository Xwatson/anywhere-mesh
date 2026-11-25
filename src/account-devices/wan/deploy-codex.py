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
import tomllib

if os.geteuid() != 0:
    raise SystemExit("Run as the deployment administrator")
stage = Path(sys.argv[1]).resolve()
unitdir = Path("/etc/systemd/system")
prefix = Path("/opt/anywhere-wan")
service = "anywhere-wan-host.service"
control = lambda *args: subprocess.run(["systemctl", *args], check=True)
files = ("server.mjs", "mcp.mjs", "agy-mcp-bridge.mjs", "ui/app.js", "ui/index.html", "ui/thread.js", "ui/session-cache.js", "ui/style.css", "ui/manifest.webmanifest", "ui/sw.js", "ui/icon-192.png", "ui/icon-512.png")
has_agy = all((stage / name).exists() for name in ("anywhere-wan-agy.socket", "anywhere-wan-agy@.service", "agy-service.py"))
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
if has_agy:
    for name in ("anywhere-wan-agy.socket", "anywhere-wan-agy@.service"):
        install(stage / name, unitdir / name)
    install(stage / "agy-service.py", prefix / "bin/agy-service.py")
cfg = json.loads(Path("/etc/anywhere-wan/host.json").read_text())
cfg.update(codexSocket="/run/anywhere-wan-codex.sock", codexCwd="/var/lib/anywhere-wan-codex")
if has_agy:
    cfg.update(
        antigravitySocket="/run/anywhere-wan-agy.sock",
        antigravityCwd="/var/lib/anywhere-wan-agy",
        antigravityMcpBridge=str(release / "agy-mcp-bridge.mjs"),
        antigravityMcpDir="/run/anywhere-wan-mcp",
        nodePath=str(prefix / "bin/node-v24.21.0"),
    )
# Only public server identity is needed by the app. EasyTier retains the network keys.
wire = tomllib.loads(Path("/etc/anywhere-wan/network.toml").read_text())
if wire["secure_mode"]["enabled"] and wire["listeners"] == ["ws://127.0.0.1:31483/"]:
    cfg["windowsNetwork"] = {"name": wire["network_identity"]["network_name"],
                             "serverKey": wire["secure_mode"]["local_public_key"]}
if Path("/etc/nginx/conf.d/anywhere-wan-domain.conf").exists():
    cfg["directTransport"] = True
config = release / "host.json"
config.write_text(json.dumps(cfg) + "\n")
config.chmod(0o644)
dropdir = unitdir / (service + ".d")
dropdir.mkdir(exist_ok=True)
override = dropdir / "50-codex.conf"
old = override.read_bytes() if override.exists() else None
sockets = "anywhere-wan-codex.socket anywhere-wan-agy.socket" if has_agy else "anywhere-wan-codex.socket"
mcp_runtime = "RuntimeDirectory=anywhere-wan-mcp\nRuntimeDirectoryMode=0755\n" if has_agy else ""
override.write_text(
    f"[Unit]\nWants={sockets}\nAfter={sockets}\n"
    f"Description=Anywhere WAN authenticated session host with Codex{' and Antigravity' if has_agy else ''}\n"
    f"[Service]\n{mcp_runtime}ExecStart=\nExecStart={prefix}/bin/node-v24.21.0 {release}/server.mjs {config}\n"
)
try:
    control("daemon-reload")
    control("enable", "--now", "anywhere-wan-codex.socket")
    if has_agy:
        control("enable", "--now", "anywhere-wan-agy.socket")
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
