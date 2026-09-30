#!/usr/bin/env node
/**
 * patch-dsh-android-0.2.js
 * -----------------------------------------------------------------------------
 * dsh 0.2.0-rc.x 的 Android/Termux 兼容补丁集（幂等）。
 *
 * 与 patch-dsh-android-link.js（面向 0.1.0-rc.6/rc.7）的区别：0.2.0 是一次大重构
 * （包数 194 -> 286），原先三处补丁锚点已消失，本脚本按 0.2.0 的实际代码重写：
 *
 *   [1] node-addon-require-builtin -> 纯 JS shim（0.2.0 新增的硬依赖）
 *       上游该包用 node-addon-native-custom-loader 加载平台原生包
 *       node-addon-require-builtin-<platform>，但 optionalDependencies 只有
 *       darwin / linux(gnu|musl) / win32，没有 android-arm64（npm E404），且发布版
 *       不含源码（上游 README: fail closed）。0.2.0 的 dsh-app-boot 与
 *       profile-resolution-bootstrap 在 internalModules() 里硬 require 它，
 *       于是 Android 上启动即 "host preparation failed"。
 *       替代：dsh 只用它取 Node 内部模块，而启动包装脚本已带 --expose-internals，
 *       此时 require('internal/...') 等价可得，故用纯 JS 顶替。
 *
 *   [2] dsh-session-persistence-jsonl：会话日志的两处硬链接发布改为无硬链接回退
 *       （Android SELinux 全局禁硬链接，link(2) 返回 EACCES）
 *         - materializePosix：临时文件随发布被消耗（后续 rm 均带 force:true）-> rename
 *         - publishCurrentExclusive：必须保留 no-replace 的 EEXIST 语义
 *           -> copyFile(COPYFILE_EXCL)
 *       注意 link 必须保留在 import 中：0.2.0 的 defaultFileSystem 依赖注入默认
 *       对象以裸 `link,` 引用它，删掉会导致模块导入即 ReferenceError。
 *
 *   [3] dsh-attachment-local：附件发布 link -> copyFile(..., COPYFILE_EXCL)
 *       0.2.0 的两处 link 语义不同，不能用 rename：
 *         - publishImmutableAlias(root, source, target)：source 是既有内容寻址
 *           对象，必须保留，只能复制；COPYFILE_EXCL 保持与 link 相同的 EEXIST
 *           竞态语义（调用方据此做摘要校验）。
 *         - publishStagedObject(root, target, staged)：随后 unlink(staged.path)，
 *           用复制同样保留全部错误语义。
 *       另：祖先目录遍历容忍 EACCES/EPERM/ENOSYS（同 rc 时代的修复）。
 *
 *   [4] dsh-fs-local：write 工具新建文件的 no-replace 发布在 link 被拒时回退到
 *       O_CREAT|O_EXCL 占位 + rename 填充（沿用 patch-dsh-android-link.js 第 3 项）。
 *
 *   [5] dsh-client-ui-conversation：作曲栏「普通回车=换行，Ctrl/Cmd+Enter=发送」
 *       0.2.0 的键盘处理已重构（rc 时代的 keyboard.arbitrate/textarea 路径不存在），
 *       现在在 Lexical registerCommand 的 Enter 处理器里。返回 false 表示"未处理"，
 *       交回 Lexical 默认行为插入换行。
 *
 * 不再需要的补丁（0.2.0 已自行解决）：
 *   - dsh-subprocess-local 的 android->linux：LinuxProcessInspector 已删除，
 *     新 selectContainmentMode() 在 Android 上返回 "fallback"（普通 spawn + 一条
 *     警告），属优雅降级，无需打补丁。
 *
 * 用法：
 *   node patch-dsh-android-0.2.js --install <dsh 包目录>
 *   默认 install 为 /data/data/com.termux/files/usr/lib/node_modules/@deepseek-ai/dsh
 *
 * 退出码：0 全部就位（含已应用）；1 有 pattern-mismatch（需人工检查）。
 * -----------------------------------------------------------------------------
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// ---------------------------------------------------------------- 参数解析
function parseArgs(argv) {
	const out = { install: "/data/data/com.termux/files/usr/lib/node_modules/@deepseek-ai/dsh" };
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === "--install" && argv[i + 1] !== void 0) {
			out.install = argv[i + 1];
			i += 1;
		} else if (argv[i] === "--help" || argv[i] === "-h") {
			out.help = true;
		}
	}
	return out;
}

const MARK = "[dsh-android]";

// ------------------------------------------------- [1] require-builtin shim
const SHIM_SOURCE = [
	'"use strict";',
	"/**",
	" * " + MARK + " 纯 JS 替代实现，顶替上游缺失的原生绑定。",
	" *",
	" * 背景：官方 node-addon-require-builtin 通过 node-addon-native-custom-loader",
	" * 加载平台原生包 node-addon-require-builtin-<platform>。但上游 optionalDependencies",
	" * 里只有 darwin / linux(gnu|musl) / win32，**没有 android-arm64**（npm E404），且发布",
	" * 版不含原生源码（上游 README：Published installs do not ship native sources and",
	" * fail closed），因此 Android/Termux 上该绑定无法获得，dsh 0.2.0 启动即在",
	" * dsh-app-boot / profile-resolution-bootstrap 的 internalModules() 处失败。",
	" *",
	" * 替代原理：dsh 只用它取 Node 内部模块（internal/modules/esm/loader、",
	" * internal/modules/cjs/loader、internal/modules/helpers、internal/modules/esm/utils、",
	" * internal/modules/esm/resolve）。启动包装脚本 /usr/bin/dsh 已带 --expose-internals",
	" * （rc 时代为 HMR 所需），此时 require('internal/...') 可直接拿到与运行时同一批",
	" * 模块实例，语义等价（已实测 esm.resolveSync / getOrCreateModuleJob /",
	" * Module._resolveFilename / getCjsConditions / getDefaultConditions / defaultResolve",
	" * 全部为 function）。",
	" *",
	" * 上游语义保持：本变体不做白名单限制，requireBuiltin(id) 透传给 Node 的",
	" * builtin require，isAllowedInternalId() 恒为 true（见上游 README）。",
	" */",
	'Object.defineProperty(exports, "__esModule", { value: true });',
	"exports.requireBuiltin = requireBuiltin;",
	"exports.isAllowedInternalId = isAllowedInternalId;",
	"exports.getBindingInfo = getBindingInfo;",
	"",
	'const INTERNAL_PREFIX = "internal/";',
	"",
	"function requireBuiltin(moduleId) {",
	'\tif (typeof moduleId !== "string") {',
	'\t\tthrow new TypeError("dsh-android: requireBuiltin expects a module id string");',
	"\t}",
	"\ttry {",
	"\t\treturn require(moduleId);",
	"\t} catch (error) {",
	"\t\tif (moduleId.startsWith(INTERNAL_PREFIX)) {",
	'\t\t\tconst detail = error instanceof Error ? error.message : String(error);',
	"\t\t\tconst hint = new Error(",
	'\t\t\t\t`dsh-android: cannot load Node internal module "${moduleId}": ${detail}. ` +',
	'\t\t\t\t\t"Node internals require --expose-internals (the /usr/bin/dsh wrapper and start_dsh.sh already pass it).",',
	"\t\t\t);",
	"\t\t\thint.cause = error;",
	'\t\t\thint.code = "DSH_ANDROID_INTERNALS_UNAVAILABLE";',
	"\t\t\tthrow hint;",
	"\t\t}",
	"\t\tthrow error;",
	"\t}",
	"}",
	"",
	"/** 上游 unrestricted 变体不做 id 白名单限制，恒为 true（见其 README）。 */",
	"function isAllowedInternalId(moduleId) {",
	'\treturn typeof moduleId === "string";',
	"}",
	"",
	"function getBindingInfo() {",
	"\treturn Object.freeze({",
	'\t\tbackend: "nodeabi",',
	"\t\tabi: `node-v${process.versions.modules}`,",
	"\t\tpath: __filename,",
	'\t\tsource: "js-fallback",',
	"\t\tplatform: process.platform,",
	"\t\tarch: process.arch,",
	'\t\truntime: "node",',
	'\t\tvariant: "dsh-android-js-shim",',
	"\t});",
	"}",
	"",
	"const api = { requireBuiltin, isAllowedInternalId, getBindingInfo };",
	"exports.default = api;",
	"module.exports = Object.assign(exports, api);",
	"",
].join("\n");

// ------------------------------------------------------------- 通用工具
/** 重写某个 node 内置模块的具名导入：增删名字并排序（幂等）。 */
function fixNodeImport(src, specifier, { add = [], remove = [] }) {
	const escaped = specifier.replace(/[/\\]/g, "\\$&");
	const pattern = new RegExp(`import \\{([^}]*)\\} from "${escaped}";`, "g");
	return src.replace(pattern, (whole, body) => {
		let names = body.split(",").map((s) => s.trim()).filter(Boolean);
		for (const name of remove) names = names.filter((n) => n !== name);
		for (const name of add) if (!names.includes(name)) names.push(name);
		names.sort();
		return `import { ${names.join(", ")} } from "${specifier}";`;
	});
}

function fixFsPromisesImport(src, changes) {
	return fixNodeImport(src, "node:fs/promises", changes);
}

function readIfExists(file) {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return void 0;
	}
}

/** 逐条替换；任何一条锚点未命中即整体放弃并报 mismatch，避免产出半成品。 */
function applyEdits(src, edits) {
	let out = src;
	for (const [from, to, expect] of edits) {
		const seen = out.split(from).length - 1;
		if (seen !== (expect ?? 1)) {
			return { ok: false, reason: `锚点命中 ${seen} 次（期望 ${expect ?? 1}）：${JSON.stringify(from.slice(0, 60))}` };
		}
		out = out.split(from).join(to);
	}
	return { ok: true, src: out };
}

// --------------------------------------------------------- 补丁定义
const HARDLINK_HELPER = [
	"/** " + MARK + " link(2) 被拒绝或不支持的错误码：Android SELinux 全局禁硬链接（EACCES），部分 FUSE 挂载未实现（ENOSYS/ENOTSUP）。 */",
	"function isHardLinkUnavailable(error) {",
	'\treturn error instanceof Error && typeof error.code === "string" && (error.code === "EACCES" || error.code === "EPERM" || error.code === "EMLINK" || error.code === "ENOSYS" || error.code === "ENOTSUP" || error.code === "EOPNOTSUPP");',
	"}",
].join("\n");

/**
 * publishCurrentExclusive：no-replace 发布 current 指针。link 被拒时改用
 * copyFile(COPYFILE_EXCL)，EEXIST 语义与 link 完全一致（外层仍据此 return false），
 * 因此不能像 materializePosix 那样用 rename 覆盖。
 */
const SESSION_PUBLISH_EXCLUSIVE_OLD = [
	"\ttry {",
	"\t\tawait internals.fs.link(staged, currentPath);",
	"\t} catch (error) {",
	"\t\t/* v8 ignore else -- a non-collision filesystem error propagates unchanged. */",
	"\t\tif (isEEXIST(error)) return false;",
	"\t\t/* v8 ignore next -- the filesystem error is already complete. */",
	"\t\tthrow error;",
	"\t}",
].join("\n");

const SESSION_PUBLISH_EXCLUSIVE_NEW = [
	"\t/* " + MARK + " 无硬链接的文件系统（Android SELinux 禁 link(2)）改用 copyFile(COPYFILE_EXCL) 完成 no-replace 发布：EEXIST 语义与 link 一致。 */",
	"\ttry {",
	"\t\ttry {",
	"\t\t\tawait internals.fs.link(staged, currentPath);",
	"\t\t} catch (error) {",
	"\t\t\tif (!isHardLinkUnavailable(error)) throw error;",
	"\t\t\tawait copyFile(staged, currentPath, fsConstants.COPYFILE_EXCL);",
	"\t\t}",
	"\t} catch (error) {",
	"\t\t/* v8 ignore else -- a non-collision filesystem error propagates unchanged. */",
	"\t\tif (isEEXIST(error)) return false;",
	"\t\t/* v8 ignore next -- the filesystem error is already complete. */",
	"\t\tthrow error;",
	"\t}",
].join("\n");

const WALK_HELPER = [
	"/**",
	" * " + MARK + " 同 syncDirectory，但容忍内核拒绝打开的祖先目录：Android SELinux 禁止 app open 应用前缀之上的系统目录（EACCES）。",
	" * 拿不到句柄就没有可同步的东西，跳过无害；应用自身的目录仍会照常 fsync。",
	" */",
	"async function syncDirectoryTolerant(path) {",
	'\tif (process.platform === "win32") return;',
	"\ttry {",
	"\t\tawait syncDirectory(path);",
	"\t} catch (error) {",
	'\t\tif (error && (error.code === "EACCES" || error.code === "EPERM" || error.code === "ENOSYS")) return;',
	"\t\tthrow error;",
	"\t}",
	"}",
].join("\n");

const LINK_FALLBACK_HELPERS = [
	"/** " + MARK + " link(2) 被拒绝或不支持的错误码：Android SELinux 全局禁硬链接（EACCES），部分 FUSE 挂载未实现（ENOSYS/ENOTSUP）。 */",
	"function isHardLinkUnavailable(error) {",
	'\treturn error instanceof Error && typeof error.code === "string" && (error.code === "EACCES" || error.code === "EPERM" || error.code === "EMLINK" || error.code === "ENOSYS" || error.code === "ENOTSUP" || error.code === "EOPNOTSUPP");',
	"}",
	"/**",
	" * " + MARK + " 无硬链接的 no-replace 发布回退：先用 O_CREAT|O_EXCL 原子占位（EEXIST 表示并发创建者已抢先），",
	" * 再用同目录 rename 原子填充。占位与填充之间崩溃会留下空占位文件，已在错误路径尽力清理。",
	" */",
	"async function publishNoReplaceNoHardlink(tempPath, absolutePath, displayPath) {",
	"\tlet guard;",
	"\ttry {",
	'\t\tguard = await open(absolutePath, "wx", 384);',
	"\t} catch (error) {",
	'\t\tif (isEEXIST(error)) throw new FsError(`cannot overwrite existing "${displayPath}" without reading it first`, "FS_NOT_OBSERVED", { cause: error });',
	"\t\tthrow new FsError(`cannot write \"${displayPath}\": ${errorMessage(error)}`, \"FS_IO_ERROR\", { cause: error });",
	"\t}",
	"\ttry {",
	"\t\tawait guard.close();",
	"\t\tawait rename(tempPath, absolutePath);",
	"\t} catch (error) {",
	"\t\tawait rm(absolutePath, { force: true }).catch(() => {});",
	"\t\tthrow error;",
	"\t}",
	"}",
].join("\n");

const LINK_FALLBACK_BLOCK_OLD = [
	"\t\tif (createIfAbsent !== void 0) try {",
	"\t\t\tawait linkFile(tempPath, absolutePath);",
	"\t\t} catch (error) {",
	"\t\t\tawait throwGuardedCreateFailure(error, absolutePath, createIfAbsent.displayPath, inspectPublicationTarget);",
	"\t\t}",
].join("\n");

const LINK_FALLBACK_BLOCK_NEW = [
	"\t\tif (createIfAbsent !== void 0) try {",
	"\t\t\tawait linkFile(tempPath, absolutePath);",
	"\t\t} catch (error) {",
	"\t\t\t/* " + MARK + " 拒绝 link(2) 的文件系统（Android SELinux、部分 FUSE）回退到无硬链接的 no-replace 发布。 */",
	"\t\t\tif (isHardLinkUnavailable(error)) await publishNoReplaceNoHardlink(tempPath, absolutePath, createIfAbsent.displayPath);",
	"\t\t\telse await throwGuardedCreateFailure(error, absolutePath, createIfAbsent.displayPath, inspectPublicationTarget);",
	"\t\t}",
].join("\n");

/** 前端回车补丁的锚点（0.2.0：Lexical registerCommand 的 Enter 处理器）。 */
const ENTER_OLD = [
	"\t\t\t\tevent?.preventDefault();",
	"\t\t\t\tif (event?.repeat === true) return true;",
	"\t\t\t\tif (!handlers.canSubmit()) return true;",
	"\t\t\t\thandlers.submit(event?.ctrlKey === true || event?.metaKey === true);",
].join("\n");

const ENTER_NEW = [
	"\t\t\t\t/* " + MARK + " 普通回车换行，Ctrl/Cmd+Enter 发送 */",
	"\t\t\t\tif (event?.ctrlKey !== true && event?.metaKey !== true) return false;",
	"\t\t\t\tevent?.preventDefault();",
	"\t\t\t\tif (event?.repeat === true) return true;",
	"\t\t\t\tif (!handlers.canSubmit()) return true;",
	"\t\t\t\thandlers.submit(true);",
].join("\n");

const PATCHES = [
	{
		id: "require-builtin-shim",
		label: "node-addon-require-builtin 纯 JS shim（Android 无原生绑定）",
		file: (root) => path.join(root, "node_modules/node-addon-require-builtin/lib/index.js"),
		done: (src) => src.includes("dsh-android-js-shim"),
		apply: () => SHIM_SOURCE,
	},
	{
		id: "session-persistence",
		label: "会话日志发布 link -> 无硬链接回退（rename / copyFile EXCL）",
		file: (root) => path.join(root, "node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js"),
		done: (src) => src.includes("isHardLinkUnavailable") && src.includes("await rename(tmp, finalPath);"),
		apply(src) {
			// 注意：不能把 link 从 import 里删掉 —— defaultFileSystem 这个依赖注入
			// 默认对象里以 `link,` 形式裸引用它（0.2.0 新增），删掉会导致模块导入即
			// ReferenceError: link is not defined。
			const edited = applyEdits(src, [
				// site A：materializePosix —— 临时文件随发布被消耗（后续 rm 均带 force:true），rename 等价替代
				["\t\t\tawait link(tmp, finalPath);", "\t\t\tawait rename(tmp, finalPath);"],
				// site B：publishCurrentExclusive —— 必须保留 EEXIST=并发创建者已抢先
				[SESSION_PUBLISH_EXCLUSIVE_OLD, SESSION_PUBLISH_EXCLUSIVE_NEW],
			]);
			if (!edited.ok) return edited;
			let out = fixFsPromisesImport(edited.src, { add: ["copyFile", "link", "rename"] });
			// 该文件已从 node:zlib 导入 `constants`（zstd 参数用），故 fs 常量必须用别名，
			// 否则 "Identifier 'constants' has already been declared"。
			out = fixNodeImport(out, "node:fs", { add: ["constants as fsConstants"] });
			const anchor = "function isEEXIST(error) {";
			if (!out.includes(anchor)) return { ok: false, reason: "未找到 isEEXIST 锚点" };
			out = out.replace(anchor, HARDLINK_HELPER + "\n" + anchor);
			return { ok: true, src: out };
		},
	},
	{
		id: "attachment-local",
		label: "附件发布 link -> copyFile(COPYFILE_EXCL) + 祖先遍历容忍",
		file: (root) => path.join(root, "node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js"),
		done: (src) => src.includes("syncDirectoryTolerant") && !src.includes("await link("),
		apply(src) {
			const edited = applyEdits(src, [
				["\t\t\tawait link(source, target);", "\t\t\tawait copyFile(source, target, constants.COPYFILE_EXCL);"],
				["\t\t\tawait link(staged.path, target);", "\t\t\tawait copyFile(staged.path, target, constants.COPYFILE_EXCL);"],
				["\t\tawait syncDirectory(parent);", "\t\tawait syncDirectoryTolerant(parent);"],
				["\t\t\tawait syncDirectory(level);", "\t\t\tawait syncDirectoryTolerant(level);", 2],
			]);
			if (!edited.ok) return edited;
			let out = fixFsPromisesImport(edited.src, { add: ["copyFile"], remove: ["link"] });
			const anchor = "async function syncDirectory(path) {";
			if (!out.includes(anchor)) return { ok: false, reason: "未找到 syncDirectory 定义锚点" };
			out = out.replace(anchor, WALK_HELPER + "\n\n" + anchor);
			return { ok: true, src: out };
		},
	},
	{
		id: "fs-local-no-hardlink",
		label: "write 工具新建文件：link 被拒时回退无硬链接 no-replace 发布",
		file: (root) => path.join(root, "node_modules/@deepseek-ai/dsh-fs-local/lib/index.js"),
		done: (src) => src.includes("publishNoReplaceNoHardlink"),
		apply(src) {
			if (!src.includes(LINK_FALLBACK_BLOCK_OLD)) return { ok: false, reason: "未找到 createIfAbsent linkFile 块锚点" };
			let out = src.replace(LINK_FALLBACK_BLOCK_OLD, LINK_FALLBACK_BLOCK_NEW);
			const anchor = "async function writeFileAtomic(";
			if (!out.includes(anchor)) return { ok: false, reason: "未找到 writeFileAtomic 锚点" };
			out = out.replace(anchor, LINK_FALLBACK_HELPERS + "\n\n" + anchor);
			return { ok: true, src: out };
		},
	},
	{
		id: "client-ui-enter",
		label: "作曲栏 普通回车=换行 / Ctrl+Enter=发送",
		file: (root) => path.join(root, "node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js"),
		done: (src) => src.includes("普通回车换行，Ctrl/Cmd+Enter 发送"),
		apply(src) {
			return applyEdits(src, [[ENTER_OLD, ENTER_NEW]]);
		},
	},
];

// ------------------------------------------------------------------ 主流程
function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log("用法: node patch-dsh-android-0.2.js [--install <dsh 包目录>]");
		return 0;
	}
	const root = path.resolve(args.install);
	console.log(`${MARK} dsh 0.2.0 Android 补丁集`);
	console.log(`  安装目录: ${root}`);
	if (!fs.existsSync(path.join(root, "package.json"))) {
		console.error(`  [FAIL] 不是 dsh 包目录（缺 package.json）`);
		return 1;
	}
	const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
	console.log(`  dsh 版本: ${version}\n`);

	let mismatched = 0;
	for (const patch of PATCHES) {
		const file = patch.file(root);
		const src = readIfExists(file);
		if (src === void 0) {
			console.log(`  [FAIL] ${patch.label}\n         找不到文件: ${file}`);
			mismatched += 1;
			continue;
		}
		if (patch.done(src)) {
			console.log(`  [skip] ${patch.label}（已就位）`);
			continue;
		}
		const result = patch.apply(src);
		if (!result.ok) {
			console.log(`  [FAIL] ${patch.label}\n         ${result.reason}（dsh 版本不匹配？请人工检查）`);
			mismatched += 1;
			continue;
		}
		fs.writeFileSync(file, result.src);
		console.log(`  [ok]   ${patch.label}`);
	}

	console.log(`\n${MARK} 完成：${PATCHES.length - mismatched}/${PATCHES.length} 就位，${mismatched} 项需人工检查`);
	return mismatched === 0 ? 0 : 1;
}

process.exitCode = main();
