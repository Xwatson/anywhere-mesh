# Windows 实验客户端

飞牛虚拟机 `192.168.8.210` 已安装 Windows 桌面实验版。系统为 Windows 10 Enterprise LTSC 2021 x64，构建号 19044.3324。设备在管理页显示为 `Windows · DESKTOP-L0OT7AS`。

## 在 Windows 上使用

1. 双击桌面或开始菜单的 **AnywhereMesh**，首次打开即显示账号登录页。账号验证通过后，客户端保存登录并自动配置本机连接。领取连接配置、建立 EasyTier 连接或同步账号状态暂时失败时，会沿用该登录自动重试。
2. 在首页直接输入「请读取 notes.txt 的第一行」，按 Enter 发送。首次使用时选择项目权限并确认发送，默认选中「只读」。会话绑定本机，并用首条消息命名。取消授权会保留草稿。Shift+Enter 可以换行。
3. 左侧按项目列出会话，Ctrl+K 可按会话名、项目或设备搜索。标题栏显示执行设备和在线状态。工具操作可展开查看原始返回，选中文字后可右键复制或按 Ctrl+C。在其他电脑打开同一会话时，页面会提示它绑定的设备。
4. 首次安装的默认项目为 `%LOCALAPPDATA%\AnywhereMesh\project`。新对话中点击输入框下方的项目按钮，再点 **选择文件夹…**，可以登记并选用本机固定磁盘上的其他项目。首条消息把会话绑定到所选项目。新登记的项目初始为「未授权」，可按需授权只读、编辑或完全访问。左下角账户菜单提供退出登录，管理员还可查看所有设备和绑定会话。[打开服务端管理页](https://mesh.example.com/?view=devices)
5. 更改密码时，点左下角账号名 → **更改密码**，输入当前密码和两次新密码，再点 **保存密码**。当前登录保留，其他客户端需要用新密码重新登录。

## 关闭、重开和注销

从 0.3.3 升级后首次登录一次。0.3.4 使用当前 Windows 用户的 DPAPI 加密设备登录令牌，保存在 `%LOCALAPPDATA%\AnywhereMesh\state\login.dpapi`。关闭应用会结束设备连接。再次打开后，客户端向服务端确认同一账号、设备和本机项目，恢复原来的项目授权，侧栏可打开之前的会话。连接暂时不可用时会自动重试。点击账号菜单的 **退出登录** 会移除凭据，再次打开需要登录。服务端令牌有效期为登录后 30 天，令牌到期、被撤销或设备被停用时也需要重新登录。[Windows 数据保护 API](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.protecteddata?view=netframework-4.8.1)

## 会话记录位置

| 内容 | 位置 |
| --- | --- |
| 已发送消息、Codex 回复、工具调用与结果摘要 | 美国服务器 `/var/lib/anywhere-wan/u<账号数字ID>/history.sqlite`。表 `chat_events` 按会话 ID 和顺序号保存消息，`records` 中的 `sessions` 保存标题、设备与项目绑定、Codex 线程编号等元数据 |
| 工作区任务、执行状态、输出与回执 | 美国服务器 `/var/lib/anywhere-wan/u<账号数字ID>/<工作区UUID>/journal.sqlite`，Windows 执行端另有 `%LOCALAPPDATA%\AnywhereMesh\state\<工作区UUID>\journal.sqlite` |
| 项目文件与未发送草稿 | 当前预置项目位于 `%LOCALAPPDATA%\AnywhereMesh\project`。草稿在当前窗口的 `sessionStorage` 暂存，关闭窗口可能丢失 |

例如 `lab-coder` 使用 `/var/lib/anywhere-wan/u2/history.sqlite`。服务端 Codex CLI 还会把自身的线程记录保存在 `/home/desktop/.codex/sessions/`。应用侧栏通过已登录账号的会话接口加载历史。

## 传输与文件工具

新安装先通过 `https://mesh.example.com` 登录。服务端只向持有有效设备登录令牌的客户端签发独立的 EasyTier 2.6.4 凭据，分配虚拟地址，并返回服务端公钥。客户端固定该公钥，自动建立到 `wss://mesh.example.com/easytier` 的用户态连接。业务 HTTPS、WSS 和 Workspace MCP 经本机回环端口转发到 `10.203.73.2:18443`，另行验证实验 CA。入网凭据只交给本次网络子进程。退出登录、停用设备或登录到期后，服务端回收该凭据和地址。SSH 用于部署和驱动测试。桌面拥有网络进程的生命周期，后端退出会关闭控制管道，Windows Job Object 负责监督进程异常终止时的回收。[EasyTier 无 TUN 模式](https://easytier.cn/en/guide/network/no-root.html) 和 [端口转发](https://easytier.cn/en/guide/network/port-forward.html)

客户端复用 Linux 桌面的 Electron 界面、账号协议、设备身份、项目授权和操作日志。美国端 Codex 通过会话绑定的 Workspace MCP 调用工具。Windows 读取器逐段打开本地路径，从已校验的文件句柄读取至多 1 MiB 的 UTF-8 文本。目录联接、重解析点和多硬链接文件会被拒绝。Desktop Commander 0.3.3 的 `TextFileHandler.read` 对私有快照执行分页。服务端按设备实际支持的工具生成 MCP 清单。[Desktop Commander 源码](https://github.com/wonderwhy-er/DesktopCommanderMCP/tree/bce370e9395f5bc74eda34913e5ae1dee48df8f8)

只读权限覆盖单文件或多文件读取、目录列表、文件信息与搜索。编辑权限增加创建目录、写入和精确替换。修改已有文本时须提交最近读取的版本，文件在本机发生变化时会返回版本冲突。完全访问另可执行 Windows 项目命令，安装版附带 Node 与 npm。

与 Linux 端统一：当项目授予「完全访问（`execute`）」权限时，命令由 `cmd.exe` 以当前 Windows 用户权限直接在项目工作区目录中运行，具备完整网络与本机工具链访问能力（自动将随包附带的 Node 与 npm 目录追加到 `PATH`），单条命令限时 120 秒，取消或超时会通过 `taskkill /T /F` 终止整个子进程树。只读与编辑模式的文件工具仍通过 `WorkspaceSnapshot.exe` 限制在授权工作区目录内并执行乐观版本校验。

安装包按 Windows 用户安装，尚未做 Authenticode 签名或自动更新。升级会沿用原有 `windows.toml`、设备身份、项目和 0.3.4 的已保存登录。登记新文件夹需要同步升级会话宿主以支持 `POST /api/device/workspaces`。项目路径和文件系统身份保存在本机 `state/installation.json`，服务端登记项目名称和设备绑定。

## 重建 Windows x64 安装包

在仓库根目录运行 `bundle.py` 生成应用压缩包。在 Windows 上用 .NET Framework 的 C# 编译器将 `WorkspaceSnapshot.cs` 和 `WorkspaceTree.cs` 一同编译为 `WorkspaceSnapshot.exe`，引用 `System.Web.Extensions.dll`。将 `PeerHost.cs`、`TaskHost.cs` 和 `LoginProtection.cs` 分别编译为同名 EXE，登录保护程序引用 `System.Security.dll`。四个程序均使用 x64 并放入同一目录。构建机使用 Python 3.11+、Pillow 和 NSIS 3。将以下参数替换为构建机上的实际路径，`build/payload` 应为空缺目录。

```sh
python3 src/account-devices/windows/bundle.py ws-8.22.0.tgz desktop-commander-0.3.3.tgz windows-app.zip
python3 src/account-devices/windows/package-installer.py \
  --archives images --native compiled-windows-helpers --app windows-app.zip \
  --ca ca.crt --dest build
(cd build && makensis setup.nsi)
```

安装程序包含固定版本的 Electron、Node、EasyTier、Workspace MCP 工具和部署 CA 公共证书。程序安装在 `%LOCALAPPDATA%\Programs\AnywhereMesh`，卸载入口在 Windows「应用和功能」中。项目与设备配置由当前用户保存在 `%LOCALAPPDATA%\AnywhereMesh`。

全新安装验收使用桌面快捷方式指向的已安装程序、独立空配置目录和测试账号 `lab-other` 启动，通过系统 UI Automation 操作登录、授权和聊天表单，从只读切换到完全访问，并在本机核对模型读取的随机内容及项目命令生成的文件。使用已登录图形桌面的 Windows 用户，从飞牛实验目录运行：

```sh
python3 source/src/account-devices/windows/verify-installed.py --project-access \
  xwatson@192.168.8.210 /home/xwatson/.ssh/id_rsa \
  secrets/wan-203.0.113.10/accounts.json artifacts/windows-installer/0.3.5
```

用 `--remember-login` 可以验证关闭应用后的自动登录、历史恢复、主动注销和服务端撤销。用 `--fresh` 替换 `--project-access` 可以同时复测错误密码的首次登录流程。

## 早期便携版与跨设备协议复测

从仓库根目录以 Python 3 运行下列命令。`ws` 来自根锁文件，Desktop Commander 来自仓库记录的 npm tarball，两者都在打包时校验。新装 Windows VM 时生成一次独立的 EasyTier 密钥和实例编号。已有安装沿用 `windows.toml`。

```sh
python3 src/account-devices/windows/bundle.py ws-8.22.0.tgz desktop-commander-0.3.3.tgz windows-app.zip
python3 src/account-devices/windows/prepare-peer.py client.toml windows.toml
```

将生成的两份文件、实验 CA 公共证书 `ca.crt`、`install.ps1` 及三个官方 x64 压缩包放入当前 Windows 用户的 `%LOCALAPPDATA%\AnywhereMesh\staging`。三个压缩包分别为 Node 24.21.0、Electron 45.3.3 和 EasyTier 2.6.4，文件名与 SHA-256 记录在安装脚本内。脚本使用 .NET Framework 4 的 C# 编译器生成本地辅助程序。EasyTier 在加载时需要同一压缩包内的 `Packet.dll`。运行安装脚本后，启动入口位于上一级目录。

```powershell
& "$env:LOCALAPPDATA\AnywhereMesh\staging\install.ps1"
```

在飞牛实验根目录执行下面的复测。Windows 用户需已登录图形桌面并关闭实验客户端。飞牛 Ubuntu VM 中至少一个 Linux 实验客户端需已登录同一普通账号。测试在已登录的 Windows 桌面以普通权限运行 Electron，密码通过该用户专用的一次性命名管道交给表单。测试结束后会移除临时计划任务。

```sh
python3 source/src/account-devices/windows/verify.py \
  xwatson@192.168.8.210 /home/xwatson/.ssh/id_rsa scripts/ssh-guest.sh \
  secrets/wan-203.0.113.10/accounts.json artifacts/windows-read
```

Windows 首先发起真实读取，然后在项目内更新本次测试创建的文件。Linux 设备通过自己的登录连接，在同一会话再次读取。验收比较新内容的 SHA-256，并检查远端提权、只读写入、撤销后的读取及离线发送均被拒绝。每次复测生成独立的 JSON 报告和原生桌面截图。另可运行 `read.test.mjs` 检查 Windows 文件边界、授权、离线 npm 构建、写回冲突和取消，运行 `check-peer.ps1` 验证异常退出后的进程与端口回收。
