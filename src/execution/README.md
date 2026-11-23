# 可恢复执行协议实验（阶段 B1）

本模块在 Ubuntu 24.04 实验 VM 内运行，使用真实 EasyTier、中继、mTLS WSS 和双端 SQLite 日志；任务进程是固定的模拟程序。**没有接入真实 Claude/Codex、生产服务或模型凭证，也没有开放任意 shell、文件工具或 PTY。**

用户已确定：先用模拟宿主把协议、工作区执行、桌面及功能链路跑通，两种真实 CLI 放到最后的 F 阶段接入验收。B1 是协议闭环原型，后续 B2 才接入受限工作区工具和统一 WorkspaceExecutor/MCP。

## 运行位置

代码主副本在 NAS `/vol1/1000/anywhere-crossborder-lab/source/experimental/execution/`；明确同步到 VM 后才安装和测试。独立分支为 `feature/durable-execution-loop`。当前生产源码只更新研究文档。

| 组件 | 位置与权限 |
| --- | --- |
| 国内 Agent | `anywhere-execution-agent.service`，专用非 root 用户，进入阶段 A 的 CN netns |
| 美国 broker | `anywhere-execution-broker.service`，另一个专用非 root 用户，进入 US netns |
| 业务链路 | CN 主动连接 `wss://10.126.10.2:8443/device`；独立应用层 mTLS、证书指纹与设备绑定 |
| 网络管理 | 复用阶段 A helper；集成测试持有两端租约，业务进程没有 NET_ADMIN/NET_RAW 或控制 socket 权限 |
| 代码安装 | `/usr/lib/anywhere-execution/`，只安装本模块和锁定的 `ws` 8.22.0，root 所有、服务只读 |
| 身份与配置 | `/etc/anywhere-execution/{agent,broker}/`，root 管理，只给相应服务读取 |
| 持久数据 | `/srv/anywhere-lab/execution-b/{agent,broker}/journal.sqlite`，SQLite WAL + `synchronous=FULL` |
| 模拟副作用 | Agent 私有目录的 `mock-effects.jsonl`，独立 fsync，用来观察有无重复执行 |
| 本地控制 | broker 私有目录 `control.sock`，0660、实验 lab 组；不在网络上开放控制 API |

服务配置含 cgroup 回收、内存/CPU/进程数限制、空 capability 集、NoNewPrivileges、只读系统与独立可写目录。系统调用 `flock` 持有 Agent 生命周期锁，第二实例不能并行使用同一日志。服务与 VM 实验均不设置自动启动。VM 的虚拟磁盘继续保留在已批准的 `/vol1/vm/pool/`。

## 协议与不变量

`protocol.mjs` 定义版本、能力、规范化摘要与范围校验。当前只声明 `mock.task.v1`：参数为有限步骤数、间隔、输出量、退出码及是否创建一个受管子进程。任意命令、环境变量、绝对目录或额外字段均被拒绝。

每次调用带稳定 `accountId/deviceId/workspaceId/sessionId/turnId/turnEpoch/grantVersion`。broker 根据本地配对范围填充执行目标；真实 CLI 的可信调用上下文桥接尚未实现。实验中的调用标识由受信任测试宿主提供，不能类推为模型自己产生的可信身份。

- broker 在派发前持久登记 `(session, turn, epoch, toolCallId) → operationId → requestHash`；Agent 登记稳定 `taskId`。摘要包含目标、能力、参数、cwd、期限和授权版本，不包含可变连接代次。
- 相同操作返回原记录；相同编号参数不同拒绝。传输超时保留未确认状态，连接层不自动重放任务。确认国内没有记录后，只有显式重试原编号才可派发。
- 本地 `accepted → running` 的启动意图先落盘，结果也先落盘再传输。Agent 重启将未决记录变成 `unknown`，保留证据、阻止同工作区新操作，不能因新 `toolCallId` 绕过。
- 当前保守恢复不会重新接管旧 PID，也没有“自动解决 unknown”。安装的 systemd service 先清理旧进程 cgroup；已经发生的文件或外部副作用仍可能未知。
- 每次连接重新认证，broker 持久递增 epoch，关闭旧连接；Agent 保存最高 epoch 并拒绝旧代次。网络恢复先补交持久停止/取消意图，再核对任务和输出。
- broker 与 Agent 各有主动心跳。单次 RPC 等待 8 秒，国内心跳每 3 秒；重连退避有抖动、上限约 6.25 秒。心跳失败关闭连接，不把运行中任务当作失败。
- 取消记录在启动前生效时保留 tombstone；运行中先 `cancelling`，确认固定模拟程序的进程组停止后才 `cancelled`。完成先落盘时保留真实成功/失败；取消 unknown 仍是 unknown。停止回合的标记持久化，恢复后拒绝迟到新任务。
- stdout/stderr 分块落盘，序号单调；broker 原子保存输出和游标之后才确认。两端每任务各保留至多约 64 KiB，截断报告 `firstAvailableSeq/truncatedThrough` 和 gap，不能静默跳过。
- 每帧最多 64 KiB、待响应请求最多 16、发送缓冲上限 128 KiB，日志分页最多两任务、每任务八块。通知合并；取消属于控制请求，不等待全部日志补传。
- 当前每端最多 128 个操作，不清理操作/取消身份；容量满拒绝新操作，不能因为记录清理而重新执行旧编号。生产保留期与归档迁移仍属于后续工作。

网络 `ready` 与业务恢复门槛分开。未确认、未接收、unknown 或尚未消费的终态结果都会阻止同工作区新执行。CLI/推理 idle、任务终态、broker 接收、界面展示与宿主消费分别记录；只展示结果不会解除恢复门槛，也不会提前把整体任务标为完成。

`MockRunner` 有独立 SQLite 回执：先将结构化结果、范围和缺失输出信息写入模拟历史，再确认 `consumed`。回执丢失只重复确认，不重复模拟任务或重复写入模拟历史。这验证的是可控消费者模型；不代表真实 CLI 已经支持原工具调用恢复、原子写入历史或可靠消费确认。

## 复测

以下命令在 VM 内运行，安装和集成脚本会检查实验客体身份：

```bash
cd /srv/anywhere-lab/source
npm ci --offline
sudo bash experimental/execution/lab/install.sh
npm run test:execution
npm run test:execution:integration
```

通常已有依赖，无需重复 `npm ci`。依赖安装和运行都不能在生产目录进行。集成测试会暂时停止阶段 A 的 `anywhere-helper-us-mock-1`，使用其已批准的 8443 端口；结束时恢复该探针、停止 B 服务、清除附加延迟、释放 helper 租约。阶段 0 拓扑和实验网页继续运行。

每次故障组使用独立日志：仅在两个 B 服务均停止后，将之前的数据库和副作用文件移动到 `execution-b/archive/<run>-<case>/`，不覆盖之前证据。**归档重置只用于测试隔离，不是产品恢复逻辑。** 最后一组故意留下 unknown 数据作为证据，服务处于停止状态。

## 已验证与后续工作

16 项单元测试覆盖去重、摘要冲突、权限、拒绝非声明能力、过期、取消竞态、旧代次、崩溃恢复、输出截断、完成门槛和模拟消费回执。18 项真实集成检查覆盖 mTLS/设备绑定、低权限与重复实例、真实中继断网、任务继续、离线取消、broker 重启、丢失启动响应、输出补传/截断、400 ms 延迟，以及以下 Agent 强制退出窗口：接收落盘后、启动意图落盘后、进程创建后、结果落盘前。unknown 均未自动重复执行。

证据在实验根目录 `artifacts/execution-b-integration.json`、`execution-b-normal-snapshot.json`、`execution-b-checkpoint.json` 与 `logs/execution-b-tests.log`，各次模拟历史数据库保留在客体 artifacts 中。测试数不等于完整产品验收，尚无真实跨国或长时间压力结果。

下一步 B2：明确 WorkspaceExecutor 契约，增加国内读、改、搜、补丁及受隔离的构建/测试，再通过模拟宿主/Workspace MCP 验证；继续复用本模块的稳定编号、取消和恢复门槛。随后补充 C–E 的授权收紧、历史代次、文件冲突、Git/PTY、桌面与部署体验。真实 CLI 最后在 F 阶段逐一验证可信调用关联、工具路由、审批、取消、输出、resume/压缩/子代理和结果消费。

固定 mock worker 与 Agent 当前使用同一执行 UID，仅能运行安装的模拟代码。这**不是任意工作区命令沙箱**；开放实际命令前必须隔离凭据、日志、控制 socket 与进程资源，不能只把 `cwd` 换成项目目录。当前证书和本地授权预置，配对 UI、动态撤销、轮换、正式安装授权与真正桌面包装均未完成。期限基于实验 VM 的共同系统时钟，真实双机部署的时钟误差策略还需补齐。
