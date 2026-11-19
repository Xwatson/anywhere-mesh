# Linux 双设备与独立公网服务端

飞牛 Ubuntu VM 内的两个 Linux 安装实例通过 EasyTier WSS 连接远端 Ubuntu 服务端。项目、桌面账号登录和本地授权在飞牛 VM 中，远端运行账号库、管理网页、会话宿主及每次调用的 stdio MCP。模拟宿主通过正常业务协议调用本地工具。

| 入口 | 当前部署 |
| --- | --- |
| 公网传输 | `198.84.90.137:31483/TCP`，EasyTier 2.6.4 的 WSS 入口与会话宿主同机 |
| 业务 HTTPS / WSS | `10.203.73.2:18443`，仅位于服务端专用网络命名空间 |
| 服务端管理 | `127.0.0.1:18443` 由 systemd 转发至业务 HTTPS |
| 服务端目录 | `/opt/anywhere-wan` 保存定版的 Node、EasyTier 和构建产物，`/etc/anywhere-wan` 保存配置和证书，`/var/lib/anywhere-wan` 保存账号与会话 |
| 客户端目录 | VM 中 `/srv/anywhere-lab/wan/project-a` 和 `project-b` 各由独立用户持有，`/etc/anywhere-wan-cn` 保存连接配置 |

## 打开管理页和桌面

在能登录服务器的电脑上运行以下命令，保持 SSH 连接并打开 `https://localhost:18443/`。需要验证 HTTPS 时，测试 CA 的公有证书可从服务端 `/etc/anywhere-wan/ca.crt` 获取，只需在测试浏览器配置中信任它。

```sh
ssh -N -L 127.0.0.1:18443:127.0.0.1:18443 root@198.84.90.137
```

管理账号为 `lab-admin`，设备 A/B 共用的普通测试账号为 `lab-coder`。密码保存在 NAS 实验根目录的 `secrets/wan-198.84.90.137/accounts.json`。在飞牛 VM 运行 `sudo systemctl start anywhere-wan-ui-a` 或 `anywhere-wan-ui-b` 可打开对应的桌面；登录后客户端会出现于管理页，在设备上授予项目权限后即可操作。退出登录会撤销该安装的项目权限。

## 构建和部署

1. 在具备 D3 运行时、锁定依赖和已编译 `server/dist` 的飞牛实验 VM 中运行 `bash experimental/account-devices/wan/build.sh STAGE/app`。对 `STAGE` 中的 `app/server.mjs`、`app/mcp.mjs` 和三个 Web 资源生成相对路径的 `app.sha256`。
2. 在管理机运行 `python3 experimental/account-devices/wan/prepare.py NEW_PRIVATE_DIR PUBLIC_IPV4` 生成这一套测试身份。向远端独立暂存目录传送 `app/`、`app.sha256`、`server.toml`、锁定的 `node.tar.xz`（24.21.0 Linux x64）、`easytier-core` 和 `easytier-cli`（2.6.4 Linux x86_64），以及安装脚本。以 root 运行 `python3 install-server.py STAGE PUBLIC_IPV4`，首次从 SSH 标准输入提供 `accounts.json`。安装器验证文件哈希，使用独立服务身份，并在首次部署签发 TLS 证书。
3. 将 `client.toml`、`accounts.json`、远端的公有 `ca.crt` 和 `server.crt` 放入飞牛 VM 的私有暂存目录。同步本分支的 `experimental/` 到 VM 源码副本后，运行 `sudo python3 experimental/account-devices/wan/install-client.py STAGE PUBLIC_IPV4`。登录密码和网络私钥只保存在运行所需的私有目录。EasyTier 的启动输出关闭，避免把密钥写入服务日志。

## 复测和生命周期

NAS 实验根目录下执行以下命令。测试程序使用飞牛 VM 中的两个客户端，重启远端的测试会话宿主后自动验证恢复。SSH 私钥保留在 NAS。

```sh
python3 source/experimental/account-devices/wan/check.py scripts/ssh-guest.sh \
  198.84.90.137 /srv/anywhere-lab/artifacts/wan-acceptance.json
```

图形验收使用设备 B 的独立测试 profile 和 VM 的 Xorg，启动 Electron 时传入 `--lab-device=b --lab-wan --lab-device-smoke`。该进程需要能访问设备 A/B 控制套接字和 `/run/anywhere-wan-cn/netns` 内的 HTTPS。报告和截图位于客体 `/srv/anywhere-lab/artifacts/wan-*`。

服务端通过 `systemctl start anywhere-wan-net anywhere-wan-wire.socket anywhere-wan-admin.socket anywhere-wan-host` 启动；客户端在 VM 中通过 `systemctl start anywhere-wan-client-a anywhere-wan-client-b` 启动。两侧按需启动，重启操作系统后使用上述命令恢复。若要结束实验，先在 VM 停止 `anywhere-wan-ui-{a,b}`、`anywhere-wan-client-{a,b}` 和 `anywhere-wan-cn`，再在服务器停止 `anywhere-wan-wire.socket`、`anywhere-wan-admin.socket`、相应的两个代理服务、`anywhere-wan-host` 和 `anywhere-wan-net`。
