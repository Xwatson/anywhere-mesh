# Desktop Commander 适配验证（Linux VM）

这是 B2 的候选执行器验证，复用 Desktop Commander 的文件、编辑、搜索和进程实现，经真实 stdio MCP 调用。美国侧仍使用模拟调用方；没有接入真实 Claude/Codex CLI、模型或其凭据。生产 Anywhere 应用不使用本模块。

调用链：模拟工具调用 → B1 Broker 持久任务 → mTLS WSS / EasyTier → 国内 Agent → 受信任 MCP 适配进程 → Bubblewrap 沙箱中的 Desktop Commander → 专用工作区。

## 固定依赖与兼容补丁

- Desktop Commander `0.3.3`，源提交 `bce370e9395f5bc74eda34913e5ae1dee48df8f8`，MIT；来源、下载摘要、许可证见 `vendor/`。
- MCP SDK `1.32.1`，完整依赖由 `vendor/package-lock.json` 锁定。安装使用 `npm ci --ignore-scripts --no-audit --no-fund`，不执行安装统计或下载脚本。Ubuntu 软件包提供 `ripgrep` 和 `bubblewrap`。
- 配置预置 `telemetryEnabled: false`；每次运行创建独立 HOME，并清空继承环境。沙箱没有外网接口，不依赖仅关闭遥测来限制外连。
- `lab/patch-vendor.py` 在应用前校验上游文件 SHA-256，保留 `.upstream` 原件，记录修改前后摘要。补丁增加进程输出的结构化结束状态/退出码、保留上游原本在 MCP 出口删去的进程/搜索结构化字段、补齐未匹配编辑及多文件读取失败的 `isError`，并在专用环境变量开启时跳过远程 feature flags、Chrome 自动预下载和 Office/PDF 预加载。另外，将进程完成事件从 `exit` 改为 `close`，等待输出管道读完；受 CPU 配额限制时曾复现 stdin 命令退出却丢失最后输出，修复后 6 次专项回归均收到完整输出。仍复用上游文件、编辑、搜索和进程实现；升级必须重新核对补丁和回归。

## 当前入口

| 适配操作 | 复用的上游工具 | 限制 |
| --- | --- | --- |
| `dc.tool` | read_file、read_multiple_files、write_file、edit_block、create_directory、list_directory、get_file_info | 相对路径、固定工作区、文本参数限额；写权限独立检查 |
| `dc.search` | start_search、get_more_search_results | 同一个任务内完成搜索；最多 50 条、10 秒搜索期限；返回不完整标记 |
| `dc.run` | start_process、read_process_output、interact_with_process | 有限命令、可选一次 stdin；真实结束才完成；不把开始执行/等待超时当作成功 |
| `dc.inspect` | MCP initialize、tools/list | 实验诊断入口，只返回版本、工具名及参数字段 |

不上送任意 MCP 工具名、PID、shell 配置、环境变量、绝对工作区根路径。`set_config_value`、`kill_process` 等不在适配入口中。上游发现的工具数量不等于已经开放和验证的工具数量。写入必须显式选择 `rewrite` 或 `append`。

## 隔离与任务语义

每个任务有新 MCP server、用户/挂载/PID/网络命名空间。只映射批准的 `/workspace`、只读 `/usr` 和运行时、临时 HOME/tmp、局部 proc/dev。控制连接和凭据留在沙箱外；命令看不到 Agent 的证书、网络 helper socket、NAS 路径或开发源码。只读模式使用只读挂载，shell 也不能写工作区。PID 命名空间用于收掉 `setsid()` 脱离原进程组的后代，外层 systemd cgroup 负责服务退出清理。

专用 systemd 服务为非 root、零宿主 capabilities、`NoNewPrivileges=yes`，内存上限 768 MiB、CPU 配额 75%、128 tasks；同一 Agent 只并行一个任务。系统 AppArmor 的用户命名空间限制保持开启，仅对 root 所有的专用 bwrap 副本授权。DC Agent 允许 AF_NETLINK，使 bwrap 能初始化新网络命名空间的 loopback；它没有宿主网络管理能力。`ProtectKernelTunables` 的 proc 子挂载会阻止非特权沙箱挂载自己的 proc，因此此实验 Agent 关闭该项，仍由非 root UID、DAC、零 capabilities 和沙箱挂载控制限制内核参数写入；其他服务不变。

B1 保留操作身份、请求哈希、取消意图、输出序号和结果消费状态。MCP server 的内存 PID/session 不用于跨重启恢复。断网时已启动任务继续执行，恢复后按 B1 日志补传。Agent 崩溃、传输异常或执行后无法交付完整结果时保留 `unknown`，阻止自动重做。调用有失败结果不意味着文件事务回滚。

结构化结果通过沙箱外适配进程的独立 FD 交回 Agent，不从命令输出文本解析退出码。结果限 22 KiB；超限明确保留 unknown，不静默截断文件结果。命令 stdout/stderr 沿用上游合并输出，尚不保留每行的流来源；合并日志进入 B1 的 64 KiB 保留窗口，截断有显式 gap。DC 同步每次一个任务，输出页另限 16 KiB 编码大小，避免超出 64 KiB WSS 帧。

## 在实验 VM 重现

前提：阶段 A 拓扑、helper、阶段 B1 固定运行时和测试证书已安装，B1 实验服务处于停止状态。只在通过 `/srv/anywhere-lab/scripts/guest-guard.sh` 检查的客体执行：

```bash
# vendor/package*.json 已复制到此目录；不要在生产项目安装依赖。
cd /srv/anywhere-lab/vendor/desktop-commander-0.3.3
npm ci --ignore-scripts --no-audit --no-fund
sudo bash /srv/anywhere-lab/source/experimental/desktop-commander/lab/install.sh
cd /srv/anywhere-lab/source
node --test experimental/execution/test/*.test.mjs experimental/desktop-commander/test/*.test.mjs
node experimental/desktop-commander/lab/integration.mjs
```

首次准备运行时需管理员建立 lab 可写的 vendor 目录；安装脚本随后将其归 root 所有并取消普通用户写权限。再次 `npm ci` 前应另建可写 staging 目录，验证后由管理员替换，不能直接在已加固目录安装。

安装路径 `/usr/lib/anywhere-dc-runtime/`；状态、工作区和归档 `/srv/anywhere-lab/desktop-c/`；专用服务 `anywhere-dc-agent`、`anywhere-dc-broker`，不启用开机自启。测试开始先归档上一轮状态和工作区；结束停止实验服务、恢复阶段 A mock、释放租约。原 B1 的 unknown 记录不会被本测试覆盖。

证据位于客体及 NAS 实验根目录的 `artifacts/desktop-commander-*.json` 和 `logs/desktop-commander-*.log`。最终集成结果、工具发现清单、保留的 unknown 日志、补丁摘要和收尾状态分别记录，不只依赖终端截图。

2026-11-15 最终验收：22 项单元测试、14 项集成检查通过，另有 6 次 stdin 输出专项回归。实际 MCP 发现 25 个工具；23 个启动计时样本的中位数 526 ms（506–564 ms），CPU 配额为 75%。最后保留一条真实追加写入后的 unknown 记录，副作用只发生一次。测试后两端实验服务停止、helper idle、原探针恢复；完整结果见 `desktop-commander-final-state.json`。

## 仍需完成

本轮不代表 B2 或整个产品完成。未覆盖 Windows/macOS、图形桌面、浏览器/Office/PDF 工具、长期 PTY/REPL 会话、依赖在线安装、多项目并发、并发本地编辑的原子冲突保护，以及正式沙箱安装/升级/卸载流程。后续统一工具接口和动态权限撤销的实验实现见 [Workspace MCP](../workspace/README.md)。当前新建 MCP server 的启动成本需要后续评估；不能直接通过共用长期 session 规避成本而丢失任务隔离和崩溃语义。

工作区授权、任务可靠性和平台隔离由 Anywhere 负责，Desktop Commander 提供执行能力。最终 F 阶段仍须检查两种真实 CLI 的工具发现、调用关联、上下文消费、停止/恢复及实际编程效果，不能以本轮测试宣称模型能力与本地 CLI 等价。
