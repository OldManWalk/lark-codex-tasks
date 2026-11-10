# LarkNotify Session 与群组 Attachment 设计

## 1. 四种对象不能混用

- **逻辑任务链（chain）**：用户持续推进的同一件事。跨执行轮次、跨群重建、跨设备交接保持同一 chain。
- **Codex thread**：某个 Codex 节点本地保存的执行上下文。thread ID 只在所属节点有效。
- **群 Attachment**：群与 chain 的协作关系。它决定群消息是否进入执行器、审批与结果发送到哪里。
- **执行轮次（run/job）**：一次 turn 的生命周期。模型策略、审批回调、执行进程和结果均属于 run，不永久属于群。

执行权是 Attachment 的运行时状态，不是 thread 的属性。一个 thread 可以长期存在，但同一时刻最多一个执行入口。

## 2. 本机与服务器

`threadNode.id` 是判断能否直接恢复的依据，`local/server` 是可读角色：

- macOS 默认 `local`，服务器默认 `server`，可用 `LCT_NODE_ROLE` 显式覆盖。
- 同一节点：可以 `thread/resume` 原 thread，并保留原 cwd。
- 不同节点：不能直接输入服务器 thread ID。先回收固定成果和返回摘要，再在本地创建或恢复关联 thread。
- 不用操作系统名称代替节点 ID。另一台 Linux 也可能是本机，同一台机器的不同 LarkNotify 实例也有不同 node ID。

## 3. 状态关系

```text
active group / attached / owner=current node
       |
       | /release（仅在无运行、无排队、无待审批、无待投递时）
       v
parked group / parked / owner=none / Resume package retained
       |
       | /done（显式第二阶段）
       v
group dissolved / binding removed / archive retained
```

`release` 不删除 thread、不删除群、不归档任务，也不自动超时。普通群消息在 parked 状态不会入队或触发模型。重复 `release` 幂等，不重复增加 generation。

## 4. 持久化边界

`groups.json` 仍是群绑定的唯一权威，不另建一份容易漂移的 Session 表。每个 active/parked 群记录包含：

- `chain/thread`：逻辑链与当前节点的 thread 引用。
- `attachment.threadNode`：thread 所在节点。
- `attachment.ownerNode`：当前执行节点；parked 时为 null。
- `attachment.generation`：每次释放递增，用于拒绝旧执行事件与审批。
- `attachment.resume`：释放时生成的恢复包。

最新 job 同时保存 Resume 包，`lct resume <jobId>` 根据当前节点生成恢复说明。跨节点只返回 `remote-result-handoff`，不伪造可直接执行的 Codex 命令。

## 5. 不变量

1. 一个 active 群只有一个最新 anchor，chain 不因执行轮次改变。
2. 一个 thread 最多一个 active 群执行入口；parked 历史可以保留。
3. 群 parked 后普通消息不执行，旧审批与待投递不得残留。
4. `/done` 可以结算 active 或 parked 群，但永远由用户显式触发。
5. 跨设备交接是 `source thread reference -> target thread`，不是远程 ID 直接复用。
6. 模型策略属于 run。CCSwitch 默认值在每轮读取，Attachment 将来可以携带显式覆盖。

## 6. 本阶段与后续

本阶段实现 Attachment 元数据、唯一 active 附着、`/release`、parked 路由、`/done` 第二阶段和 `lct resume`。

后续 Handoff Skill 负责生成摘要与不可变输入 checkpoint。服务器接收器完成能力预检、群创建、执行权接收和 `READY_TO_SHUTDOWN` 回执。跨机返回还需实现结果分支/材料回收，不能用本设计中的 Resume 包假装已经完成。

## 7. 本机与服务器后续融合

融合的目标是统一任务视图与交接协议，不是把 本地节点和服务器 合并成一个双活进程。

- **节点独立**：配置、状态目录、Codex Home、队列和本地工具保持独立。节点 ID 不随同步复制。
- **逻辑统一**：chain 是跨节点主键；每次交接产生新的 generation 和 Attachment，旧执行事件不能跨代生效。
- **传输可替换**：当前可使用 SSH/私有 socket，将来可增加统一事件路由或 Web 控制台，不改变执行器语义。
- **单写者**：同一 chain 同时只有一个执行 owner。飞书应用也只能有一个活跃消费端，除非使用不同应用。
- **按需接管**：统一控制台可以只读聚合各节点状态；写操作必须路由到当前 owner，不能直接修改另一节点的 groups/jobs。

推荐的演进顺序：

1. 独立 本地节点/服务器 安装与本设计中的 Attachment、release、resume。
2. Handoff manifest、固定输入 checkpoint、目标能力预检和接管回执。
3. 结果发布与跨机回收，完成 `release -> local resume -> done`。
4. 只读统一控制台与可选主备事件路由。最后才考虑自动化主备切换，且仍需防止双写。
