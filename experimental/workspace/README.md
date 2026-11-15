# Workspace MCP 与本地权限（Linux 实验）

这是 B2 的统一工作区接口原型。模拟美国宿主通过真实 MCP SDK 调用本模块，沿 B1 的持久任务协议到达国内 Agent，再由 Bubblewrap 内的 Desktop Commander 操作文件或执行命令。没有接入真实 CLI、模型凭据、生产 Anywhere 或 Electron UI。

固定 MCP SDK 1.32.1，复用 `../desktop-commander/vendor/package-lock.json` 锁定的依赖与六项兼容补丁，不另行安装浮动版本。执行器和沙箱限制见 [Desktop Commander 适配说明](../desktop-commander/README.md)。

## 工具与权限

| 国内权限 | 对模型开放的业务工具 | 工具总数 |
| --- | --- | --- |
| `revoked`（初始状态） | 无新业务操作 | 4 |
| `read` | 单/多文件读取、目录、文件信息、搜索 | 9 |
| `edit` | 以上工具，加文本写入、精确替换、建目录 | 12 |
| `execute` | 以上工具，加 `workspace_run` 有限 shell 命令 | 13 |

四个管理工具为 `workspace_capabilities`、`workspace_task_status`、`workspace_task_output`、`workspace_task_cancel`。撤销或断网后仍可查询已登记任务、读取已落盘的输出和提出取消；工具列表只在已确认连接、且宿主绑定的授权版本与国内一致时展示业务工具。旧绑定可核对历史，不能新增任务。

模型参数只有相对路径、文本、命令等操作内容。账号、设备、工作区、会话、回合代次、授权版本及稳定调用编号均由可信宿主绑定，不接受模型指定。每个 MCP 进程绑定一个不可变的回合与授权版本；授权变更后，宿主应为后续调用建立新绑定，保留旧绑定处理未交付结果。

权限权威在国内设备的 SQLite 日志。本地 Unix socket 提供 `status` 与 `setMode({requestId, expectedVersion, mode})`，由文件权限限制访问；不向远端 RPC 或模型暴露改权方法。变更采用版本比较和持久去重，即使重试旧请求也不会将当前权限回滚。国内变更先落盘，再取消旧版本的在途任务；取消确认前不声称进程已停止。离线也能收紧或撤销，美国侧显示未确认，重连后核对。撤销不能回滚已经发生的文件修改。

`read` 模式同时使用只读工作区挂载；`edit` 不开放命令。可执行模式允许沙箱内任意有限命令，Git、本地构建和测试已经实测。沙箱无外网，不能据此声称已支持联网安装依赖或远端 Git push/pull。

## 可信宿主调用协议

`contracts.d.ts` 定义接口，`executor.mjs` 实现稳定映射。调用流程：

1. 宿主创建固定 `WorkspaceBinding`，用上层稳定工具调用编号调用 `issue(hostCallId, toolName, args)`。此方法不注册为 MCP 工具。
2. 先持久记录参数摘要、期限与随机凭据，再向 Broker 准备任务；调用记录与任务查询索引在同一事务中提交。丢失准备响应时查回同一任务，不创建新的操作。
3. 宿主将返回的凭据注入 MCP 请求 `_meta['anywhere/callTicket']`。凭据不放进模型可编辑的参数，MCP request ID 也不用作任务去重编号。同编号改参数、跨绑定凭据和越权目标均拒绝。
4. 工具返回包含 `task.state`、`resultReady`、`resultDigest`、输出游标和截断信息。等待超过 10 秒会返回运行状态；继续用任务查询和输出分页，不重发新调用。
5. 宿主收齐结果与保留窗口内的输出，将其提交到自己的持久历史后，调用 `consumeAfterPersist`。MCP 返回、UI 展示、CLI idle 均不等于结果已进入模型历史。消费回执可幂等重试；未消费结果和 unknown 会阻止新操作。

凭据与回合配置位于宿主私有目录，不导出到普通诊断报告。模拟宿主用独立 `mock-history.sqlite` 验证先落历史、后确认消费的顺序；真实 CLI 的历史语义仍留到 F 阶段验证。仅把这个 stdio server 填入普通 CLI MCP 配置还不够，必须有可信宿主适配调用凭据、结果持久化与回合停止。

MCP SDK 在请求取消和 transport 断开时都会触发请求 AbortSignal，因此该信号仅停止当前等待，不推断国内任务应取消。明确停止必须调用 `workspace_task_cancel` 或可信宿主取消 API；整个回合停止还需宿主对接 B1 的 `stopTurn`。关闭或重建 MCP 进程不会自动重跑或取消国内任务，已实测同一凭据恢复结果且副作用只有一次。

## 本地管理与实验复现

权限入口目前是 CLI 和本地 API，供后续桌面壳复用。Agent 运行时，在 VM 的获准本地账号下查询：

```bash
node /usr/lib/anywhere-workspace-runtime/workspace/local-control.mjs \
  /srv/anywhere-lab/workspace-b2/local/control.sock status
```

变更用 `set-mode read|edit|execute|revoked EXPECTED_VERSION`，其中版本必须来自刚取得的状态；不要猜测版本或让模型自行决定授权。当前测试收尾后 Agent 停止，权限持久状态为 revoked。

前提是阶段 A、B1 与 Desktop Commander 固定运行时已安装。只在通过 guest guard 检查的实验 VM 内运行，先确保其他执行实验服务已停止：

```bash
sudo bash /srv/anywhere-lab/source/experimental/workspace/lab/install.sh
cd /srv/anywhere-lab/source
node --test experimental/execution/test/*.test.mjs experimental/desktop-commander/test/*.test.mjs experimental/workspace/test/*.test.mjs
node experimental/workspace/lab/integration.mjs
node experimental/workspace/lab/verify-final.mjs
```

服务 `anywhere-workspace-agent`、`anywhere-workspace-broker` 不自启；运行时 `/usr/lib/anywhere-workspace-runtime/`，状态 `/srv/anywhere-lab/workspace-b2/`。每轮集成测试先停本实验服务并归档本实验的日志和工作区，再创建新的测试夹具；不删除 B1/DC 证据。测试临时占用阶段 A 的业务端口，结束恢复 mock、释放 helper 租约并停止本轮执行服务。归档重置仅用于测试，不能用来绕过真实 unknown 的恢复屏障。

本轮 34 项单元测试、12 项真实联调通过，覆盖本地 Git/构建/测试、文件读写、并发重传、篡改/越权拒绝、过期授权、在线/离线撤权、显式取消、Agent 与 MCP 重启、消费回执重传，以及真实写入后的崩溃未知态。结果在客体及 NAS 实验根目录 `artifacts/workspace-mcp-*.json`，测试日志在 NAS `logs/workspace-mcp-final-tests.log`。

## 尚未完成

当前限制：单个固定实验工作区、一个并行任务、每条命令最多 120 秒，结构化结果最多 22 KiB，任务输出保留约 64 KiB；没有长期 PTY、联网依赖下载、多项目路由、原子文件冲突保护、unknown 人工核对入口或桌面权限 UI。授权历史最多 64 条，满时禁止新增授权，但额外保留一次最终撤销记录；调用身份最多 128 条，达到上限拒绝新任务，尚无正式归档/保留策略。

后续继续 C 阶段的保留策略、并发编辑与资源边界验证，再接 D 阶段桌面状态和权限入口。真实 CLI 的可信调用编号、元数据注入、历史消费和停止映射仍是 F 阶段独立验收项，模拟通过不代表模型端兼容性或实际编程效果已经通过。
