# Linux 账号登录、设备与会话（D3）

飞牛 VM 连接独立公网服务端的部署、管理页入口和复测命令见[公网联调说明](wan/README.md)。

Windows 10 x64 已接入同一账号和会话协议，可从同账号的 Linux 客户端读取绑定到 Windows 会话的本地文本。[Windows 客户端使用与复测](windows/README.md)

在飞牛的 `anywhere-lab` 中使用。国内 A、B 是独立 Linux 用户运行的两个安装实例，各有私有安装凭据、桌面 profile、项目根和 Agent 日志。美国端运行实验账号库、设备管理页和模拟 CLI 宿主。两个项目均含 `notes.txt`，内容分别带有 `ONLY_DEVICE_A` 和 `ONLY_DEVICE_B`。

## 使用

在 VM 中运行 `sudo systemctl start anywhere-d3-ui-a` 打开设备 A，`anywhere-d3-ui-b` 打开 B。实验账号为 `lab-coder`，管理员为 `lab-admin`。实验密码保存在客体私有文件 `/srv/anywhere-lab/d3/test/accounts.json`，安装时随机生成。管理员可在桌面选择“设备管理”，或从实验虚拟网访问美国服务端 `https://10.126.10.2:8443/` 登录网页。网页使用 HTTPS，信任实验服务端 CA。

1. 在 A 登录后直接输入第一条消息。首次使用项目时确认只读授权，客户端会自动创建并命名会话。输入框内的项目按钮可切换本机项目或调整权限。
2. 在 B 登录同一账号，从项目侧栏或「搜索会话」打开 A 的会话。标题栏和提示条标出绑定的执行设备。发送 `/read notes.txt` 可以查到 A 的标记。若要从这个会话写入，在 A 上授予编辑权限，先读取，再发送 `/append notes.txt 内容`。
3. 在 B 的本机项目上新建另一会话即可操作 B。退出 A 后，原会话可在 B 查看历史。重新登录 A 并在 A 上授权，可继续原会话。
4. 网页管理页按账号展示设备、在线状态、最近在线时间及已绑定会话。停用设备会断开此设备的执行链路。恢复接入后，由该设备重新登录。

## 路由与状态

桌面通过受限 IPC 与本地 Agent 通信。只有本地 Agent 持有安装凭据和登录令牌。服务端复用本项目的账号验证、登录节流、会话期限和管理员角色，数据目录为实验专用。服务端按账号和安装凭据的摘要识别设备，分配稳定 UUID。浏览器管理登录使用独立的 HttpOnly Cookie，不登记为执行设备。设备名及 IP 只用于显示和连接。

新建会话时，账号和设备来自已认证的登录，工作区必须属于本机。在同一事务中保存会话、目标和创建回执。服务器按账号隔离会话及请求编号。后续消息和停止仅接受会话编号、请求编号及业务参数。使用原 D2 SessionHost、Workspace MCP、Broker 和国内 Desktop Commander 执行请求，工具的账号、设备、项目和授权版本均经校验。旧 D2 日志独立保留。

已认证的设备 WSS 每 2 秒检测心跳，超过 8 秒无回应在下一次检查时转离线。连接主动关闭或管理员停用时立即移除。每个项目独立建立执行 WSS，权限仍由该设备本地管理。客户端关闭、注销或切换账号会撤销本地权限。服务端独立于各桌面窗口运行。服务端与客户端重连不改变已保存的会话目标。

## 部署与复测

仅在已准备的实验 VM 中运行。D2 和 D3 使用同一实验业务端口，切换前先正常关闭正在使用的实验桌面。VM 重启后，先恢复 `native/linux/network-helper/lab/install.sh` 中的 helper 和命名空间，D3 启动时自动获取两端租约。D3 服务单元按需启动。

```sh
cd /srv/anywhere-lab/source
sudo python3 experimental/account-devices/lab/install.py
sudo systemctl start anywhere-d3-host anywhere-d3-client-a anywhere-d3-client-b anywhere-desktop-display
sudo nsenter --net=/run/anywhere-network/cn.netns runuser -u lab -- /usr/local/bin/node \
  experimental/account-devices/lab/acceptance.mjs /srv/anywhere-lab/artifacts/d3-acceptance.json
sudo systemd-run --quiet --wait --collect --unit=anywhere-d3-screen-check --uid=lab \
  -p NetworkNamespacePath=/run/anywhere-network/cn.netns -p Environment=DISPLAY=:0 \
  -p Environment=XAUTHORITY=/srv/anywhere-lab/desktop-d/display.Xauthority -p Environment=LANG=zh_CN.UTF-8 \
  /usr/bin/dbus-run-session /usr/lib/anywhere-desktop-electron/electron --disable-setuid-sandbox \
  /usr/lib/anywhere-d3-runtime/experimental/desktop --lab-device=b --lab-device-smoke
cat /srv/anywhere-lab/artifacts/d3-gui.json
```

复测使用 D3 专用测试账号和工作区，过程中重启 D3 宿主并暂停、恢复 A 的心跳。所有服务与资料位于实验 VM。收尾时使用 `sudo systemctl stop anywhere-d3-ui-a anywhere-d3-ui-b anywhere-d3-client-a anywhere-d3-client-b anywhere-d3-host anywhere-d3-network` 关闭本轮实验并释放租约。

本轮使用预设的本地项目根和模拟宿主，验证重点是账号、设备权限、路由和在线状态。通用目录选择、桌面安全存储与升级、D2 的完整本地离线历史及未知结果核对界面整合仍在后续范围。真实 CLI 按计划在最后接入。
