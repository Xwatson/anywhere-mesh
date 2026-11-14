# Anywhere Coding

随时随地通过浏览器控制本机的 **Claude Code** 和 **Codex** 写代码。服务跑在你自己的电脑上，经 Cloudflare 隧道从公网访问。

## 功能（v0.1）

- **用户名密码登录**：scrypt 哈希、HttpOnly Cookie、登录失败限流（15 分钟内 5 次）
- **多账号**：不开放注册，由管理员在网页上添加账号（左下角用户菜单 →「账号管理」）。每个账号的会话和推送通知互相独立，管理员可以只读查看所有账号的会话。普通账号的 AI 只通过 SSH 在它自己的电脑上工作，在这台服务器上没有任何工具，记忆放在 `工作区/用户名/AGENTS.md`，Claude 和 Codex 共用。每个人可以在用户菜单里「修改密码」。详见下方「多账号」
- **结构化对话**：Claude Code（Agent SDK）和 Codex（`codex app-server`）统一成同一套事件模型，手机上按"消息 / 工具调用 / 文件改动"分块展示，支持流式输出
- **手机端审批**：Claude 或 Codex 要编辑文件或执行命令时，页面上弹出确认卡片（允许 / 本会话始终允许 / 拒绝）；也支持 AI 的选择题提问（Claude 的 AskUserQuestion、Codex 的 request_user_input，点选项或自己填写）和 Claude 的计划审批（Plan 模式）。Codex 默认只在 Plan 模式下才会出选择题，网页启动的 Codex 会额外打开 `default_mode_request_user_input`，让它平时也能出选择题；只影响网页会话，不改 `~/.codex/config.toml`
- **权限模式**：Claude 可随时切换 逐项确认 / 自动接受编辑 / 智能审批 / 只做计划 / 全部放行；Codex 的沙箱模式（只读 / 可写工作目录 / 完全访问）和审批策略（需要时询问 / 每个命令都问 / 从不询问）是两个独立的设置，都可随时切换（运行中切换从下一轮起生效）
- **模型满载自动重试**：Codex 遇到「Selected model is at capacity」这类临时满载错误（包括自动压缩时），会在 30 秒、1 分钟、2 分钟后自动重试，最多 3 次；这一轮已经做了一部分时让它从中断处继续，不会重做。等待期间点「停止」取消，或直接发新消息
- **断线不丢**：AI 进程在服务端独立运行，所有事件写入 SQLite，重连后自动补齐；关掉浏览器任务也会继续
- **本机历史会话**：自动读取本机 Claude Code（CLI / IDE）和 Codex（CLI / VS Code / exec）已有的会话，打开后显示完整历史，并可以直接接着提问（真正的 resume，上下文不丢）。在 CLI 里继续过的会话，网页会提示「有更新」，一键同步
- **额度查看**：侧栏实时显示 Claude（5 小时 / 每周）和 Codex（5 小时 / 每周、credits）的用量和重置时间。Claude 的数据来自它自带的 `/usage` 命令（本地执行，不消耗额度），Codex 的数据来自 `codex app-server`
- **上下文与压缩**：输入框上方显示当前上下文用量（根据最近一次回复已返回的用量计算，不额外请求），可一键「压缩」——Claude 用它自带的 `/compact`，Codex 用 app-server 的 compact，效果与在 CLI 里手动压缩相同
- **模型与推理强度**：每个会话可随时切换模型（列表来自 Claude Code 和 Codex 自身）和推理强度（只列出所选模型支持的档位），下一次请求起生效
- **图片和文件**：点回形针、直接粘贴截图或拖进页面即可附加（单个上限 20MB）。图片直接交给模型看；其他文件保存在 `DATA_DIR/uploads/<会话>/`（不进项目目录），把路径告诉 AI 让它自己读取
- **网页上重启服务**：左下角用户菜单 →「服务」→「重启服务」（服务以 systemd 运行时可用）。显示已运行多久；服务端重新构建过但还没重启时会提示「重启后生效」，源码有改动还没构建时也会提醒；有会话正在运行时先确认。重启后页面自动刷新
- **自我保护**：经网页启动的 AI 会被告知自己运行在本服务里，不要重启/停止服务；Claude 还有硬性拦截（PreToolUse hook，在「全部放行」模式下也生效）。这些只对网页会话生效，终端里直接用 CLI 不受影响。AI 进程中有环境变量 `ANYWHERE_CODING=1`
- **并行任务（git worktree）**：新建会话时勾选「在独立的 worktree 里工作」，或在项目分组的「+」里选「新 worktree」，会新建一个分支和单独的目录，多个 AI 同时改同一个项目也互不干扰。会话标题旁显示分支，点开可以合并回基础分支、让 AI 先同步基础分支的新提交，或者删除 worktree（可连同分支一起删）。详见下方「并行任务」
- **项目管家**：每个项目可以配一个全权推进的 AI 角色——拿产品主意、写需求书、派活、验收、合并、巡视，只在凭证、甲方拍板和否决上找你。它了解项目、研究竞品和同类开源项目、替你拿产品主意（给明确建议而不是罗列选项），并负责把要问甲方的事写成甲方能直接回答的形式；只用 Claude，从项目分组的「+」菜单进入，一个项目一个。它有自己的记忆（项目画像、甲方、竞品与开源、决策日志、提案与待办），存在 `DATA_DIR/advisors/u<账号>/<项目>/`（每个账号各有一份；管家需要项目在这台服务器上，只有管理员能用），每次对话开始时交给它、对话中由它自己维护，页面上点「记忆」可查看；「重新开始对话」会保留记忆另起一段对话。它从不修改项目文件（有硬性拦截）；要落地的改动它写成需求书（记忆目录下的 `briefs/`），对话里会出一张卡片，点「交给编码会话」就在独立 worktree 里起一个 Claude 会话、首条消息就是这份需求书，做完走合并 / PR 流程；需求书上会记下交接给了哪个会话，管家 下次读记忆时就知道。编码会话每一轮结束（包括停下来提问）都汇报给管家，管家随时可以用「## 给编码会话 分支名」对任一编码会话发话；服务重启后，被打断的会话会被叫起来接着做，管家也会自己检查一遍。之后两边自动往返：编码会话有提交的那一轮结束后，总结自动汇报给 管家；管家 回复里「## 给编码会话」一节自动转回编码会话（最多 4 轮）；管家 说「可以合并」时推送提醒你去合并——合并、推送、部署始终由你决定，合并或建 PR 后 管家 会收到通知并关掉对应待办。「记忆」面板的「自动」页签可以再进一步：**自动交接**（管家标了「状态：可开工」的需求书一写完就自动开编码会话；护栏：同时最多 N 个、每天最多 N 个、Claude 额度到阈值就暂停）和**定时巡视**（管家 每隔若干小时自己看项目变化、查竞品与开源动向、整理待办，推送一段摘要）。还有**自动合并**（管家说可以合并就合并进基础分支，失败则推送让你手动处理）。三者默认关闭，设置存在该项目的记忆目录里。管家 会话头部的「进展」列出每份需求书走到哪了——等你回答 / 等你合并 / 进行中 / 排队 / 待议 / 已合并——一行结论，等你处理的数量显示在按钮上，可以直接在里面合并
- **分享会话**：会话右上角「⋯」→「分享」，生成一个只读链接，对方不用登录就能看这个会话的对话记录（包括工具调用、图片附件），不能发消息、审批或做任何操作。可以设密码（4 位起，可一键生成），有效期默认 1 天，可选 1 小时 / 6 小时 / 1 天 / 3 天 / 7 天（最长 7 天），到期自动失效；也可以随时「取消分享」，删除会话时链接一起失效。可以选对方「看到全部，包括之后的新消息」（停留在页面上会自动刷新，适合让人跟进度），或者「只到现在为止」（之后的对话不会出现在链接里）。一个会话可以有多个链接，分别设不同的密码和期限。密码只保存哈希，只在生成时显示一次；输错 5 次锁 15 分钟。链接形如 `https://你的域名/share/<随机串>`，经 Cloudflare Access 保护时需要放行，见下方「通过 Cloudflare 隧道发布」
- **项目分组**：侧栏按 git 仓库（或目录）分组，组标题上可一键在该目录新建会话
- **Git：改动、提交、推送、PR**：点会话顶部的「改动」，查看相对 HEAD 的改动（含未跟踪文件），勾选文件、填写提交信息直接提交，或者交给 AI 写提交信息并提交；还可以拉取（只快进）、推送（首次推送自动设置上游）、新建分支、创建 PR。装了并登录 GitHub CLI（`gh`）时直接创建 PR，否则推送后给出 GitHub / GitLab 的「新建 PR」链接。仓库没配置提交者时，会让你填一个（只写入这个仓库的 `.git/config`）
- **原始终端**：基于 xterm.js + node-pty 的完整终端（可直接跑 `claude` / `codex` TUI），手机上有 Esc / Tab / Ctrl-C / 方向键快捷栏
- **推送通知（PWA + Web Push）**：任务完成、失败或需要你确认时推送到手机 / 电脑，**关掉页面也能收到**；通知里带上要执行的命令、要改的文件或回复摘要，点开直接跳到对应会话。可以「添加到主屏幕」当成 App 用。在侧栏底部的用户菜单里按设备开启，详见下方「推送通知」

## 快速开始

```bash
npm install
cp .env.example .env                           # 按需修改端口、工作区根目录
npm run user -- add <用户名>                    # 创建第一个账号（会提示输入密码），它自动成为管理员
```

**开发模式**（前端热更新）：

```bash
npm run dev          # 后端 :3210，前端 Vite :5173（自动代理 /api 和 /ws）
```

**生产模式**：

```bash
npm run build && npm start      # 访问 http://127.0.0.1:3210
```

**安装为系统服务**（开机自启，崩溃自动重启）：

```bash
bash deploy/install-service.sh
sudo loginctl enable-linger $USER    # 退出登录后仍保持运行
journalctl --user -u anywhere-coding -f   # 查看日志
```

账号平时在网页的「账号管理」里管理（管理员可见）。命令行用于还没有账号、或者忘了密码的时候：`npm run user -- list | add <名> [--admin] [--adopt-folder] | passwd <名> | admin <名> | unadmin <名> | remote <名> <用户@地址> [端口] | del <名>`（改密码会让该用户所有已登录设备下线，推送也随之关闭）。从单账号版本升级时，原来的账号自动成为管理员，已有的会话和管家记忆都归它。

## 配置（.env）

| 变量 | 默认 | 说明 |
|---|---|---|
| `HOST` | `127.0.0.1` | 监听地址。**保持本地回环**，只让隧道访问 |
| `PORT` | `3210` | 端口 |
| `WORKSPACE_ROOTS` | `~/workspace` | AI 能工作的根目录，逗号分隔。目录选择器和会话都被限制在这些目录内（符号链接也会被解析校验）。本机历史里不在这些目录下的会话只能查看，要继续对话需把它的目录加进来 |
| `DATA_DIR` | `~/.anywhere-coding` | SQLite 数据库和上传文件（`uploads/`）的位置 |
| `CLAUDE_PATH` / `CODEX_PATH` | SDK 内置 | 可选，指定使用本机安装的 CLI |
| `PUSH_SUBJECT` | `mailto:anywhere-coding@example.com` | 可选，Web Push 的联系地址（`mailto:` 或 `https:`），推送服务只在出问题时用它联系发送方 |

Claude 和 Codex 使用本机已有的登录状态（`~/.claude`、`~/.codex`），无需在本项目里配置 API Key。

**如果你的终端是通过代理上网的**（例如在 `~/.bashrc` 里 `export https_proxy=…`），要把同样的 `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` 写进 `.env`：systemd 服务不会读取 `~/.bashrc`，没有代理时 Claude 会被拒绝（`403 Request not allowed`）。

Codex 使用本机已有的登录状态（`~/.codex`）。Claude 会话会加载你的用户级和项目级设置（CLAUDE.md、settings.json、MCP 等）。

## 通过 Cloudflare 隧道发布

1. **添加路由**：Cloudflare Zero Trust → Networks → Tunnels → 你的隧道 → Public Hostname → 添加
   - 子域名：例如 `code.你的域名.com`
   - Service：`HTTP` → `localhost:3210`

   如果隧道是用配置文件管理的，在 `config.yml` 的 `ingress` 里加：
   ```yaml
   - hostname: code.你的域名.com
     service: http://localhost:3210
   ```
   WebSocket 无需额外配置。

2. **强烈建议加一层 Cloudflare Access**（零代码，请求在到达你电脑之前就被拦截）：
   Zero Trust → Access → Applications → Add → Self-hosted，域名填上面的子域名，
   Policy 选 Allow、Include → Emails → 你的邮箱。登录方式用邮箱验证码或 GitHub 即可。

   这样即使应用本身有漏洞，没通过 Access 的人也碰不到它。

   **用了 Access 又要分享会话时**：没有账号的人也要能打开分享链接，再加一个 Self-hosted 应用，同一个域名、路径填 `share/*`、`api/share/*`、`assets/*`、`icons/*`（每个路径一条），Policy 的 Action 选 **Bypass**、Include → Everyone。这些路径只有分享页本身、只读的分享接口和前端静态文件，其余页面和接口仍然要先过 Access。

## 并行任务（git worktree）

- worktree 默认放在仓库旁边：`<仓库>.worktrees/<分支名>`（例如 `~/workspace/app.worktrees/feat-login`），不会被原项目的构建、测试扫描到。如果仓库的上级目录不在 `WORKSPACE_ROOTS` 内，就放在仓库里的 `.worktrees/`，并自动写进 `.git/info/exclude`
- 不填分支名时自动生成，例如 `ac/claude-1012-0930`；默认基于当前分支
- 新目录里只有 git 管理的文件。仓库根目录的 `.env*` 和 `CLAUDE.local.md` 会自动复制过去；其他需要复制的本地文件（被 git 忽略的配置等）可以写在仓库根目录的 `.worktreeinclude` 里，每行一个相对路径。`node_modules` 等依赖需要在新目录里重新安装（AI 会按需安装）
- 「合并到基础分支」：worktree 里必须没有未提交的改动；基础分支所在的目录（通常是主目录）也必须是干净的，在那里执行 `git merge`。有冲突时会自动撤销，并提示你让 AI 先在 worktree 里把基础分支合并进来。基础分支如果没有在任何目录检出，只做快进
- 也可以不合并，在「改动」里推送分支并创建 PR
- 删除会话时可以选择同时删除 worktree 和分支；有未提交的改动或未合并的提交时，会再确认一次是否强制删除

## 多账号

管理员在左下角用户菜单 →「账号管理」里添加账号，没有注册入口。第一个账号（从单账号版本升级时就是原来的账号）是管理员。

- **管理员**：AI 直接在这台服务器上工作：整个工作区（`WORKSPACE_ROOTS`），使用这台电脑上 Claude / Codex 的个人设置（`~/.claude/CLAUDE.md`、插件、MCP 服务器、claude.ai 连接器、`~/.codex/config.toml`），和在终端里用 CLI 一样。本机历史、终端、重启服务和账号管理也只有管理员能用。
- **普通账号只在自己的电脑上工作**：管理员给它设置一台电脑（SSH 地址 `用户@IP` 或 `~/.ssh/config` 里的 Host 别名，可选端口；「测试」按钮检查能不能连上）。需要先把服务器的公钥（`~/.ssh/id_ed25519.pub`）加进那台电脑的 `~/.ssh/authorized_keys`，免密登录。没设置电脑的账号不能新建会话。新建会话时，在他自己的电脑上选一个文件夹作为项目（可以浏览、直接粘贴路径、新建文件夹），AI 一开始就在这个文件夹里工作；侧栏按他电脑上的项目分组，项目组上的「+」在同一个项目里开新会话。
- **它的 AI 在这台服务器上没有任何工具**：Claude 只保留不碰本机的内置工具（WebSearch、WebFetch、待办、提问、计划），Codex 关掉了 shell、看图、子代理等本机工具，沙箱固定只读。两边都通过一个专门的 MCP 服务器（`server/src/remote/mcp.ts`）干活，用法和本机工具对应：`run`（在他的电脑上执行命令；和终端一样 cd 之后的工作目录会保留，`run_in_background` 在后台启动开发服务器之类的命令）、`read_file` / `write_file` / `edit_file`（读写他电脑上的文件，走 sftp，macOS / Linux / Windows 都一样，相对路径从当前工作目录算，缺的文件夹自动建）、`apply_patch`（Codex 自己的补丁格式，Codex 改文件最顺手的方式）、`read_attachment` / `send_attachment`（网页上传的附件：图片照常直接发给模型，Claude 会话的 PDF 也直接发；文本、日志、PDF 文字用 read_attachment 读；压缩包、Office 文档等要在他电脑上处理的用 send_attachment 传过去）、`memory_edit` / `memory_write`（账号记忆）。想在服务器上执行命令、读写文件，会被直接拒绝（任何权限模式下都一样）；WebFetch 不能访问本机和内网地址；SSH 不转发 agent、端口和 X11，对方电脑也连不回来。它也不加载这台电脑的个人设置（CLAUDE.md、插件、MCP 服务器、claude.ai 连接器、Codex 的应用和记忆）。在「逐项确认」模式下，每条远程命令、每次改文件都会弹出确认卡片。
- **记忆**：在服务器上的 `工作区/用户名/AGENTS.md`（同目录的 `CLAUDE.md` 用 `@AGENTS.md` 引用它，和手工给别人电脑建的入口目录一样）。Claude 和 Codex 的每个会话开始时都会读到它，学到值得长期记住的东西（他电脑上的环境、项目在哪个目录、习惯和决定，或者用户说「记住……」）时用记忆工具自己更新，两边共用同一份。用户在菜单 →「我的记忆」里可以查看和修改。添加账号时如果同名文件夹已经存在（比如之前手工建的 `lxj`），会先问你是否让它使用，里面已有的 `AGENTS.md` 就是它的记忆。删除账号不会删除它的文件夹，也不影响它电脑上的文件。
- **共用的东西**：所有账号共用这台服务器的 Claude / Codex 登录和额度，也用这台服务器的 SSH 密钥连接各自的电脑。同一个会话的 SSH 连接会复用（`DATA_DIR/ssh/`），不用每条命令都重新握手。
- **管理员能看到所有账号的会话**：侧栏「其他账号」按账号列出别人的会话，哪些正在运行一目了然（有正在运行的会话时标签上有绿点）；点开可以实时查看对话，但只能看：不能发消息、停止或回答它的确认请求。重启服务前，确认框会列出所有账号正在运行的会话。

## 推送通知

在侧栏底部点开用户菜单 →「推送通知」→「开启」，再点「测试」确认能收到。每台设备（每个浏览器）要分别开启；退出登录会关闭这台设备的推送。推送按账号分开：一台设备只收它当前登录账号的会话通知，换一个账号登录后，这台设备的推送就跟着换过去。

- **需要 HTTPS**：经 Cloudflare 隧道的域名就是 HTTPS；本机 `localhost` 也可以
- **iPhone / iPad**（iOS 16.4+）：先在 Safari 里「分享 → 添加到主屏幕」，从主屏幕图标打开后再开启
- **Chrome / Edge**：浏览器要通过 Google 的推送服务（FCM）接收消息。如果网络访问不了 Google，开启时会提示超时，请让浏览器走代理，或者换用 Safari / Firefox
- **服务端**：推送请求会经过 `.env` 里的 `HTTPS_PROXY` 发出（如果配置了）
- 页面正在前台显示时不会重复弹通知；同一个会话的新通知会替换旧的；你自己点「停止」的任务不通知
- 服务的推送密钥保存在 `DATA_DIR/vapid.json`，删除它会让所有设备的订阅失效，需要重新开启

## 安全须知

这个服务本质上是"从公网远程控制一台能执行任意命令的电脑"，请务必：

- 使用强密码，并开启上面的 Cloudflare Access
- 不要把 `HOST` 改成 `0.0.0.0`
- `WORKSPACE_ROOTS` 只放项目目录，不要设成 `~` 或 `/`
- 谨慎使用「全部放行」（Claude）和「完全访问」（Codex）
- 注意：Codex 的审批策略选「从不询问」时，安全边界只剩沙箱模式；Codex 发来的网页端暂不支持的请求（额外权限配置、MCP elicitation、登录刷新等）会被自动拒绝；"原始终端"拥有你本人的全部 shell 权限

## 项目结构

```
server/src/
  index.ts              Fastify 入口：静态页面、安全响应头、优雅退出
  config.ts             读取 .env
  db.ts                 SQLite 表结构与迁移
  auth.ts               密码哈希、会话 Cookie、登录限流
  sessions.ts           会话管理：事件持久化、广播、调度 agent
  uploads.ts            附件保存与读取（DATA_DIR/uploads/<会话>/）
  push.ts               Web Push：VAPID 密钥、设备订阅、发送通知
  advisors.ts           管家的记忆目录与模板（DATA_DIR/advisors/u<账号>/<项目>/）、需求书的读取与交接记录
  accounts.ts           账号：管理员 / 普通账号、普通账号的电脑（SSH）、记忆文件（工作区/用户名/AGENTS.md）
  remote/ssh.ts         通过系统 ssh / sftp 在普通账号的电脑上执行命令、传文件（不转发任何东西回本机）
  remote/mcp.ts         普通账号的 AI 唯一的工具集（stdio MCP 服务器）：远程命令、文件、附件、记忆
  shares.ts             分享链接：生成、取消、过期清理、密码校验（会话删除时一起删除）
  handoff.ts            把需求书交给新的编码会话（独立 worktree，首条消息就是需求书）
  loop.ts               管家 与编码会话的自动往返：汇报、回传、合并通知、自动交接、定时巡视
  agents/types.ts       AgentRunner 接口
  agents/claude.ts      Claude Agent SDK 适配器（长连接 + canUseTool 审批）
  agents/codex.ts       Codex 适配器（每个会话一个 codex app-server 进程，JSON-RPC 流式输出 + 审批）
  agents/webContext.ts  告诉 AI 自己运行在本服务里（自我保护提示与拦截）
  agents/advisor.ts     管家：角色提示、记忆注入、项目文件写入拦截
  agents/account.ts     普通账号的 AI：只给远程工具（Claude 工具白名单与拦截、Codex 关闭本机工具）、记忆注入、不加载本机个人设置
  external/history.ts   读取本机 Claude / Codex 历史会话并转换成统一事件
  external/codexAppServer.ts  codex app-server 进程封装
  external/codexRollout.ts    读取 Codex rollout 文件（上下文用量）
  external/holders.ts   检测会话是否正被终端里的 Claude 打开
  external/usage.ts     Claude / Codex 额度查询
  external/models.ts    可用模型与推理强度列表
  terminals.ts          node-pty 终端 + 回放缓冲
  files.ts              目录浏览（限制在工作区内）、git diff
  git.ts                提交 / 推送 / 拉取 / 分支 / PR（只用参数数组调用 git，不经过 shell）
  worktrees.ts          每个任务一个 worktree：创建、状态、合并回基础分支、删除
  routes/               REST API、WebSocket 协议、账号管理（admin.ts，仅管理员）、分享链接的公开只读接口（share.ts，不需要登录）
  cli/user.ts           账号管理命令
  shared/protocol.ts    前后端共享的类型（统一事件模型）
web/src/
  lib/                  API、自动重连 WebSocket、状态 store、项目分组、模型列表
  components/           登录、侧栏、项目分组、对话、审批卡片、附件、Diff、终端、历史会话、管家 记忆、账号管理与修改密码、分享设置与分享页（SharedView.tsx，/share/<链接>）
web/public/            Service Worker（sw.js，只处理推送，不做缓存）、PWA manifest 和图标
deploy/                 systemd 服务安装脚本
```

新增一种 AI CLI：实现 `server/src/agents/types.ts` 里的 `AgentRunner` 接口，把它的输出映射成 `AgentEvent` 即可。

## 路线图

- [x] 每个任务一个 git worktree，多个 AI 并行改同一项目
- [x] 网页上提交 / 推送 / 创建 PR
- [x] PWA + Web Push（关闭页面也能收到通知）
- [x] 上传图片和文件给 AI
- [x] Codex 网页端审批
- [x] 管家 · 巡视：定时看项目变化、查竞品与开源项目的动向，有事推送
- [x] 管家 · 自动交接：可开工的需求书自动开编码会话，带并发 / 每日 / 额度护栏
- [x] 管家 · 交接：需求书一键生成编码会话
- [ ] 安卓端（Capacitor 打包同一套前端）
