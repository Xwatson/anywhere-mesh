"""NAS-side verification. The lab password goes only to Windows via SSH stdin."""
import argparse
import json
import os
from pathlib import Path
import selectors
import shlex
import subprocess
import uuid

p = argparse.ArgumentParser()
p.add_argument("--windows", required=True)
p.add_argument("--identity", required=True)
p.add_argument("--server", required=True)
p.add_argument("--source-ip")
p.add_argument("--server-dir", required=True)
p.add_argument("--accounts", type=Path, required=True)
p.add_argument("--reports", type=Path, required=True)
args = p.parse_args()
os.umask(0o077)
args.reports.mkdir(parents=True, exist_ok=True)
key = str(uuid.uuid4())
path = args.reports / (key + ".json")
ssh = ["ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=12"]
win = ssh + ["-i", args.identity, "-o", "IdentitiesOnly=yes", args.windows]
server = ssh + (["-b", args.source_ip] if args.source_ip else []) + [args.server]
member = next(a for a in json.loads(args.accounts.read_text()) if a["username"] == "lab-coder")
report = {"runId": key}
def save():
    path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
def write(proc, value):
    proc.stdin.write((json.dumps(value) + "\n").encode())
    proc.stdin.flush()
def read(proc, seconds=175):
    with selectors.DefaultSelector() as ready:
        ready.register(proc.stdout, selectors.EVENT_READ)
        if not ready.select(seconds):
            raise TimeoutError("Windows fixture response timed out")
    line = proc.stdout.readline()
    if not line:
        raise RuntimeError("Windows fixture closed")
    return json.loads(line)
def run(target):
    cmd = ["python3", args.server_dir + "/launch.py"]
    result = subprocess.run(server + [shlex.join(cmd)], input=json.dumps(target), text=True,
                            stdout=subprocess.PIPE, timeout=235)
    if not result.stdout:
        raise RuntimeError("US acceptance launcher exited with no report")
    return json.loads(result.stdout), result.returncode
fixture = r'cmd.exe /c "%LOCALAPPDATA%\AnywhereCodingLab\runtime\node.exe %LOCALAPPDATA%\AnywhereCodingLab\staging\codex-fixture.mjs"'
print("Acceptance", path, flush=True)
with subprocess.Popen(win + [fixture], stdin=subprocess.PIPE, stdout=subprocess.PIPE) as client:
    try:
        write(client, {"username": member["username"], "password": member["password"]})
        target = read(client)
        if target.pop("phase") != "ready":
            raise RuntimeError("Windows grant not ready")
        report["target"] = target
        save()
        print("Windows ready; real Codex turn submitted", flush=True)
        result, status = run(target)
        report["codex"] = result
        save()
        if status or not result.get("passed"):
            raise RuntimeError("Codex read: " + str(result.get("error", "failed")))
        write(client, {k: result[k] for k in ("answerSha256", "fileRevision", "callId")})
        check = read(client)
        if check.get("phase") != "revoked" or check.get("expectedSha256") != result["answerSha256"]:
            raise RuntimeError("Independent Windows digest check failed")
        report["windows"] = check
        save()
        print("Windows verified the answer and history; checking revoked grant", flush=True)
        denied, status = run(target)
        if not status or denied.get("error") != "LOCAL_READ_PERMISSION_REQUIRED" or denied.get("operationId") or denied.get("threadId"):
            raise RuntimeError("Revoked workspace admitted a read")
        report["revoked"] = {"deniedBeforeModelTurn": True, "error": denied["error"], "operationCreated": False}
        write(client, {"close": True})
        report["cleanup"] = read(client)
        if report["cleanup"].get("phase") != "closed" or client.wait(timeout=25) != 0:
            raise RuntimeError("Windows fixture cleanup failed")
        report["passed"] = True
        save()
        print("PASS", path, flush=True)
    except Exception as error:
        report.update(passed=False, error=str(error))
        save()
        raise
    finally:
        if client.stdin and not client.stdin.closed:
            client.stdin.close()
        try:
            client.wait(timeout=30)
        except subprocess.TimeoutExpired:
            client.terminate()
