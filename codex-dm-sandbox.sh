#!/bin/sh
# lark-codex-tasks — 私聊 Codex 沙箱启动器（bubblewrap）。
# 私聊实例以 nobody UID 运行；home tmpfs 隐藏 bridge 凭证，仅放行 node、codex 包与 scratch 工作区。
set -eu

dm_home=${HOME:?}
state_root=${LCT_STATE_DIR:-"$dm_home/.local/state/lark-codex-tasks"}
dm_state="$state_root/dm-codex-home"
workspace_root=${LCT_WORKSPACE_ROOT:-"$dm_home/workspace"}
scratch_dir=${LCT_SCRATCH_DIR:-"$workspace_root/scratch"}
node_bin=${LCT_NODE_BIN:-"$dm_home/.local/bin/node"}
codex_pkg=${LCT_CODEX_PKG:-"$dm_home/.local/lib/node_modules/@openai/codex"}
codex_scope=$(dirname "$codex_pkg")      # …/node_modules/@openai
modules_dir=$(dirname "$codex_scope")    # …/node_modules
lib_dir=$(dirname "$modules_dir")        # …/lib
dm_runtime_dir=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
test -d "$dm_state"
case "$dm_runtime_dir" in /run/user/[0-9]*) ;; *) exit 1 ;; esac

# The home tmpfs hides bridge credentials; the remapped UID alone does not.
exec /usr/bin/bwrap \
  --die-with-parent --new-session \
  --unshare-user --uid 65534 --gid 65534 --unshare-pid --unshare-ipc --unshare-uts \
  --ro-bind / / \
  --tmpfs "$dm_home" \
  --dir "$dm_home/.local" --dir "$dm_home/.local/bin" \
  --ro-bind "$node_bin" "$node_bin" \
  --dir "$lib_dir" --dir "$modules_dir" \
  --dir "$codex_scope" \
  --ro-bind "$codex_pkg" "$codex_pkg" \
  --dir "$workspace_root" \
  --bind "$scratch_dir" "$scratch_dir" \
  --dir "$dm_home/.codex" --bind "$dm_state" "$dm_home/.codex" \
  --tmpfs /tmp --tmpfs "$dm_runtime_dir" --proc /proc --dev /dev \
  --setenv HOME "$dm_home" --setenv CODEX_HOME "$dm_home/.codex" \
  --setenv PATH "$dm_home/.local/bin:/usr/local/bin:/usr/bin:/bin" \
  "$node_bin" "$codex_pkg/bin/codex.js" "$@"
