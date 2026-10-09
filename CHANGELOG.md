# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 约定，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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

[Unreleased]: https://github.com/OldManWalk/lark-codex-tasks/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/OldManWalk/lark-codex-tasks/releases/tag/v0.1.0
