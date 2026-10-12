# 缓存、持久附件与归档

安装时可指定 Cache、Persist、知识库项目和归档文件目录，也可通过 bridge.env 配置。请使用绝对路径；systemd EnvironmentFile 不展开 `$HOME` 或 `~`。

| 配置 | 默认值 | 用途 |
|---|---|---|
| LCT_CACHE_DIR | ~/.cache/<serviceName> | 上传附件的临时缓存，实际位于 attachments/ |
| LCT_PERSIST_DIR | ~/workspace/persist/<serviceName> | 明确保留的附件，实际位于 attachments/ |
| LCT_CACHE_RETENTION_DAYS | 7 | 自最后接收/使用起的缓存保留天数 |
| LCT_KNOWLEDGE_DIR | ~/workspace/knowledge/content | 归档项目；已有 Git 仓库时只提交本次归档文件 |
| LCT_ARCHIVE_DIR | <knowledgeDir>/任务归档 | 任务 Markdown 归档，可选择知识库外的独立目录 |
| LCT_ATTACHMENT_MAX_COUNT | 8 | 单条消息可受理的独立附件数量 |
| LCT_ATTACHMENT_MAX_BYTES | 26214400 | 单文件下载后的接收大小限制（25 MiB） |

Cache/Persist 必须不同，不能通过符号链接指向同一个实际附件目录。保留天数及大小/数量上限必须为正整数。

## 默认保留策略

- 上传图片、文件、富文本内嵌图片先将资源元数据与消息一起持久入队，再在本会话的异步执行阶段下载。慢下载不阻塞其他会话和控制指令；同群保持 FIFO。
- cache 只清理程序登记的附件文件。启动时及每小时检查一次，达到 7 天且没有活动引用才删除，因此实际清理可比截止时间晚一个检查周期。
- 排队、执行、待审批回合及未结算任务链引用的附件不清理；即使队列暂停也继续保护引用。
- `/files` 查看附件 ID、保留状态和路径；`/keep <附件ID>` 明确转存 persist。
- 结算归档时，会把本任务链引用、仍存在的附件转存 persist，并在归档中记录持久路径。
- 转存先复制、落盘并读回核对 SHA-256，再登记成功。不覆盖同名但内容不同的持久文件。复制或登记失败时，已保存的保留意图会保护 cache，待修复后重试 `/keep` 或 `/done`。
- 未完成下载的文件不能转存，避免把半个文件登记为持久附件。
- 已转存附件的 cache 副本在没有活动引用且达到期限后可清理；persist 中的文件不会被自动清理。

## 清理范围

自动清理只处理当前 Cache 下受管 attachments/ 中的登记文件，不跟随文件符号链接，不删除用户放入的未知文件。不会清理 Persist、Markdown 归档、jobs 状态、原始 Codex Session、私聊 dm-codex-home、凭据、项目源码或 worktree。

这套策略管理上传附件，不是整个服务器的通用磁盘清理器。scratch 工作区及模型/工具自行生成的其他产物不自动删除。修改路径配置后，旧目录不会被自动迁移或清理；迁移需要独立核对引用。

图片使用 Codex app-server 原生 localImage 输入，文件仍通过本地路径及文件工具读取。实际识图能力取决于模型/供应方，协议与模拟测试通过不代表真实模型识图已经验收。文件大小限制在下载完成后验证，不是下载流量或下载期间磁盘占用的硬上限。

## Session 与归档

缓存过期只删除登记的临时附件，不删除 Session。Session 中已经保存的聊天和图片上下文也不会因附件缓存过期而被抹除。归档目录在知识库 Git 项目内时提交归档文件；知识库外或没有 Git 的目录直接保存 Markdown，不承诺产生 Git 提交。原始 Codex Session 不改写，任务可沿原线程续接，持久附件路径可以从归档或 `/files` 获取。

## 升级与回滚

v0.3.0 的 scratch/inbox 不自动迁移，新受理的附件进入配置的 Cache。旧目录需另行核对引用后处理。store.json 保持 version=1，并新增可选 attachments 索引；旧数据可直接启动。回滚旧代码前要保留新增附件索引，不能用旧状态快照覆盖此后已受理的任务。
