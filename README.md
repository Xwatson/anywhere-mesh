# Anywhere Crossborder

跨国 AI 编程代理与受控远程工作区系统：海外会话主机托管 AI CLI（**Codex CLI** / **Antigravity CLI**），通过加密 EasyTier 隧道与受控 Workspace MCP 协议安全读写并执行国内设备上的本地项目，支持 Web 端与 Windows 桌面客户端同步操作。

## 核心架构

- **海外会话宿主（`src/account-devices/` + `src/session-host/`）**
  - `host.mjs` / `wan/server.mjs`：HTTPS / WSS 服务端，多账号认证（`auth.mjs` / `auth-db.mjs`，Node 24 内置 `node:sqlite`）、设备绑定、SSE 实时流（`GET /api/sessions/:id/stream`）、会话管理与附件存储。
  - `codex-turns.mjs` + `codex-app-server.mjs`：Codex CLI 引擎（dynamicTools + 实时流式推送）。
  - `antigravity-turns.mjs` + `wan/agy-mcp-bridge.mjs`：Antigravity CLI (`agy acp`) 引擎，跨用户 Unix Socket MCP 桥接（256-bit 随机 Bearer Token 鉴权），仅放行绑定工作区 `mcp_anywhere_workspace_*` 工具并拦截所有主机本地工具。
  - `ui/`：零框架轻量前端（Web 与 Electron 共用），支持引擎/模型/推理强度切换、流式思考与回复、图片/文件附件、会话重命名/删除、分页回溯与本地未知任务核对。
- **执行隔离与可靠协议（`src/execution/` + `src/workspace/` + `src/reliability/` + `src/desktop-commander/`）**
  - 本地授权状态机（未授权 / 只读 / 编辑 / 完全访问）、调用票据绑定（`callTicket`）、内容哈希版本乐观锁（`expectedRevision`）、多文件补丁（`workspace_apply_patch`）、日志压缩与中断未知任务本地核对。
- **Windows 桌面客户端（`src/desktop/` + `src/account-devices/windows/`）**
  - Electron 沙箱外壳（`desktop/main.cjs`）、DPAPI 设备登录凭据保护（`LoginProtection.cs`）、零配置 EasyTier 用户态加密隧道（`PeerHost.cs` + `network.mjs`）、安全文件快照（`WorkspaceSnapshot.cs`）与离线 AppContainer 命令执行（`TaskHost.cs`）。

## 运行测试

需要 Node.js 24+（使用内置 `node:sqlite` 与 `node:test`）：

```bash
npm install
npm test
```

## 构建发布

- **服务端打包**：
  ```bash
  bash src/account-devices/wan/build.sh /tmp/wan-stage
  ```
- **Windows x64 安装包**：详见 [src/account-devices/windows/README.md](src/account-devices/windows/README.md)。
