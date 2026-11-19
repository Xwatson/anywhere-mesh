# 美国 Codex CLI 与 Windows 工作区只读验收

该入口供实验管理员单次启动。美国端已经登录 ChatGPT 的 `desktop` 用户运行 Codex，`anywhere-wan` 用户加载已登录桌面创建的会话、解析设备绑定并调用已部署的 Workspace MCP。两个进程用匿名管道交换 app-server 协议。Windows 继续通过自己的 EasyTier 连接传送工具请求与结果。

在已有构建依赖的 Linux 实验 VM 的源码根目录运行以下命令，生成单次测试用的宿主。服务器上的部署目录需要允许两个用户穿越，构建文件只需供服务用户读取。将 `read-turn.mjs` 与本目录的 `launch.py` 放在一起。启动器会找到正在运行的 `anywhere-wan-host.service` 所用的 MCP 版本。

```sh
node_modules/.bin/esbuild experimental/account-devices/codex/read-turn.mjs \
  --bundle --platform=node --target=node24 --format=esm \
  --external:bufferutil --external:utf-8-validate \
  --banner:js="import {createRequire as __nodeRequire} from 'node:module';const require=__nodeRequire(import.meta.url);" \
  --outfile=/tmp/read-turn.mjs
```

把 `../windows/codex-fixture.mjs` 上传到 Windows 实验用户的 `%LOCALAPPDATA%\AnywhereCodingLab\staging\`，在 NAS 侧运行以下命令。远端启动器使用 Python 3.11 及以上版本，工作区宿主使用实验服务部署的 Node 24。

```sh
lab=/vol1/1000/anywhere-crossborder-lab
python3 experimental/account-devices/codex/verify.py \
  --windows xwatson@192.168.8.210 --identity "$HOME/.ssh/id_rsa" \
  --server root@198.84.90.137 --source-ip 192.168.8.2 \
  --server-dir /opt/anywhere-wan/experiments/codex-read/dfe7486f765e79b6 \
  --accounts "$lab/secrets/wan-198.84.90.137/accounts.json" \
  --reports "$lab/artifacts/codex-windows"
```

多网卡 NAS 可以用 `--source-ip` 指定运维 SSH 的源地址。美国端可执行文件位于 `/opt/anywhere-wan/experiments/codex-read/dfe7486f765e79b6/`，每次启动在 `/var/tmp/awc-codex-read-*` 下创建独立工作目录。

Windows 控制器用普通实验账号登录、授予只读权限，在项目内新建一行随机文本。发送给模型的是文件名和读取要求。工具回调从 Codex 获取线程、回合及调用编号。宿主核对会话与当前授权，给实际 MCP 调用签发票据，持久化终态结果后回执。Codex 使用 `desktop` 原有的登录资料，调用票据保存在 `anywhere-wan` 的会话数据库。Windows 通过已有会话历史验证工具输出、模型答案和本地原文，随后撤销权限、验证服务端拒绝、退出并清理临时文件。报告保留文件及答案摘要、设备启动次数、结果确认状态和回合编号。

这条命令只联调固定测试文件的单次读取。网页正常发送消息仍使用实验模拟宿主。若中断，使用报告中的操作编号查询原操作；再次运行验收会生成新的文件，作为另一次独立测试。[Codex app-server 动态工具协议](https://learn.chatgpt.com/docs/app-server)
