# lark-codex-tasks

**飞书 ↔ Codex 任务群工作流**：在飞书私聊里一句话派活，机器人自动建任务群、驱动本机 [Codex](https://github.com/openai/codex) 干活，审批用交互卡片，完成后一键结算归档并解散群。

> 手机掏出来发一句"帮我建个群管理 OpenWrt 路由器"，剩下的在群里看着它干。

## 它是怎么工作的

```
你（飞书私聊）: "帮我建一个群，把网站的 HTTPS 证书续期流程修好"
        │
        ▼
机器人: 建群「🔵 HTTPS 证书续期 ·a1b2c3」，群内发任务卡
        │
        ▼
Codex 在你服务器的项目工作区里开始干活（auto 模式）
        │
        ├─ 需要人工判断时 → 群内弹审批卡片 [✅通过 / 🔓记住 / ❌拒绝 / ⛔取消]
        │
        ▼
结果卡片发进群（附 `codex resume <threadId>` 接管命令）
        │
        ▼
群内再发消息 = 给同一任务排队派后续活（自动接续原会话线程）
        │
        ▼
你: "/done" → 结论归档到知识库（自动 git commit）→ 群解散
```

## 特性

- **任务群生命周期**：私聊派活 → 自动建群（`🔵 主题 ·短id`）→ 群内执行 → `/done` 归档结算解散，一个任务一个群，互不串味
- **排队续接**：群内发消息（含富文本）即给原任务线程派后续活，FIFO 持久队列，前序结束自动接续，崩溃重启先对账再恢复，绝不叫用户重发
- **审批卡片**：Codex 需要人工决策时发交互卡片，按钮回调校验 owner 身份；卡片投递失败持久重试，文字 `y/ys/n/c` 可降级操作，**无超时**——你几小时后点依然有效
- **会话隔离**：私聊（你的 AI 助手人格）与任务群（纯执行单元，无人格）严格分命名空间，任务通知永不进私聊
- **归档知识库**：`/done` 把任务结论写成 Markdown 归档（自动 git commit），旧任务可用自然语言续接（"续接之前 sub2api 的任务"）
- **断点接管**：每个任务报告附 `codex resume <threadId>`，任何终端可接着同一会话继续
- **执行模式**：`auto`（默认，日常直接执行、特殊操作问你）/ `safe`（能问都问）/ `yolo`（全自动）
- **模型故障透明**：模型过载/限流/连接中断在结果卡里如实说明，并给出恢复路径（群内回复"继续"即可）

## 架构

```
飞书 (owner-only 校验)
   │  im.message.receive_v1 + card.action.trigger（长连接，无需公网 URL）
   ▼
lark-cli（事件消费者，双路）
   ▼
lark-bridge.cjs ──┬─ Supervisor：任务队列/并发/幂等/死信（queue.json / store.json 原子事务）
                  ├─ CodexClient：`codex app-server` JSON-RPC stdio 驱动，审批中继
                  └─ 私聊路由：JSON Schema 动作判定（reply / create_group / resume_task）
   ▼
Codex 线程（每任务独立 thread；私聊实例跑在 bubblewrap 沙箱里，与 bridge 凭证物理隔离）
```

## 快速开始

### 前置条件

- Linux + systemd（用户级服务；推荐 Debian 12+），`bubblewrap`（私聊沙箱）
- Node.js ≥ 18
- [Codex CLI](https://github.com/openai/codex) 已安装并完成登录/配置（`codex` 命令可用）
- [lark-cli] 已安装并登录你的飞书自建应用（消息 + 卡片回调权限，见 [docs/feishu-app-setup.md](docs/feishu-app-setup.md)）
- 一个你自己的飞书 owner open_id（只有你能指挥机器人）

### 安装

```bash
git clone https://github.com/OldManWalk/lark-codex-tasks.git
cd lark-codex-tasks
./install.sh init        # 交互式初始化：生成配置、systemd 服务并启动
```

装好后在飞书里给机器人发 `/ping`，收到回执即就绪。

管理命令：`./install.sh status|logs|update|uninstall`

### 配置

全部配置在 `~/.config/lark-codex-tasks/bridge.env`（安装时生成，权限 600）：

| 变量 | 必填 | 说明 |
|---|---|---|
| `LARK_OWNER_OPEN_ID` | ✅ | 你的飞书 open_id（`ou_...`），唯一可指挥机器人的人 |
| `LARK_OPS_CHAT` | | 运维兜底群 chat_id（`oc_...`），审批丢失上下文时兜底投递 |
| `LARK_OWNER_NAME` | | 审批卡片上显示的操作人名字 |
| `LCT_BRAND` | | 品牌串，出现在 /ping、指令与归档中（默认 `lark-codex-tasks`） |
| `LCT_SERVICE_NAME` | | systemd 服务名（默认 `lark-codex-tasks`） |
| `LCT_STATE_DIR` | | 状态目录（默认 `~/.local/state/lark-codex-tasks`） |
| `LCT_CONFIG_DIR` | | 配置目录（默认 `~/.config/lark-codex-tasks`） |
| `LCT_WORKSPACE_ROOT` | | 工作区根目录（默认 `~/workspace`） |
| `LCT_ARCHIVE_DIR` | | 任务归档目录（默认 `<workspace>/knowledge/content/任务归档`） |
| `LCT_PERSONA_FILE` | | 私聊人格文件（Markdown，见 `examples/persona.example.md`） |
| `LCT_DM_ADDRESS` / `LCT_DM_GREETING` / `LCT_DM_ACK` | | 私聊称呼 / 在线回执 / 受理回执文案 |
| `LCT_THREAD_PREFIX` | | Codex 线程名前缀（默认 `lct`） |
| `LCT_NODE_BIN` / `LCT_CODEX_PKG` | | 私聊沙箱内 node / codex 包路径（非默认位置时设置） |

项目工作区注册表：`~/.config/lark-codex-tasks/projects.json`

```json
{
  "scratch": "/home/you/workspace/scratch",
  "mysite": "/home/you/workspace/mysite/content"
}
```

`scratch` 是通用工作区（可同时跑两个任务）；代码项目通过 git worktree 隔离，同项目串行。

## 命令

```
/ping /status /projects /jobs /groups /logs [ID]
/group [项目] [任务]            建独立任务群
/run <项目> <任务> [--yolo|--safe]
/resume <项目> <会话ID> <任务>   接管已有 Codex 会话
/cancel [ID] /done [ID] /reopen <ID>
/queue /qpause /qresume /qdrop <序号> /qclear
/outbox …                       死信管理
/cleanup /adopt /auditgroups    群注册表维护
```

私聊里也可以完全用自然语言："帮我建个群处理 XX"、"续接之前 XX 的任务"。

## 安全模型

- **owner-only**：所有消息与卡片回调都校验 `LARK_OWNER_OPEN_ID`，别人 @机器人 无效
- **凭证物理隔离**：私聊 Codex 实例跑在 bubblewrap 沙箱（nobody UID + home tmpfs）里，看不到 bridge 的飞书凭证；任务进程环境经 `sanitizeEnv` 剥离 `LARK_*`/`FEISHU_*`
- **自杀防护**：注入线程的最高优先级安全约束禁止 AI 重启/停止 bridge 服务，需要重启时它会回复"请联系维护者"
- **不盲目重放**：turn 请求一旦发出（含响应超时），绝不自动重放副作用操作；重启先对账，结果未知标 `interrupted`
- **脱敏**：持久化与通知边界对 `KEY|TOKEN|SECRET|PASSWORD` 类环境变量值自动 `[REDACTED]`
- 审批决策回调校验操作人 open_id；群内成员变动会核验"群里只有你 + 机器人"

## 测试与运维

```bash
node --test *.test.cjs        # 137 项验收测试
systemctl --user status lark-codex-tasks
journalctl --user -u lark-codex-tasks -f
```

## 与同类项目的关系

[zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge)、[xile611/lark-codex-bridge](https://github.com/xile611/lark-codex-bridge) 等项目解决的是"飞书消息 ↔ 本地 coding CLI"的桥接；**lark-codex-tasks 是其上的工作流层扩展**：任务群生命周期、排队续接、审批卡片、归档知识库、多工作区 worktree 隔离。如果你只需要简单的消息转发桥，用它们就好；如果你想要"一个任务一个群、干完归档散伙"的完整工作流，那是本项目的主场。

## 致谢

本项目为独立实现，设计与演进过程中受到以下社区项目的启发（均为 MIT）：

- [zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge) — 飞书 ↔ Claude Code / Codex 桥
- [xile611/lark-codex-bridge](https://github.com/xile611/lark-codex-bridge) — 飞书 ↔ Codex 桥
- [VicLuoV5/lark-agents-bridge](https://github.com/VicLuoV5/lark-agents-bridge) — 飞书 ↔ 本地 Agents 桥

感谢 [lark-cli] 提供的飞书长连接与 IM 能力底座。

## 商标与免责声明

飞书、Lark 是北京抖音信息服务有限公司（ByteDance）的商标；Codex、OpenAI 是 OpenAI 的商标。本项目为个人开源作品，与上述公司无任何隶属、背书或合作关系。本项目按 MIT 协议"原样"提供，作者不对使用后果承担责任；请自行评估将 AI agent 接入生产服务器的风险（建议先用 `safe` 模式）。

## License

[MIT](LICENSE) © 2026 OldManWalk

---

## English

**lark-codex-tasks** bridges Feishu/Lark with a local Codex CLI as a *task-group workflow*: dispatch work from a DM, the bot auto-creates a dedicated task group, drives Codex in the matching workspace, asks for approvals via interactive cards (no timeout), queues follow-ups sent in the group onto the same Codex thread, and `/done` archives the outcome to a git-backed knowledge base and dissolves the group.

Highlights: owner-only enforcement · per-task groups with full lifecycle · durable FIFO queue with crash-safe reconciliation (never replays a submitted turn) · card-based approvals with owner verification · bwrap-sandboxed DM persona physically isolated from bridge credentials · `auto`/`safe`/`yolo` execution modes · `codex resume <threadId>` handoff for every job.

Requires: Linux + systemd user services, Node ≥ 18, logged-in Codex CLI, a self-built Feishu app (long-connection events `im.message.receive_v1` + `card.action.trigger`), and [lark-cli]. See `docs/feishu-app-setup.md` and the configuration table above ( Chinese section is the canonical reference for now).

```bash
git clone https://github.com/OldManWalk/lark-codex-tasks.git && cd lark-codex-tasks && ./install.sh init
```

MIT © 2026 OldManWalk. Independent implementation inspired by the MIT-licensed projects listed above; not affiliated with ByteDance or OpenAI.

[lark-cli]: https://github.com/larksuite/lark-cli
