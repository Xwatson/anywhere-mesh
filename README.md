# AnywhereMesh

**One AI host, every machine you own.**

在一台主机（家庭小主机、NAS 或云端 VPS）上登录一次 AI 编程订阅（**Codex CLI** / **Antigravity CLI**），通过 **EasyTier 加密组网（P2P 打洞 + WSS 中继）** 与受控 **Workspace MCP** 协议，随时随地安全指挥你的任意电脑执行本地代码任务。

## 为什么做 AnywhereMesh

- **订阅只登一台设备**：不需要在每一台开发机上重复配置代理或登录 AI 账号，一台常开主机作为 AI 大脑。
- **任意电脑随时接入**：无论是家里台式机、公司电脑还是笔记本，打开客户端自动领取加密组网凭据，无需公网 IP 或开放入站防火墙端口。
- **严格本地权限边界**：每台设备的每个项目由本机独立授权（未授权 / 只读 / 编辑 / 完全访问），随时可一键撤销；服务端 AI 内置本地文件/命令工具一律拦截，只能通过受控 MCP 票据操作已授权目录。
- **Web + 桌面端同步控制**：在桌面客户端发起并授权项目后，用浏览器也能跨设备继续对话与查看进度。

## 目录结构

```text
src/
├── account-devices/   # 会话宿主、多账号鉴权、Web/桌面共用前端、WAN 部署与 Windows 打包
├── session-host/      # 会话存储、运行时调度、Codex CLI 与 Antigravity CLI (ACP) 引擎
├── desktop/           # Electron 沙箱桌面外壳
├── execution/         # 本地授权状态机、RPC 通道与可靠执行内核
├── workspace/         # Workspace MCP 工具目录、调用票据执行器与多文件补丁引擎
├── reliability/       # 文件内容哈希乐观锁与历史归档核对
└── desktop-commander/ # 本地读写/搜索适配与路径边界策略
```

## 快速测试

需要 Node.js 24+（使用内置 `node:sqlite` 与 `node:test`）：

```bash
npm install
npm test
```

## 构建发布

- **服务端打包（Linux）**：
  ```bash
  bash src/account-devices/wan/build.sh /tmp/wan-stage
  ```
- **Windows x64 安装包**：详见 [src/account-devices/windows/README.md](src/account-devices/windows/README.md)。
