#!/data/data/com.termux/files/usr/bin/bash
# =============================================================================
# rollback-dsh.sh
# -----------------------------------------------------------------------------
# 把 dsh 从 0.2.0-rc.2 回滚到升级前的版本（通常是 0.1.0-rc.6），并还原配置格式。
#
# 为什么必须同时还原配置：
#   - 0.2.0 的凭据文件是新 schema（version: 1 / refs: {...}），而 0.1.0-rc.6 的
#     解析器是严格的「引用 -> 非空字符串」扁平映射，读到 version（数字）会直接
#     抛错 —— 不还原的话 rc.6 会读不到 API Key；
#   - 0.2.0 会把 settings.yaml 迁移为 settings.yaml.imported，需还原 settings.yaml。
#   只还原这两个配置文件，**不动 sessions/**，因此升级后新产生的会话不会丢。
#
# 用法：
#   bash ~/dsh/rollback-dsh.sh
# =============================================================================
set -euo pipefail

STATE="$HOME/dsh-backup/.upgrade-state"
GLOBAL="/data/data/com.termux/files/usr/lib/node_modules/@deepseek-ai/dsh"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[v]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*"; exit 1; }

[ -f "$STATE" ] || die "找不到升级状态文件：$STATE
    若你是手动切换的，请手动把 $GLOBAL 换回备份目录。"
# shellcheck disable=SC1090
. "$STATE"

[ -n "${TREE_BACKUP:-}" ] && [ -d "$TREE_BACKUP" ] || die "找不到安装目录备份：${TREE_BACKUP:-未记录}"
[ -n "${CONFIG_BACKUP:-}" ] && [ -f "$CONFIG_BACKUP" ] || die "找不到配置备份：${CONFIG_BACKUP:-未记录}"

info "回滚：$TO_VERSION -> $FROM_VERSION（升级于 $UPGRADED_AT）"

info "停止 dsh 服务"
bash "$HOME/dsh/stop_dsh.sh" || true
sleep 2

# 把 0.2.0 挪到一边（保留，便于再次前滚），再换回旧树
DISPLACED="$HOME/dsh-backup/dsh-tree-$TO_VERSION-$UPGRADED_AT"
if [ -e "$DISPLACED" ]; then
  rm -rf "$DISPLACED"
fi
mv "$GLOBAL" "$DISPLACED"
mv "$TREE_BACKUP" "$GLOBAL"
ok "已换回 $FROM_VERSION（0.2.0 保留在 $DISPLACED）"

info "还原 rc.6 可读的配置格式（只动 .credentials.yaml 与 settings.yaml）"
tar xzf "$CONFIG_BACKUP" -C "$HOME" .dsh/.credentials.yaml .dsh/settings.yaml
rm -f "$HOME/.dsh/settings.yaml.imported"
chmod 600 "$HOME/.dsh/.credentials.yaml"
ok "配置已还原（sessions/ 未改动，升级后的新会话仍在）"

REAL_VER="$(dsh --version 2>/dev/null | tail -1)"
[ "$REAL_VER" = "$FROM_VERSION" ] || die "回滚后版本校验失败：期望 $FROM_VERSION，实际 $REAL_VER"
ok "版本校验通过：dsh $REAL_VER"

rm -f "$STATE"
info "启动 dsh $REAL_VER"
bash "$HOME/dsh/start_dsh.sh"
