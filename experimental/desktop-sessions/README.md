# Linux desktop projects and sessions (D2)

This isolated experiment adds project selection, sessions and an HTTPS/WSS conversation channel to the D1 Electron shell. It reuses the existing `StoredEvent` format, timeline, tool cards, buttons and dialogs. The US session host is a **mock**, while MCP, Desktop Commander, file changes, Bubblewrap commands and the EasyTier transport are real. No model credentials or real Claude/Codex CLI are used. NAS production on port 3210 remains separate.

## Operate

Open **fnOS → Virtual Machine → anywhere-lab → console / VNC**. The D2 window opens offline with both projects revoked; saved sessions remain readable. It replaces the D1 demonstration window, retaining all D1 data.

1. Choose **项目 A · 示例服务** or **项目 B · 示例库**, then **连接设备**. Each project has its own permission and sessions.
2. Select **只读**, click **+** beside 项目会话, create a session, and send `/read notes.txt`.
3. Select **编辑**, then `/append notes.txt 一条实验记录`. First read that file in the same session; a changed file requires a new read.
4. Select **执行**, confirm locally, then `/build` or `/long`. Expand the tool card to see the real output. **停止任务** remains pending until device confirmation.
5. Switch projects while a task runs: the running task remains attached to its original workspace. Each permission button applies to the currently displayed project only.
6. **断开连接** revokes every local project first. The sidebar, cached histories and local permission controls continue working. Closing the window exits and cleans up D2 services and helper leases.

The project **+** opens a native folder dialog. This iteration accepts only these two already provisioned roots inside the VM:

```text
/srv/anywhere-lab/desktop-d2/projects/project-alpha
/srv/anywhere-lab/desktop-d2/projects/project-beta
```

Canonical path and filesystem device/inode must match the root-owned catalog. A renderer cannot submit a path or provision an arbitrary root. This is not yet a general directory onboarding flow. For an unknown result, revoke that project's permission, inspect the actual files/processes, then submit **本地核对**. The task keeps its unknown outcome and audit; it is never automatically rerun.

From NAS, reopen the window using the existing VM wrapper:

```bash
bash /vol1/1000/anywhere-crossborder-lab/scripts/ssh-guest.sh \
  'sudo -n systemctl start anywhere-desktop2-ui.service'
```

Do not run D1 and D2 concurrently. After a VM reboot, restore the lab Docker topology and helper namespace links first, as documented in the lab root README. UI/display units have no automatic startup enabled.

## Process and authority boundaries

```text
Electron renderer (local assets; no Node/network)
  → exact-frame IPC → Electron main (native folder picker)
  → system Node controller → local Unix socket
  → domestic bridge in CN namespace (local cache and permissions)
  → EasyTier → mTLS HTTPS/WSS → mock session host in US namespace
  → WorkspaceExecutor / MCP → per-workspace Broker
  → mTLS WSS → domestic Agent → Desktop Commander / Bubblewrap
```

- Runtime: `/usr/lib/anywhere-desktop2-runtime/`; private configuration: `/etc/anywhere-desktop2/`; data: `/srv/anywhere-lab/desktop-d2/`.
- Services: `anywhere-desktop2-agent-a`, `-agent-b`, `-bridge`, `-host`, `-ui`. `-smoke` and `-crash-test` are manual test units. Display reuses `anywhere-desktop-display` from D1.
- Each workspace has an immutable UUID, distinct Agent state, grant versions, client certificate and Broker journal. A session binds that ID permanently. Switching the sidebar does not change existing calls, stop requests or review targets.
- Host, desktop and two Agents use separate pinned TLS identities. A valid CA certificate alone is insufficient. Agent A cannot attach to B or use the desktop API. Account/device IDs are fixed laboratory identities; there is no account login, self-service pairing, revocation service or multi-tenant account isolation yet.
- The Electron main retains D1 sandbox, context isolation, exact-frame IPC, local asset scheme, disabled GPU and restrictive CSP. The renderer has `connect-src 'none'`; all remote traffic belongs to the CN bridge. The controller uses existing VM `lab` sudo to manage fixed experiment units. A production installer/polkit boundary remains required.
- Connect acquires both helper leases and starts the US host, temporarily replacing only stage A's US mock on port 8443. Disconnect revokes all projects and releases the CN lease; the US host remains until window exit. Cold offline startup holds neither lease. Exit restores the stage A US mock. Stage 0 and the separate web instance on 3211 keep running.
- Normal controller EOF revokes and stops the four D2 services. Unexpected controller death exits Electron, and the UI unit's `ExecStopPost` stops those cgroups. Always start via the systemd unit to retain this fallback.

## History and request recovery

The local outbox commits request ID and body before POST. The host atomically stores the message, turn identity and acceptance receipt. Duplicate IDs return the same receipt; changed parameters or session targets are rejected. Concurrent duplicates are rechecked after asynchronous readiness queries. Reconnect performs lookup-only recovery; explicit retry reuses the exact saved request. It does not create a new ID.

WSS history uses immutable session/workspace/history-epoch binding and durable sequence cursors. Replay is deduplicated; gaps, changed historical events and wrong bindings are rejected. An accepted message advances local metadata so late HTTP snapshots cannot restore an older finished turn. Project-specific histories and drafts remain separate when switching the UI.

The US host persists tool results and retained output into its history before consumption acknowledgment. Lost acknowledgments can be retried without another execution or duplicate turn ending. Restart uses recovery queries for existing call mappings, never an unconditional dispatch. Unknown tasks have no successful/end event until local review closes the blocker; review preserves unknown outcome.

Current limits: two provisioned projects, one active operation per project, 50 sessions, 256 turns, 64 MiB admission budget per journal, command deadline at most 120 seconds and retained output around 64 KiB. These are experiment bounds, not long-term quota/compaction policy. No arbitrary-root registration, attachments, package download network, long-lived PTY, tray/suspend flow, legacy history migration or full installer is delivered here. Existing file-tool final check/replace race remains documented in the reliability module; command writes are outside that revision check.

## Reproduce inside the VM

Prerequisites are the existing D1/C users, vendor packages, Bubblewrap/AppArmor, Electron 45.3.3, display and helper namespaces. No new dependency is added. Close D1/D2 before installation; installers preserve existing state and reject active profiles. Never run these commands on the NAS production checkout.

```bash
cd /srv/anywhere-lab/source
node_modules/.bin/tsc --project experimental/desktop-sessions/tsconfig.json
node_modules/.bin/vite build --config experimental/desktop-sessions/vite.config.mjs
sudo bash experimental/desktop-sessions/lab/install.sh
node --test experimental/execution/test/*.test.mjs experimental/desktop-commander/test/*.test.mjs \
  experimental/workspace/test/*.test.mjs experimental/reliability/test/*.test.mjs \
  experimental/desktop/test/*.test.mjs experimental/desktop-sessions/test/*.test.mjs
node experimental/desktop-sessions/lab/integration.mjs
sudo systemctl start anywhere-desktop2-smoke.service
# Wait for exit and inspect artifacts/desktop-d2-ui-smoke.json, not just exit code.
node experimental/desktop-sessions/lab/crash-check.mjs
sudo systemctl start anywhere-desktop2-ui.service
```

Evidence: `desktop-d2-integration.json`, `desktop-d2-ui-smoke.json`, `desktop-d2-crash-check.json`, `desktop-d2-chat.png` and `desktop-d2-checkpoint.json` under lab `artifacts/`. The GUI smoke supplies the selected directory at the native-dialog return boundary using an explicit test-only flag; subsequent root validation and full network/tool operations are real. It does not claim automated native-dialog mouse coverage. No private keys, ticket databases or display cookies are exported.

The expanded GUI checks also exercise read-only rejection, a permitted append verified against the actual file, per-session unsent drafts, and the local unknown-result review dialog. The harness waits for asynchronous dialogs and checks the confirmed terminal outcome, not merely the absence of an active turn. A prior interrupted UI-write test is explicitly inspected and reviewed through the same dialog; its journal is preserved. Review screenshots are saved as `desktop-d2-review.png`. The 2026-11-16 user-requested retest passed 57 unit tests, 8 integration checks, 7 GUI groups and 2 crash/recovery checks; earlier failed harness attempts are retained with the retest evidence.

Next: authenticated pairing and lifecycle, general root provisioning with scoped installation, attachments and E's Git/diff/worktree/PTY/automation, plus remaining C reliability tests. Real CLI adapters and model-history validation remain final phase F; Windows/macOS are later platform work.
