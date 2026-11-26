#!/usr/bin/env python3
"""Build signed lightweight app-bundles and manifest.json for AnywhereMesh auto-update.

Produces:
  - anywhere-mesh-app-<version>-win32-x64.tar.gz   (~300 KB delta bundle)
  - anywhere-mesh-app-<version>-linux-x64.tar.gz   (~300 KB delta bundle)
  - optional full installers copied alongside (--win-installer / --linux-archive)
  - manifest.json signed with an offline Ed25519 private key
  - SHA256SUMS.txt

Optionally uploads artifacts first and atomically swaps manifest.json on the WAN server
via --deploy-ssh root@<host>.
"""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

WS_INTEGRITY = "sha512-Ydggc987+RO0AnWtZ/7Wq9FtNvcrL1b/RO0ud9mWjUPgDrsAAwQSF51sm2hm1XofbU/4jkpGEsLFsZZxU+1DOg=="
MANIFEST_DOMAIN_PREFIX = "anywhere-mesh-update-v1\n"
LINUX_RUNTIME_ABI = "e45.3.3-n24.21.0-et2.6.4-lin"

WIN_FILES = {
    "desktop": ["main.cjs", "builtin-browser.cjs", "package.json", "contract.cjs", "updater-core.mjs", "updater.cjs", "apply-update.mjs"],
    "desktop-commander": ["adapter.mjs"],
    "execution": ["agent.mjs", "grants.mjs", "journal.mjs", "protocol.mjs", "retention.mjs", "rpc.mjs"],
    "workspace": ["patch.mjs", "catalog.mjs", "bg-processes.mjs"],
    "browser": ["settings.mjs", "accessibility.mjs", "cdp-client.mjs", "external-mcp.mjs", "manager.mjs"],
    "account-devices": [
        "client.mjs", "remembered-login.mjs", "server-config.mjs", "contract.cjs", "preload.cjs",
        "ui/index.html", "ui/app.js", "ui/thread.js", "ui/session-cache.js", "ui/style.css",
        "ui/manifest.webmanifest", "ui/sw.js", "ui/icon-192.png", "ui/icon-512.png",
        "windows/controller.mjs", "windows/client.mjs", "windows/network.mjs", "windows/read.mjs", "windows/tasks.mjs",
    ],
}

LINUX_FILES = {
    "desktop": ["main.cjs", "builtin-browser.cjs", "package.json", "contract.cjs", "updater-core.mjs", "updater.cjs", "apply-update.mjs"],
    "desktop-commander": ["adapter.mjs"],
    "execution": ["agent.mjs", "grants.mjs", "journal.mjs", "protocol.mjs", "retention.mjs", "rpc.mjs"],
    "workspace": ["patch.mjs", "catalog.mjs", "bg-processes.mjs"],
    "browser": ["settings.mjs", "accessibility.mjs", "cdp-client.mjs", "external-mcp.mjs", "manager.mjs"],
    "account-devices": [
        "client.mjs", "remembered-login.mjs", "server-config.mjs", "contract.cjs", "preload.cjs",
        "linux-agent.mjs", "linux-workspace.mjs",
        "linux/network.mjs", "linux/client.mjs", "linux/controller.mjs",
        "linux/agent.sh", "linux/anywhere-mesh-agent.service.example",
        "ui/index.html", "ui/app.js", "ui/thread.js", "ui/session-cache.js", "ui/style.css",
        "ui/manifest.webmanifest", "ui/sw.js", "ui/icon-192.png", "ui/icon-512.png",
    ],
}


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def canonical_json(obj) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sign_manifest(manifest: dict, private_key_path: Path) -> dict:
    clean = {k: v for k, v in manifest.items() if k != "signature"}
    payload = (MANIFEST_DOMAIN_PREFIX + canonical_json(clean)).encode("utf-8")
    try:
        from cryptography.hazmat.primitives.serialization import load_pem_private_key
        key = load_pem_private_key(private_key_path.read_bytes(), password=None)
        sig_bytes = key.sign(payload)
    except ImportError:
        with tempfile.TemporaryDirectory() as tmp:
            in_path = Path(tmp) / "payload.bin"
            sig_path = Path(tmp) / "sig.bin"
            in_path.write_bytes(payload)
            subprocess.run(
                ["openssl", "pkeyutl", "-sign", "-inkey", str(private_key_path), "-rawin",
                 "-in", str(in_path), "-out", str(sig_path)],
                check=True,
            )
            sig_bytes = sig_path.read_bytes()
    return {**clean, "signature": base64.b64encode(sig_bytes).decode("ascii")}


def compute_windows_runtime_abi(src_root: Path) -> str:
    win_dir = src_root / "src/account-devices/windows"
    h = hashlib.sha256()
    for cs_name in ("WorkspaceSnapshot.cs", "PeerHost.cs", "TaskHost.cs", "LoginProtection.cs"):
        h.update((win_dir / cs_name).read_bytes())
    return f"e45.3.3-n24.21.0-et2.6.4-win-{h.hexdigest()[:8]}"


def add_tar_bytes(tar: tarfile.TarFile, arcname: str, data: bytes, mode: int = 0o644):
    info = tarfile.TarInfo(name=arcname)
    info.size = len(data)
    info.mode = mode
    info.mtime = 0
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    tar.addfile(info, io.BytesIO(data))


def build_app_bundle(
    src_root: Path,
    file_map: dict,
    ws_archive: Path,
    dc_archive: Path | None,
    version: str,
    runtime_abi: str,
    out_path: Path,
):
    modules = src_root / "src"
    ws_integrity = "sha512-" + base64.b64encode(hashlib.sha512(ws_archive.read_bytes()).digest()).decode()
    if ws_integrity != WS_INTEGRITY:
        raise SystemExit("ws archive checksum mismatch")

    if dc_archive is not None:
        vendor = json.loads((modules / "desktop-commander/vendor/provenance.json").read_text(encoding="utf-8"))
        if sha256_file(dc_archive) != vendor["sha256"]:
            raise SystemExit("Desktop Commander archive checksum mismatch")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(out_path, "w:gz", format=tarfile.PAX_FORMAT) as out_tar:
        pkg_bytes = (json.dumps({
            "name": "anywhere-mesh",
            "productName": "AnywhereMesh",
            "version": version,
            "runtimeAbi": runtime_abi,
            "main": "src/desktop/main.cjs",
        }, indent=2) + "\n").encode("utf-8")
        add_tar_bytes(out_tar, "package.json", pkg_bytes, 0o644)

        for module, names in file_map.items():
            for name in names:
                file_path = modules / module / name
                mode = 0o755 if (name.endswith(".sh") or name == "linux-agent.mjs") else 0o644
                add_tar_bytes(out_tar, f"src/{module}/{name}", file_path.read_bytes(), mode)

        with tarfile.open(ws_archive, "r:gz") as ws_tar:
            for member in ws_tar.getmembers():
                p = Path(member.name)
                if member.isfile() and p.parts[0] == "package" and ".." not in p.parts:
                    rel = p.relative_to("package").as_posix()
                    add_tar_bytes(out_tar, f"src/execution/node_modules/ws/{rel}", ws_tar.extractfile(member).read(), 0o644)

        if dc_archive is not None:
            with tarfile.open(dc_archive, "r:gz") as dc_tar:
                for src_name, dst_name in [("dist/utils/files/text.js", "text.mjs"), ("LICENSE", "LICENSE")]:
                    add_tar_bytes(
                        out_tar,
                        f"src/account-devices/windows/vendor/{dst_name}",
                        dc_tar.extractfile("package/" + src_name).read(),
                        0o644,
                    )

    return {
        "path": out_path,
        "sha256": sha256_file(out_path),
        "size": out_path.stat().st_size,
    }


def deploy_over_ssh(stage_dir: Path, ssh_target: str, remote_dir: str):
    subprocess.run(
        ["ssh", ssh_target, f"mkdir -p {remote_dir} && chown anywhere-wan:anywhere-wan {remote_dir} || true"],
        check=True,
    )
    # Upload artifacts FIRST so manifest.json never references missing files
    artifacts = [p for p in sorted(stage_dir.iterdir()) if p.is_file() and p.name != "manifest.json"]
    if artifacts:
        subprocess.run(["scp", *[str(p) for p in artifacts], f"{ssh_target}:{remote_dir}/"], check=True)
    # Upload manifest.json to temp name then atomically mv into place
    manifest = stage_dir / "manifest.json"
    remote_tmp = f"{remote_dir}/manifest.json.next"
    remote_final = f"{remote_dir}/manifest.json"
    subprocess.run(["scp", str(manifest), f"{ssh_target}:{remote_tmp}"], check=True)
    subprocess.run(
        ["ssh", ssh_target,
         f"chmod 644 {remote_dir}/* && chown -R anywhere-wan:anywhere-wan {remote_dir} && mv -f {remote_tmp} {remote_final}"],
        check=True,
    )


def main():
    parser = argparse.ArgumentParser(description="Build & sign AnywhereMesh auto-update release artifacts.")
    parser.add_argument("--ws", required=True, type=Path, help="Path to pinned ws-8.22.0.tgz")
    parser.add_argument("--dc", required=True, type=Path, help="Path to pinned desktop-commander-0.3.3.tgz")
    parser.add_argument("--signing-key", required=True, type=Path, help="Path to offline Ed25519 private key PEM")
    parser.add_argument("--output-dir", required=True, type=Path, help="Staging directory for manifest + artifacts")
    parser.add_argument("--channel", default="stable", help="Release channel (default: stable)")
    parser.add_argument("--notes", default="", help="Release notes markdown text")
    parser.add_argument("--notes-file", type=Path, default=None, help="Path to release notes markdown file")
    parser.add_argument("--win-installer", type=Path, default=None, help="Optional full Windows Setup.exe")
    parser.add_argument("--linux-archive", type=Path, default=None, help="Optional full Linux x64 tar.gz")
    parser.add_argument("--deploy-ssh", default=None, help="Optional SSH target (e.g. root@mesh.example.com)")
    parser.add_argument("--remote-dir", default="/var/lib/anywhere-wan/updates", help="Remote updates directory")
    args = parser.parse_args()

    src_root = Path(__file__).resolve().parents[3]
    version = json.loads((src_root / "package.json").read_text(encoding="utf-8"))["version"]
    win_abi = compute_windows_runtime_abi(src_root)
    lin_abi = LINUX_RUNTIME_ABI

    notes = args.notes
    if args.notes_file is not None:
        notes = args.notes_file.read_text(encoding="utf-8").strip()

    out_dir = args.output_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    win_bundle_name = f"anywhere-mesh-app-{version}-win32-x64.tar.gz"
    lin_bundle_name = f"anywhere-mesh-app-{version}-linux-x64.tar.gz"

    win_bundle = build_app_bundle(src_root, WIN_FILES, args.ws, args.dc, version, win_abi, out_dir / win_bundle_name)
    lin_bundle = build_app_bundle(src_root, LINUX_FILES, args.ws, None, version, lin_abi, out_dir / lin_bundle_name)

    targets = {
        "win32-x64": {
            "bundle": {
                "url": f"/updates/{win_bundle_name}",
                "sha256": win_bundle["sha256"],
                "size": win_bundle["size"],
                "runtimeAbi": win_abi,
            },
        },
        "linux-x64": {
            "bundle": {
                "url": f"/updates/{lin_bundle_name}",
                "sha256": lin_bundle["sha256"],
                "size": lin_bundle["size"],
                "runtimeAbi": lin_abi,
            },
        },
    }

    checksums = [
        f"{win_bundle['sha256']}  {win_bundle_name}",
        f"{lin_bundle['sha256']}  {lin_bundle_name}",
    ]

    if args.win_installer is not None:
        dst_name = args.win_installer.name
        dst_path = out_dir / dst_name
        if args.win_installer.resolve() != dst_path:
            shutil.copyfile(args.win_installer, dst_path)
        sha = sha256_file(dst_path)
        targets["win32-x64"]["full"] = {
            "url": f"/updates/{dst_name}",
            "sha256": sha,
            "size": dst_path.stat().st_size,
            "kind": "nsis",
        }
        checksums.append(f"{sha}  {dst_name}")

    if args.linux_archive is not None:
        dst_name = args.linux_archive.name
        dst_path = out_dir / dst_name
        if args.linux_archive.resolve() != dst_path:
            shutil.copyfile(args.linux_archive, dst_path)
        sha = sha256_file(dst_path)
        targets["linux-x64"]["full"] = {
            "url": f"/updates/{dst_name}",
            "sha256": sha,
            "size": dst_path.stat().st_size,
            "kind": "linux-tar",
        }
        checksums.append(f"{sha}  {dst_name}")

    manifest = {
        "schemaVersion": 1,
        "channel": args.channel,
        "version": version,
        "publishedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "notes": notes,
        "targets": targets,
    }
    signed = sign_manifest(manifest, args.signing_key)
    (out_dir / "manifest.json").write_text(json.dumps(signed, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (out_dir / "SHA256SUMS.txt").write_text("\n".join(checksums) + "\n", encoding="utf-8")

    print(f"Published signed update manifest v{version} -> {out_dir}")
    print(f"  win32-x64 bundle: {win_bundle_name} ({win_bundle['size'] / 1024:.1f} KiB, abi={win_abi})")
    print(f"  linux-x64 bundle: {lin_bundle_name} ({lin_bundle['size'] / 1024:.1f} KiB, abi={lin_abi})")

    if args.deploy_ssh:
        deploy_over_ssh(out_dir, args.deploy_ssh, args.remote_dir)
        print(f"Uploaded and activated on {args.deploy_ssh}:{args.remote_dir}")


if __name__ == "__main__":
    main()
