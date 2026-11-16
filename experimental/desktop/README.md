# Linux desktop minimum (D subset)

This is an operable Electron shell in the existing fnOS-managed Ubuntu VM. It connects the existing network helper, domestic permission authority, reliable execution protocol and real Desktop Commander MCP. The US host is a **mock**; no Claude/Codex CLI, account or model credentials are used. The original Anywhere instance on NAS port 3210 is not built, restarted or contacted by the shell.

## Use

Open **fnOS → Virtual Machine → anywhere-lab → console / VNC**. The experiment uses an Xorg/Openbox display at 1280×800. The last deployment leaves the window open, initially disconnected and revoked. No display/UI/execution unit is enabled for automatic startup.

1. Click **连接设备**, then select **只读** and **读取说明**.
2. Select **编辑**, then **追加记录**. The read revision is checked before writing; reread after an external edit.
3. Select **执行**, confirm the workspace, then **构建与测试**. The actual offline command builds the fixture and runs two tests.
4. **运行长任务** produces live output and can be cancelled. Cancellation is shown as complete only after device confirmation.
5. **断开连接** revokes local permission first. Permission controls still work offline. Closing the window exits, revokes, stops D services and releases leases; there is no tray mode yet.

For an unknown task, revoke permission, inspect effects locally, then use **本地核对** with an observation. The result stays unknown, the audit is retained, and the original task is never automatically replayed. In this fixed fixture, an administrator can inspect files from a VM terminal using `sudo -u anywhere-exec-agent cat /srv/anywhere-lab/desktop-d/workspace/notes.txt`. A general local inspection/file-picker flow is still pending.

To reopen from the NAS (this wrapper addresses only the VM):

```bash
bash /vol1/1000/anywhere-crossborder-lab/scripts/ssh-guest.sh \
  'sudo -n systemctl start anywhere-desktop-ui.service'
```

After a VM reboot, first restore the experiment Docker topology and namespace links as described in the lab root README / network-helper module. Starting the display alone does not recreate those prerequisites.

## Isolation and lifecycle

- Source: NAS independent Git branch `feature/linux-desktop-minimal`; build/test only in `/srv/anywhere-lab/source` inside the VM.
- Root-owned application: `/usr/lib/anywhere-desktop-runtime/`; fixed Electron binary: `/usr/lib/anywhere-desktop-electron/`.
- Runtime data, workspace and private desktop profile: `/srv/anywhere-lab/desktop-d/`; new workspace identity `desktop-d-fixture`. B1/DC/B2/C histories remain separate.
- Services: `anywhere-desktop-agent`, `anywhere-desktop-broker`, `anywhere-desktop-display`, `anywhere-desktop-ui`. `*-ui-smoke` and `*-crash-test` are manual test units only.
- The mock host holds the US helper lease while the desktop is open; the domestic lease is acquired on Connect. While open, D replaces only the helper experiment's US mock container on port 8443. Exit restores that container. The stage 0 topology and isolated web 3211 remain running.
- App runs as VM user `lab`; Agent and Broker retain separate service users and resource limits. Commands run in the existing offline Bubblewrap sandbox. Chromium's renderer has a user namespace/seccomp sandbox, `contextIsolation`, no Node integration, restrictive CSP, denied navigation/downloads/permissions and an exact-frame IPC check. The renderer sees only a small operation-specific bridge, not keys, tokens, system commands or arbitrary paths.
- GPU acceleration is disabled. The dedicated AppArmor profile permits user namespaces only for the fixed root-owned Electron executable; global Ubuntu userns restrictions remain enabled. `chrome-sandbox` is not setuid. `--disable-setuid-sandbox` selects the user namespace path; `--no-sandbox` is never used.
- The main process owns a separate system Node controller. Normal close or stdin EOF performs cleanup. A dead controller makes the UI exit, and the systemd `ExecStopPost` stops only D execution cgroups and restores the fixture. Helper leases also expire on lost clients. Start via the documented unit to obtain this fallback.

The controller in this experiment is both the trusted mock host and the local UI adapter. It can use the VM's pre-existing `lab` sudo permission to manage **fixed experiment services**. This is not the final desktop privilege/remote-host design; production requires a narrowly scoped installer/helper or polkit boundary and separate authenticated transport.

## History, operations and limits

Each new action first persists a job with stable identity and current grant binding. Actual business calls use the real MCP SDK over stdio with a host-issued ticket. Desktop MCP is configured to return promptly and poll; the earlier profiles keep their existing waiting default. Results and all retained output pages are written to the desktop SQLite history before a consumption acknowledgment is sent.

Restart recovery uses the host-only `WorkspaceExecutor.recover`: it can query and restore an existing mapping, but cannot prepare or dispatch new work. An interrupted submission with no prepared operation stays interrupted. A fresh desktop process revokes authority and starts disconnected. Reopening or displaying a task is not a consumption receipt.

One active task; finite command deadline ≤120 seconds; tool result ≤22 KiB; command output retained ≈64 KiB with explicit truncation. The UI lists the last 50 resolved jobs; archived identities/results remain queryable. History has an admission budget, not a full disk quota. Extended disk-full/soak testing remains C work. Existing-file writes retain the optimistic check-to-replace race described in the reliability README; arbitrary command writes are outside that file-tool check.

## Reproduce (VM only)

Prerequisites: existing B2/C users, AppArmor/Bubblewrap and vendor dependencies, restored helper namespaces, Node 24.21.0 and root workspace dependencies. Before install/test, close this desktop and other execution experiments through their normal lifecycle. Installers refuse active execution profiles and preserve existing D data; they never reset old histories.

```bash
cd /srv/anywhere-lab/source
node_modules/.bin/tsc --project experimental/desktop/tsconfig.json
node_modules/.bin/vite build --config experimental/desktop/vite.config.mjs
sudo bash experimental/desktop/lab/install-electron.sh
sudo bash experimental/desktop/lab/install.sh
sudo bash experimental/desktop/lab/install-display.sh

node --test experimental/execution/test/*.test.mjs experimental/desktop-commander/test/*.test.mjs \
  experimental/workspace/test/*.test.mjs experimental/reliability/test/*.test.mjs experimental/desktop/test/*.test.mjs
node experimental/desktop/lab/integration.mjs
sudo systemctl start anywhere-desktop-ui-smoke.service
# Wait for the UI test unit to exit, then check artifacts/desktop-d-ui-smoke.json.
# Electron process exit alone is not the assertion result.
node experimental/desktop/lab/crash-check.mjs
sudo systemctl start anywhere-desktop-ui.service
```

Electron is pinned to **45.3.3 Linux x64**. ZIP SHA-256: `0a63ce0e2b6a69d6ced7194949934b8414a6dadeca82910f88dc8720a1433269`. The GitHub release API digest, official SHASUMS and ZIP integrity were checked; metadata is under the lab `vendor/electron-45.3.3/`, the download under `images/`, and upstream licenses remain beside the installed binary. Sources: [official release](https://releases.electronjs.org/release/v45.3.3), [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security).

## Current boundary

This is the first D subset, not a complete desktop product. It offers a fixed example workspace and fixed mock actions. Real chat/session transport, login, device pairing, project selection, attachments, trusted install/update/uninstall, diagnostic export, tray/suspend/resume and native OS authorization still need implementation. E adds multi-workspace routing, Git/diff/worktree/PTY, automation and legacy history migration. Keep the requested order: complete the mock workflow first; real CLI integration and model-history validation stay in final phase F. Windows/macOS remain separate later work.

Evidence under lab `artifacts/`: `desktop-d-integration.json`, `desktop-d-ui-smoke.json`, `desktop-d-crash-check.json`, `desktop-d-build.png`, `desktop-d-review.png` and the final checkpoint. Private ticket/history databases and display authentication cookies are not exported as reports.
