# AnywhereMesh Linux 客户端（桌面 GUI + 无界面 CLI Agent）

一套安装包同时提供两种运行方式，均无需 `root` 权限：

1. **桌面图形客户端 (`anywhere-mesh`)**：完整 Electron 图形界面（与 Windows 桌面端一致的聊天、双引擎切换、项目文件夹选择器、本地权限授权、系统管理、5 步连接进度条），同时将本机作为在线设备注册到 AnywhereMesh。
2. **无界面后台 Agent (`anywhere-mesh-agent`)**：纯命令行/守护进程模式，适合 Linux 服务器、NAS 或不需要打开图形窗口时常驻后台，由其他设备远程控制本机代码仓库。

## 打包 Linux x64 离线安装包

```bash
python3 src/account-devices/linux/package-linux.py \
  --archives /path/to/images \
  --ws /path/to/ws-8.22.0.tgz \
  --ca /path/to/ca.crt \
  --output /path/to/AnywhereMesh-0.4.5-linux-x64.tar.gz
```

## 安装与使用

```bash
tar -xzf AnywhereMesh-0.4.5-linux-x64.tar.gz
cd AnywhereMesh-0.4.5-linux-x64
./install.sh
```

安装完成后：
- **图形桌面客户端**：直接从桌面应用菜单打开 **AnywhereMesh**，或命令行运行 `~/.local/bin/anywhere-mesh`。
- **无界面命令行 Agent**：
  ```bash
  ~/.local/bin/anywhere-mesh-agent --project /path/to/repo --label my-repo --mode execute
  ```
- **systemd 用户后台服务**：参考 [anywhere-mesh-agent.service.example](./anywhere-mesh-agent.service.example)。
- **卸载**：运行 `~/.local/opt/AnywhereMesh/uninstall.sh`（附加 `--purge` 可一并删除本地状态与登录凭据）。
