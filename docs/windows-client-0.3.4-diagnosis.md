# Windows 0.3.4 客户端问题诊断

代码位于 `/vol1/1000/anywhere-crossborder-lab/source`，分支 `feature/account-device-sessions`，核对版本 `5971f07`。Windows 10 测试机的安装版本为 0.3.4，已比对安装目录中的 Electron 主进程、界面、设备客户端及两个 Windows 连接模块，五个文件均与该提交一致。以下现场时间均为 **2026 年 11 月 22 日洛杉矶时间（UTC−8）**。

## 1. 第一次点登录报服务不可用，第二次能进入

**首要排查点是领取设备连接配置和等待 EasyTier 隧道就绪。** 桌面把账号验证、设备联网和首次状态同步放在一次登录操作里。任何一步超时，用户都可能还停在登录页。现场观察到了链路间歇超时，但缺少用户第一次点击的精确时间和客户端分阶段错误码，无法断定那一次停在哪一步。

| 只读观测 | 结果 |
| --- | --- |
| 美国源站 Nginx 与账号库 | 19:16:06 有一笔 Windows 设备登录成功，`POST /api/auth/login` 返回 200，下一秒 `POST /api/device/network` 也返回 200。19:18:44 至 19:26:50，该配置接口先后记下 5 次 499，19:28:10 又返回 200。 |
| 同一源站的 EasyTier 入口 | 19:12 至 19:30，`/easytier` 记下 6 次 101 和 20 次 499。101 表示完成过 WebSocket 升级。499 表示从 Nginx 看，下游在响应完成前断开，日志本身无法区分是桌面端还是中间代理先取消。统计覆盖整个入口。[499 的含义](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-499/) |
| Windows、现有 Linux 隧道与源站对照 | 19:26 起，Windows 用安装包自带的 Node 匿名请求公网 `GET /api/state`，连续 4 次在 10 秒内未收到 HTTP 响应。19:28 再测，5.46 秒收到预期的 401。Linux 经已运行的 EasyTier 隧道访问同一接口，一次建连超过 9 秒，随后一次 1.22 秒收到 401。美国源站回环访问耗时约 6.5 毫秒，返回 401。这些探测只验证到达接口的能力。 |

安装包有两条登录路径，复现时先确认测试的是哪一条。

- **全新安装**先通过公网提交账号密码，再用返回的令牌申请设备网络配置、启动 EasyTier，并从本机转发端口探测内层 TLS。公网请求的 socket 空闲超时为 8 秒，整次请求限时 10 秒。隧道单次 TLS 探测限时 2.5 秒，总等待约 23 秒。配置或隧道步骤失败后，客户端会停止 peer 并尝试注销刚取得的登录。公网请求遇到 DNS、TLS 或超时等错误时，原始原因会被折叠成 `WINDOWS_BOOTSTRAP_UNAVAILABLE`。[登录与错误映射](../experimental/account-devices/windows/controller.mjs#L19) · [HTTP 时限](../experimental/account-devices/client.mjs#L17) · [隧道探测](../experimental/account-devices/windows/network.mjs#L49)
- **保留旧配置的安装**先启动 `windows.toml` 指定的 peer，等待隧道就绪，然后经隧道验证账号。测试虚拟机的默认配置走这条路径，转发端口是 `127.0.0.1:31844`。首次等待超时后 peer 可以继续连接，因此第二次点击有机会直接通过。公网登录日志主要用于分析自动配置路径。[两条认证分支](../experimental/account-devices/windows/controller.mjs#L34) · [配置选择与启动](../experimental/account-devices/windows/network.mjs#L58)

手工登录成功后，界面依靠首次 `GET /api/state` 才进入首页。如果这笔请求失败，而此时 `state` 为空、`restoring` 为假，界面会停留在登录页，定时器也不会重试。此时本机可能已经保存了有效令牌。复现时应把这一步与账号认证、配置领取、内层 TLS 的耗时和错误码分别记录。[登录提交](../experimental/account-devices/ui/app.js#L551) · [保存登录](../experimental/account-devices/client.mjs#L104) · [状态同步](../experimental/account-devices/ui/app.js#L373)

已有安装版验收脚本遇到部分连接错误会重新提交登录，最多三次，验收通过只能说明最终成功。同设备再次提交账号密码会使旧设备登录失效。[验收重试](../experimental/account-devices/windows/installed-ui.ps1#L103) · [设备登录事务](../experimental/account-devices/directory.mjs#L43)

## 2. 登录后出现“服务端暂时不可达，草稿已保留”

**这条横幅由一次同步异常触发。** 窗口可见且空闲时每 1.5 秒刷新。读取账号状态、读取管理页、加载聊天历史、校验历史序号和渲染共用一个 `try/catch`。除登录失效等提前返回的情况外，一次异常就会把全局 `online` 设为 `false`，显示横幅并禁用发送。即使刚收到有效的账号状态，后续历史校验失败也会产生相同提示。下一次状态读取成功又会把 `online` 设回 `true`。[刷新与异常处理](../experimental/account-devices/ui/app.js#L337) · [提示文案](../experimental/account-devices/ui/app.js#L305) · [发送按钮](../experimental/account-devices/ui/app.js#L262) · [轮询周期](../experimental/account-devices/ui/app.js#L652)

在 Windows 上，登录后的 `/api/state` 走 EasyTier 内层 HTTPS。自动配置模式下，修复连接的定时器每 30 秒检查设备在线 WebSocket。连接状态为 OPEN 时会跳过修复。HTTP 请求与设备在线状态因此可能不同步。当前代码能确定横幅的触发条件。要定位这次报警，需要记录失败的是 `state`、`history` 还是本地校验，并分别看 HTTP 与设备连接状态。[设备状态请求](../experimental/account-devices/client.mjs#L220) · [Windows 重连条件](../experimental/account-devices/windows/controller.mjs#L75)

## 3. 全窗口没有右键菜单，无法用右键复制

**已确认安装版没有实现右键菜单。** Electron 默认不弹出网页浏览器那样的菜单。主进程创建了窗口，没有处理 `webContents` 的 `context-menu` 事件，渲染页也没有自定义菜单或消息复制按钮。`autoHideMenuBar` 控制的是窗口顶部的菜单栏。这里的复制属于窗口编辑操作，独立于项目的“只读／完全访问”授权。[窗口创建](../experimental/desktop/main.cjs#L104) · [消息渲染](../experimental/account-devices/ui/thread.js#L99) · [Electron 官方上下文菜单说明](https://www.electronjs.org/docs/latest/tutorial/context-menu)

**键盘复制需单独验证。** 现有键盘处理只接管了 `Ctrl+K`、`Ctrl+N` 这两个全局组合键，样式中也没有全局禁选规则。收到新聊天事件时，渲染器会整块替换消息列表，已有选区可能消失。可分别在输入框、已完成的回复和仍在更新的回复中测试选中文字后按 `Ctrl+C`。[快捷键处理](../experimental/account-devices/ui/app.js#L644) · [消息列表替换](../experimental/account-devices/ui/thread.js#L128)

## 4. 新建会话时没有选择本机目录的入口

**会话已经绑定设备和项目，当前 Windows 版只注册了一个预置目录。** 安装版启动时创建 `%LOCALAPPDATA%\AnywhereCodingLab\project`，Windows 控制器把它作为唯一项目。界面“本机项目”下拉只列出已注册项目，只有一个选项时会禁用。点“新建会话”先打开空白对话，首条消息发送时才用当前 `workspaceId` 创建会话。因此授予“完全访问”也仍然作用于同一个目录。[默认目录](../experimental/desktop/main.cjs#L58) · [Windows 项目配置](../experimental/account-devices/windows/controller.mjs#L12) · [项目下拉](../experimental/account-devices/ui/app.js#L403) · [首条消息创建会话](../experimental/account-devices/ui/app.js#L454)

缺口横跨界面、桌面 IPC 和设备项目注册。仓库已有系统目录选择器，但只接在旧的 Linux `--lab-sessions` 入口。Windows 使用 `account-devices` 协议，其中没有 `chooseWorkspace` 或 `registerWorkspace`。客户端从安装记录校验目录身份，服务端在设备登录时接收 `localId` 和标签，并在新建会话时校验项目属于本机。接手时要一起核对“选目录 → 持久化注册 → 首条消息绑定”，并用两个不同目录验证重开后旧会话各自仍指向原目录。[入口分流](../experimental/desktop/main.cjs#L9) · [已有目录选择器](../experimental/desktop/main.cjs#L119) · [Windows 使用的 IPC 协议](../experimental/account-devices/contract.cjs#L2) · [本机目录身份](../experimental/account-devices/client.mjs#L39) · [服务端项目登记](../experimental/account-devices/directory.mjs#L30) · [会话绑定校验](../experimental/account-devices/host.mjs#L159)
