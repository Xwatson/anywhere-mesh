"""Run one Antigravity CLI ACP server (or quota query) on the accepted local socket as the logged-in desktop user."""
import json
import os
import select
import socket
import subprocess
import sys

AGY = "/home/desktop/.local/bin/agy"


def peek_quota_request():
    sock = None
    try:
        sock = socket.fromfd(0, socket.AF_UNIX, socket.SOCK_STREAM)
        readable, _, _ = select.select([sock], [], [], 2.0)
        if not readable:
            return None
        data = sock.recv(4096, socket.MSG_PEEK)
        if not data or b"anywhere/quota" not in data:
            return None
        buf = b""
        while b"\n" not in buf and len(buf) < 16384:
            chunk = sock.recv(4096)
            if not chunk:
                break
            buf += chunk
        line = buf.decode("utf-8", errors="replace").splitlines()[0]
        msg = json.loads(line)
        if isinstance(msg, dict) and msg.get("method") == "anywhere/quota":
            return msg
    except Exception:
        return None
    finally:
        if sock is not None:
            sock.close()
    return None


def parse_json_output(stdout):
    text = (stdout or "").strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except Exception:
        pass
    for line in reversed(text.splitlines()):
        line = line.strip()
        if not line or not line.startswith("{"):
            continue
        try:
            return json.loads(line)
        except Exception:
            continue
    return {"rawText": text[:4000]}


def read_quota():
    cmds = [
        [AGY, "--print", "/usage", "--output-format", "json"],
        [AGY, "-p", "/usage", "--output-format", "json"],
    ]
    last_err = ""
    for cmd in cmds:
        try:
            proc = subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=20)
        except FileNotFoundError:
            raise RuntimeError("AGY_NOT_FOUND")
        except subprocess.TimeoutExpired:
            raise RuntimeError("AGY_QUOTA_TIMEOUT")
        parsed = parse_json_output(proc.stdout)
        if proc.returncode == 0 and parsed is not None:
            return parsed
        last_err = (proc.stderr or proc.stdout or f"exit {proc.returncode}").strip()
    raise RuntimeError(last_err[:280] or "AGY_QUOTA_FAILED")


def main():
    req = peek_quota_request()
    if req is not None:
        req_id = req.get("id", 1)
        try:
            result = read_quota()
            resp = {"jsonrpc": "2.0", "id": req_id, "result": result}
        except Exception as err:
            resp = {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32000, "message": str(err)}}
        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()
        return
    args = [AGY, "acp", "--disable-telemetry"]
    os.execv(args[0], args)


if __name__ == "__main__":
    main()
