# Linux 网络 helper 原型

阶段 A 的实现与测试位于独立实验分支 `feature/linux-network-helper`，当前生产 Anywhere 没有接入此模块。运行验证环境为 Ubuntu 24.04、systemd 255、Python 3.12、Node 24、EasyTier 2.6.4。

`helper.py` 是原生 systemd 服务，`client.mjs` 是供后续 Electron main/本地 Agent 使用的 Node 客户端；`cli.mjs` 提供当前可用的控制台入口。无需新增 npm 依赖。Docker 只负责搭建两端的隔离网络、中继与探针；helper 和受管 EasyTier 进程实际运行在 VM 的 systemd cgroup 中。

## 已实现

- systemd socket activation；Unix socket 为 root 所有、客户端组可连接，并使用内核 `SO_PEERCRED` 核对配置中的登录 UID。
- 只接受 `start`、`renew`、`status`、`stop`，没有执行命令、指定路径、修改环境或上传配置的接口；配置与二进制由管理员安装，检查父目录权限、符号链接与 SHA-256。
- 每个端点仅允许一个持有者；重复 start 返回同一租约，其他连接无法抢占或停止它。租约绑定原连接及随机令牌，状态响应不含令牌或密钥。
- 10 秒租约、Node 客户端每约 3.3 秒续租。连接断开立即清理；连接仍在但未续租时超时清理；已到期租约不能被迟来的续租复活。
- 正常停止向受管进程组发送 TERM，再按超时发送 KILL；systemd `KillMode=control-group` 处理 helper 崩溃时的子进程回收。
- 中继中断时保持同一个 EasyTier 进程，状态变为 degraded；恢复后重新检查。内核崩溃仅在仍有租约时限速重启，默认 60 秒窗口最多重启 3 次；停止会取消等待中的重启。
- helper 以独立非 root 用户运行，仅保留 NET_ADMIN、NET_RAW，运行在预先准备的独立网络命名空间；只读系统、设备访问限制、资源限额和禁止 core dump 已配置。
- 4 KiB 请求帧、最多 8 条控制连接、探测输出及请求等待均有上限；不把 EasyTier 原始输出或私钥写入状态和日志。

同一登录 UID 的进程属于这里的调用方信任范围，这不是可执行文件签名验证。后续项目命令隔离仍须限制其访问控制 socket。OS 管理员可以修改安装文件，属于管理员信任范围。

## 状态与协议

按行传输 JSON，版本为 1。`id` 是客户端请求编号，每个响应对应同一个编号。

```json
{"version":1,"id":"request-1","method":"start"}
{"version":1,"id":"request-2","method":"renew","lease":"<start 返回的令牌>"}
{"version":1,"id":"request-3","method":"status"}
{"version":1,"id":"request-4","method":"stop","lease":"<同一连接的令牌>"}
```

状态包括 idle、starting、connected、degraded、restarting、stopping、failed。connected 只表示预期 TUN 地址与固定 WSS 中继均已确认；业务 mTLS/设备会话的就绪和恢复应由后续执行协议分别确认。helper 或控制连接丢失后，Node 客户端不会自动重新取得租约，也不会重放业务操作。

关闭窗口但保留桌面主进程时，主进程可以继续持有租约；明确退出时调用 `client.close()`。close 可并发重复调用，只发送一次 stop。

## 在实验 VM 中使用

本机测试配置在 `/srv/anywhere-lab/helper-a/`，与阶段 0 的 `anywhere-lab` Compose 项目、身份和网络分开。阶段 A 的 Compose 项目名为 `anywhere-helper`，底层网段为 172.31.10/24 和 172.31.20/24。

重新部署或 VM 重启后，在 VM 内执行：

```bash
sudo bash /srv/anywhere-lab/source/native/linux/network-helper/lab/install.sh
cd /srv/anywhere-lab/source
npm run network-helper -- status /run/anywhere-network/cn.sock
```

安装脚本受 VM 身份检查保护，只处理本模块的服务和测试项目；不启用开机自启。它重新定位 Docker 测试命名空间，生成受保护的固定 profile，并开启两个控制 socket。管理员安装结束后，下面的控制命令以普通 `lab` 用户运行，不加 sudo。

在两个终端分别持有 CN/US 租约：

```bash
npm run network-helper -- hold /run/anywhere-network/cn.sock
npm run network-helper -- hold /run/anywhere-network/us.sock
```

两端均 connected 后，可在第三个终端执行：

```bash
docker exec anywhere-helper-cn-probe-1 python /probe/probe.py
```

对 hold 进程按 Ctrl+C 即释放对应隧道。只运行 status 不会启动 EasyTier。socket/helper 可以保持 idle，测试网络基础设施可以保留；退出后不应存在本产品 TUN、虚拟路由和受管 EasyTier 子进程。

如需停止全部阶段 A 测试基础设施，先停止两个 socket/service，再执行对应 Compose down；不要在 helper 持有租约时自行重建承载它的网络命名空间。

```bash
sudo systemctl stop anywhere-network@cn.socket anywhere-network@us.socket anywhere-network@cn.service anywhere-network@us.service
cd /srv/anywhere-lab/helper-a/config/topology
sudo env HELPER_UID="$(id -u anywhere-net)" docker compose --project-name anywhere-helper down
```

## 验证结果

```bash
cd /srv/anywhere-lab/source
npm run test:network-helper
npm run test:network-helper:integration
```

12 项 Python 测试覆盖输入限制、可信文件、租约、所有权、网络中断、重启预算和 spawn/退出竞态；3 项 Node 测试覆盖并发关闭、控制连接丢失和超大响应。测试均在 VM 内运行通过。

12 项真实集成检查通过，包括非 root 能力边界、mTLS、拒绝无证书、拒绝底层直连/管理 RPC、拒绝确实存在的未授权虚拟网监听端口、中继停止与恢复、EasyTier 崩溃重启、正常退出、客户端 SIGKILL、租约过期与 helper SIGKILL 的 cgroup 清理。

本次客户端 SIGKILL 后回收约 264 ms；保持连接但停止续租后约 10.39 秒回收。启动、稳定期、中继重连、进程重启和退出期间抓到的 495 个底层 IP 包全部为批准的中继 TCP 端口，UDP 为 0。这是本轮实验结果，不是服务时延承诺。

证据在实验根目录 `artifacts/helper-a-integration.json`、`helper-a-cn.pcap`、`helper-a-packet-summary.txt`，测试输出在 `logs/helper-a-unit.log` 和 `helper-a-integration.log`。当前两个 helper 最终均为 idle，无租约和 TUN。

## 尚未实现的产品部分

本轮是 Linux 网络原型。正式安装包、首次图形授权、真实网卡/DNS 地址更新策略、备用中继、休眠唤醒、Electron 托盘/升级、Windows/macOS 适配仍需后续实现与验收；测试命名空间来自 Docker 并不意味着最终用户必须安装 Docker。国内任务 RPC、持久任务、断线对账和双 CLI 尚未接入。

管理员可替换 EasyTier 二进制并更新 profile 摘要，普通客户端不能覆盖。第三方版本、哈希、来源和许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

实现依据：[systemd socket activation](https://www.freedesktop.org/software/systemd/man/latest/systemd.socket.html)、[systemd 执行与网络命名空间配置](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)。运行时以本机 systemd 255 的验证结果为准。
