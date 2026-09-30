# DeepSeek Harness for Android/Termux

> 在 **Android 手机 Termux 环境** 原生运行 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的一键部署项目 · One-click deployment of DeepSeek Harness on **Android/Termux**.
>
> 点击下方语言标题切换 · Click a language below to view its README.

> [!IMPORTANT]
> **当前最高支持 deepseek-harness 0.2.0-rc.2**。0.2.0 是大重构，Android 上需要额外步骤，见下方「五、升级到 dsh 0.2.0」。
> **rc.7 及更早版本**（含 rc.6）继续由 `setup.sh` 一键支持，无需额外步骤。
>
> **Currently supports deepseek-harness up to 0.2.0-rc.2** — a large refactor that needs extra Android steps; see "5. Upgrading to dsh 0.2.0" below. **rc.7 and earlier** (incl. rc.6) remain one-click supported by `setup.sh`.

---

<details open>
<summary><b>🇨🇳 中文</b> · 点击收起/展开中文说明</summary>

## 这是什么

在 Android 手机上原生运行 DeepSeek Harness（`@deepseek-ai/dsh`，DeepSeek 官方的 agent harness，类 Claude Code）。通过 **Web UI**（`http://127.0.0.1:3080`）在手机浏览器里使用，agent 可在手机上真实执行 bash 命令。

> ⚠️ **需要 Termux**：必须在 Android 手机的 Termux 终端里安装运行。**不要用 Google Play 版 Termux**（已过时）。

### 一、安装 Termux

- **F-Droid（推荐）**：<https://f-droid.org/en/packages/com.termux/>
- **GitHub Releases**：<https://github.com/termux/termux-app/releases>

打开 Termux 后执行 `pkg update -y`。

### 二、一键安装

```bash
pkg install -y git
git clone https://github.com/FunnelCakes/deepseek-harness-android.git
cd deepseek-harness-android
bash setup.sh
```

> 🇨🇳 **国内用户提示**：`setup.sh` 会自动测速，npm / nodejs.org 较慢时**自动切换到 npmmirror 镜像**（仅本次会话生效，不改全局配置）。若 `git clone` 很慢或超时，请先开代理/TUN，或改用镜像 clone（如 `https://gitclone.com/github.com/FunnelCakes/deepseek-harness-android.git`）。

### 三、使用

```bash
bash ~/dsh/start_dsh.sh   # 启动并自动拉起浏览器
bash ~/dsh/stop_dsh.sh    # 停止
```

打开 <http://127.0.0.1:3080>，在 **Models** 页填入你的 **DeepSeek API Key**（存于 `~/.dsh/.credentials.yaml`，0600 权限），即可开始。

### 四、setup.sh 自动修复的 Android 兼容问题

| 问题 | 现象 | 修复 |
|---|---|---|
| node-pty 无法编译 | `Undefined variable android_ndk_path` | 修补 node-gyp 缓存 `common.gypi` |
| koffi 无法编译 | `statx` 相关 `__u32` 编译错误 | `-target aarch64-linux-android30` |
| npm 拦截构建脚本 | node-pty/koffi 无产物 | `--allow-scripts` 放行 |
| `link()` 被禁（SELinux） | 会话/附件保存、write 工具新建文件报 `EACCES` | 会话/附件发布改 `rename()`；write 新建文件回退"O_EXCL 占位+rename"；附件祖先遍历/清理容忍（`patches/patch-dsh-android-link.js`，幂等） |
| PTY 终端检测失败 | `unsupported on platform android` | subprocess 把 android 视同 linux |
| sharp 无法加载 | `Could not load sharp module` | 安装 `@img/sharp-wasm32` wasm 回退 |
| HMR 启动崩溃 | `--expose-internals is required` | 包装脚本加 `--expose-internals` |
| bash 工具不可用 | `SANDBOX_UNAVAILABLE` | 权限模式设 `danger-full-access` |
| 前端不适配竖屏 | 桌面布局、触控目标小等 | `apply-frontend.sh` 注入移动端 CSS/JS |
| 软键盘遮挡输入框 | 输入法弹出后输入框被键盘盖住 | `visualViewport` 跟随：键盘弹出时整页（含输入框）抬到键盘上方，收回时还原 |
| 局域网 HTTP 缺少 Web Crypto API | `crypto.randomUUID is not a function` | 注入基于 `crypto.getRandomValues()` 的 UUID v4 回退 |
| 上下文大时重进/切回卡顿 | 冷重进、从外部应用切回要等很久 | `apply-js-patches.sh`：history 窗口瘦身（chunk 流过滤+大结果截断）+ 重连增量同步（保留窗口静默补齐） |
| 整页重载重复下载 JS | 每次刷新重下 ~4.7MB bundle | 静态资源与插件 bundle 加 immutable 缓存头 |
| PWA 沉浸模式键盘不跟随 | fullscreen 下软键盘覆盖、视口不收缩，composer 被盖住 | manifest display 改 `standalone`（需重装 PWA，恢复系统栏+正常键盘行为）|

> **0.2.0 差异（重要）**：上表针对 rc.7 及更早版本。在 0.2.0 上：
> - 「PTY 终端检测」**不再需要**——上游已删除 `LinuxProcessInspector`，新代码在 Android 上优雅降级（普通 spawn + 一条警告）；
> - 「`link()` 被禁」改由 `patches/patch-dsh-android-0.2.js` 处理（锚点已按 0.2.0 重写）；
> - 最后两行性能优化（历史瘦身 / 增量重连 / 静态缓存）**暂不适用**，需按 0.2.0 的新文件布局重新适配。

### 五、升级到 dsh 0.2.0

0.2.0 是一次大重构（依赖包 194 → 286：`dsh-client-web` 拆成数十个 `dsh-client-ui-*`，`dsh-host-apiproxy` 拆成 `dsh-api-*-controller`），rc 时代的补丁锚点多数已失效；同时上游原生包矩阵**不含 Android**，会撞上两个硬阻塞：

| 0.2.0 新增的 Android 阻塞 | 现象 | 修复 |
|---|---|---|
| `node-addon-require-builtin` 无 android 原生绑定 | **启动即崩** `host preparation failed` | 上游未发布该平台包（npm 404）且发布版不含源码；`patch-dsh-android-0.2.js` 用纯 JS shim 顶替——启动脚本已带 `--expose-internals`，可直接取 Node 内部模块 |
| `flock` 未放行 android | **能启动，但一发消息就写不了会话** | 上游门禁只放行 linux/darwin；`build-flock-android.sh` 用上游自带的 `src/flock.c` 本地编译绑定并放行门禁 |

完整流程（**旁路安装**，全程不覆盖在用安装）：

```bash
# 1) 旁路安装到 ~/dsh-stage
CFLAGS="-target aarch64-linux-android30 -I$PREFIX/include" \
CXXFLAGS="-target aarch64-linux-android30 -I$PREFIX/include" \
  npm install -g --prefix ~/dsh-stage \
  --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs \
  @deepseek-ai/dsh@0.2.0-rc.2

# 2) Android 补丁 + flock 绑定（均幂等，可重复执行）
node patches/patch-dsh-android-0.2.js --install ~/dsh-stage/lib/node_modules/@deepseek-ai/dsh
bash patches/build-flock-android.sh      ~/dsh-stage/lib/node_modules/@deepseek-ai/dsh

# 3) 前端移动端适配
bash apply-frontend.sh ~/dsh-stage/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html

# 4) 切换（先 --check 预检，再执行；会自动备份旧树与配置）
bash upgrade-to-0.2.0.sh --check
bash upgrade-to-0.2.0.sh
```

回滚：`bash rollback-dsh.sh`——会连同 rc.6 可读的配置格式一起还原（0.2.0 的凭据是新 schema，旧版解析器读不了），且不动 `sessions/`。

原理、锚点与逐条验证记录见 **[docs/0.2.0-android-notes.md](docs/0.2.0-android-notes.md)**。升级 dsh 或重装后，第 2 步的两个脚本都要重跑。

### 六、安全说明

- 服务只监听 `127.0.0.1`（本机），不走局域网。
- API Key 存 `~/.dsh/.credentials.yaml`（0600），不进日志、不进进程环境。
- `danger-full-access` 关闭了进程沙箱（Android 无 bwrap/landlock 替代），agent 可执行任意命令——仅建议个人设备使用。
- 升级 dsh 或 Node 后需重跑对应的适配脚本：**rc.7 及更早**用 `setup.sh`；**0.2.0** 用 `patches/patch-dsh-android-0.2.js` + `patches/build-flock-android.sh`（`npm install -g` 覆盖安装会把补丁全部抹掉，包括 flock 绑定和 require-builtin shim）。

### 七、常见问题

- **页面白屏/打不开**：确认在 Termux 环境；看日志 `~/dsh/storage/dsh.log`。
- **`AbortSignal.any is not a function`**：浏览器过旧，`apply-frontend.sh` 已注入 polyfill。
- **`crypto.randomUUID is not a function`**：局域网 HTTP 或旧版 WebView 不暴露该 API，`apply-frontend.sh` 已注入安全随机 UUID v4 回退。
- **模型没反应**：检查 Models 页 API Key 与 `~/.dsh/.credentials.yaml`。
- **0.2.0 启动即报 `host preparation failed`**：缺少 require-builtin shim，跑 `node patches/patch-dsh-android-0.2.js --install <dsh 包目录>`。
- **0.2.0 能启动、但一发消息就报错或会话存不下来**：flock 未放行 android（上游只支持 linux/darwin）。跑 `bash patches/build-flock-android.sh <dsh 包目录>`。
- **0.2.0 下直接 `curl http://127.0.0.1:3080` 返回 401**：这是 0.2.0 新增的 token 门禁，属正常；浏览器带 token cookie 访问不受影响。
- **换机/重装**：重跑 `bash setup.sh`（0.2.0 另见「五、升级到 dsh 0.2.0」）。

### 八、作者测试环境与兼容性

- **测试设备**：华为 Mate 60（ALN-AL80），HarmonyOS 4.2.0（build 4.2.0.186），**无 root**，Termux（Node v26，aarch64）。
- 不同手机 / ROM 的差异可能导致额外问题，例如：部分 ROM 通过 SELinux 禁用 `link()` 系统调用（会话/附件无法持久化，本脚本已改为 `rename()` 修复）、命名空间沙箱权限不同、bwrap/landlock 是否可用等。
- `setup.sh` 覆盖了通用 Android 场景，但个别机型可能需要额外适配。

**欢迎提 issue / PR 适配更多环境**：如果你在其它品牌、系统版本或 root 状态下遇到问题，欢迎在 [Issues](https://github.com/FunnelCakes/deepseek-harness-android/issues) 提交，或提交 Pull Request 补充对应机型的修复。

### 参考

- [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- [deepseek-harness Discussion #136 — Android/Termux 部署](https://github.com/deepseek-ai/deepseek-harness/discussions/136)
- [deepseek-harness Discussion #248 — Android 禁 hardlink（link→rename 提案）](https://github.com/deepseek-ai/deepseek-harness/discussions/248)
- [Termux Wiki](https://wiki.termux.com/)

</details>

---

<details>
<summary><b>🇬🇧 English</b> · click to expand/collapse</summary>

## What is this

Run [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`@deepseek-ai/dsh`, DeepSeek's official agent harness, Claude Code–like) natively on Android. Use it through the **Web UI** at `http://127.0.0.1:3080` in your mobile browser; the agent can run real bash commands on the phone.

> ⚠️ **Termux required**: install and run inside the **Termux terminal on your Android phone**. Do **NOT** use the Google Play version (outdated).

### 1. Install Termux

- **F-Droid (recommended)**: <https://f-droid.org/en/packages/com.termux/>
- **GitHub Releases**: <https://github.com/termux/termux-app/releases>

Run `pkg update -y` after opening Termux.

### 2. One-click setup

```bash
pkg install -y git
git clone https://github.com/FunnelCakes/deepseek-harness-android.git
cd deepseek-harness-android
bash setup.sh
```

> `setup.sh` auto-detects slow npm / nodejs.org and switches to the npmmirror mirror when needed (session-only, doesn't change your global config).

### 3. Usage

```bash
bash ~/dsh/start_dsh.sh   # start & auto-open browser
bash ~/dsh/stop_dsh.sh    # stop
```

Open <http://127.0.0.1:3080>, enter your **DeepSeek API Key** in the **Models** page (stored at `~/.dsh/.credentials.yaml`, mode 0600), and start chatting.

### 4. Android issues auto-fixed by setup.sh

| Issue | Symptom | Fix |
|---|---|---|
| node-pty fails to build | `Undefined variable android_ndk_path` | patch node-gyp cache `common.gypi` |
| koffi fails to build | `statx` `__u32` compile error | `-target aarch64-linux-android30` |
| npm blocks build scripts | no node-pty/koffi output | allow via `--allow-scripts` |
| `link()` blocked (SELinux) | `EACCES` saving sessions/attachments, and when `write` tool creates a new file | session/attachment publish uses `rename()`; new-file write falls back to "O_EXCL reserve + rename"; attachment ancestor-walk & cleanup tolerate EACCES/ENOENT (`patches/patch-dsh-android-link.js`, idempotent) |
| PTY terminal detection fails | `unsupported on platform android` | treat android as linux in subprocess |
| sharp fails to load | `Could not load sharp module` | install `@img/sharp-wasm32` wasm fallback |
| HMR crashes on start | `--expose-internals is required` | wrapper script adds `--expose-internals` |
| bash tool unavailable | `SANDBOX_UNAVAILABLE` | permission mode `danger-full-access` |
| Frontend not mobile-ready | desktop layout, small touch targets | `apply-frontend.sh` injects mobile CSS/JS |
| Soft keyboard covers the input | input box hidden behind the IME when it opens | `visualViewport`-driven follow: page (incl. input) lifts above the keyboard on open, restores on close |
| Web Crypto API missing over LAN HTTP | `crypto.randomUUID is not a function` | inject a UUID v4 fallback based on `crypto.getRandomValues()` |
| Lag re-entering / switching back with big context | cold re-entry and app-return stall for seconds | `apply-js-patches.sh`: slim history windows (chunk-stream filter + big-result truncation) + incremental reconnect sync (keep window, quiet catch-up) |
| Page reload re-downloads JS | ~4.7MB bundles re-fetched every refresh | immutable cache headers on static assets & plugin bundles |
| PWA immersive-mode keyboard not followed | soft keyboard overlays without shrinking the viewport; composer stays covered | manifest `display` → `standalone` (reinstall the PWA; restores system bars + normal keyboard behavior) |

> **0.2.0 differences (important)**: the table above targets rc.7 and earlier. On 0.2.0:
> - "PTY terminal detection" is **no longer needed** — upstream removed `LinuxProcessInspector` and the new code degrades gracefully on Android (plain spawn + one warning);
> - "`link()` blocked" is now handled by `patches/patch-dsh-android-0.2.js` (anchors rewritten for 0.2.0);
> - the last two rows of performance work (history slimming / incremental reconnect / static cache) **do not apply yet** and need re-authoring against 0.2.0's file layout.

### 5. Upgrading to dsh 0.2.0

0.2.0 is a large refactor (194 → 286 packages: `dsh-client-web` split into dozens of `dsh-client-ui-*`, `dsh-host-apiproxy` into `dsh-api-*-controller`); most rc-era patch anchors are gone, and upstream's native package matrix **does not include Android**, so two hard blockers appear:

| New 0.2.0 blocker on Android | Symptom | Fix |
|---|---|---|
| `node-addon-require-builtin` has no android binding | **crashes on startup**: `host preparation failed` | Upstream publishes no such platform package (npm 404) and ships no sources; `patch-dsh-android-0.2.js` substitutes a pure-JS shim — the launch wrapper already passes `--expose-internals`, so Node internals are reachable |
| `flock` gate excludes android | **starts fine, but cannot persist a session the moment you send a message** | Upstream's gate only allows linux/darwin; `build-flock-android.sh` compiles the shipped `src/flock.c` locally and opens the gate |

Full flow (**side-by-side install**, never overwrites the install in use):

```bash
# 1) side-by-side install into ~/dsh-stage
CFLAGS="-target aarch64-linux-android30 -I$PREFIX/include" \
CXXFLAGS="-target aarch64-linux-android30 -I$PREFIX/include" \
  npm install -g --prefix ~/dsh-stage \
  --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs \
  @deepseek-ai/dsh@0.2.0-rc.2

# 2) Android patches + flock binding (both idempotent)
node patches/patch-dsh-android-0.2.js --install ~/dsh-stage/lib/node_modules/@deepseek-ai/dsh
bash patches/build-flock-android.sh      ~/dsh-stage/lib/node_modules/@deepseek-ai/dsh

# 3) frontend mobile adaptation
bash apply-frontend.sh ~/dsh-stage/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html

# 4) switch over (--check first; backs up the old tree and config automatically)
bash upgrade-to-0.2.0.sh --check
bash upgrade-to-0.2.0.sh
```

Rollback: `bash rollback-dsh.sh` — it also restores the config format rc.6 can read (0.2.0's credentials use a new schema the old parser rejects) and leaves `sessions/` untouched.

Rationale, anchors and the per-item verification log live in **[docs/0.2.0-android-notes.md](docs/0.2.0-android-notes.md)**. Re-run both step-2 scripts after any dsh upgrade or reinstall.

### 6. Security notes

- The service listens only on `127.0.0.1` (local, not LAN).
- API Key is stored at `~/.dsh/.credentials.yaml` (0600), never in logs or process env.
- `danger-full-access` disables the process sandbox (no bwrap/landlock on Android); the agent can run any command — personal devices only.
- Re-run the matching adaptation scripts after upgrading dsh or Node: **rc.7 and earlier** → `setup.sh`; **0.2.0** → `patches/patch-dsh-android-0.2.js` + `patches/build-flock-android.sh` (an `npm install -g` overwrite wipes every patch, including the flock binding and the require-builtin shim).

### 7. FAQ

- **Blank screen / cannot open**: make sure it's Termux; check `~/dsh/storage/dsh.log`.
- **`AbortSignal.any is not a function`**: old browser; `apply-frontend.sh` injects a polyfill.
- **`crypto.randomUUID is not a function`**: LAN HTTP and older WebViews may not expose the API; `apply-frontend.sh` injects a secure UUID v4 fallback.
- **Model not responding**: check the API Key in Models page and `~/.dsh/.credentials.yaml`.
- **0.2.0 crashes on startup with `host preparation failed`**: the require-builtin shim is missing; run `node patches/patch-dsh-android-0.2.js --install <dsh package dir>`.
- **0.2.0 starts, but errors out or cannot persist a session once you send a message**: the flock gate still excludes android (upstream only supports linux/darwin). Run `bash patches/build-flock-android.sh <dsh package dir>`.
- **On 0.2.0, a bare `curl http://127.0.0.1:3080` returns 401**: that is 0.2.0's new token fence and is expected; browsers carrying the token cookie are unaffected.
- **Reinstall / new device**: re-run `bash setup.sh` (for 0.2.0 see "5. Upgrading to dsh 0.2.0").

### 8. Author's test environment & compatibility

- **Tested device**: Huawei Mate 60 (ALN-AL80), HarmonyOS 4.2.0 (build 4.2.0.186), **no root**, Termux (Node v26, aarch64).
- Different phones / ROMs may behave differently, e.g. some ROMs block the `link()` syscall via SELinux (sessions/attachments fail to persist — this script switches to `rename()` to fix it), namespace-sandbox permissions vary, and bwrap/landlock may or may not be available.
- `setup.sh` covers the common Android cases, but specific devices may need extra tweaks.

**Issues & PRs welcome**: if you hit a problem on another brand / OS version / root state, please open an [issue](https://github.com/FunnelCakes/deepseek-harness-android/issues) or submit a pull request with a fix for your environment.

### References

- [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- [deepseek-harness Discussion #136 — Android/Termux deployment](https://github.com/deepseek-ai/deepseek-harness/discussions/136)
- [deepseek-harness Discussion #248 — hardlinks blocked on Android (link→rename proposal)](https://github.com/deepseek-ai/deepseek-harness/discussions/248)
- [Termux Wiki](https://wiki.termux.com/)

</details>

---

## License

MIT
