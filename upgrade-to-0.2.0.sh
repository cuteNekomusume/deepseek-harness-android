#!/data/data/com.termux/files/usr/bin/bash
# =============================================================================
# upgrade-to-0.2.0.sh
# -----------------------------------------------------------------------------
# 把已打好 Android 补丁的 dsh 0.2.0-rc.2（暂存于 ~/dsh-stage）切换到全局安装位置，
# 停服 -> 换树 -> 校验 -> 启动。换树是两次 rename（同一文件系统），瞬时完成。
#
# 安全性：
#   - 切换前自动备份当前安装目录（整目录重命名，不复制）与 ~/.dsh 配置；
#   - 状态写入 ~/dsh-backup/.upgrade-state，供 rollback-dsh.sh 精确回滚；
#   - 版本校验失败会直接报错退出，不会带着坏树启动。
#
# 用法：
#   bash ~/dsh/upgrade-to-0.2.0.sh            # 执行切换
#   bash ~/dsh/upgrade-to-0.2.0.sh --check    # 只做前置检查，不动服务
# =============================================================================
set -euo pipefail

CHECK=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) printf '[x] 未知参数: %s\n' "$arg"; exit 2 ;;
  esac
done

STAGED="$HOME/dsh-stage/lib/node_modules/@deepseek-ai/dsh"
GLOBAL="/data/data/com.termux/files/usr/lib/node_modules/@deepseek-ai/dsh"
TREE_BACKUP="$HOME/dsh-backup/dsh-tree-rc6"
STATE="$HOME/dsh-backup/.upgrade-state"
TARGET_VERSION="0.2.0-rc.2"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[v]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*"; exit 1; }

# ---------------------------------------------------------------- 1/6 前置检查
[ -d "$STAGED" ] || die "找不到暂存安装：$STAGED
    请先完成旁路安装（npm install -g --prefix ~/dsh-stage ...）并运行补丁脚本。"
NEW_VER="$(node -e "console.log(require('$STAGED/package.json').version)" 2>/dev/null || echo unknown)"
[ "$NEW_VER" = "$TARGET_VERSION" ] || die "暂存版本不是 $TARGET_VERSION（实际 $NEW_VER）"
[ -d "$GLOBAL" ] || die "找不到当前安装：$GLOBAL"
OLD_VER="$(node -e "console.log(require('$GLOBAL/package.json').version)" 2>/dev/null || echo unknown)"
info "版本切换：$OLD_VER -> $NEW_VER"

# 关键前置：补丁与 flock 绑定必须已就位
[ -f "$STAGED/node_modules/@deepseek-ai/node-addon-system-android-arm64/bin/system.node" ] \
  || die "暂存的 0.2.0 缺少 android flock 绑定，请先运行 patches/build-flock-android.sh"
grep -q "platform !== 'android'" "$STAGED/node_modules/@deepseek-ai/node-addon-system/lib/flock.js" \
  || die "暂存的 0.2.0 未放行 flock 的 android 门禁，请先运行 patches/build-flock-android.sh"
node -e "
const s = require('node:fs').readFileSync('$STAGED/node_modules/node-addon-require-builtin/lib/index.js','utf8');
if (!s.includes('dsh-android-js-shim')) { console.error('缺少 require-builtin shim'); process.exit(1); }
" || die "暂存的 0.2.0 缺少 require-builtin shim，请先运行 patches/patch-dsh-android-0.2.js"
ok "补丁与原生绑定检查通过"

if [ "$CHECK" -eq 1 ]; then
  echo
  ok "前置检查全部通过（--check 模式，未改动任何东西）"
  echo "    暂存安装: $STAGED"
  echo "    目标位置: $GLOBAL"
  echo "    备份目录: $HOME/dsh-backup"
  echo "    去掉 --check 即可执行切换。"
  exit 0
fi

# ---------------------------------------------------------------- 2/6 备份
mkdir -p "$HOME/dsh-backup"
STAMP="$(date +%Y%m%d-%H%M%S)"
CFG_BACKUP="$HOME/dsh-backup/dsh-config-$STAMP.tgz"
info "备份 ~/.dsh 配置 -> $CFG_BACKUP"
tar czf "$CFG_BACKUP" -C "$HOME" .dsh
if [ -d "$TREE_BACKUP" ]; then
  warn "安装目录备份已存在（$TREE_BACKUP），保留不覆盖"
else
  ok "当前安装目录将原地重命名为备份：$TREE_BACKUP"
fi

# ---------------------------------------------------------------- 3/6 停服
info "停止 dsh 服务"
bash "$HOME/dsh/stop_dsh.sh" || true
sleep 2

# ----------------------------------------------------------- 4/6 换树（rename）
if [ ! -d "$TREE_BACKUP" ]; then
  mv "$GLOBAL" "$TREE_BACKUP"
  ok "旧安装已移至 $TREE_BACKUP"
fi
mv "$STAGED" "$GLOBAL"
ok "0.2.0 已就位：$GLOBAL"

# ---------------------------------------------------------------- 5/6 校验
REAL_VER="$(dsh --version 2>/dev/null | tail -1)"
[ "$REAL_VER" = "$TARGET_VERSION" ] || die "切换后版本校验失败：期望 $TARGET_VERSION，实际 $REAL_VER
    可运行 bash ~/dsh/rollback-dsh.sh 回滚。"
ok "版本校验通过：dsh $REAL_VER"

cat > "$STATE" <<EOF
UPGRADED_AT=$STAMP
FROM_VERSION=$OLD_VER
TO_VERSION=$NEW_VER
TREE_BACKUP=$TREE_BACKUP
CONFIG_BACKUP=$CFG_BACKUP
EOF
ok "状态已记录：$STATE"

# ---------------------------------------------------------------- 6/6 启动
info "启动 dsh $REAL_VER"
echo
echo "注意："
echo "  1) 首次启动会把 ~/.dsh/settings.yaml 迁移为 settings.yaml.imported，"
echo "     并把 .credentials.yaml 升级为新 schema —— 原文件已在上面备份。"
echo "  2) 旧会话日志会自动兼容读取；新写入的日志为 session.v4.jsonl.zstd。"
echo "  3) 若模型无响应，检查 Models 页的 API Key。"
echo "  4) 回滚：bash ~/dsh/rollback-dsh.sh"
echo
bash "$HOME/dsh/start_dsh.sh"
