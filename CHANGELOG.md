# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 约定，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- docs 收录《场景介绍》PDF（两个真实场景与工作流说明）；发布敏感扫描跳过图片/PDF 等二进制文件。

## [0.4.1] - 2026-10-13

### Added

- 长报告文件投递：任务结论超过阈值（默认 2500 字，LCT_REPORT_FILE_THRESHOLD）时，完整报告先落盘为 Markdown 并尽力转为 PDF（reportlab + 内嵌中文字体，LCT_REPORT_PDF/LCT_REPORT_PDF_FONT/LCT_REPORTS_DIR 可配），作为文件消息发送到任务群；结果卡只展示开头摘要并标注完整报告去向。PDF 转换失败自动退化为 Markdown 文件，不阻断交付。
- 结果投递可观测性：flush 重试日志携带真实失败原因，不再只有 `notification pending for <id>`。

### Fixed

- 私聊委派建群任务时，worker 收到的任务文本改为路由提取的任务内容，不再携带“帮我建一个群”等控制面措辞；此前 worker 会纠结于自己无权建群（生产事故：郑州买房调研任务首条回复跑偏）。带附件时仍追加原文保留附件路径上下文。
- 结果卡被服务端明确拒绝（如 230099 `card table number over limit`，表格密集型报告触发）时，降级为富文本、再降级纯文本，保证结论必达；此前兜底只认 schema 类错误，导致结果无限期卡死在通知重试中，用户只看到 DONE 表情。传输层失败（状态未知）保持不降级、由幂等键重试的原有纪律。

### Changed

- README 删除致谢章节及对应目录项，将“与同类项目的关系”改为“项目定位”；明确 lark-cli 与 Codex app-server 的实际依赖，以及本项目实现的任务工作流，移除容易被理解为依赖其他桥接项目的表述。

## [0.4.0] - 2026-10-12

### Added

- 附件先持久入队后异步下载，支持独立图片/文件与富文本内嵌图片；图片传入原生 `localImage`，与文字说明一起送入任务或私聊线程。真实供应方识图仍需单独验收。
- 可自定义 Cache、Persist、知识库项目和归档目录；安装问卷写入配置，私聊沙箱绑定 Cache/Persist。
- Cache 默认保留 7 天，启动及每小时清理登记且无活动引用的过期附件；排队/执行/审批与未结算任务链受保护。
- `/files` 查看附件，`/keep <附件ID>` 校验后长期保留；归档引用的附件转存 Persist。Persist、归档、Session 和凭据不自动清理。

### Fixed

- 发布脚本默认只预览，不改发布工作树；运行文件、测试与文档均用完整显式白名单。`--apply` 才写工作树，`--commit` 才提交，`--push` 才推送。
- 发布前拒绝脏工作树、白名单外跟踪文件、危险链接路径和远端 HEAD 不一致；敏感扫描或候选测试失败即停止，不删除未知文件，不全量暂存，不推送其他标签。
- 发布测试清除继承的 Node 测试进程标志，并要求实际执行且有通过项，避免“未运行测试但退出码为零”。
- 统一 group-task-v3 指令：用户明确授权的文档、知识库、表格、文件与业务产物交付可执行；建群、成员管理、任务状态通知、执行审批和结算控制仍由 bridge 独占。

- 事务失败原位恢复队列/outbox/附件对象，异步完成不再回写已被替换的旧对象；回调自身抛错也回滚。
- 分开记录尝试提交与确认受理，提交结果未知和已取消回合不重试；取消发生在初始化或安全重试等待期间时，阻止新建回合。完整私聊调用链继续保留不重放保护。
- `230002` 不再证明群已解散；结算先保存任务记录再移除绑定，保存失败明确报错，绑定清理重试不重复解散。
- Outbox 等待本会话最早消息完成退避；发送回执保存失败时不在当前进程中重发，恢复存储后补保存。
- 新表情失败保留旧标记；持久化失败撤回新标记；`/qdrop`、`/qclear` 在持久删除后清理等待表情。
- 附件下载失败且尚未提交模型时允许同消息重投；取消后的消息保留去重，避免自动重放。
- 拒绝附件路径越界、符号链接、非普通文件、同名不同内容的持久覆盖，以及缓存/持久目录实际重合；未下载完成的文件不能被长期保留。
- 自定义归档目录不再假定固定知识库相对路径；没有 Git 或在知识库外时直接保存归档文件。
- 包版本字段与 v0.4.0 发布标签一致，修正此前标签与 package.json 不一致的问题。

## [0.3.0] - 2026-10-11

### Added

- **图片/文件消息受理**：群内或私聊发送的图片、文件自动下载到 `scratch/inbox/`（按消息 ID 命名，文件名消毒），本地路径注入任务正文——worker 直接读取附件处理，私聊沙箱经 scratch 绑定同样可读；下载失败明确告知重发，不入队、不静默丢弃；重复投递幂等。新增 4 项验收测试（152 项全绿）

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

[Unreleased]: https://github.com/OldManWalk/lark-codex-tasks/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/OldManWalk/lark-codex-tasks/releases/tag/v0.3.0
[0.2.4]: https://github.com/OldManWalk/lark-codex-tasks/releases/tag/v0.2.4
[0.2.3]: https://github.com/OldManWalk/lark-codex-tasks/releases/tag/v0.2.3
[0.2.2]: https://github.com/OldManWalk/lark-codex-tasks/releases/tag/v0.2.2
[0.2.1]: https://github.com/OldManWalk/lark-codex-tasks/releases/tag/v0.2.1
[0.2.0]: https://github.com/OldManWalk/lark-codex-tasks/releases/tag/v0.2.0
[0.1.0]: https://github.com/OldManWalk/lark-codex-tasks/releases/tag/v0.1.0
