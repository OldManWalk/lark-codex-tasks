# 飞书自建应用配置指引

lark-codex-tasks 通过**长连接**接收事件与卡片回调，**不需要公网 URL、不需要备案域名**，家庭服务器 / NAT 后面也能跑。

## 1. 创建企业自建应用

1. 打开 [飞书开放平台](https://open.feishu.cn/) → 开发者后台 → 创建企业自建应用（名字随意，比如"任务群助手"）。
2. 在「应用能力 → 机器人」开启机器人能力。
3. 发布一个版本（版本管理与发布 → 创建版本 → 申请发布；企业内自建应用一般自动通过）。

## 2. 权限

在「权限管理」开通（名称以后台为准，可能随平台更新微调）：

| 权限 | 用途 |
|---|---|
| `im:message` / `im:message:send_as_bot` | 发消息、发卡片 |
| `im:chat` | 创建/管理任务群、设置群描述 |
| `im:chat:readonly` | 读取群信息、成员列表（owner 核验） |
| `im:resource` | 读取群内图片/文件（可选） |
| `contact:user.id:readonly` | 解析 open_id（可选） |

## 3. 事件与回调（长连接）

1. 「事件订阅」→ 接收方式选 **使用长连接接收事件** → 添加事件 `im.message.receive_v1`（接收消息）。
2. 「回调订阅」→ 同样选长连接 → 添加 `card.action.trigger`（卡片按钮回调，审批卡片依赖它）。

> 没有 `card.action.trigger` 回调，审批卡片按钮点了不会有任何反应——这是最常见的部署坑。

## 4. 凭证给 lark-cli

本项目不直接持有 appId/appSecret，全部交给 [lark-cli] 管理：

```bash
lark-cli auth login     # 按提示填入 App ID / App Secret 并完成授权
lark-cli auth status
```

## 5. 拿到你的 owner open_id

`LARK_OWNER_OPEN_ID` 是**唯一能指挥机器人的人**（你自己）。获取方式之一：

```bash
lark-cli contact resolve --name "你自己的名字"
```

得到 `ou_xxxxxxxx...` 填入 `bridge.env`。

## 6. 验证

```bash
systemctl --user status lark-codex-tasks
journalctl --user -u lark-codex-tasks -f
```

日志里应看到 `im.message.receive_v1` 与 `card.action.trigger` 两路 `ready`。然后在飞书里私聊机器人发 `/ping`，收到回执即全部打通。

[lark-cli]: https://github.com/larksuite/lark-cli
