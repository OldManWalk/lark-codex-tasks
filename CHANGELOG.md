# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 约定，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.2.4] - 2026-10-11

### Fixed

- **启动加固**：systemd unit 增加 `nss-lookup` 依赖与 DNS 就绪等待（`ExecStartPre` 最多等 60s）——修复断电/重启后开机早期 DNS 未就绪导致 bridge 取 tenant token 失败报错的问题（此前靠重试自愈，现在启动即干净）

## [0.2.3] - 2026-10-09

### Added

- **群名状态灯**：任务群名跟随队列状态——队列暂停（任务失败/手动 `/qpause`/锁定）时自动改为 🟡 前缀，`/qresume` 恢复后改回 🔵；仅在状态翻转时改名，不重复打扰（148 项测试全绿）

## [0.2.2] - 2026-10-09

### Fixed

- **裸 API 调用显式 bot 身份**：`dissolveGroup` / `deleteMessage` 两个裸 `api DELETE` 补上 `--as bot`——修复宿主机器做过 `lark-cli auth login`（user 身份）后 lark-cli 默认身份漂移、导致 `/done` 解散群必然 `missing_scope` 失败的问题；新增静态回归测试：所有 `lark()` 调用必须显式携带身份（147 项全绿）

## [0.2.1] - 2026-10-09

### Fixed

- **结算容错**：`/done` 时群已解散/机器人已不在群（API 232009/230002）视为既成事实，照常清账（移除失效绑定、落 `settledAt`），不再报"群解散失败"卡死；真实异常仍失败并保留绑定供重试
- **结算错误消息**：失败时展示真实 API 原因，不再只显示被 80 字符截断的命令行前缀
- 新增 3 项结算容错验收测试，总数 146

## [0.2.0] - 2026-10-09

### Added

- **指令表情三态**：用户指令消息上的表情实时反映进度——`OneSecond`（已受理/排队）→ `Typing`（处理中）→ `DONE`（完成）/ `CrossMark`（失败）。切换贴新删旧、同一消息串行不乱序；`LCT_REACTIONS=0` 可整体关闭。纯装饰性设计：表情 API 失败仅记日志，不进死信队列、绝不影响任务执行
- 新增 6 项表情链路验收测试（三态顺序、失败态、退回重等、开关关闭、API 故障容忍、私聊路径），总数 143

### Fixed

- **任务群指令升级 `group-task-v2`**：明确禁止工作群 Codex 自行调用飞书 CLI / 开放平台 API 建群、发消息、改群信息——修复任务文本含"建一个群讨论 X"时工作单元把桥接层动作当成任务内容、重复建群的问题（建群/通知/归档/解散的唯一执行者是宿主 bridge）
- **名额退回竞态**：任务因执行名额满退回等待时，提前 `pump()` 会在 `inFlight` 标记删除前对账，把重新启动的执行项误判为"结果未知"并暂停队列；改为由 `finally` 统一调度

## [0.1.0] - 2026-10-09

首次公开发布。

### Added

- **任务群生命周期**：一个任务 = 一个飞书群 = 一条 Codex 线程；私聊派活自动建群、群内执行、`/done` 归档 Markdown 进知识库（git commit）后解散群
- **私聊分流**：私聊 Codex 仅做路由（JSON Schema 判定 `reply` / `create_group` / `resume_task`），不亲自执行；人格可用 persona 文件自定义
- **FIFO 持久队列**：群内发消息即追加后续任务；受理与去重同事务提交；支持 `/queue` `/qpause` `/qresume` `/qdrop` `/qclear`；重启后对账恢复，绝不盲目重放
- **三档执行模式**：`auto`（默认，日常直接执行、特殊操作弹卡片审批）/ `safe`（workspace-write，能问都问）/ `yolo`（全自动）
- **审批卡片**：交互卡片 [通过/记住/拒绝/取消]，回调校验 owner open_id，无超时；投递失败进死信队列退避重试；文字 `y/ys/n/c` 降级
- **归档续接**：归档是续接搜索池，旧任务群解散后可自然语言找回线程续接（`/reopen` 强制重建）
- **凭证隔离**：私聊 Codex 跑 bubblewrap 沙箱（nobody UID + home tmpfs）；任务环境 `sanitizeEnv` 剥离 `LARK_*`/`FEISHU_*`；持久化与通知边界自动 `[REDACTED]`
- **运维工具**：`/status` `/jobs` `/groups` `/logs` `/outbox`（死信核查）/ `/cleanup` `/adopt` `/auditgroups`；交互式 `install.sh init`（systemd user 服务）
- **测试**：137 项验收测试覆盖会话隔离、队列幂等、重启对账、审批生命周期、死信管理、富文本受理、密钥脱敏、模型故障路径

[Unreleased]: https://github.com/OldManWalk/lark-codex-tasks/compare/v0.2.4...HEAD
[0.2.4]: https://github.com/OldManWalk/lark-codex-tasks/releases/tag/v0.2.4
[0.2.3]: https://github.com/OldManWalk/lark-codex-tasks/releases/tag/v0.2.3
[0.2.2]: https://github.com/OldManWalk/lark-codex-tasks/releases/tag/v0.2.2
[0.2.1]: https://github.com/OldManWalk/lark-codex-tasks/releases/tag/v0.2.1
[0.2.0]: https://github.com/OldManWalk/lark-codex-tasks/releases/tag/v0.2.0
[0.1.0]: https://github.com/OldManWalk/lark-codex-tasks/releases/tag/v0.1.0
