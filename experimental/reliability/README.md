# C 阶段：保留策略、未知任务核对与文件版本保护

这是 Linux 单工作区可靠性的首轮实现，继续使用模拟宿主、真实 MCP、EasyTier/mTLS、国内 Agent 和沙箱内 Desktop Commander。生产 Anywhere 和真实 CLI 均未接入；前面的 B1/DC/B2 状态及未知任务证据保留。

## 记录容量与恢复

SQLite 增加 `archive_records`，查询自动查回归档。已结束且宿主确认消费的操作，由 Broker 向国内发送绑定结果摘要的 `consumeResult`；双方确认后，各自仅保留最近 32 条已交付操作在活动集合，其余请求、调用身份、结果和审计记录进入同库归档。移动记录和相关索引在事务中完成。未知、运行中和未交付任务始终保留活动状态。

归档不会删除操作身份，不会将旧请求变成可重新执行的新操作。旧调用仍可查原结果，同编号改参数仍拒绝；调用凭据、任务索引和消费回执在宿主侧一起归档。已交付操作的旧输出页可回收，查询时继续显示截断位置；完整会话输出由已经落盘的宿主历史负责。仍需处理停止意图的回合会恢复到活动集合，确认停止后再归档。

授权历史和变更请求也保留最近 32 条在活动集合，旧版本和旧请求可从归档恢复核对，取消了 64 次变更的生命周期上限。当前每个日志库按数据库与 WAL 的实际分配空间设置 64 MiB 接收预算，并预留 256 KiB 给结果、取消和拒绝记录；不足时拒绝新工作/新授权，撤权和查询仍可进行。活动中未解决的调用上限仍为 128，已交付任务会归档，因此这不再是整个工作区的总调用次数上限。

这是有容量预算的长期身份保留，不是无限存储。没有静默清空日志或按时间删除去重身份的功能；达到预算后需要受控扩容或带新工作区身份的迁移，不能删数据库后继续沿用原凭据。线上配额管理与迁移 UI 仍待产品化。

## 本地核对未知任务

新增国内本地 `reviewPreview` 和 `reviewUnknown`，不向模型或美国 RPC 暴露。核对前必须撤销工作区权限；仍有受管进程时拒绝关闭任务。预览给出操作请求、摘要、已知结果和待核对摘要；提交必须绑定当前摘要、独立请求编号、明确的 `acknowledge_unknown` 处置及说明。

核对后状态为 `reviewed`，执行结果仍标为 **unknown**，保存原状态、原结果、说明和时间，不伪造成功、不自动重做。美国宿主收齐这一决定并落入历史，再确认消费，才能解除恢复屏障。重复核对请求幂等，过期预览或改写已有请求被拒绝。实际人工核对应该查看文件、Git 差异、命令产物和必要的备份；确认关闭不等于事务回滚。

Agent 运行时在国内本地使用：

```bash
node /usr/lib/anywhere-reliability-runtime/workspace/local-control.mjs \
  /srv/anywhere-lab/reliability-c/local/control.sock review-preview OPERATION_ID
node /usr/lib/anywhere-reliability-runtime/workspace/local-control.mjs \
  /srv/anywhere-lab/reliability-c/local/control.sock review-submit decision.json
```

`decision.json` 格式如下，摘要必须来自当前预览，请求编号由本地管理端生成并保存，以便安全重试：

```json
{
  "requestId": "unique-local-review-id",
  "operationId": "operation-id-from-preview",
  "expectedDigest": "digest-from-current-preview",
  "disposition": "acknowledge_unknown",
  "note": "本地核查的内容、观察到的副作用及为何可以结束等待"
}
```

目前入口是本地 API/CLI；图形核对界面属于后续桌面阶段。实验只核对本轮创建的故障夹具，未关闭 B1/DC/B2 留存的未知记录。

## 文件版本保护

可靠性配置启用 `workspace.reliability`。文本读取先取得有界快照，再交给 Desktop Commander；返回的 `fileVersions` 包含路径和不透明 `revision`。写入/精确编辑必须携带 `expectedRevision`；新文件使用 `null`，表示路径必须尚不存在。

```json
{"path":"src/example.ts","oldText":"before","newText":"after","expectedRevision":"file-v1:…"}
```

版本包含内容摘要、inode、大小与纳秒时间等信息，能发现同内容换 inode。Desktop Commander 在私有副本上执行编辑，然后再校验原文件版本；本地编辑已改变文件时返回 `FILE_VERSION_CONFLICT`，原文件不被覆盖。目录组件通过 `dir_fd` 与 `O_NOFOLLOW` 打开，拒绝符号链接、硬链接、多余上级路径、非普通文件和超过 1 MiB 的文本快照。父目录变化也会重新核对。

新文件采用原子“仅不存在时创建”；已有文件采用版本检查后原子替换，并先持久保存修改前副本。替换保留所有者、组、普通权限及扩展属性；无法保留时拒绝提交，带 setuid/setgid 或 `security.*` 属性的文件暂不支持修改。备份位于国内私有 `agent/file-backups/`，以操作编号摘要命名，预算 64 MiB；未决任务的备份保留，已交付并归档的旧任务备份可回收，近期约 32 条仍可核查。异常中断导致提交状态不明时继续进入 unknown。

**这是乐观并发保护，不是文件系统级 compare-and-swap。** 不配合锁定的外部编辑器，仍可能在最后检查与替换之间写入；不能宣称已经消除此窗口。需要完全互斥的协作编辑体验，后续应引入编辑器协作或工作副本合并流程。当前保护能拒绝已观察到的版本变化，并提供修改前副本。它仅覆盖这些文件工具；`workspace_run` 中的构建、Git 或脚本写入仍受执行权限与沙箱约束，不承诺文件级版本检查。

## 输出与资源边界

任务输出继续按 64 KiB 保留，分页和截断 gap 显式返回，宿主必须读到最终游标。结构化结果限制 22 KiB；只读操作结果超限返回明确失败和缩小范围的提示，不再制造无法解除的未知态。可能产生副作用的操作若丢失完整结果，仍保守进入 unknown。命令最长 120 秒；Agent 保持非 root、零宿主 capabilities、768 MiB 内存、75% CPU 与 128 tasks 限制。

## 复现和证据

仅在已有实验 VM 上安装，旧执行实验服务应停止。新服务为 `anywhere-reliability-agent`、`anywhere-reliability-broker`，运行时 `/usr/lib/anywhere-reliability-runtime/`，状态 `/srv/anywhere-lab/reliability-c/`；不启用自启。重复联调会归档本轮 C 状态和工作区再创建夹具，不能将这种测试重置用于真实未知任务。

```bash
sudo bash /srv/anywhere-lab/source/experimental/reliability/lab/install.sh
cd /srv/anywhere-lab/source
node --test experimental/execution/test/*.test.mjs experimental/desktop-commander/test/*.test.mjs experimental/workspace/test/*.test.mjs experimental/reliability/test/*.test.mjs
node experimental/reliability/lab/integration.mjs
node experimental/reliability/lab/verify-final.mjs
```

本轮 45 项单元测试、10 项真实联调通过。联调包含 140 次连续真实 MCP 调用和 70 次权限变更、归档后旧写入不重做、过期文件版本拒绝、200 KB 命令输出截断后仍保留尾部、运行中 Broker 重启，以及真实写入后故障、国内核对、宿主确认消费和恢复新操作。最终检查另行重启实验 Agent/Broker 核对历史，验证无重复执行，并检查数据库完整性和服务收尾。

证据位于客体/NAS 实验根目录 `artifacts/reliability-c-{integration,retained-state,final-state,checkpoint}.json`，NAS 日志为 `logs/reliability-c-{tests,integration,final-state}.log`。凭据数据库不导出到报告。

本轮不是完整 C 阶段压力认证。小时/天级持续运行、真实跨国丢包、磁盘满故障注入、更多双连接竞态、文件编辑最终竞态消除及桌面产品恢复流程仍待验证。下一阶段可将这些明确的状态和限制接入 Linux 桌面最小版本，继续用模拟宿主，真实 CLI 留到最后。
