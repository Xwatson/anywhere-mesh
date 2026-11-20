# Linux 双设备与独立公网服务端

飞牛 Ubuntu VM 内的两个 Linux 安装实例通过 EasyTier WSS 连接远端 Ubuntu 服务端。项目、桌面账号登录和本地授权在飞牛 VM 中，远端运行账号库、管理网页、会话宿主及每次调用的 stdio MCP。模拟宿主通过正常业务协议调用本地工具。

| 入口 | 当前部署 |
| --- | --- |
| 公网传输 | EasyTier 2.6.4 主动连接 `wss://awc.xbxbe.com/easytier`，经 Cloudflare 和源站 Nginx 的 443 端口到达服务端 |
| 业务 HTTPS / WSS | `10.203.73.2:18443`，仅位于服务端专用网络命名空间 |
| 服务端管理 | `https://awc.xbxbe.com/`，Nginx 通过 `127.0.0.1:18443` 转发到业务 HTTPS 并验证内部证书 |
| 服务端目录 | `/opt/anywhere-wan` 保存定版的 Node、EasyTier 和构建产物，`/etc/anywhere-wan` 保存配置和证书，`/var/lib/anywhere-wan` 保存账号与会话 |
| 客户端目录 | VM 中 `/srv/anywhere-lab/wan/project-a` 和 `project-b` 各由独立用户持有，`/etc/anywhere-wan-cn` 保存连接配置 |

## 打开管理页和桌面

浏览器首页用于继续已绑定设备的会话。管理账号可从左下角账户菜单打开设备管理，也可使用直达链接。浏览器使用系统信任库，桌面在 EasyTier 隧道内单独验证实验 CA。公网网页和桌面业务都走 443。[打开管理页](https://awc.xbxbe.com/?view=devices)

管理账号为 `lab-admin`，设备 A/B 共用的普通测试账号为 `lab-coder`。密码保存在 NAS 实验根目录的 `secrets/wan-198.84.90.137/accounts.json`。在飞牛 VM 运行 `sudo systemctl start anywhere-wan-ui-a` 或 `anywhere-wan-ui-b` 可打开对应的桌面；登录后客户端会出现于管理页，在设备上授予项目权限后即可操作。退出登录会撤销该安装的项目权限。

桌面和网页均可从左下角账号名 → **更改密码** 更新自己的密码。当前登录保留，其他设备与浏览器需要重新登录。自动化验收单独从 NAS 私有凭据文件读取密码，修改用于验收的账号后需要同步更新该文件中的对应条目。

## 构建和部署

1. 在具备 D3 运行时、锁定依赖和已编译 `server/dist` 的飞牛实验 VM 中运行 `bash experimental/account-devices/wan/build.sh STAGE/app`。对 `STAGE` 中的 `app/server.mjs`、`app/mcp.mjs` 和 `app/ui/` 下的全部网页资源生成相对路径的 `app.sha256`。
2. 全新部署时在管理机运行 `python3 experimental/account-devices/wan/prepare.py NEW_PRIVATE_DIR awc.xbxbe.com` 生成身份。向远端独立暂存目录传送 `app/`、`app.sha256`、`server.toml`、锁定的 `node.tar.xz`（24.21.0 Linux x64）、`easytier-core`、`easytier-cli`（2.6.4 Linux x86_64）和此目录的安装脚本与模板。以 root 运行 `python3 install-server.py STAGE awc.xbxbe.com`，首次从 SSH 标准输入提供 `accounts.json`。
3. 在已配置 Nginx 和 Certbot 账号的源站运行 `python3 publish-domain.py awc.xbxbe.com /opt/web-desktop-certbot/bin/certbot`。HTTP-01 验证目录为 `/var/www/anywhere-wan-acme`。系统每天两次检查本域名证书，续签成功后平滑重载 Nginx。EasyTier 上游和业务上游分别绑定源站回环端口 31483、18443。
4. 将 `client.toml`、`accounts.json`、远端的公有 `ca.crt` 和 `server.crt` 放入飞牛 VM 私有暂存目录。同步本分支的 `experimental/` 后运行 `sudo python3 experimental/account-devices/wan/install-client.py STAGE awc.xbxbe.com`。VM 首次启动和运行中每分钟解析该域名，向专用容器提供 IPv4 地址。只有网络进程可经物理出口连接解析出的地址和 TCP 443。设备 A、B 在隧道内访问业务端口 18443。

## 实验会话连接已登录的 Codex

在完成上述部署的美国机上，`desktop` 用户运行的 Codex CLI 0.170.0 已登录。构建机用 `bash experimental/account-devices/wan/build.sh STAGE` 生成服务端与 MCP，将同目录的 `codex-service.py`、`anywhere-wan-codex.socket`、`anywhere-wan-codex@.service`、`deploy-codex.py` 一起复制到美国机的构建产物目录。在该机以部署管理员执行 `python3 STAGE/deploy-codex.py STAGE`。升级会检查实验服务的活动回合，重启该服务并检查 HTTPS 健康状态。

登录客户端，打开有本机授权的会话，便可从「发给 Codex」发送自然语言消息。美国端按会话持久化线程编号，读取工具经已有 Workspace MCP 和设备连接执行。生成中点击「停止任务」可中断当前回合。设备诊断命令（如 `/read notes.txt`）继续使用模拟宿主。

## 复测和生命周期

NAS 实验根目录下执行以下命令。测试程序使用飞牛 VM 中的两个客户端，重启远端的测试会话宿主后自动验证恢复。SSH 私钥保留在 NAS。

```sh
python3 source/experimental/account-devices/wan/check.py scripts/ssh-guest.sh \
  198.84.90.137 /srv/anywhere-lab/artifacts/domain-acceptance.json --ssh-bind 192.168.8.2
python3 -B source/experimental/account-devices/wan/domain-check.py awc.xbxbe.com \
  secrets/wan-198.84.90.137/accounts.json /tmp/anywhere-domain-check.json
```

`--ssh-bind` 仅让 NAS 的管理 SSH 使用指定的本机地址。公网验收分别检查网页和设备接口的身份验证、管理员登录和退出、WebSocket 升级。图形验收使用设备 B 的独立测试 profile 和 VM 的 Xorg，启动 Electron 时传入 `--lab-device=b --lab-wan --lab-device-smoke`。该进程需要能访问设备 A/B 控制套接字和 `/run/anywhere-wan-cn/netns` 内的 HTTPS。报告和截图位于客体 `/srv/anywhere-lab/artifacts/wan-*`。

服务端通过 `systemctl start anywhere-wan-net anywhere-wan-wire.socket anywhere-wan-admin.socket anywhere-wan-host` 启动；客户端在 VM 中通过 `systemctl start anywhere-wan-client-a anywhere-wan-client-b` 启动。两侧按需启动，重启操作系统后使用上述命令恢复。若要结束实验，先在 VM 停止 `anywhere-wan-ui-{a,b}`、`anywhere-wan-client-{a,b}` 和 `anywhere-wan-cn`，再在服务器停止 `anywhere-wan-wire.socket`、`anywhere-wan-admin.socket`、相应的两个代理服务、`anywhere-wan-host` 和 `anywhere-wan-net`。
