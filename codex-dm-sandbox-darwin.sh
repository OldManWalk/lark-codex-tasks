#!/bin/sh
# lark-codex-tasks — 私聊 Codex 沙箱启动器（macOS sandbox-exec / seatbelt）。
# 语义对齐 Linux bwrap 版：$HOME 默认拒读（藏住 bridge 凭据），写默认拒绝，
# 白名单放行 scratch、附件目录、DM 专属 codex home、node 与 codex 包本体。
# seatbelt 规则后写覆盖先写；--print-profile 仅输出档案（供测试与审计）。
set -eu

dm_home=${HOME:?}
state_root=${LCT_STATE_DIR:-"$dm_home/.local/state/lark-codex-tasks"}
dm_state="$state_root/dm-codex-home"
workspace_root=${LCT_WORKSPACE_ROOT:-"$dm_home/workspace"}
scratch_dir=${LCT_SCRATCH_DIR:-"$workspace_root/scratch"}
service_name=${LCT_SERVICE_NAME:-lark-codex-tasks}
cache_dir=${LCT_CACHE_DIR:-"$dm_home/Library/Caches/$service_name"}
persist_dir=${LCT_PERSIST_DIR:-"$workspace_root/persist/$service_name"}
logs_dir=${LCT_LOGS_DIR:-"$dm_home/Library/Logs/$service_name"}
node_bin=${LCT_NODE_BIN:-$(command -v node)}
codex_pkg=${LCT_CODEX_PKG:-"$dm_home/.local/lib/node_modules/@openai/codex"}
codex_scope=$(dirname "$codex_pkg")
modules_dir=$(dirname "$codex_scope")
lib_dir=$(dirname "$modules_dir")

# seatbelt 按真实路径匹配：先建目录再做 realpath 归一（macOS 的 /var→/private/var 等符号链接会绕过未归一的规则）
mkdir -p "$scratch_dir" "$cache_dir/attachments" "$persist_dir/attachments" "$dm_state" "$logs_dir"
canon(){ (cd "$1" 2>/dev/null && pwd -P) || printf '%s' "$1"; }
dm_home=$(canon "$dm_home"); scratch_dir=$(canon "$scratch_dir")
cache_dir=$(canon "$cache_dir"); persist_dir=$(canon "$persist_dir")
dm_state=$(canon "$dm_state"); logs_dir=$(canon "$logs_dir"); lib_dir=$(canon "$lib_dir")
node_bin="$(canon "$(dirname "$node_bin")")/$(basename "$node_bin")"

# 路径含双引号或反斜杠会破坏 SBPL，拒绝启动优于生成错误档案
case "$dm_home$scratch_dir$cache_dir$persist_dir$dm_state$logs_dir$node_bin$lib_dir" in
  *[\"\\]*) echo "路径含特殊字符，无法生成沙箱档案" >&2; exit 1 ;;
esac

profile="$dm_state/dm-sandbox.sb"
if [ "${1:-}" = "--print-profile" ]; then profile=/dev/stdout; fi

cat > "$profile" <<SB
(version 1)
(allow default)
;; 读：$HOME 全拒，白名单放行（后写覆盖先写）
(deny file-read* (subpath "$dm_home"))
(allow file-read* (subpath "$scratch_dir"))
(allow file-read* (subpath "$cache_dir/attachments"))
(allow file-read* (subpath "$persist_dir/attachments"))
(allow file-read* (subpath "$dm_state"))
(allow file-read* (literal "$node_bin"))
(allow file-read* (subpath "$lib_dir"))
;; 写：默认全拒，白名单放行
(deny file-write*)
(allow file-write* (subpath "$scratch_dir"))
(allow file-write* (subpath "$cache_dir/attachments"))
(allow file-write* (subpath "$persist_dir/attachments"))
(allow file-write* (subpath "$dm_state"))
(allow file-write* (subpath "$logs_dir"))
(allow file-write* (subpath "/tmp"))
(allow file-write* (subpath "/private/tmp"))
(allow file-write* (subpath "/private/var/folders"))
(allow file-write* (literal "/dev/null"))
SB

if [ "$profile" = /dev/stdout ]; then exit 0; fi
export CODEX_HOME="$dm_state"
exec /usr/bin/sandbox-exec -f "$profile" "$node_bin" "$codex_pkg/bin/codex.js" "$@"
