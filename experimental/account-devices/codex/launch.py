"""One-shot US acceptance launcher. Connect two unprivileged roles by anonymous pipes."""
import json
import os
from pathlib import Path
import pwd
import subprocess
import sys
import tempfile
import tomllib

os.umask(0o077)
release = Path(__file__).resolve().parent
target = json.load(sys.stdin)
expected = {"accountId", "deviceId", "workspaceId", "sessionId", "file"}
if set(target) != expected or os.geteuid() != 0:
    raise SystemExit("Expected a private admin launch with a locally selected test target")
node = "/opt/anywhere-wan/bin/node-v24.21.0"
service = pwd.getpwnam("anywhere-wan")
desktop = pwd.getpwnam("desktop")
run = Path(tempfile.mkdtemp(prefix="awc-codex-read-", dir="/var/tmp"))
os.chmod(run, 0o711)
def private_dir(name, owner):
    directory = run / name
    directory.mkdir(mode=0o700)
    os.chown(directory, owner.pw_uid, owner.pw_gid)
    return directory

cwd = private_dir("cli", desktop)
state = private_dir("host", service)
def role(user):
    return dict(user=user.pw_uid, group=user.pw_gid, extra_groups=[],
                env={"HOME": user.pw_dir, "USER": user.pw_name, "LOGNAME": user.pw_name,
                     "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"})

# Use the MCP shipped with the running service, even if another release is staged.
pid = subprocess.check_output(["systemctl", "show", "-p", "MainPID", "--value", "anywhere-wan-host.service"], text=True).strip()
argv = Path("/proc", pid, "cmdline").read_bytes().split(b"\0")
server = next(Path(os.fsdecode(a)) for a in argv if a.endswith(b"/server.mjs"))
config = dict(target, cliCwd=str(cwd), serviceState="/var/lib/anywhere-wan", runDir=str(state), mcpPath=str(server.with_name("mcp.mjs")))
configfile = state / "config.json"
configfile.write_text(json.dumps(config))
os.chown(configfile, service.pw_uid, service.pw_gid)
host = role(service)
host["env"]["DATA_DIR"] = str(state / "client-data")
host["env"]["NODE_NO_WARNINGS"] = "1"
# Disable every configured third-party MCP by name without forwarding its credentials.
cli_args = ["/usr/bin/codex", "app-server"]
for feature in ("shell_tool", "apps", "plugins", "multi_agent", "multi_agent_v2", "code_mode", "skill_search"):
    cli_args.extend(["--disable", feature])
cli_args += ["-c", 'web_search="disabled"', "-c", "mcp_servers={}", "-c", 'approval_policy="never"']
client_config = Path(desktop.pw_dir, ".codex", "config.toml")
if client_config.is_file():
    for name in tomllib.loads(client_config.read_text()).get("mcp_servers", {}):
        cli_args.extend(["-c", "mcp_servers." + json.dumps(name) + ".enabled=false"])
with subprocess.Popen(cli_args, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                      stderr=subprocess.DEVNULL, **role(desktop)) as cli:
    try:
        with subprocess.Popen([node, str(release / "read-turn.mjs"), str(configfile)], cwd=state, stdin=cli.stdout,
                              stdout=cli.stdin, **host) as worker:
            cli.stdout.close()
            cli.stdin.close()
            try:
                status = worker.wait(timeout=205)
            except subprocess.TimeoutExpired:
                worker.terminate()
                raise
    finally:
        if cli.poll() is None:
            cli.terminate()
        try:
            cli.wait(timeout=8)
        except subprocess.TimeoutExpired:
            cli.kill()
report = json.loads((state / "result.json").read_text())
report["cliVersion"] = subprocess.check_output(["/usr/bin/codex", "--version"], text=True, **role(desktop)).strip()
report["cliUser"] = desktop.pw_name
report["serviceUser"] = service.pw_name
print(json.dumps(report, ensure_ascii=False), flush=True)
sys.exit(status)
