"""Drive Windows Electron via SSH and use an existing Linux desktop session as the second device."""
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

target, identity, guest, accounts, report_dir = sys.argv[1:]
dest = Path(report_dir)
os.umask(0o077)
dest.mkdir(parents=True, exist_ok=True)
run_id = str(uuid.uuid4())
member = next(a for a in json.loads(Path(accounts).read_text()) if a["username"] == "lab-coder")
opts = ["-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes",
        "-o", "ConnectTimeout=7", "-i", identity]
ssh = ["ssh", "-T", *opts, target]
win_dir = "AppData/Local/AnywhereMesh/artifacts"
report = "smoke-" + run_id + ".json"
print("Windows desktop check", run_id, flush=True)
launcher = Path(__file__).with_name("smoke-launch.ps1")
subprocess.run(["scp", "-q", *opts, str(launcher), target + ":AppData/Local/AnywhereMesh/staging/"], check=True)
launch = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File AppData/Local/AnywhereMesh/staging/smoke-launch.ps1"

def download(name, path):
    result = subprocess.run(["scp", "-q", *opts, target + ":" + win_dir + "/" + name, str(path)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=12)
    return result.returncode == 0

def read_state():
    tmp = dest / (run_id + ".tmp")
    if download(report, tmp):
        value = json.loads(tmp.read_text())
        assert value["runId"] == run_id
        tmp.replace(dest / report)
        return value
    return {}

with (dest / (run_id + "-process.log")).open("wb") as log:
    proc = subprocess.Popen(ssh + [launch], stdin=subprocess.PIPE, stdout=log, stderr=log)
    proc.stdin.write(json.dumps(dict(username=member["username"], password=member["password"], runId=run_id)).encode())
    proc.stdin.close()
    linux = None
    try:
        stop = time.monotonic() + 275
        phase = None
        while time.monotonic() < stop:
            state = read_state()
            current = state.get("phase")
            if current != phase:
                print("Windows", current, flush=True)
                phase = current
            if current == "failed":
                raise RuntimeError(state.get("error", "Windows smoke failed"))
            if current == "awaiting-linux" and linux is None:
                fields = {k: state[k] for k in ("file", "workspaceId", "deviceId", "sessionId", "secondDigest")}
                arg = base64.urlsafe_b64encode(json.dumps(fields).encode()).decode().rstrip("=")
                source = Path(__file__).with_name("linux-read.mjs").read_bytes()
                check = subprocess.run([guest, "/usr/local/bin/node --input-type=module - " + arg],
                                       input=source, capture_output=True, timeout=160)
                if check.returncode:
                    raise RuntimeError("Linux cross-device check failed: " + check.stderr.decode()[-1400:])
                linux = json.loads(check.stdout)
                print("Linux read verified, offline targeting verified", flush=True)
            if current == "passed" and linux:
                if proc.wait(timeout=40) != 0:
                    raise RuntimeError("Windows desktop exited with an error")
                download(run_id + "-online.png", dest / (run_id + "-online.png"))
                result = {"windows": state, "linux": linux}
                (dest / (run_id + "-acceptance.json")).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
                break
            if proc.poll() is not None:
                # A successful final report can arrive between poll and the SCP above.
                if read_state().get("phase") == "passed" and linux:
                    continue
                raise RuntimeError("Windows desktop exited before verification, code " + str(proc.returncode))
            time.sleep(0.8)
        else:
            raise TimeoutError("Windows desktop did not finish")
    finally:
        if proc.poll() is None:
            # Terminate only this temporary test task. Let its launcher unregister it.
            stop = "Stop-ScheduledTask -TaskName 'AnywhereLab-Smoke-" + run_id + "' -ErrorAction SilentlyContinue"
            encoded = base64.b64encode(stop.encode("utf-16-le")).decode()
            subprocess.run(ssh + ["powershell.exe -NoProfile -NonInteractive -EncodedCommand " + encoded],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=12)
            try: proc.wait(timeout=45)
            except subprocess.TimeoutExpired: proc.terminate()
        if not linux or proc.returncode:
            read_state()
            download(run_id + "-diagnostic.png", dest / (run_id + "-diagnostic.png"))
