# Windows 实验客户端

飞牛虚拟机 `192.168.8.210` 已安装 Windows 桌面实验版。系统为 Windows 10 Enterprise LTSC 2021 x64，构建号 19044.3324。设备在管理页显示为 `Windows · DESKTOP-L0OT7AS`。

## 在 Windows 上使用

1. 在资源管理器地址栏输入 `%LOCALAPPDATA%\AnywhereCodingLab\Start-Anywhere.cmd` 并运行。用普通实验账号 `lab-coder` 登录，客户端会登记本机，首次权限为「撤销」。
2. 项目目录为 `%LOCALAPPDATA%\AnywhereCodingLab\project`。选择「只读」并点击「应用权限」。打开「Windows VM 只读验收」或在本机创建新会话，发送 `/read notes.txt`。
3. 在另一台客户端用同一账号打开该会话，标题会显示 Windows 执行设备及在线状态。Windows 退出后，其他设备能查看该会话的历史。重新登录 Windows 并授权后可继续。
4. 普通用户可关闭桌面结束此安装的连接。管理员从网页查看该设备、最近在线时间和绑定会话。[打开服务端管理页](https://awc.xbxbe.com/)

## 传输与文件工具

Windows 运行 EasyTier 2.6.4，以独立身份 `10.203.73.3` 连接 `wss://awc.xbxbe.com/easytier`。无 TUN 模式在用户态将 `127.0.0.1:31844` 转发到服务端虚拟地址 `10.203.73.2:18443`。Node 客户端用实验 CA 验证内层 TLS。SSH 用于部署和驱动测试。桌面拥有网络进程的生命周期，后端退出会关闭控制管道，Windows Job Object 负责监督进程异常终止时的回收。[EasyTier 无 TUN 模式](https://easytier.cn/en/guide/network/no-root.html) 和 [端口转发](https://easytier.cn/en/guide/network/port-forward.html)

客户端复用 Linux 桌面的 Electron 界面、账号协议、设备身份、项目授权和操作日志。美国端模拟 CLI 通过正常的 Workspace MCP 调用 `workspace_read_file`。Windows 读取器逐段打开本地路径，从已校验的文件句柄读取至多 1 MiB 的 UTF-8 文本。目录联接、重解析点和多硬链接文件会被拒绝。Desktop Commander 0.3.3 的 `TextFileHandler.read` 对私有快照执行分页。服务端按设备实际支持的工具生成 MCP 清单。[Desktop Commander 源码](https://github.com/wonderwhy-er/DesktopCommanderMCP/tree/bce370e9395f5bc74eda34913e5ae1dee48df8f8)

本轮 Windows 支持单文件只读。通用目录选择、搜索与编辑、隔离构建、签名安装与更新仍待实现。真实模型 CLI 在各平台基础链路稳定后接入。

## 重建与验收

从仓库根目录以 Python 3 运行下列命令。`ws` 来自根锁文件，Desktop Commander 来自仓库记录的 npm tarball，两者都在打包时校验。新装 Windows VM 时生成一次独立的 EasyTier 密钥和实例编号。已有安装沿用 `windows.toml`。

```sh
python3 experimental/account-devices/windows/bundle.py ws-8.22.0.tgz desktop-commander-0.3.3.tgz windows-app.zip
python3 experimental/account-devices/windows/prepare-peer.py client.toml windows.toml
```

将生成的两份文件、实验 CA 公共证书 `ca.crt`、`install.ps1` 及三个官方 x64 压缩包放入当前 Windows 用户的 `%LOCALAPPDATA%\AnywhereCodingLab\staging`。三个压缩包分别为 Node 24.21.0、Electron 45.3.3 和 EasyTier 2.6.4，文件名与 SHA-256 记录在安装脚本内。脚本使用 .NET Framework 4 的 C# 编译器生成本地辅助程序。EasyTier 在加载时需要同一压缩包内的 `Packet.dll`。运行安装脚本后，启动入口位于上一级目录。

```powershell
& "$env:LOCALAPPDATA\AnywhereCodingLab\staging\install.ps1"
```

在飞牛实验根目录执行下面的复测。Windows 用户需已登录图形桌面并关闭实验客户端。飞牛 Ubuntu VM 中至少一个 Linux 实验客户端需已登录同一普通账号。测试在已登录的 Windows 桌面以普通权限运行 Electron，密码通过该用户专用的一次性命名管道交给表单。测试结束后会移除临时计划任务。

```sh
python3 source/experimental/account-devices/windows/verify.py \
  xwatson@192.168.8.210 /home/xwatson/.ssh/id_rsa scripts/ssh-guest.sh \
  secrets/wan-198.84.90.137/accounts.json artifacts/windows-read
```

Windows 首先发起真实读取，然后在项目内更新本次测试创建的文件。Linux 设备通过自己的登录连接，在同一会话再次读取。验收比较新内容的 SHA-256，并检查远端提权、未支持工具、只读写入、撤销后的读取及离线发送均被拒绝。每次复测生成独立的 JSON 报告和原生桌面截图。另可运行 `read.test.mjs` 检查 Windows 文件边界，运行 `check-peer.ps1` 验证异常退出后的进程与端口回收。
