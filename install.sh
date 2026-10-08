#!/bin/sh
# lark-codex-tasks — 安装 / 管理入口
# 用法:
#   ./install.sh init         交互式初始化（配置 + systemd 服务 + 启动）
#   ./install.sh status       服务状态
#   ./install.sh logs         跟踪日志
#   ./install.sh update       从源码目录更新运行文件并重启
#   ./install.sh uninstall    停止服务并移除（保留配置与状态）
set -eu

PKG_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PREFIX=${LCT_PREFIX:-"$HOME/.local/share/lark-codex-tasks"}
CONFIG_DIR=${LCT_CONFIG_DIR:-"$HOME/.config/lark-codex-tasks"}
STATE_DIR=${LCT_STATE_DIR:-"$HOME/.local/state/lark-codex-tasks"}
WORKSPACE=${LCT_WORKSPACE_ROOT:-"$HOME/workspace"}
SERVICE=${LCT_SERVICE_NAME:-lark-codex-tasks}
ENV_FILE="$CONFIG_DIR/bridge.env"
UNIT_DIR="$HOME/.config/systemd/user"

die(){ echo "✗ $*" >&2; exit 1; }
ok(){ echo "✓ $*"; }
ask(){ # ask <var> <prompt> [default]
  _v=$1; _p=$2; _d=${3:-}
  if [ -n "$_d" ]; then printf '%s [%s]: ' "$_p" "$_d" >&2; else printf '%s: ' "$_p" >&2; fi
  IFS= read -r _a || true
  if [ -z "$_a" ]; then _a=$_d; fi
  eval "$_v=\$_a"
}

cmd_init(){
  echo "== lark-codex-tasks 初始化 =="
  command -v node >/dev/null 2>&1 || die "未找到 node（需要 ≥18）：https://nodejs.org/"
  node -e 'process.exit(parseInt(process.versions.node,10)>=18?0:1)' || die "node 版本过低（需要 ≥18）"
  ok "node $(node -v)"
  command -v codex >/dev/null 2>&1 || echo "⚠ 未在 PATH 找到 codex；请确认已安装并登录（https://github.com/openai/codex）"
  command -v lark-cli >/dev/null 2>&1 || echo "⚠ 未在 PATH 找到 lark-cli；bridge 启动前请安装并完成 auth login"
  command -v bwrap >/dev/null 2>&1 || echo "⚠ 未找到 bubblewrap（私聊沙箱需要）：Debian/Ubuntu 安装 bwrap 包"
  command -v systemctl >/dev/null 2>&1 || die "需要 systemd（用户级服务）"

  NODE_BIN=$(command -v node)
  ask NODE_BIN "node 可执行文件路径" "$NODE_BIN"
  [ -x "$NODE_BIN" ] || die "node 路径不可执行: $NODE_BIN"

  CODEX_PKG_DEFAULT="$HOME/.local/lib/node_modules/@openai/codex"
  [ -d "$CODEX_PKG_DEFAULT" ] || CODEX_PKG_DEFAULT="$(npm root -g 2>/dev/null || echo /usr/lib/node_modules)/@openai/codex"
  ask CODEX_PKG "codex npm 包目录（…/node_modules/@openai/codex）" "$CODEX_PKG_DEFAULT"

  if [ -f "$ENV_FILE" ]; then
    echo "已存在配置 $ENV_FILE，跳过问卷（编辑该文件可改配置）。"
  else
    ask OWNER_ID "你的飞书 owner open_id（ou_ 开头，唯一可指挥机器人的人）" ""
    case "$OWNER_ID" in ou_*) ;; *) die "owner open_id 应以 ou_ 开头" ;; esac
    ask OWNER_NAME "审批卡片显示的操作人名字" "owner"
    ask OPS_CHAT "运维兜底群 chat_id（oc_ 开头，可留空）" ""
    ask BRAND "品牌串（出现在回执与归档中）" "lark-codex-tasks"
    mkdir -p "$CONFIG_DIR"
    umask 077
    {
      echo "LARK_OWNER_OPEN_ID=$OWNER_ID"
      echo "LARK_OWNER_NAME=$OWNER_NAME"
      [ -n "$OPS_CHAT" ] && echo "LARK_OPS_CHAT=$OPS_CHAT"
      echo "LCT_BRAND=$BRAND"
      echo "LCT_SERVICE_NAME=$SERVICE"
      echo "LCT_STATE_DIR=$STATE_DIR"
      echo "LCT_CONFIG_DIR=$CONFIG_DIR"
      echo "LCT_WORKSPACE_ROOT=$WORKSPACE"
      echo "LCT_NODE_BIN=$NODE_BIN"
      echo "LCT_CODEX_PKG=$CODEX_PKG"
    } > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    ok "已写入 $ENV_FILE"
  fi

  mkdir -p "$STATE_DIR/dm-codex-home" "$WORKSPACE/scratch" "$WORKSPACE/knowledge/content" "$UNIT_DIR"
  chmod 700 "$STATE_DIR" "$STATE_DIR/dm-codex-home"
  if [ ! -f "$CONFIG_DIR/projects.json" ]; then
    printf '{\n  "scratch": "%s"\n}\n' "$WORKSPACE/scratch" > "$CONFIG_DIR/projects.json"
    chmod 600 "$CONFIG_DIR/projects.json"
    ok "已生成 projects.json（scratch 通用工作区），按需添加代码项目"
  fi
  if [ ! -f "$STATE_DIR/dm-codex-home/auth.json" ] && [ -f "$HOME/.codex/auth.json" ]; then
    cp "$HOME/.codex/auth.json" "$STATE_DIR/dm-codex-home/auth.json"
    chmod 600 "$STATE_DIR/dm-codex-home/auth.json"
    ok "已把 ~/.codex/auth.json 复制给私聊沙箱（dm-codex-home）"
  else
    echo "ℹ 私聊沙箱需要自己的 codex 登录态：CODEX_HOME=$STATE_DIR/dm-codex-home codex login"
  fi

  mkdir -p "$PREFIX"
  cp "$PKG_DIR"/*.cjs "$PREFIX"/
  cp "$PKG_DIR"/codex-dm-sandbox.sh "$PREFIX"/
  chmod 700 "$PREFIX"/codex-dm-sandbox.sh
  chmod 600 "$PREFIX"/*.cjs
  ok "运行文件已安装到 $PREFIX"

  cat > "$UNIT_DIR/$SERVICE.service" <<EOF
[Unit]
Description=lark-codex-tasks Feishu Codex bridge
After=network-online.target

[Service]
Type=simple
EnvironmentFile=$ENV_FILE
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$NODE_BIN $PREFIX/lark-bridge.cjs
Restart=always
RestartSec=5
TimeoutStopSec=20
KillMode=control-group
UMask=0077

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now "$SERVICE"
  ok "服务已启动：systemctl --user status $SERVICE"
  echo
  echo "下一步："
  echo "  1) 确认飞书应用已开启长连接事件与卡片回调（docs/feishu-app-setup.md）"
  echo "  2) 在飞书里给机器人发 /ping"
  echo "  3) 开机自启（无登录也运行）：sudo loginctl enable-linger \$USER"
}

cmd_status(){ systemctl --user status "$SERVICE" --no-pager; }
cmd_logs(){ journalctl --user -u "$SERVICE" -f; }

cmd_update(){
  [ -d "$PREFIX" ] || die "尚未安装，先运行 ./install.sh init"
  cp "$PKG_DIR"/*.cjs "$PREFIX"/
  cp "$PKG_DIR"/codex-dm-sandbox.sh "$PREFIX"/
  chmod 700 "$PREFIX"/codex-dm-sandbox.sh
  chmod 600 "$PREFIX"/*.cjs
  systemctl --user restart "$SERVICE"
  ok "已更新并重启（运行中的任务会标记 interrupted，建议空闲时操作）"
}

cmd_uninstall(){
  systemctl --user disable --now "$SERVICE" 2>/dev/null || true
  rm -f "$UNIT_DIR/$SERVICE.service"
  systemctl --user daemon-reload
  echo "已停止并移除服务。配置（$CONFIG_DIR）与状态（$STATE_DIR）保留，手动删除即可。"
}

case "${1:-init}" in
  init) cmd_init ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  update) cmd_update ;;
  uninstall) cmd_uninstall ;;
  *) die "未知命令 ${1}（init/status/logs/update/uninstall）" ;;
esac
