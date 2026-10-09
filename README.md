<p align="center">
  <img src="docs/logo.png" alt="lark-codex-tasks logo" width="160">
</p>

<h1 align="center">lark-codex-tasks</h1>

**飞书 ↔ Codex 任务群工作流**——把"常开机的服务器 + 飞书"变成你的任务托管中心：工作交接给服务器继续跑，或只带手机也能派活，审批与监督全程在飞书完成。

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE) ![Platform](https://img.shields.io/badge/platform-Linux%20%2B%20systemd-lightgrey) ![Runtime](https://img.shields.io/badge/runtime-Node%20%E2%89%A518-green) ![Tests](https://img.shields.io/badge/tests-147%20passed-brightgreen)

> 下班了任务没跑完？交接给服务器，地铁上用飞书审批接着干。
> 手头只有手机？私聊机器人建个群，小事当场就办了。

## 目录

- [这是什么——60 秒版](#这是什么60-秒版)
- [两个核心场景](#两个核心场景)
- [一次真实任务的完整过程](#一次真实任务的完整过程)
- [核心概念](#核心概念)
- [工作流详解](#工作流详解)
- [架构](#架构)
- [快速开始](#快速开始)
- [配置参考](#配置参考)
- [命令参考](#命令参考)
- [执行模式与项目工作区](#执行模式与项目工作区)
- [安全模型](#安全模型)
- [测试](#测试)
- [运维手册](#运维手册)
- [故障排查 FAQ](#故障排查-faq)
- [路线图](#路线图)
- [与同类项目的关系](#与同类项目的关系)
- [致谢](#致谢)
- [商标与免责声明](#商标与免责声明)
- [English](#english)

## 这是什么——60 秒版

lark-codex-tasks 围绕两个真实需求而生：

1. **Handoff 交接**：笔记本上的任务没做完，人要先走——把工作交接给常开机的服务器，它建群接着干，你在路上用飞书审批监督。
2. **应急派活**：手头只有手机、不方便开电脑——私聊机器人一句话建群，小任务当场处理。

支撑它们的是同一套**任务群基建**（建群 / 跟进 / 审批 / 归档）：

| 痛点 | 本项目的答案 |
|---|---|
| 多个任务挤在一个会话，上下文互相污染 | **一个任务 = 一个飞书群 = 一条 Codex 线程** |
| 审批来了人不在电脑前，任务卡死 | 审批卡片**无超时**，几小时后点都有效 |
| 中途想追加需求 | 群里直接发消息，**自动排队**接续原线程，不用催不用重发 |
| 干完的任务没沉淀 | `/done` 自动归档 Markdown 进知识库（git commit），可自然语言续接 |
| 手机上没法操作 | 全部操作都在飞书完成：派活、审批、看日志、结算 |
| AI 自动化不敢放权 | owner-only + 三档模式 + 自杀防护 + 凭证物理隔离 |

## 两个核心场景

### 场景一：Handoff——下班了，任务交给服务器接着跑

笔记本上的活干了一半，人要离开。把进展交接给常开机的服务器，剩下的路在飞书里走完：

```
17:50 工位 · 任务跑到一半，要赶地铁
  └─ 把项目推上服务器（git push / 快照同步），留一段交接说明 HANDOFF.md
17:55 飞书私聊: "接着 myproject 的 HANDOFF.md 把 XX 做完"
  └─ 机器人建群「🔵 XX ·a1b2c3」，Codex 读交接说明继续干
18:20 地铁上 · 群里弹审批卡片 → 点 ✅ → 任务继续
19:00 到家 · 结果卡已在群里 → /done 归档，进展 pull 回笔记本
```

- 交接的是**代码 + 上下文说明**；服务器上的会话全新开始，你本机的凭证和原始会话不出本机。
- 若任务本来就是在服务器上开始的，还可以用 `/resume <项目> <会话ID> <任务>` 直接接回那条 Codex 线程。
- "怎么交接上来"不限定：git push 到服务器仓库、rsync、或你自己的快照脚本都可以——只要项目在 `projects.json` 里注册了工作区。

### 场景二：应急派活——只有手机，也能把事办了

在外面、在地铁上、在沙发上，突然想起一件事要处理。私聊机器人一句话：

```
你: "帮我建一个群：把知识库里上周的任务归档整理成一份周报 PPT 发给我，总结也记回知识库"
机器人: 建群「🔵 周报 PPT ·a1b2c3」→ 读归档 → 生成 PPT 发到群里 → 总结写回知识库
机器人: 结果卡 → /done 归档解散
```

### 基建能力（两个场景共用）

建群 → 跟进 → 审批 → 归档，四个环节是全部公共底座：

- **建群**：自然语言或 `/group` `/run` `/resume`，一个任务一个群，互不串味
- **跟进**：群内发消息即排队续接原线程；崩溃对账恢复；绝不叫用户重发。指令消息上的表情实时反映进度：`⏳ OneSecond`（已受理）→ `Typing`（处理中）→ `DONE` / `CrossMark`（完成/失败）
- **审批**：交互卡片，owner 校验，无超时，死信重试
- **归档**：`/done` 写知识库（git commit），旧任务可自然语言续接

## 一次真实任务的完整过程

```
你（飞书私聊，在地铁上）:
  "帮我建一个群：把知识库里上周的任务归档整理成一份周报 PPT 发给我，总结也记回知识库"

机器人（私聊）:
  "收到。已建群「🔵 周报 PPT ·a1b2c3」，群内说明要求即可开工。"

  （群内）任务卡：目标 / 工作区 / 执行模式

你（进入该群，发一段富文本补充，含换行）:
  "风格简洁，10 页以内，突出完成了什么；数据从归档文件里取"

机器人（群内秒回）:
  "已排队：前面 0 条。轮到自动处理。"   ← 受理回执，永不叫你重发

Codex（在工作区里干活，需要安装依赖时）:
  ┌──────────────────────────────────┐
  │ 🔐 审批申请                       │
  │ 操作: npm install pptxgenjs      │
  │ [✅ 通过] [🔓 记住] [❌ 拒绝] [⛔ 取消] │
  └──────────────────────────────────┘

你（三小时后看到，点 ✅）: 继续执行        ← 无超时，点了就生效

机器人（群内结果卡）:
  "✅ 完成 · PPT 已发到群内，总结已写入知识库 · codex resume 1f2a3b4c-…（任意终端可接管）"

你（群内）: "/done"
  → 结论写入 knowledge/content/任务归档/<id>.md（自动 git commit）
  → 群解散，注册表清理

下周你（私聊）: "续接周报 PPT 那个任务，模板换成深色再来一版"
  → 找到唯一匹配的任务链，复用其 Codex 线程建群，接着干
```

## 核心概念

### 任务群 = 工作单元

每个任务独占一个飞书群（`🔵 主题 ·短id`）、一条 Codex 线程、一份工作区上下文。群里只发三类东西：任务卡、审批卡、结果卡。群描述保存任务目标。任务之间互不串味。

### 私聊 = 前台与分流

私聊里的助手（人格可通过 `persona.md` 自定义）**只做三件事**：开新任务、续接旧任务、陪你对话。它绝不亲自执行部署/改代码类工作——新增工作一律由 bridge 建群开 job。私聊通过 JSON Schema 结构化判定你的意图：

| 你的话 | 判定动作 |
|---|---|
| "帮我建个群处理 XX" / 明确的新工作 | `create_group` → 建群开任务 |
| "续接之前 XX 的任务" | `resume_task` → 搜索归档链，**唯一匹配才复用**，模糊则只给证据 |
| "在吗 / 怎么建群 / 聊聊方案" | `reply` → 正常对话 |

### 知识库 = 记忆

`/done` 把任务结论（目标、过程摘要、最终结果、会话线程 ID）写成 Markdown 归档并自动 git commit。归档是续接的搜索池：旧任务即使群已解散，也能通过主题/ID 找回线程继续。

## 工作流详解

### 1. 派活

- **自然语言**：私聊直接说（私聊模型分流 + 独立复核器双重判定，不把设备名误判为项目名）。
- **显式命令**：`/group [项目] [任务]`、`/run <项目> <任务> [--yolo|--safe]`、`/resume <项目> <会话ID> <任务>`。
- 执行名额占满时，新任务请求**持久排队**，空位后自动建群启动，无需重发。

### 2. 执行

- 通用工作区 `scratch` 可并行两个任务；**代码项目经 git worktree 隔离**，同项目串行，接续前自动在上一 worktree 做 checkpoint 提交，保证后续任务基于真实工作状态。
- 每个 job 以 `LCT_JOB_ID` / `LCT_JOB_CHAT_ID` 环境变量标记，环境经 `sanitizeEnv` 剥离 `LARK_*`/`FEISHU_*` 凭证。

### 3. 审批

- Codex 需要人工判断时发交互卡片：`✅通过 / 🔓记住 / ❌拒绝 / ⛔取消`。
- 按钮回调**校验操作人 open_id**，旁人点了无效。
- **无超时**：审批挂单期间任务安全等待，几小时后点击依然生效。
- 卡片投递失败 → 持久重试队列；内容被永久拒绝 → 先发终态新卡再撤回旧卡；文字 `y/ys/n/c` 可降级处理。
- 服务重启会使内存中待审批失效，过期点击得到明确提示而非静默吞掉。

### 4. 追加与排队（续接）

- 群内发消息（**text 与富文本 post 均受理**：@提及自动剔除、段落换行保留、链接文字保留；纯图片/文件会提示补文字）即给本群任务链派后续活。
- 每条有效消息**持久入队**（FIFO）并立即回执前方数量；前序结束调度器自动接续本群线程，绝不叫用户重发。
- 崩溃/重启后先对账：`active` 项结果未知标 `interrupted` 不盲目重放，`waiting` 项保留续跑。
- 队列管理：`/queue /qpause /qresume /qdrop <序号> /qclear`。

### 5. 结算与归档

`/done [ID]` 是任务群的终点：归档 Markdown 到知识库（自动 git commit）→ 通知群 → 解散群 → 清注册表。归档对象永远是任务群本身。

### 6. 续接与接管

- **自然语言续接**：私聊说"续接之前 XX 的任务"→ 按主题/ID 搜索任务链，唯一匹配才复用最新节点的 Codex 线程建群；无匹配或多匹配只返回证据，不新建任务。
- **`/reopen <ID>`**：为已完成（未归档）的任务链重建任务群。
- **终端接管**：每张结果卡附 `codex resume <threadId>`，任何终端可接着同一会话继续。

## 架构

```
飞书 (owner-only 校验)
   │  im.message.receive_v1 + card.action.trigger（长连接，无需公网 URL）
   ▼
lark-cli（双路事件消费者）
   ▼
lark-bridge.cjs ──┬── Supervisor：任务队列 / 并发上限 / 幂等 / 死信（原子事务落盘）
                  ├── CodexClient：`codex app-server` JSON-RPC stdio 驱动，审批中继
                  └── 私聊路由：JSON Schema 动作判定 + 独立复核器
   ▼
Codex 线程（每任务独立 thread；私聊实例跑在 bubblewrap 沙箱，与 bridge 凭证物理隔离）
```

### 模块职责

| 文件 | 职责 |
|---|---|
| `lark-bridge.cjs` | 主逻辑：事件受理、建群/生命周期、审批、队列调度、归档、私聊路由 |
| `supervisor.cjs` | job 生命周期、并发控制、worktree 隔离、落盘与脱敏原语 |
| `codex-client.cjs` | `codex app-server` JSON-RPC stdio 驱动：thread/turn、审批中继、重连计数、不盲目重放 |
| `config.cjs` | 全部部署配置的环境变量解析（纯函数，无副作用） |
| `report-card.cjs` / `task-failure.cjs` | 结果卡片构建 / 失败分类与恢复指引（过载、限流、中断） |
| `hook-notify.cjs` / `hooks-rpc.cjs` | Codex hooks 事件采集 / hooks 信任管理工具 |
| `codex-dm-sandbox.sh` | 私聊 Codex 的 bubblewrap 沙箱启动器 |
| `smoke.cjs` | 联调冒烟工具 |

### 状态目录（`LCT_STATE_DIR`）

```
store.json      seen 去重 + queues 队列 + outbox 死信 + dispatches 派活意图（单文件原子事务）
groups.json     任务群注册表（anchor job / 线程 / 状态）
sessions.json   私聊会话命名空间（与任务群严格分离）
jobs/<id>/      每个 job 的 state.json + output.log
dm-codex-home/  私聊沙箱的 CODEX_HOME（独立登录态）
```

## 快速开始

### 前置条件

| 依赖 | 说明 |
|---|---|
| Linux + systemd | 用户级服务运行；推荐 Debian 12+ |
| Node.js ≥ 18 | 运行 bridge |
| [Codex CLI](https://github.com/openai/codex) | 已安装并 `codex login`（或配置好 API 供应方） |
| [lark-cli] | 已安装并 `lark-cli auth login`（管理你的飞书应用凭证） |
| 飞书自建应用 | 机器人能力 + 长连接事件/回调，见 [docs/feishu-app-setup.md](docs/feishu-app-setup.md) |
| bubblewrap | 私聊沙箱（`apt install bubblewrap`） |
| 你的 owner open_id | `ou_...`，唯一可指挥机器人的人 |

### 安装

```bash
git clone https://github.com/OldManWalk/lark-codex-tasks.git
cd lark-codex-tasks
./install.sh init
```

`init` 会交互式完成：依赖检查 → 填写 owner open_id 等 → 生成 `bridge.env`（权限 600）→ 生成 `projects.json` → 复制运行文件到 `~/.local/share/lark-codex-tasks` → 写入并启动 systemd user 服务。

管理命令：`./install.sh status | logs | update | uninstall`。

> [!WARNING]
> 审批卡片按钮依赖飞书后台的 `card.action.trigger` 回调（长连接方式）。没配的话按钮点了没反应——这是最常见的部署坑，配置步骤见 [docs/feishu-app-setup.md](docs/feishu-app-setup.md)。

### 第一次任务

1. 飞书里私聊机器人：`/ping` → 收到回执即链路通。
2. 私聊发：`帮我建一个群，整理一下我书房的 NAS 照片目录结构`。
3. 进群看任务卡，补一句具体要求，观察执行与审批。
4. 完成后 `/done`，去 `~/workspace/knowledge/content/任务归档/` 看归档。

## 配置参考

配置文件：`~/.config/lark-codex-tasks/bridge.env`（安装时生成，权限 600；全量示例见 [examples/bridge.env.example](examples/bridge.env.example)）。

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `LARK_OWNER_OPEN_ID` | ✅ | — | 你的飞书 open_id，所有消息/卡片回调的身份校验基准 |
| `LARK_OPS_CHAT` | | 空 | 运维兜底群 `oc_...`；审批丢失上下文时兜底投递，留空则跳过 |
| `LARK_OWNER_NAME` | | `owner` | 审批卡片上显示的操作人 |
| `LCT_BRAND` | | `lark-codex-tasks` | 品牌串（/ping、指令、归档署名） |
| `LCT_SERVICE_NAME` | | `lark-codex-tasks` | systemd 服务名（写入 AI 安全约束） |
| `LCT_STATE_DIR` | | `~/.local/state/lark-codex-tasks` | 状态目录 |
| `LCT_CONFIG_DIR` | | `~/.config/lark-codex-tasks` | 配置目录 |
| `LCT_WORKSPACE_ROOT` | | `~/workspace` | 工作区根目录 |
| `LCT_SCRATCH_DIR` | | `<root>/scratch` | 通用工作区 |
| `LCT_KNOWLEDGE_DIR` | | `<root>/knowledge/content` | 知识库根目录（/done 归档与知识写入的基准） |
| `LCT_ARCHIVE_DIR` | | `<knowledge>/任务归档` | 任务归档目录 |
| `LCT_PERSONA_FILE` | | `<config>/persona.md` | 私聊人格文件（见 examples/persona.example.md） |
| `LCT_DM_ADDRESS` | | 空 | 私聊对你的称呼（如：老板） |
| `LCT_DM_GREETING` | | `<brand> 在线。` | 私聊 /ping 回执 |
| `LCT_DM_ACK` | | `收到，处理中，稍后回报。` | 私聊受理回执 |
| `LCT_THREAD_PREFIX` | | `lct` | Codex 线程名前缀 |
| `LCT_BIN_DIR` | | `~/.local/bin` | `codex` / `lark-cli` 可执行文件所在目录 |
| `LCT_NODE_BIN` | | `~/.local/bin/node` | 沙箱内 node 路径 |
| `LCT_CODEX_PKG` | | `~/.local/lib/node_modules/@openai/codex` | 沙箱内 codex 包路径 |
| `LCT_OB_MAX_ATTEMPTS` | | `5` | 出站消息投递重试次数 |
| `LCT_OB_BACKOFF_MS` | | `2000` | 出站投递退避基数（毫秒） |
| `LCT_REACTIONS` | | `1` | 指令表情三态（等待/处理中/完成）；`0` 关闭 |

项目工作区注册表：`~/.config/lark-codex-tasks/projects.json`（示例见 [examples/projects.json.example](examples/projects.json.example)）。`scratch` 是内置通用工作区；其余别名指向各项目内容目录（代码项目应在 git 仓库内以启用 worktree 隔离）。

## 命令参考

| 分类 | 命令 | 说明 |
|---|---|---|
| 通用 | `/ping` `/status` `/help` | 存活回执 / 运行概况 / 命令一览 |
| 查询 | `/projects` `/jobs` `/groups` `/logs [ID]` | 工作区 / 任务 / 任务群 / 日志 |
| 派活（仅私聊） | `/group [项目] [任务]` | 建独立任务群（不启动 worker，等群内说明） |
| 派活（仅私聊） | `/run <项目> <任务> [--yolo\|--safe]` | 建群并立即启动 |
| 派活（仅私聊） | `/resume <项目> <会话ID> <任务>` | 接管已有 Codex 会话建群 |
| 任务控制 | `/cancel [ID]` | 取消任务（私聊裸发 = 取消当前对话） |
| 结算 | `/done [ID]` `/reopen <ID>` | 归档+解散 / 重建任务群 |
| 队列 | `/queue` `/qpause` `/qresume` `/qdrop <n>` `/qclear` | 查看 / 暂停 / 恢复 / 丢弃 / 清空 |
| 死信 | `/outbox` `… show/retry/resolve` | 投递失败消息的核查与处置 |
| 维护 | `/cleanup` `/adopt` `/auditgroups` | 注册表清理 / 受控绑定已有群 / 群审计 |

## 执行模式与项目工作区

| 模式 | 沙箱 | 审批策略 | 适用 |
|---|---|---|---|
| `auto`（默认） | danger-full-access | 日常直接执行，确需判断时发卡片问你 | 信任的日常工作 |
| `safe` | workspace-write | 能问都问 | 新项目磨合期 |
| `yolo` | danger-full-access | 全自动不问 | 明确边界的重复性任务 |

- `scratch`：通用工作区，可同时运行两个互不共享会话的任务（文件仍共享）。
- 代码项目：git worktree 隔离，同项目串行；接续前自动 checkpoint 上一 worktree。

> [!TIP]
> 第一次接入真实服务器建议先用 `safe` 模式跑几天，确认它的判断符合预期后再放权的模式。

## 安全模型

| 威胁 | 防线 |
|---|---|
| 旁人指挥机器人 | 所有消息/卡片回调校验 `LARK_OWNER_OPEN_ID`；群成员变动核验"仅你+机器人" |
| AI 切断联系 | 最高优先级注入约束：永不 restart/stop bridge；需要重启回复"请联系维护者" |
| 私聊实例偷看凭证 | bubblewrap 沙箱：nobody UID + home tmpfs，物理看不到 bridge 配置 |
| 任务环境泄漏凭证 | `sanitizeEnv` 剥离 `LARK_*`/`FEISHU_*`；`LARK_OPS_CHAT` 不进任务环境 |
| 密钥落入日志/卡片 | 持久化与通知边界对 `KEY\|TOKEN\|SECRET\|PASSWORD` 值自动 `[REDACTED]` |
| 网络抖动重放副作用 | turn 一旦提交（含响应超时）绝不自动重放；重启先对账标 `interrupted` |
| 内存与磁盘状态分裂 | 受理+去重同一持久事务提交；写盘失败回滚内存视图 |
| 会话串味 | 私聊/任务群命名空间物理分离；任务通知永不进私聊 |

**它不会做的**：不响应非 owner；不主动重启自己；不把任务通知发进私聊；不在群里执行 `/run` `/group` `/resume` `/reopen`（这些仅限私聊）。

> [!IMPORTANT]
> lark-codex-tasks 是严格的单用户（owner-only）设计：只有你 `LARK_OWNER_OPEN_ID` 这一个人能指挥机器人。请勿把它当成多人协作机器人部署。

## 测试

```bash
node --test *.test.cjs     # 147 项验收测试
```

| 测试文件 | 覆盖 |
|---|---|
| `session-isolation` | 私聊/任务群隔离、人格注入边界、并发锁按会话隔离 |
| `task-routing` | 自然语言路由、建群/续接判定、地址≠项目、即时受理回执 |
| `task-queue` | 队列幂等、暂停/恢复、路径正文路由、未知命令用法 |
| `restart-review` | 崩溃对账、死信重试、富文本受理、归档、重启语义 |
| `provider-failure` | 模型过载/限流的结构化呈现与恢复指引 |
| `supervisor` | job 生命周期、脱敏、worktree |
| `report-card` | 结果卡片构建 |

## 运维手册

```bash
systemctl --user status lark-codex-tasks     # 服务状态
journalctl --user -u lark-codex-tasks -f     # 跟踪日志
./install.sh update                          # 更新运行文件并重启（空闲时操作）
./install.sh uninstall                       # 卸载（保留配置与状态）
```

- **备份**：`LCT_STATE_DIR` 整个目录 + `bridge.env` + `projects.json` 即全部状态。
- **开机自启（免登录）**：`sudo loginctl enable-linger $USER`。

> [!CAUTION]
> 重启服务会中断运行中的任务（标 `interrupted`）并使内存中待审批失效——确认 `/jobs` 无运行项再重启。

## 故障排查 FAQ

**Q: 点审批卡片按钮没反应？**
飞书后台没开 `card.action.trigger` 回调（回调订阅 → 长连接）。这是最常见的坑，见 docs/feishu-app-setup.md。

**Q: /ping 没回？**
`journalctl --user -u lark-codex-tasks -f` 看两路事件是否 `ready`；再查 lark-cli 登录态 `lark-cli auth status`。

**Q: 任务失败卡写着"模型过载/限流"？**
模型供应方拥塞，不是系统坏了。会话线程还在，群里回复"继续"即可续接。

**Q: 重启后任务显示 interrupted？**
这是"结果未知不盲目重放"的保护语义。查看该 job 的实际产出后，在群里说明继续方向即可。

**Q: 私聊机器人说"无法建群"？**
私聊实例跑在沙箱里，本来就看不到宿主接口——建群由 bridge 执行。若自然语言没触发，用显式命令 `/group`。

**Q: 多人能用吗？**
设计上严格 owner-only（单用户）。多人协作需要先改身份模型，暂不支持。

## 路线图

- [ ] npm 发布（`npm i -g @oldmanwalk/lark-codex-tasks`）
- [ ] 任务定时调度（cron 式派活）
- [ ] 群内图片/文件直接进入任务上下文
- [ ] 更多模型供应方的故障分类适配

版本历史与每次更新的具体内容见 [CHANGELOG.md](CHANGELOG.md)。

## 与同类项目的关系

[zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge)、[xile611/lark-codex-bridge](https://github.com/xile611/lark-codex-bridge) 等项目解决"飞书消息 ↔ 本地 coding CLI"的桥接；**lark-codex-tasks 是其上的工作流层扩展**：任务群生命周期、排队续接、审批卡片、归档知识库、多工作区 worktree 隔离。只需要消息转发桥用它们就好；想要"一个任务一个群、干完归档散伙"的完整工作流，那是本项目的主场。

## 致谢

本项目为独立实现，设计与演进过程中受到以下社区项目的启发（均为 MIT）：

- [zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge) — 飞书 ↔ Claude Code / Codex 桥
- [xile611/lark-codex-bridge](https://github.com/xile611/lark-codex-bridge) — 飞书 ↔ Codex 桥
- [VicLuoV5/lark-agents-bridge](https://github.com/VicLuoV5/lark-agents-bridge) — 飞书 ↔ 本地 Agents 桥

感谢 [lark-cli] 提供的飞书长连接与 IM 能力底座。

## 商标与免责声明

飞书、Lark 是北京抖音信息服务有限公司（ByteDance）的商标；Codex、OpenAI 是 OpenAI 的商标。本项目为个人开源作品，与上述公司无任何隶属、背书或合作关系。本项目按 MIT 协议"原样"提供，作者不对使用后果承担责任；请自行评估将 AI agent 接入生产服务器的风险（建议先用 `safe` 模式）。

---

## English

**lark-codex-tasks** turns "an always-on server + Feishu/Lark" into your task hosting center, built around two real-world scenarios:

1. **Handoff** — your laptop task isn't finished but you have to leave: push the work to the server, DM the bot to continue it in a dedicated group, then supervise approvals from the subway.
2. **Quick tasks from your phone** — no computer at hand: one DM creates a task group and gets small jobs done end-to-end in Feishu.

Both rest on the same task-group infrastructure — one task = one Feishu group = one Codex thread, with a full lifecycle (create → follow-up → approval → archive).

**Workflow.** Dispatch from a DM (natural language or `/group`) → the bot auto-creates a task group `🔵 topic ·id` → Codex works in the matching workspace (`auto`/`safe`/`yolo` modes) → approvals arrive as interactive cards (`✅/🔓/❌/⛔`, owner-verified, **no timeout**) → follow-up messages in the group are durably queued and continue the same Codex thread → `/done` archives the outcome to a git-backed knowledge base and dissolves the group. Every report card carries `codex resume <threadId>` for terminal handoff.

**Engineering guarantees.** Never replays a submitted turn (crash-safe reconciliation marks `interrupted`) · accept + dedupe in one atomic persistent transaction · DM persona runs in a bubblewrap sandbox physically isolated from bridge credentials · `LARK_*`/`FEISHU_*` stripped from job environments · secret redaction at persist/notify boundaries · strict DM/task-group session isolation.

**Requires.** Linux + systemd user services · Node ≥ 18 · logged-in Codex CLI · a self-built Feishu app with long-connection events (`im.message.receive_v1` + `card.action.trigger`) · [lark-cli] · bubblewrap.

```bash
git clone https://github.com/OldManWalk/lark-codex-tasks.git
cd lark-codex-tasks && ./install.sh init
```

All deployment config lives in one env file (`~/.config/lark-codex-tasks/bridge.env`, generated interactively). The Chinese sections above are the canonical reference; see `docs/feishu-app-setup.md` for the Feishu app walkthrough. 147 acceptance tests: `node --test *.test.cjs`.

MIT © 2026 OldManWalk. Independent implementation inspired by the MIT-licensed projects listed above; not affiliated with ByteDance or OpenAI.

[lark-cli]: https://github.com/larksuite/cli
