#!/data/data/com.termux/files/usr/bin/bash
# =============================================================================
# build-flock-android.sh
# -----------------------------------------------------------------------------
# 为 Android/Termux 本地编译 dsh 0.2.0 所需的 flock 原生绑定。
#
# 为什么需要：
#   dsh 0.2.0 的会话写锁（dsh-session-persistence-jsonl 的 SessionWriteLease）
#   通过 @deepseek-ai/node-addon-system 的异步 flock(2) 实现。但该包：
#     1) lib/flock.js 有平台门禁：platform !== 'linux' && !== 'darwin' 直接抛
#        ERR_FLOCK_UNSUPPORTED_PLATFORM —— Android 被排除；
#     2) 平台原生包只发布了 darwin-arm64/x64、linux-x64/arm64，
#        **没有 android-arm64**（npm E404）。
#   结果是：dsh web 能启动（启动不碰会话锁），但一旦真正写会话日志（发消息）
#   就会撞门禁，会话无法持久化。
#
# 本机实测：`flock(LOCK_EX|LOCK_NB)` 在 Termux/android30 下**正常工作**
#   （SELinux 只挡了 link(2)，没挡 flock(2)），所以可以自行编译。
#
# 好在 node-addon-system 发布版自带 C 源码 src/flock.c，且它是**纯 C 的
# Node-API 单文件插件**（不依赖 node-addon-api/C++，只需 node_api.h）：
#   - 导出唯一函数 tryLock(fd, callback)，回调收到 0 或正 errno；
#   - 走 napi_create_async_work，异步执行 flock(LOCK_EX | LOCK_NB)。
# 因此用 clang 直接编成共享库即可，无需 gyp/cmake。
#
# 本脚本做三件事：
#   1) 编译 src/flock.c -> system.node
#   2) 生成平台包 @deepseek-ai/node-addon-system-android-arm64（含 bin/system.node）
#      —— 这是 lib/flock.js 用 require.resolve 查找的落点
#   3) 幂等放开 lib/flock.js 的 android 门禁
#
# 用法：
#   bash build-flock-android.sh [dsh 包目录]
#   默认 /data/data/com.termux/files/usr/lib/node_modules/@deepseek-ai/dsh
#
# 环境变量：
#   NODE_HEADERS  覆盖 Node 头文件目录（默认取自 node-gyp 缓存）
#   EXTRA_CFLAGS  追加编译参数（例如 -target aarch64-linux-android30）
# =============================================================================
set -euo pipefail

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[v]\033[0m %s\n' "$*"; }

DSH_DIR="${1:-/data/data/com.termux/files/usr/lib/node_modules/@deepseek-ai/dsh}"
NAS_DIR="$DSH_DIR/node_modules/@deepseek-ai/node-addon-system"
PLATFORM_DIR="$DSH_DIR/node_modules/@deepseek-ai/node-addon-system-android-arm64"
FLOCK_JS="$NAS_DIR/lib/flock.js"
FLOCK_C="$NAS_DIR/src/flock.c"

[ -f "$FLOCK_C" ] || { echo "[x] 找不到 $FLOCK_C（dsh 0.2.0 才有该源码；旧版无需此步骤）"; exit 1; }
[ -f "$FLOCK_JS" ] || { echo "[x] 找不到 $FLOCK_JS"; exit 1; }

# --------------------------------------------------------------- 1/4 头文件
NODE_VER="$(node -v | sed 's/^v//')"
HEADERS="${NODE_HEADERS:-$HOME/.cache/node-gyp/$NODE_VER/include/node}"
if [ ! -f "$HEADERS/node_api.h" ]; then
  info "node_api.h 不在 $HEADERS，尝试用 node-gyp 下载 Node headers"
  timeout 300 npx --yes node-gyp install || true
fi
[ -f "$HEADERS/node_api.h" ] || { echo "[x] 仍缺少 $HEADERS/node_api.h，请手动设置 NODE_HEADERS"; exit 1; }
ok "Node headers: $HEADERS (node v$NODE_VER)"

command -v clang >/dev/null 2>&1 || { echo "[x] 缺少 clang，请先 pkg install clang"; exit 1; }

# ----------------------------------------------------------------- 2/4 编译
info "编译 flock.c -> system.node（纯 C Node-API 插件，无需 gyp/cmake）"
mkdir -p "$PLATFORM_DIR/bin"
clang -shared -fPIC -O2 -I"$HEADERS" ${EXTRA_CFLAGS:-} \
  -o "$PLATFORM_DIR/bin/system.node" "$FLOCK_C"
SIZE="$(du -h "$PLATFORM_DIR/bin/system.node" | cut -f1)"
ok "已编译 system.node ($SIZE)"

# ------------------------------------------------------- 3/4 生成平台包
info "生成平台包 @deepseek-ai/node-addon-system-android-arm64"
cat > "$PLATFORM_DIR/package.json" <<'JSON'
{
  "name": "@deepseek-ai/node-addon-system-android-arm64",
  "version": "0.1.2",
  "private": true,
  "description": "[dsh-android] 本地编译的 flock(Node-API) 绑定；上游未发布该平台包",
  "os": ["android"],
  "cpu": ["arm64"],
  "license": "BSD-3-Clause"
}
JSON
ok "平台包就位: $PLATFORM_DIR"

# ------------------------------------------------- 4/4 放开 Android 门禁
info "放开 lib/flock.js 的 android 平台门禁（幂等）"
if grep -q "platform !== 'android'" "$FLOCK_JS"; then
  ok "  门禁已放开"
else
  python3 - "$FLOCK_JS" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
old = "    if (platform !== 'linux' && platform !== 'darwin') {"
new = (
    "    /* [dsh-android] android 同样提供 flock(2)（bionic 的 sys/file.h，已在本机实测可用），\n"
    "       只是上游 optionalDependencies 未发布 android 平台包，且此门禁排除了 android。\n"
    "       本地用本包自带的 src/flock.c 编译出 bin/system.node 后放开此门禁。 */\n"
    "    if (platform !== 'linux' && platform !== 'darwin' && platform !== 'android') {"
)
if old not in s:
    if "platform !== 'android'" in s:
        print("  [skip] 已处理")
        sys.exit(0)
    print("  [x] 未找到门禁锚点，请人工检查 lib/flock.js")
    sys.exit(1)
open(p, 'w', encoding='utf-8').write(s.replace(old, new, 1))
print("  patched lib/flock.js (android 加入支持平台)")
PY
  ok "  门禁已放开"
fi

# ------------------------------------------------------------------ 自检
info "自检：加载绑定并验证加锁/争用/释放语义"
TMPLOCK="$(mktemp -d)/flock-selfcheck.lock"
node --input-type=module -e "
import { open } from 'node:fs/promises';
const { tryLockExclusive } = await import('$NAS_DIR/lib/flock.js');
const a = await open('$TMPLOCK', 'w');
await tryLockExclusive(a.fd);
const b = await open('$TMPLOCK', 'w');
let contended = null;
try { await tryLockExclusive(b.fd); } catch (error) { contended = error.code; }
await a.close();
await tryLockExclusive(b.fd);
await b.close();
if (contended !== 'EAGAIN' && contended !== 'EWOULDBLOCK') {
  console.error('  [x] 争用未按预期被拒，得到: ' + contended);
  process.exit(1);
}
console.log('  [v] 加锁成功 / 争用 -> ' + contended + ' / 释放后可重获');
"
ok "flock 绑定可用 🎉"
echo
echo "注意：dsh 升级或重装后需重跑本脚本。"
