// myna —— pi 的极简 Electron 前端
// 依赖：只有 electron。pi 通过 `pi --mode rpc` 子进程接入，不引入 pi 的 npm 包。
import { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, screen, Tray, Menu, Notification, nativeImage } from "electron";
import { spawn, execSync, execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, renameSync, openSync, readSync, closeSync, watch, unlinkSync, appendFileSync, realpathSync, copyFileSync } from "node:fs";
import { join, sep, resolve, extname, basename, dirname, delimiter as pathSep } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { sanitizePiEnv } from "./src/core/pi-env.js";
import { copyThinkingLevelMap, normalizeThinkingLevelMap, hasThinkingLevelMap } from "./src/core/thinking-level-map.js";

const T0 = Date.now();

// 自定义协议：让 ES module / fetch 在渲染层可用（file:// 会被 CORS 拦）
protocol.registerSchemesAsPrivileged([
	{
		scheme: "app",
		privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
	},
]);

const SESSIONS_ROOT = join(homedir(), ".pi", "agent", "sessions");
// 改名 myna 后继续用旧的 userData：localStorage 里的草稿、队列、统计、偏好都在里面
try {
	const legacyData = join(app.getPath("appData"), "pi-mini");
	app.setPath("userData", existsSync(legacyData) ? legacyData : join(app.getPath("appData"), "myna"));
} catch {}
const LOG_FILE = join(homedir(), "AppData", "Local", "Temp", "pi-mini.log");
// 右栏文件预览的限制：文本只读前 512KB，图片上限 12MB
const PREVIEW_TEXT_MAX = 512 * 1024;
const PREVIEW_IMAGE_MAX = 12 * 1024 * 1024;
const PREVIEW_IMAGE_MIME = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".bmp": "image/bmp",
	".ico": "image/x-icon",
	".avif": "image/avif",
};
// 应用状态改名 myna；首次启动从旧文件复制（旧文件保留作备份）
// 端到端测试用独立的状态文件，不污染用户真实的窗口/会话指针
let STATE_FILE = join(homedir(), process.env.PI_MINI_E2E ? ".myna-e2e.json" : ".myna.json");
const STATE_LEGACY = join(homedir(), ".pi-mini.json");
if (!existsSync(STATE_FILE) && existsSync(STATE_LEGACY)) {
	try {
		copyFileSync(STATE_LEGACY, STATE_FILE);
	} catch {}
}
if (!existsSync(STATE_FILE) && existsSync(STATE_LEGACY)) STATE_FILE = STATE_LEGACY;

function log(...args) {
	const line = args
		.map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
		.join(" ");
	try {
		appendFileSync(LOG_FILE, `${new Date().toISOString().slice(11, 19)} ${line}
`);
	} catch {}
}

let win = null;
let tray = null;
// 真正退出中：窗口 close 放行、window-all-closed 不再兜底
let quitting = false;
// 流式回合已确认「仍然退出」：避免 before-quit 反复弹窗
let quitConfirmed = false;
// 正在确认退出：挡住并发的 app.quit() 重入
let quitPending = false;

// 单实例：两个实例同时跑 pi 会写同一个 session 文件，直接拒绝第二个进程
// 端到端测试是特例：要独占启动，不能被用户正开着的实例挤掉。
const IS_E2E = Boolean(process.env.PI_MINI_E2E);
// e2e 期间当前场景名 + 被拦截的 prompt（避免测试真的调用模型）
let e2eScenario = "";
let e2eCapturedPrompt = null;
if (!IS_E2E && !app.requestSingleInstanceLock()) {
	app.exit(0);
} else if (!IS_E2E) {
	// 第二个实例直接把隐藏到托盘的窗口拉回来
	app.on("second-instance", () => showMainWindow());
}
let child = null;
let piReady = false;
let buffer = "";
let seq = 0;
const waiting = new Map();

function loadState() {
	try {
		return JSON.parse(readFileSync(STATE_FILE, "utf8"));
	} catch {
		return {};
	}
}

function saveState(patch) {
	try {
		writeFileSync(STATE_FILE, JSON.stringify({ ...loadState(), ...patch }));
	} catch {}
}

let currentCwd = (() => {
	const saved = loadState().cwd;
	return typeof saved === "string" && saved && existsSync(saved) ? saved : homedir();
})();
// 界面缩放：0.7–1.6，持久化到 ~/.pi-mini.json
let zoomFactor = (() => {
	const saved = Number(loadState().zoom);
	return Number.isFinite(saved) && saved >= 0.7 && saved <= 1.6 ? saved : 1;
})();
// 渲染层当前打开的会话文件：持久化到 ~/.pi-mini.json，主进程重启也能续上
// （否则 relaunch 后 startPi 会开新会话，renderer 又把 lastSession 覆盖成空会话）
let activeSessionFile = (() => {
	const saved = loadState().sessionFile;
	return typeof saved === "string" && saved && existsSync(saved) ? saved : null;
})();
function resumeSessionFile() {
	return activeSessionFile && existsSync(activeSessionFile) ? activeSessionFile : null;
}

// 直接解析会话文件，不依赖 pi 子进程——用于启动时先画历史，避免长时间白屏
function readSessionMessages(path, maxLines = 240) {
	const out = [];
	let raw;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return out;
	}
	const lines = raw.split("\n");
	// 只要最近的部分：首屏渲染用不到全部历史，全量 JSON.parse 在大会话上要几百毫秒
	const from = Math.max(0, lines.length - maxLines);
	for (const line of lines.slice(from)) {
		if (!line.startsWith("{")) continue;
		let rec;
		try {
			rec = JSON.parse(line);
		} catch {
			continue;
		}
		if (rec?.type !== "message" || !rec.message) continue;
		const m = rec.message;
		if (!m.role) continue;
		out.push({ role: m.role, content: m.content, timestamp: m.timestamp, toolCallId: m.toolCallId });
	}
	return out;
}

// ---------- pi cli 定位 ----------
// 便携版自带一份 pi（bundle 自包含 + jiti），用户不需要自己装；找不到时才回退到全局安装
function bundledPiCli() {
	// 安装版走 extraResources（resources/pi），便携版走 app/node_modules
	const candidates = [
		process.resourcesPath ? join(process.resourcesPath, "pi", "dist", "bundle", "cli.js") : "",
		join(import.meta.dirname, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
	];
	for (const p of candidates) if (p && existsSync(p)) return p;
	return null;
}

function piInstallHint() {
	return [
		"没有找到 pi。",
		"",
		"在终端里执行下面这行，装完点「重试」：",
		"",
		"npm install -g @earendil-works/pi-coding-agent",
	].join("\n");
}

function resolvePiCli() {
	if (process.env.PI_CLI && existsSync(process.env.PI_CLI)) return process.env.PI_CLI;
	const bundled = bundledPiCli();
	if (bundled) return bundled;
	const roots = [];
	try {
		roots.push(execSync("npm root -g", { encoding: "utf8", windowsHide: true }).trim());
	} catch {}
	if (process.env.APPDATA) roots.push(join(process.env.APPDATA, "npm", "node_modules"));
	for (const root of roots) {
		const p = join(root, "@earendil-works", "pi-coding-agent", "dist", "cli.js");
		if (existsSync(p)) return p;
	}
	return null;
}

// ---------- 子进程与 JSONL 分帧 ----------
function send(channel, payload) {
	if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function stopPi() {
	if (!child) return;
	piReady = false;
	try {
		child.stdin.end();
		child.kill();
	} catch {}
	child = null;
	for (const [id, w] of waiting) {
		w.reject(new Error("pi 进程已停止"));
		waiting.delete(id);
	}
}

function onLine(line) {
	if (!line.trim()) return;
	let rec;
	try {
		rec = JSON.parse(line);
	} catch {
		return;
	}
	if (rec.type === "response") {
		const w = waiting.get(rec.id);
		if (!w) return;
		waiting.delete(rec.id);
		if (rec.success) w.resolve(rec.data ?? {});
		else w.reject(new Error(rec.error || "命令失败"));
		return;
	}
	send("pi:event", rec);
}

function onData(chunk) {
	buffer += chunk;
	let i;
	while ((i = buffer.indexOf("\n")) >= 0) {
		let line = buffer.slice(0, i);
		buffer = buffer.slice(i + 1);
		if (line.endsWith("\r")) line = line.slice(0, -1);
		onLine(line);
	}
}

function startPi(cwd, sessionFile = null) {
	stopPi();
	const cli = resolvePiCli();
	if (!cli) throw new Error(piInstallHint());
	const resume = sessionFile && existsSync(sessionFile) ? sessionFile : null;
	currentCwd = cwd;
	saveState({ cwd });
	buffer = "";
	piReady = false;
	const args = [cli, "--mode", "rpc"];
	if (resume) args.push("--session", resume);
	log("[pi] spawn", resume ? "resume " + resume : "new session");
	const env = sanitizePiEnv(process.env);
	// 安装版把 jiti 放在 resources/pi/lib（extraResources 会过滤 node_modules），
	// bundle 里 require("jiti") 靠 NODE_PATH 找到它
	if (process.resourcesPath) {
		const libDir = join(process.resourcesPath, "pi", "lib");
		if (existsSync(libDir)) env.NODE_PATH = [libDir, env.NODE_PATH].filter(Boolean).join(pathSep);
	}
	const proc = spawn("node", args, {
		cwd,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
		env,
	});
	child = proc;
	proc.stdout.setEncoding("utf8");
	proc.stdout.on("data", (d) => {
		if (child === proc) onData(d);
	});
	proc.stderr.setEncoding("utf8");
	proc.stderr.on("data", (d) => {
		const text = String(d);
		// pi 的 stderr 里有崩溃/配置错误的真正原因，必须落进日志，否则只能看到「退出码 1」
		log("[pi:stderr]", text.trim().slice(0, 1200));
		send("pi:stderr", text);
	});
	// 没有 'error' 监听时，写已关闭的 stdin 会抛 EPIPE 直接崩主进程
	proc.stdin.on("error", () => {});
	proc.on("error", (error) => {
		// 没有 error 监听时，spawn 失败会直接掀掉主进程（Electron 里就是整个窗口消失）。
		const wasCurrent = child === proc;
		if (wasCurrent) {
			child = null;
			piReady = false;
		}
		log("[pi] spawn error", error.message);
		if (wasCurrent) send("pi:event", { type: "error", message: `pi 启动失败：${error.message}` });
	});
	proc.on("exit", (code) => {
		// 死进程必须及时让位：否则后续命令会写进已关闭的 stdin（EPIPE/「pi 进程已停止」）
		const wasCurrent = child === proc;
		if (wasCurrent) {
			child = null;
			piReady = false;
		}
		// 只让死进程自己的命令失败，别误伤刚切过来的新进程
		for (const [id, w] of waiting) {
			if (w.proc !== proc) continue;
			w.reject(new Error("pi 进程已停止"));
			waiting.delete(id);
		}
		// 旧进程的 exit 可能晚于新进程的 spawn；无条件清 buffer 会吃掉新进程的首包。
		if (wasCurrent) buffer = "";
		// 让渲染层能收掉流式光标并提示（下一条命令会经 ensureReady 自动重启）
		if (wasCurrent) send("pi:event", { type: "process_exit", code: Number.isFinite(code) ? code : null });
	});
}

function command(cmd, timeoutMs = 60000) {
	const proc = child;
	if (!proc) return Promise.reject(new Error("pi 未启动"));
	const id = `r${++seq}`;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			waiting.delete(id);
			reject(new Error(`命令超时: ${cmd.type}`));
		}, timeoutMs);
		waiting.set(id, {
			proc,
			resolve: (d) => {
				clearTimeout(timer);
				resolve(d);
			},
			reject: (e) => {
				clearTimeout(timer);
				reject(e);
			},
		});
		try {
			// write 回调能快速暴露 EPIPE，不要只等 60s 超时
			proc.stdin.write(`${JSON.stringify({ id, ...cmd })}\n`, (err) => {
				if (!err) return;
				const w = waiting.get(id);
				if (!w) return;
				waiting.delete(id);
				clearTimeout(timer);
				w.reject(new Error("pi 进程已停止"));
			});
		} catch {
			waiting.delete(id);
			clearTimeout(timer);
			reject(new Error("pi 进程已停止"));
		}
	});
}

// 冷启动/relaunch/切 cwd 后，pi 进程要过一会儿才真正响应 RPC。
// 所有会话级调用先等它就绪，避免把命令写进半死进程。
let readyTask = null;
function ensureReady() {
	if (piReady && child) return Promise.resolve();
	if (readyTask) return readyTask;
	readyTask = (async () => {
		// 冷启动前几次给足时间；之后快速失败，避免 UI 静默挂 4 分钟
		for (let i = 0; i < 24; i++) {
			if (!child) startPi(currentCwd, resumeSessionFile());
			try {
				await command({ type: "get_state" }, i < 4 ? 4000 : 1200);
				piReady = true;
				return;
			} catch {}
			// 进程活着但一直不响应：中途重启一次，别把全部 24 次都耗在死进程上
			if (i === 12 && child) stopPi();
			await new Promise((r) => setTimeout(r, 100));
		}
		throw new Error("pi 未就绪");
	})().finally(() => {
		readyTask = null;
	});
	return readyTask;
}

// 会话命令可安全重试一次：进程刚被 stopPi 顶掉时，重启后重发。
async function sessionCall(cmd) {
	await ensureReady();
	try {
		return await command(cmd);
	} catch (e) {
		if (!/进程已停止|未启动|EPIPE/.test(e.message)) throw e;
		startPi(currentCwd, resumeSessionFile());
		await ensureReady();
		return command(cmd);
	}
}

// ---------- 会话索引（读文件头，不解析全文） ----------
function readHead(path, bytes = 65536) {
	let fd;
	try {
		fd = openSync(path, "r");
		const buf = Buffer.alloc(bytes);
		const n = readSync(fd, buf, 0, bytes, 0);
		return buf.subarray(0, n).toString("utf8");
	} catch {
		return "";
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

// 会话没有显式命名时，用第一条用户消息当标题
function firstUserText(head) {
	for (const line of head.split("\n")) {
		if (!line.includes('"role":"user"')) continue;
		try {
			const rec = JSON.parse(line);
			const content = rec?.message?.content;
			const text = Array.isArray(content)
				? content
						.filter((b) => b?.type === "text")
						.map((b) => b.text)
						.join("")
				: typeof content === "string"
					? content
					: "";
			const t = text.replace(/\s+/g, " ").trim();
			if (t) return t.slice(0, 60);
		} catch {}
	}
	return null;
}

// pi 的会话目录名由 cwd 转义而来（反斜杠/斜杠/冒号替换成连字符）
function sessionsDirFor(cwd) {
	const key = String(cwd || "").replace(/[\/:]/g, "-");
	return key ? join(SESSIONS_ROOT, `--${key}--`) : "";
}

function listSessions(perCwd = 20, onlyCwd = null) {
	const out = [];
	if (!existsSync(SESSIONS_ROOT)) return out;
	// 只关心一个工作区时别扫全量目录：切工作区/刷新列表都能少等一截
	const onlyDir = onlyCwd ? sessionsDirFor(onlyCwd) : "";
	const dirs = onlyDir && existsSync(onlyDir) ? [basename(onlyDir)] : readdirSync(SESSIONS_ROOT);
	for (const dir of dirs) {
		const full = join(SESSIONS_ROOT, dir);
		let st;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		if (!st.isDirectory()) continue;
		for (const file of readdirSync(full)) {
			if (!file.endsWith(".jsonl")) continue;
			const path = join(full, file);
			const head = readHead(path);
			const firstLine = head.slice(0, head.indexOf("\n"));
			let header;
			try {
				header = JSON.parse(firstLine);
			} catch {
				continue;
			}
			let name = null;
			const m = head.match(/"type"\s*:\s*"session_info"[^\n]*?"name"\s*:\s*"((?:[^"\\]|\\.)*)"/);
			if (m) {
				try {
					name = JSON.parse(`"${m[1]}"`);
				} catch {}
			}
			out.push({
				path,
				id: header.id,
				cwd: header.cwd,
				timestamp: header.timestamp,
				name,
				title: firstUserText(head),
			});
		}
	}
	// 每个工作区按需加载；默认 20 条，侧栏「加载更多」会请求更大的页
	const byCwd = new Map();
	for (const s of out) {
		const key = s.cwd || "";
		if (!byCwd.has(key)) byCwd.set(key, []);
		byCwd.get(key).push(s);
	}
	const picked = [];
	for (const list of byCwd.values()) {
		list.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
		picked.push(...list.slice(0, perCwd));
	}
	picked.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
	// 路径分隔符与大小写在不同来源上不一致（正/反斜杠、盘符大小写），比较前统一
	const norm = (p) => String(p || "").replace(/\\/g, "/").toLowerCase();
	const filtered = onlyCwd ? picked.filter((x) => norm(x.cwd) === norm(onlyCwd)) : picked;
	return filtered.slice(0, 600);
}

// ---------- 文件索引（输入框 @ 补全，渲染层只拿结果） ----------
// 跳过 .git / node_modules：后者在任意项目里都远超 2000 条上限，会把索引挤满
const FILE_SKIP = new Set([".git", "node_modules"]);
const FILE_LIMIT = 2000;
let fileIndex = { cwd: "", at: 0, files: [], truncated: false };

function scanFiles(root) {
	const files = [];
	let truncated = false;
	const walk = (dir, rel) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
		for (const ent of entries) {
			if (files.length >= FILE_LIMIT) {
				truncated = true;
				return;
			}
			if (FILE_SKIP.has(ent.name)) continue;
			const relPath = rel ? `${rel}/${ent.name}` : ent.name;
			let isDir = ent.isDirectory();
			if (!isDir && ent.isSymbolicLink()) {
				try {
					isDir = statSync(join(dir, ent.name)).isDirectory();
				} catch {
					isDir = false;
				}
			}
			files.push({ path: relPath, dir: isDir });
			if (isDir && !ent.isSymbolicLink()) walk(join(dir, ent.name), relPath);
		}
	};
	walk(root, "");
	return { files, truncated };
}

ipcMain.handle("pi:list-files", async (_e, cwd) => {
	const root = typeof cwd === "string" && cwd && existsSync(cwd) ? cwd : currentCwd;
	const now = Date.now();
	if (fileIndex.cwd !== root || now - fileIndex.at > 5000) {
		fileIndex = { cwd: root, at: now, ...scanFiles(root) };
	}
	return { cwd: fileIndex.cwd, files: fileIndex.files, truncated: fileIndex.truncated };
});

// ---------- 右栏：git 变更与 diff（只读，execFile 避免 shell 注入） ----------
ipcMain.handle("pi:git-changes", async () => {
	try {
		const out = execFileSync("git", ["status", "--porcelain=v1", "-uall", "--no-renames"], {
			cwd: currentCwd,
			encoding: "utf8",
			timeout: 5000,
			windowsHide: true,
		});
		return out
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const st = line.slice(0, 2);
				const path = line.slice(3).replace(/^"(.*)"$/, "$1");
				return { status: st.trim() || "??", staged: st[0] !== " " && st[0] !== "?", path };
			});
	} catch {
		return [];
	}
});

ipcMain.handle("pi:git-diff", async (_e, relPath) => {
	const run = (args) =>
		execFileSync("git", args, {
			cwd: currentCwd,
			encoding: "utf8",
			timeout: 8000,
			windowsHide: true,
			maxBuffer: 4 * 1024 * 1024,
		});
	try {
		const work = run(["diff", "--no-color", "--", String(relPath)]);
		if (work.trim()) return work;
		// 工作区干净时退回已暂存改动，避免「只有 git add 过」的文件点开是空的
		return run(["diff", "--cached", "--no-color", "--", String(relPath)]);
	} catch {
		return "";
	}
});

ipcMain.handle("pi:perf", async () => {
	const m = process.memoryUsage();
	return { uptime: Date.now() - T0, rss: m.rss, heapUsed: m.heapUsed, external: m.external, pid: process.pid };
});

// 界面缩放：Ctrl+= / Ctrl+- / Ctrl+0 和设置里共用
ipcMain.handle("pi:get-zoom", () => ({ factor: zoomFactor }));
ipcMain.handle("pi:set-zoom", (_e, raw) => {
	const wanted = Number(raw);
	if (Number.isFinite(wanted)) {
		zoomFactor = Math.round(Math.min(1.6, Math.max(0.7, wanted)) * 100) / 100;
		saveState({ zoom: zoomFactor });
		if (win && !win.isDestroyed()) {
			try {
				win.webContents.setZoomFactor(zoomFactor);
			} catch {}
		}
	}
	return { factor: zoomFactor };
});

// 设置「关于/扩展」用的只读信息：版本、路径、pi 全局包与本地扩展
ipcMain.handle("pi:app-info", async () => {
	const pi = resolvePiCli();
	let piVersion = "";
	if (pi) {
		try {
			piVersion = JSON.parse(readFileSync(join(pi, "..", "..", "package.json"), "utf8")).version || "";
		} catch {}
	}
	const agentRoot = join(homedir(), ".pi", "agent");
	const readJson = (p, fallback) => {
		try {
			return JSON.parse(readFileSync(p, "utf8"));
		} catch {
			return fallback;
		}
	};
	const settings = readJson(join(agentRoot, "settings.json"), {});
	const packages = Array.isArray(settings.packages) ? settings.packages : [];
	const extensions = [];
	try {
		for (const d of readdirSync(join(agentRoot, "extensions"), { withFileTypes: true })) {
			if (d.isDirectory() && !d.name.startsWith(".")) extensions.push(d.name);
		}
	} catch {}
	return {
		version: app.getVersion(),
		electron: process.versions.electron,
		chrome: process.versions.chrome,
		node: process.versions.node,
		piVersion,
		piCli: pi || "",
		agentRoot,
		logFile: LOG_FILE,
		packages,
		extensions,
	};
});

// 设置「提供商」：读/写 ~/.pi/agent/models.json；apiKey 只回掩码
const MODELS_JSON = join(homedir(), ".pi", "agent", "models.json");
const API_TYPES = new Set(["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"]);

function maskKey(k) {
	const s = String(k || "");
	if (!s) return "";
	if (s.startsWith("$") || s.startsWith("!")) return s;
	return s.length <= 6 ? "••••" : `••••${s.slice(-4)}`;
}

const PROVIDER_KEY = /^[a-z0-9][a-z0-9._-]*$/i;

function readModelsFile() {
	let text = "";
	let raw = null;
	try {
		text = readFileSync(MODELS_JSON, "utf8");
		raw = JSON.parse(text);
	} catch {}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) raw = {};
	if (!raw.providers || typeof raw.providers !== "object" || Array.isArray(raw.providers)) raw.providers = {};
	return { raw, text };
}

function writeModelsFile(raw, previous) {
	if (previous) {
		try {
			const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
			writeFileSync(`${MODELS_JSON}.bak-${stamp}`, previous, "utf8");
		} catch {}
	}
	const tmp = `${MODELS_JSON}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
	renameSync(tmp, MODELS_JSON);
}

// 接受 pi models.schema.json 的思考等级映射；其它高级模型字段按 id 从旧配置保留。
function cleanProviderModels(list, previous, allowEmpty = false) {
	const prev = new Map((Array.isArray(previous) ? previous : []).map((m) => [String(m?.id || ""), m]));
	const seen = new Set();
	const out = [];
	for (const m of Array.isArray(list) ? list : []) {
		const id = String(m?.id || "").trim();
		if (!id) continue;
		if (seen.has(id)) throw new Error(`模型 ID「${id}」重复`);
		seen.add(id);
		const base = prev.get(id) || {};
		const next = { ...base, id };
		const name = String(m?.name || "").trim();
		if (name) next.name = name;
		else delete next.name;
		next.reasoning = Boolean(m?.reasoning);
		const map = copyThinkingLevelMap(m?.thinkingLevelMap ?? base.thinkingLevelMap);
		if (hasThinkingLevelMap(map)) next.thinkingLevelMap = map;
		else delete next.thinkingLevelMap;
		const ctx = Number(m?.contextWindow);
		if (Number.isFinite(ctx) && ctx > 0) next.contextWindow = Math.round(ctx);
		else delete next.contextWindow;
		const max = Number(m?.maxTokens);
		if (Number.isFinite(max) && max > 0) next.maxTokens = Math.round(max);
		else delete next.maxTokens;
		const modalities = Array.isArray(m?.input) ? m.input.filter((x) => x === "text" || x === "image") : null;
		if (modalities && modalities.length) next.input = modalities;
		else if (!Array.isArray(base.input) || !base.input.length) next.input = ["text"];
		out.push(next);
	}
	if (!out.length) {
		if (allowEmpty) return [];
		throw new Error("至少需要一个模型");
	}
	return out;
}

// 从服务商 API 拉模型列表（主进程请求，避开渲染层 CORS；密钥不落日志）
function resolveProviderKey(opts) {
	let key = String(opts?.apiKey || "").trim();
	if (!key && opts?.providerKey) {
		const { raw } = readModelsFile();
		key = String(raw.providers?.[opts.providerKey]?.apiKey || "").trim();
	}
	if (key.startsWith("$")) return process.env[key.slice(1)] || "";
	if (key.startsWith("!")) throw new Error("不支持 !command 形式的密钥，请直接填入或改用 $ENV");
	return key;
}

ipcMain.handle("pi:fetch-models", async (_e, opts = {}) => {
	const base = String(opts.baseUrl || "").trim().replace(/\/+$/, "");
	if (!/^https?:\/\//i.test(base)) throw new Error("先在 Base URL 里填入服务地址（https://…）");
	const api = String(opts.api || "");
	const key = resolveProviderKey(opts);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 12000);
	try {
		let url = `${base}/models`;
		const headers = {};
		if (api === "anthropic-messages") {
			if (key) headers["x-api-key"] = key;
			headers["anthropic-version"] = "2023-06-01";
		} else if (api === "google-generative-ai") {
			if (key) url += `?key=${encodeURIComponent(key)}`;
		} else if (key) {
			headers.authorization = `Bearer ${key}`;
		}
		const res = await fetch(url, { headers, signal: controller.signal });
		const text = await res.text();
		if (!res.ok) throw new Error(`HTTP ${res.status}：${text.slice(0, 160)}`);
		let data = null;
		try {
			data = JSON.parse(text);
		} catch {
			throw new Error("返回内容不是 JSON");
		}
		const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
		const seen = new Set();
		const models = [];
		const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);
		for (const item of list) {
			let id = String(item?.id || item?.name || "").trim();
			if (id.startsWith("models/")) id = id.slice(7);
			if (!id || seen.has(id)) continue;
			seen.add(id);
			const name = String(item?.display_name || item?.displayName || item?.name || "").trim();
			// OpenRouter / Google / Anthropic 等会在列表里带上下文与输出上限
			const top = item?.top_provider || item?.topProvider || {};
			const contextWindow = num(
				item?.context_length ?? item?.context_window ?? item?.contextWindow ?? item?.inputTokenLimit ??
					item?.max_input_tokens ?? item?.maxContextLength ?? top?.context_length,
			);
			const maxTokens = num(
				item?.max_completion_tokens ?? top?.max_completion_tokens ?? item?.max_output_tokens ??
					item?.outputTokenLimit ?? item?.max_tokens ?? item?.maxTokens,
			);
			models.push({ id, name: name && name !== id ? name : "", contextWindow, maxTokens });
			if (models.length >= 300) break;
		}
		return { models, count: models.length, path: `${url.split("?")[0]}` };
	} catch (e) {
		if (e?.name === "AbortError") throw new Error("请求超时（12s）");
		throw e;
	} finally {
		clearTimeout(timer);
	}
});

ipcMain.handle("pi:providers", async () => {
	const { raw } = readModelsFile();
	return {
		path: MODELS_JSON,
		providers: Object.entries(raw.providers).map(([key, p]) => ({
			key,
			name: p?.name || key,
			baseUrl: p?.baseUrl || "",
			api: p?.api || "",
			apiKey: maskKey(p?.apiKey),
			hasKey: Boolean(p?.apiKey),
			models: (Array.isArray(p?.models) ? p.models : []).map((m) => ({
				id: String(m?.id || ""),
				name: String(m?.name || ""),
				reasoning: Boolean(m?.reasoning),
				thinkingLevelMap: normalizeThinkingLevelMap(m?.thinkingLevelMap),
				input: Array.isArray(m?.input) ? m.input : [],
				contextWindow: Number(m?.contextWindow) || 0,
				maxTokens: Number(m?.maxTokens) || 0,
			})),
			modelCount: Array.isArray(p?.models) ? p.models.length : 0,
			overrides: p?.modelOverrides && typeof p.modelOverrides === "object" ? Object.keys(p.modelOverrides).length : 0,
		})),
	};
});

ipcMain.handle("pi:save-provider", async (_e, input) => {
	const key = String(input?.key || "").trim();
	const create = Boolean(input?.create);
	if (!PROVIDER_KEY.test(key)) throw new Error("标识只能包含字母、数字、点、下划线、短横线，且不能以符号开头");
	const baseUrl = String(input?.baseUrl || "").trim();
	const api = String(input?.api || "").trim();
	const typedKey = String(input?.apiKey || "").trim();
	const { raw, text } = readModelsFile();
	const existing = raw.providers[key];
	if (create && existing) throw new Error(`提供商「${key}」已存在`);
	if (!create && !existing) throw new Error(`提供商「${key}」不存在，请刷新后重试`);
	if (create) {
		if (!/^https?:\/\//i.test(baseUrl)) throw new Error("Base URL 必须以 http:// 或 https:// 开头");
		if (!API_TYPES.has(api)) throw new Error("不支持的 API 类型");
	} else {
		// 内置路由可能没有 baseUrl/api，更新时只校验填了的字段
		if (baseUrl && !/^https?:\/\//i.test(baseUrl)) throw new Error("Base URL 必须以 http:// 或 https:// 开头");
		if (api && !API_TYPES.has(api)) throw new Error("不支持的 API 类型");
	}
	const name = String(input?.name || "").trim() || key;
	const apiKey = typedKey || String(existing?.apiKey || "");
	const hadModels = Array.isArray(existing?.models) && existing.models.length > 0;
	const models = cleanProviderModels(input?.models, existing?.models, !create && !hadModels);
	const next = { ...(existing || {}), name };
	if (models.length) next.models = models;
	else delete next.models;
	if (baseUrl) next.baseUrl = baseUrl;
	else delete next.baseUrl;
	if (api) next.api = api;
	else delete next.api;
	if (apiKey) next.apiKey = apiKey;
	else delete next.apiKey;
	raw.providers[key] = next;
	writeModelsFile(raw, text);
	log("[providers] saved", key);
	return { ok: true, path: MODELS_JSON };
});

ipcMain.handle("pi:delete-provider", async (_e, keyRaw) => {
	const key = String(keyRaw || "").trim();
	const { raw, text } = readModelsFile();
	if (!raw.providers[key]) throw new Error(`提供商「${key}」不存在`);
	delete raw.providers[key];
	writeModelsFile(raw, text);
	log("[providers] deleted", key);
	return { ok: true, path: MODELS_JSON };
});

// ---------- 技能与 MCP（~/.pi/agent/skills、~/.pi/agent/mcp.json）----------
const SKILLS_ROOT = join(homedir(), ".pi", "agent", "skills");
const MCP_JSON = join(homedir(), ".pi", "agent", "mcp.json");
const MCP_EXPOSURES = new Set(["codemode", "deferred", "direct", "hidden"]);

function readJsonAny(file) {
	let text = "";
	let raw = null;
	try {
		text = readFileSync(file, "utf8");
		raw = JSON.parse(text);
	} catch {}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) raw = {};
	return { raw, text };
}

function writeJsonAny(file, raw, previous) {
	if (previous) {
		try {
			const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
			writeFileSync(`${file}.bak-${stamp}`, previous, "utf8");
		} catch {}
	}
	const tmp = `${file}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
	renameSync(tmp, file);
}

// SKILL.md 的 YAML frontmatter 只取 name/description；没有 frontmatter 时退回目录名
function readSkillMeta(dir, dirName) {
	let text = "";
	try {
		text = readFileSync(join(dir, "SKILL.md"), "utf8");
	} catch {
		return null;
	}
	let name = dirName;
	let description = "";
	const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (m) {
		for (const line of m[1].split(/\r?\n/)) {
			const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
			if (!kv) continue;
			const key = kv[1].toLowerCase();
			let value = kv[2].trim().replace(/^["']|["']$/g, "");
			if (key === "name" && value) name = value;
			if (key === "description" && value) description = value;
		}
	}
	if (!description) {
		const body = text.replace(/^---[\s\S]*?---/, "").trim();
		const first = body.split(/\r?\n/).find((l) => l.trim().startsWith("#"));
		if (first) description = first.replace(/^#+\s*/, "").trim();
	}
	if (description.length > 200) description = `${description.slice(0, 200)}…`;
	return { name, description, path: join(dir, "SKILL.md") };
}

ipcMain.handle("pi:list-skills", async () => {
	let names = [];
	try {
		names = readdirSync(SKILLS_ROOT, { withFileTypes: true })
			// 技能目录常是 junction/symlink（withFileTypes 会报 isSymbolicLink、isDirectory=false），
			// 因此再 stat 一次确认真是目录。
			.filter((d) => {
				if (d.name.startsWith(".")) return false;
				if (d.isDirectory()) return true;
				if (!d.isSymbolicLink()) return false;
				try {
					return statSync(join(SKILLS_ROOT, d.name)).isDirectory();
				} catch {
					return false;
				}
			})
			.map((d) => d.name);
	} catch {}
	const skills = [];
	for (const n of names.sort((a, b) => a.localeCompare(b))) {
		const meta = readSkillMeta(join(SKILLS_ROOT, n), n);
		if (meta) skills.push(meta);
	}
	return { root: SKILLS_ROOT, skills };
});

ipcMain.handle("pi:list-mcp", async () => {
	const { raw, text } = readJsonAny(MCP_JSON);
	const servers = Object.entries(raw.mcpServers || {}).map(([name, cfg]) => ({
		name,
		description: String(cfg?.description || ""),
		command: String(cfg?.command || ""),
		args: Array.isArray(cfg?.args) ? cfg.args.map(String) : [],
		exposure: String(cfg?.exposure || "codemode"),
		toolExposure: cfg?.toolExposure && typeof cfg.toolExposure === "object" ? cfg.toolExposure : {},
	}));
	return { path: MCP_JSON, text, servers };
});

ipcMain.handle("pi:save-mcp", async (_e, input) => {
	const name = String(input?.name || "").trim();
	const original = String(input?.originalName || "").trim();
	const command = String(input?.command || "").trim();
	const exposure = String(input?.exposure || "codemode").trim();
	const argsRaw = input?.args;
	const args = (Array.isArray(argsRaw) ? argsRaw : String(argsRaw || "").match(/[^\s"]+|"[^"]*"/g) || []).map((a) =>
		String(a).replace(/^"|"$/g, ""),
	);
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error("名称只能包含字母、数字、点、下划线、短横线");
	if (!command) throw new Error("command 不能为空");
	if (!MCP_EXPOSURES.has(exposure)) throw new Error("不支持的 exposure");
	const { raw, text } = readJsonAny(MCP_JSON);
	if (!raw.mcpServers || typeof raw.mcpServers !== "object") raw.mcpServers = {};
	if (original && original !== name && raw.mcpServers[original]) {
		raw.mcpServers[name] = raw.mcpServers[original];
		delete raw.mcpServers[original];
	}
	const prev = raw.mcpServers[name] || {};
	const next = { ...prev, command, args, description: String(input?.description || "").trim(), exposure };
	if (next.toolExposure && !Object.keys(next.toolExposure).length) delete next.toolExposure;
	raw.mcpServers[name] = next;
	writeJsonAny(MCP_JSON, raw, text);
	log("[mcp] saved", name);
	return { ok: true, path: MCP_JSON };
});

ipcMain.handle("pi:delete-mcp", async (_e, nameRaw) => {
	const name = String(nameRaw || "").trim();
	const { raw, text } = readJsonAny(MCP_JSON);
	if (!raw.mcpServers?.[name]) throw new Error(`MCP 服务「${name}」不存在`);
	delete raw.mcpServers[name];
	writeJsonAny(MCP_JSON, raw, text);
	log("[mcp] deleted", name);
	return { ok: true, path: MCP_JSON };
});

// ---------- 终端（非 PTY：一次执行一条命令，流式回传）----------
let termSeq = 0;
const termRuns = new Map();

function termShell() {
	if (process.platform !== "win32") return { cmd: "/bin/sh", args: (c) => ["-c", c] };
	return { cmd: "powershell.exe", args: (c) => ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `$OutputEncoding=[Console]::OutputEncoding=[Text.Encoding]::UTF8;${c}`] };
}

ipcMain.handle("pi:term-run", async (e, input) => {
	const command = String(input?.command || "").trim();
	if (!command) throw new Error("命令为空");
	if (command.length > 8000) throw new Error("命令过长");
	const senderId = e.sender.id;
	for (const [id, run] of termRuns) {
		if (run.senderId === senderId) {
			try {
				run.proc.kill();
			} catch {}
			termRuns.delete(id);
		}
	}
	const cwd = existsSync(currentCwd) ? currentCwd : homedir();
	const runId = `t${++termSeq}`;
	const shellSpec = termShell();
	const proc = spawn(shellSpec.cmd, shellSpec.args(command), {
		cwd,
		windowsHide: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	termRuns.set(runId, { proc, senderId });
	const sender = e.sender;
	const send = (channel, payload) => {
		try {
			if (!sender.isDestroyed()) sender.send(channel, payload);
		} catch {}
	};
	proc.stdout.on("data", (d) => send("pi:term-data", { runId, stream: "stdout", chunk: d.toString("utf8") }));
	proc.stderr.on("data", (d) => send("pi:term-data", { runId, stream: "stderr", chunk: d.toString("utf8") }));
	proc.on("error", (err) => send("pi:term-data", { runId, stream: "stderr", chunk: `${err.message}\n` }));
	proc.on("close", (code) => {
		termRuns.delete(runId);
		send("pi:term-exit", { runId, code: code == null ? -1 : code });
	});
	return { runId };
});

ipcMain.handle("pi:term-kill", async (_e, runIdRaw) => {
	const runId = String(runIdRaw || "");
	const run = termRuns.get(runId);
	if (!run) return { ok: false };
	try {
		run.proc.kill();
	} catch {}
	termRuns.delete(runId);
	return { ok: true };
});


// ---------- IPC ----------
let restorePending = process.env.PI_MINI_SESSION || null;
let relaunching = false;

ipcMain.handle("pi:boot", async () => {
	const tBoot = Date.now();
	if (!child) startPi(currentCwd, resumeSessionFile());
	try {
		await ensureReady();
	} catch (e) {
		log("[boot] pi not ready", e.message, "after", Date.now() - tBoot, "ms");
		// 让渲染层看到真实失败（showBootError 有重试按钮），而不是空白可用态
		throw e;
	}
	const tReady = Date.now();
	// 只在本进程第一次 boot 时恢复指定会话；renderer 热重载后直接用当前会话
	const restore = restorePending;
	restorePending = null;
	const sessions = listSessions();
	const tSessions = Date.now();
	log("[boot] pi ready", tReady - tBoot, "ms; listSessions", tSessions - tReady, "ms; total", tSessions - tBoot, "ms");
	return { cwd: currentCwd, sessions, restore };
});

ipcMain.handle("pi:command", async (_e, cmd) => {
	// 附件场景只验证渲染与出参，不真的把 prompt 发给模型
	if (IS_E2E && (e2eScenario === "attach" || e2eScenario === "doc") && cmd?.type === "prompt") {
		e2eCapturedPrompt = cmd;
		return { disposition: "handled" };
	}
	await ensureReady();
	return command(cmd);
});

// ---------- 版本检查 ----------
// 只读 GitHub 的 latest release，不下载、不替换文件：未签名的静默更新容易被杀软拦
const UPDATE_API = "https://api.github.com/repos/May5921/Myna/releases/latest";
const UPDATE_TTL = 24 * 60 * 60 * 1000;

function cmpVersion(a, b) {
	const pa = String(a).replace(/^v/, "").split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
	const pb = String(b).replace(/^v/, "").split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] || 0) - (pb[i] || 0);
		if (d) return d;
	}
	return 0;
}

async function checkUpdate(force = false) {
	const current = app.getVersion();
	if (IS_E2E) return null;
	const saved = loadState().updateCheck;
	if (!force && saved && Date.now() - saved.at < UPDATE_TTL) {
		return saved.latest ? { current, ...saved, newer: cmpVersion(saved.latest, current) > 0 } : null;
	}
	try {
		const res = await net.fetch(UPDATE_API, {
			headers: { "user-agent": "Myna", accept: "application/vnd.github+json" },
		});
		if (!res.ok) return null;
		const j = await res.json();
		const latest = String(j?.tag_name || "").replace(/^v/, "");
		if (!latest) return null;
		const data = { at: Date.now(), latest, url: j.html_url };
		saveState({ updateCheck: data });
		return { current, ...data, newer: cmpVersion(latest, current) > 0 };
	} catch {
		// 网络不通就不打扰用户，下次启动再试
		return null;
	}
}

ipcMain.handle("myna:check-update", async (_e, force) => checkUpdate(Boolean(force)));

// 切会话时先用本地文件渲染，不必等 pi 就绪
ipcMain.handle("pi:session-messages", async (_e, path) => {
	if (typeof path !== "string" || !path.endsWith(".jsonl") || !existsSync(path)) return null;
	return readSessionMessages(path);
});

// 启动白屏优化：不经过 pi，直接把上次会话的历史交给渲染层
ipcMain.handle("pi:local-history", async () => {
	const path = resumeSessionFile();
	if (!path) return null;
	const messages = readSessionMessages(path);
	if (!messages.length) return null;
	let name = null;
	try {
		const head = readHead(path);
		const m = head.match(/"type"\s*:\s*"session_info"[^\n]*?"name"\s*:\s*"((?:[^"\\]|\\.)*)"/);
		if (m) name = JSON.parse(`"${m[1]}"`);
	} catch {}
	return { path, name, messages, cwd: currentCwd };
});

// 扩展 UI 响应不走 command()：它没有请求 id、也不需要等待 response
ipcMain.handle("pi:send-raw", async (_e, payload) => {
	if (!child || !payload || typeof payload !== "object") return false;
	try {
		child.stdin.write(`${JSON.stringify(payload)}\n`);
		return true;
	} catch {
		return false;
	}
});

ipcMain.handle("pi:pick-folder", async () => {
	const res = await dialog.showOpenDialog(win, {
		properties: ["openDirectory"],
		defaultPath: currentCwd,
	});
	if (res.canceled || !res.filePaths.length) return null;
	const previousCwd = currentCwd;
	const previous = activeSessionFile;
	activeSessionFile = null;
	saveState({ sessionFile: null });
	try {
		startPi(res.filePaths[0]);
		await ensureReady();
	} catch (error) {
		// 新目录没起来：cwd 和会话指针都要回滚，并重启旧目录的 pi，
		// 否则界面还显示旧工作区、git/文件/终端却按坏目录跑
		currentCwd = previousCwd;
		activeSessionFile = previous;
		saveState({ cwd: previousCwd, sessionFile: previous });
		try {
			startPi(previousCwd, previous);
		} catch (e) {
			log("[cwd] rollback failed", e.message);
		}
		throw error;
	}
	return { cwd: currentCwd, sessions: listSessions() };
});

// 侧栏点其他工作区：重启 pi 子进程切换 cwd（pi 单进程模型）
ipcMain.handle("pi:set-cwd", async (_e, cwd) => {
	if (typeof cwd !== "string" || !cwd || !existsSync(cwd)) throw new Error("目录不存在");
	const previousCwd = currentCwd;
	const previousSession = activeSessionFile;
	if (cwd !== currentCwd) {
		activeSessionFile = null;
		saveState({ sessionFile: null });
		startPi(cwd);
	}
	try {
		await ensureReady();
	} catch (error) {
		// 新目录没起来：把 cwd/会话指针恢复到切换前
		if (cwd !== previousCwd) {
			currentCwd = previousCwd;
			activeSessionFile = previousSession;
			saveState({ cwd: previousCwd, sessionFile: previousSession });
			startPi(previousCwd, previousSession);
		}
		throw error;
	}
	return { cwd: currentCwd, sessions: listSessions() };
});

ipcMain.handle("pi:sessions", async (_e, opts) => {
	const perCwd = Math.min(200, Math.max(20, Number(opts?.perCwd) || 20));
	// 带 cwd 只扫那一个目录，不重启 pi：切工作区时先出列表，不必等进程就绪
	return listSessions(perCwd, opts?.cwd || null);
});

// 会话内容全文搜索：只扫指定工作区，最近 200 个会话、每个最多读 4MB
ipcMain.handle("pi:search-sessions", async (_e, input) => {
	const query = String(input?.query || "").trim();
	const cwd = String(input?.cwd || currentCwd);
	if (query.length < 2) return { results: [], truncated: false };
	const needle = query.toLowerCase();
	const files = [];
	if (!existsSync(SESSIONS_ROOT)) return { results: [], truncated: false };
	for (const dir of readdirSync(SESSIONS_ROOT)) {
		const full = join(SESSIONS_ROOT, dir);
		let st;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		if (!st.isDirectory()) continue;
		for (const file of readdirSync(full)) {
			if (!file.endsWith(".jsonl")) continue;
			const path = join(full, file);
			const head = readHead(path, 4096);
			const firstLine = head.slice(0, head.indexOf("\n"));
			let header;
			try {
				header = JSON.parse(firstLine);
			} catch {
				continue;
			}
			if (cwd && header.cwd !== cwd) continue;
			let mtime = 0;
			try {
				mtime = statSync(path).mtimeMs;
			} catch {}
			files.push({ path, header, mtime });
		}
	}
	files.sort((a, b) => b.mtime - a.mtime);
	const truncated = files.length > 60;
	const results = [];
	for (const f of files.slice(0, 60)) {
		let text;
		try {
			text = readFileSync(f.path, "utf8");
		} catch {
			continue;
		}
		if (text.length > 2000000) text = text.slice(0, 2000000);
		const lower = text.toLowerCase();
		const at = lower.indexOf(needle);
		if (at < 0) continue;
		const lineStart = text.lastIndexOf("\n", at) + 1;
		let lineEnd = text.indexOf("\n", at);
		if (lineEnd < 0) lineEnd = text.length;
		let role = "";
		let body = text.slice(lineStart, lineEnd);
		try {
			const rec = JSON.parse(body);
			role = rec?.message?.role || "";
			const content = rec?.message?.content;
			const parts = Array.isArray(content) ? content : [{ type: "text", text: content }];
			body = parts
				.filter((p) => p?.type === "text")
				.map((p) => p.text)
				.join(" ");
		} catch {}
		const flat = body.replace(/\s+/g, " ").trim();
		const hit = flat.toLowerCase().indexOf(needle);
		let snippet = hit < 0 ? flat.slice(0, 160) : flat.slice(Math.max(0, hit - 60), hit + 120);
		if (snippet.length > 180) snippet = snippet.slice(0, 177) + "…";
		let name = null;
		const nameMatch = text.match(/"type"\s*:\s*"session_info"[^\n]*?"name"\s*:\s*"((?:[^"\\]|\\.)*)"/);
		if (nameMatch) {
			try {
				name = JSON.parse(`"${nameMatch[1]}"`);
			} catch {}
		}
		results.push({
			path: f.path,
			cwd: f.header.cwd,
			name,
			title: firstUserText(text.slice(0, 65536)),
			role,
			snippet,
			timestamp: f.header.timestamp,
		});
		if (results.length >= 20) break;
	}
	return { results, truncated };
});

ipcMain.handle("pi:open-path", async (_e, path) => {
	if (!path) return false;
	try {
		await shell.openPath(path);
		return true;
	} catch {
		return false;
	}
});

ipcMain.handle("pi:open-external", async (_e, url) => {
	if (!/^https?:\/\//i.test(String(url || ""))) return false;
	try {
		await shell.openExternal(url);
		return true;
	} catch {
		return false;
	}
});

// ---------- shiki 高亮（在主进程跑，渲染层不受 CSP 限制）----------
const LANG_ALIAS = {
	js: "javascript",
	jsx: "jsx",
	ts: "typescript",
	tsx: "tsx",
	sh: "shellscript",
	bash: "shellscript",
	zsh: "shellscript",
	shell: "shellscript",
	py: "python",
	rs: "rust",
	yml: "yaml",
	md: "markdown",
	html: "html",
	json: "json",
	css: "css",
	diff: "diff",
};

let shikiInstance = null;
let shikiLoading = null;

async function getShiki() {
	if (shikiInstance) return shikiInstance;
	if (!shikiLoading) {
		shikiLoading = import("shiki").then(async ({ createHighlighter }) => {
			shikiInstance = await createHighlighter({ themes: ["github-light", "github-dark"], langs: [] });
			return shikiInstance;
		});
	}
	return shikiLoading;
}

ipcMain.handle("pi:highlight", async (_e, items, opts) => {
	if (!Array.isArray(items) || !items.length) return [];
	const theme = opts?.dark ? "github-dark" : "github-light";
	const out = new Array(items.length).fill(null);
	let hl;
	try {
		hl = await getShiki();
	} catch (e) {
		log("[shiki] init failed", e.message);
		return out;
	}
	for (let i = 0; i < items.length; i++) {
		const raw = items[i]?.lang || "";
		const lang = LANG_ALIAS[raw.toLowerCase()] || raw.toLowerCase();
		if (!lang || lang === "text" || lang === "txt" || lang === "plaintext") continue;
		try {
			if (!hl.getLoadedLanguages().includes(lang)) await hl.loadLanguage(lang);
			out[i] = hl.codeToHtml(String(items[i].code || ""), { lang, theme });
		} catch {}
	}
	return out;
});

ipcMain.handle("pi:read-file", async (_e, filePath) => {
	// 右栏预览只允许当前工作区内的文件（和文件树同一范围）；工作区外交给系统程序打开。
	const root = realpathSync(currentCwd);
	const real = realpathSync(resolve(String(filePath || "")));
	if (real !== root && !real.startsWith(root + sep)) throw new Error("文件不在当前工作区");
	const st = statSync(real);
	const base = { path: real, name: basename(real), size: st.size };
	if (st.isDirectory()) return { ...base, kind: "dir" };
	if (!st.isFile()) throw new Error("不是文件");
	const ext = extname(real).toLowerCase();
	base.ext = ext;
	if (PREVIEW_IMAGE_MIME[ext]) {
		if (st.size > PREVIEW_IMAGE_MAX) return { ...base, kind: "binary" };
		return {
			...base,
			kind: "image",
			mime: PREVIEW_IMAGE_MIME[ext],
			data: readFileSync(real).toString("base64"),
		};
	}
	const fd = openSync(real, "r");
	let buf;
	try {
		buf = Buffer.alloc(Math.min(st.size, PREVIEW_TEXT_MAX));
		readSync(fd, buf, 0, buf.length, 0);
	} finally {
		closeSync(fd);
	}
	if (buf.includes(0)) return { ...base, kind: "binary" };
	return { ...base, kind: "text", content: buf.toString("utf8"), truncated: st.size > PREVIEW_TEXT_MAX };
});

ipcMain.handle("pi:switch-session", async (_e, path) => {
	const res = await sessionCall({ type: "switch_session", sessionPath: path });
	if (res?.cancelled) return { cancelled: true };
	// 切换成功后立刻提交指针：后面的 get_messages 若失败触发 sessionCall 重试，
	// 必须从“新会话”恢复，而不是旧会话。
	if (typeof path === "string" && path && existsSync(path)) {
		activeSessionFile = path;
		saveState({ sessionFile: path });
	}
	const history = await sessionCall({ type: "get_messages" });
	const state = await sessionCall({ type: "get_state" });
	return { cancelled: false, messages: history?.messages ?? [], state };
});

ipcMain.handle("pi:new-session", async () => {
	const previous = activeSessionFile;
	activeSessionFile = null;
	saveState({ sessionFile: null });
	try {
		await sessionCall({ type: "new_session" });
	} catch (error) {
		// 新建失败就退回原会话指针，别让下一次重启莫名其妙开新会话
		activeSessionFile = previous;
		saveState({ sessionFile: previous });
		throw error;
	}
	return { sessions: listSessions() };
});

// 渲染层把当前会话文件同步过来；崩溃重启时按它续会话
ipcMain.handle("pi:set-active-session", (_e, path) => {
	activeSessionFile = typeof path === "string" && path && existsSync(path) ? path : null;
	saveState({ sessionFile: activeSessionFile });
	return activeSessionFile;
});

// ---------- 窗口 ----------
// 开发模式：单一目录 watcher —— 渲染文件热重载、main.js 重启、shot.request 自截屏
function startDevWatch() {
	const dir = import.meta.dirname;
	const SOFT_EXT = [".js", ".css", ".html"];
	let timer = null;
	let pending = null;
	let shotBusy = false;

	try {
		watch(dir, { recursive: true }, async (_evt, file) => {
			const name = String(file || "").split(String.fromCharCode(92)).join("/");
			// dist/ 是构建产物，监听它只会造成打包时反复 reload
			if (/(^|\/)(node_modules|\.git|dist)\//.test(name)) return;
			// 静默开发：.dev-quiet 存在时只保留自截屏，编辑文件不再重载/重启，避免打断正在用的会话
			if (name !== "shot.request" && existsSync(join(dir, ".dev-quiet"))) return;
			if (name === "main.js") {
				if (relaunching) return;
				relaunching = true;
				// 编辑器保存常分多次写：等 300ms 内大小/mtime 不再变化再重启，
				// 否则会加载写了一半的 main.js（boot 直接 ReferenceError）。
				let prev = null;
				let stable = 0;
				for (let i = 0; i < 20 && stable < 3; i++) {
					let sig = "";
					try {
						const st = statSync(join(dir, "main.js"));
						sig = `${st.size}:${st.mtimeMs}`;
					} catch {}
					if (sig && sig === prev) stable++;
					else stable = 0;
					prev = sig;
					await new Promise((r) => setTimeout(r, 100));
				}
				log("[dev] main.js changed -> relaunch");
				// app.exit(0) 不触发 before-quit：子进程和托盘必须在这里显式收掉
				stopPi();
				destroyTray();
				app.relaunch();
				app.exit(0);
				return;
			}
			if (name !== "shot.request" && SOFT_EXT.some((ext) => name.endsWith(ext))) {
				pending = name;
				clearTimeout(timer);
				timer = setTimeout(() => {
					log(`[dev] reload <- ${pending}`);
					if (win && !win.isDestroyed()) win.webContents.reload();
				}, 140);
				return;
			}
			if (name === "shot.request") {
				if (!win || win.isDestroyed() || shotBusy) return;
				let want = "";
				try {
					want = readFileSync(join(dir, "shot.request"), "utf8");
				} catch {}
				if (!want.trim()) return;
				shotBusy = true;
				// 截图流程里有十几个分支，任何一处抛未捕获异常都会让 shotBusy 永久为 true，
				// 之后就再也不会响应 shot.request。加一个兜底定时器，正常结束时会清掉。
				const shotGuard = setTimeout(() => {
					if (!shotBusy) return;
					shotBusy = false;
					log("[dev] shot guard released busy flag");
				}, 30000);
				log("[dev] shot start", JSON.stringify(want));
				try {
					unlinkSync(join(dir, "shot.request"));
				} catch {}
				if (want.includes("diff")) {
					try {
						const ready = await win.webContents.executeJavaScript(
							`(async () => { for (let i = 0; i < 160; i++) { if (window.__ready) return true; await new Promise((r) => setTimeout(r, 250)); } return false; })()`,
						);
						log("[dev] shot ready", String(ready));
						if (ready) {
							// noselftest：保留当前会话内容（用于看崩溃/错误等真实状态，不被 selftest 清空）
							if (!want.includes("noselftest")) {
								await win.webContents.executeJavaScript("window.__selftest && window.__selftest()");
								log("[dev] shot selftest done");
							}
							if (want.includes("sug") || want.includes("cmd")) {
								const kind = want.includes("cmd") ? "command" : "file";
								const root = JSON.stringify(import.meta.dirname);
								// 功能模块是动态 import，__ready 之后可能才挂上钩子
								const readyDemo = await win.webContents.executeJavaScript(
									`(async () => { for (let i = 0; i < 40; i++) { if (window.__piSuggestDemo) return true; await new Promise((r) => setTimeout(r, 100)); } return false; })()`,
								);
								if (readyDemo) await win.webContents.executeJavaScript(`window.__piSuggestDemo("${kind}", ${root})`);
								else log("[dev] suggest demo unavailable");
							}
							await new Promise((r) => setTimeout(r, 1500));
						} else {
							log("[dev] selftest skipped: renderer not ready");
						}
					} catch (e) {
						log("[dev] selftest failed", e.message);
					}
				}
				if (want.includes("acts")) {
					try {
						const st = await win.webContents.executeJavaScript(`(() => {
							const rows = [...document.querySelectorAll(".row")];
							let bars = 0;
							for (const r of rows) {
								const a = r.querySelector(":scope > .acts");
								if (a) { a.style.opacity = "1"; a.style.pointerEvents = "auto"; bars++; }
							}
							return JSON.stringify({ rows: rows.length, bars, buttons: document.querySelectorAll(".row > .acts button").length });
						})()`);
						log("[dev] acts", st);
						await win.webContents.executeJavaScript(`(() => {
							const mine = document.querySelector(".row.mine");
							if (mine) mine.scrollIntoView({ block: "center" });
						})()`);
						await new Promise((r) => setTimeout(r, 250));
					} catch (e) {
						log("[dev] acts failed", e.message);
					}
				}
				if (want.includes("tps")) {
					try {
						await win.webContents.executeJavaScript(`(() => {
							const i = document.getElementById("input");
							i.value = "从 1 数到 200，每行一个数字，不要调用工具。";
							i.dispatchEvent(new Event("input", { bubbles: true }));
							i.focus();
							i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
							return true;
						})()`);
						log("[dev] tps prompt sent");
						const samples = [];
						for (let i = 0; i < 60; i++) {
							await new Promise((r) => setTimeout(r, 200));
							const st = await win.webContents.executeJavaScript(`(() => {
								const el = document.querySelector(".row.assistant .tps");
								return JSON.stringify({
									streaming: !!document.querySelector(".caret"),
									text: el?.textContent ?? "",
									rows: document.querySelectorAll(".row").length,
								});
							})()`);
							samples.push(JSON.parse(st));
							if ((samples[samples.length - 1].text || "").includes("tok/s")) break;
						}
						log("[dev] tps", JSON.stringify(samples));
						await win.webContents.executeJavaScript(`(() => {
							const rows = [...document.querySelectorAll(".row.assistant")];
							rows[rows.length - 1]?.scrollIntoView({ block: "start" });
						})()`);
						await new Promise((r) => setTimeout(r, 200));
					} catch (e) {
						log("[dev] tps failed", e.message);
					}
				}
				// 清掉上一张截图留下的 demo 状态（设置弹窗 / 排队 / 附件 / 右栏 / 终端）
				try {
					await win.webContents.executeJavaScript(`(() => {
						const ov = document.querySelector(".settings-overlay");
						if (ov && !ov.hidden) { const g = document.getElementById("settings-btn"); g && g.click(); }
						if (window.__piQueueDemoClear) window.__piQueueDemoClear();
						if (window.__piAttachClear) window.__piAttachClear();
						const t = document.getElementById("rp-toggle");
						if (t && t.getAttribute("aria-expanded") === "true") t.click();
						if (window.__piTermAPI?.isOpen) window.__piTermToggle?.();
					})()`);
				} catch {}
				if (want.includes("old")) {
					try {
						const r = await win.webContents.executeJavaScript(`(async () => {
							const s = (window.__piui?.state?.sessions || []).find((x) => x.id === "01a19de1-8f6f-7244-9b28-241ce9629252");
							if (!s) return "no session";
							const btn = [...document.querySelectorAll("#list .item")].find((b) => (b.title || "").includes(s.path));
							if (!btn) return "no button";
							btn.click();
							return "clicked";
						})()`);
						log("[dev] old session", r);
						for (let i = 0; i < 40; i++) {
							const n = await win.webContents.executeJavaScript(`document.querySelectorAll(".row").length`);
							if (n > 0) break;
							await new Promise((res) => setTimeout(res, 150));
						}
					} catch (e) {
						log("[dev] old failed", e.message);
					}
				}
				if (want.includes("tool")) {
					try {
						const html = await win.webContents.executeJavaScript(`document.querySelector(".tool")?.outerHTML?.slice(0, 1200) || "none"`);
						log("[dev] tool html", String(html));
					} catch (e) {
						log("[dev] tool probe failed", e.message);
					}
				}
				if (want.includes("expand")) {
					try {
						const st = await win.webContents.executeJavaScript(`(() => {
							const p = document.querySelector(".proj");
							const k = p?.nextElementSibling?.classList?.contains("kids") ? p.nextElementSibling : null;
							const before = k?.hidden ?? null;
							if (before === true) p.click();
							return JSON.stringify({ before, after: k?.hidden ?? null, hasProj: !!p });
						})()`);
						log("[dev] expand", st);
						await new Promise((r) => setTimeout(r, 300));
					} catch (e) {
						log("[dev] expand failed", e.message);
					}
				}
				if (want.includes("extui")) {
					try {
						await win.webContents.executeJavaScript(`(async () => {
							const i = document.getElementById("input");
							i.value = "/curator";
							i.dispatchEvent(new Event("input", { bubbles: true }));
							i.focus();
							i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
							return true;
						})()`);
						await new Promise((r) => setTimeout(r, 2500));
					} catch (e) {
						log("[dev] extui failed", e.message);
					}
				}
				if (want.includes("unarch")) {
					try {
						const r = await win.webContents.executeJavaScript(
							"window.__piClearArchive ? (window.__piClearArchive(), 'cleared') : 'missing'",
						);
						log("[dev] unarch", r);
						await new Promise((r) => setTimeout(r, 500));
					} catch (e) {
						log("[dev] unarch failed", e.message);
					}
				}
				if (want.includes("search")) {
					try {
						const st = await win.webContents.executeJavaScript(`(async () => {
							const open = document.querySelector('.side-icon[aria-label="搜索会话"]');
							if (!document.querySelector(".side-search input")) open?.click();
							await new Promise((r) => setTimeout(r, 300));
							const inp = document.querySelector(".side-search input");
							if (!inp) return JSON.stringify({ opened: false });
							inp.value = "pi-mini";
							inp.dispatchEvent(new Event("input", { bubbles: true }));
							await new Promise((r) => setTimeout(r, 1600));
							return JSON.stringify({
								opened: true,
								hits: document.querySelectorAll(".side-hits .hit").length,
								head: document.querySelector(".hits-head")?.textContent || "",
								first: document.querySelector(".hit-snippet")?.textContent?.slice(0, 60) || "",
							});
						})()`);
						log("[dev] search", st);
						await new Promise((r) => setTimeout(r, 300));
					} catch (e) {
						log("[dev] search failed", e.message);
					}
				}
				if (want.includes("cmdk")) {
					try {
						const st = await win.webContents.executeJavaScript(`(async () => {
							document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }));
							await new Promise((r) => setTimeout(r, 500));
							const panel = document.querySelector(".cmdk-panel");
							return JSON.stringify({
								open: !!panel && panel.offsetParent !== null,
								items: document.querySelectorAll(".cmdk-item").length,
								title: document.querySelector(".cmdk-title")?.textContent || "",
							});
						})()`);
						log("[dev] cmdk", st);
						await new Promise((r) => setTimeout(r, 300));
					} catch (e) {
						log("[dev] cmdk failed", e.message);
					}
				}
				if (want.includes("term")) {
					try {
						const st = await win.webContents.executeJavaScript(`(async () => {
							if (typeof window.__piTermDemo !== "function") return JSON.stringify({ demo: false });
							window.__piTermDemo();
							await new Promise((r) => setTimeout(r, 1800));
							const term = document.querySelector(".term");
							return JSON.stringify({
								demo: true,
								open: !!term && term.offsetParent !== null,
								lines: document.querySelectorAll(".term-line").length,
								text: (document.querySelector(".term-out")?.textContent || "").slice(-80),
							});
						})()`);
						log("[dev] term", st);
						await new Promise((r) => setTimeout(r, 300));
					} catch (e) {
						log("[dev] term failed", e.message);
					}
				}
				if (want.includes("sess")) {
					try {
						const st = await win.webContents.executeJavaScript(`(async () => {
							const proj = [...document.querySelectorAll(".proj")].find((p) => p.offsetParent !== null);
							const kids = proj?.nextElementSibling;
							if (proj && kids?.hidden) proj.click();
							await new Promise((r) => setTimeout(r, 400));
							const more = [...document.querySelectorAll(".kids .item-more")].find((b) => b.textContent.startsWith("显示更多"));
							more?.click();
							await new Promise((r) => setTimeout(r, 400));
							const before = document.querySelectorAll(".kids .item").length;
							const load = [...document.querySelectorAll(".kids .item-more")].find((b) => b.textContent === "加载更多会话");
							load?.click();
							await new Promise((r) => setTimeout(r, 1500));
							const rowsBefore = document.querySelectorAll(".kids .item").length;
							const target = [...document.querySelectorAll(".kids .srow")].find((r) => !r.querySelector(".item.active"));
							target?.querySelector(".sess-more")?.click();
							await new Promise((r) => setTimeout(r, 200));
							const archBtn = [...document.querySelectorAll(".sess-menu button")].find((b) => b.textContent === "归档");
							archBtn?.click();
							await new Promise((r) => setTimeout(r, 500));
							const head = document.querySelector(".archived-head");
							head?.click();
							await new Promise((r) => setTimeout(r, 500));
							return JSON.stringify({
								proj: !!proj,
								more: !!more,
								load: !!load,
								before,
								after: document.querySelectorAll(".kids .item").length,
								rowsBefore,
								archived: document.querySelectorAll(".archived-kids .item").length,
								head: head?.textContent || "",
							});
						})()`);
						log("[dev] sess", st);
					} catch (e) {
						log("[dev] sess demo failed", e.message);
					}
				}
				if (want.includes("model")) {
					try {
						await win.webContents.executeJavaScript("window.__piQueueDemoClear && window.__piQueueDemoClear()");
						await win.webContents.executeJavaScript("document.querySelector('#menu').hidden = true");
						await win.webContents.executeJavaScript("document.querySelector('#model').click()");
						await new Promise((r) => setTimeout(r, 700));
						if (want.includes("providers")) {
							await win.webContents.executeJavaScript("document.querySelector('#menu .menu-cell')?.click()");
							await new Promise((r) => setTimeout(r, 700));
						}
					} catch (e) {
						log("[dev] model demo failed", e.message);
					}
				}
				if (want.includes("queue")) {
					try {
						await win.webContents.executeJavaScript("window.__piQueueDemo && window.__piQueueDemo(2)");
						await new Promise((r) => setTimeout(r, 900));
					} catch (e) {
						log("[dev] queue demo failed", e.message);
					}
				}
				if (want.includes("theme-dark") || want.includes("theme-light") || want.includes("theme-system")) {
					try {
						const mode = want.includes("theme-dark") ? "dark" : want.includes("theme-system") ? "system" : "light";
						const res = await win.webContents.executeJavaScript(`window.__mynaSetTheme && window.__mynaSetTheme(${JSON.stringify(mode)})`);
						log("[dev] theme demo", JSON.stringify(res));
						await new Promise((r) => setTimeout(r, 500));
					} catch (e) {
						log("[dev] theme demo failed", e.message);
					}
				}
				if (want.includes("settings")) {
					try {
						const ready = await win.webContents.executeJavaScript(
							`(async () => { for (let i = 0; i < 80; i++) { if (window.__piSettingsDemo) return true; await new Promise((r) => setTimeout(r, 100)); } return false; })()`,
						);
						log("[dev] settings demo ready", String(ready));
						if (!ready) throw new Error("settings demo unavailable");
						await win.webContents.executeJavaScript("window.__piSettingsDemo()");
						const navKey = want.match(/setnav-([a-z]+)/)?.[1];
						if (navKey) {
							await new Promise((r) => setTimeout(r, 400));
							await win.webContents.executeJavaScript(`document.querySelector('#settings-nav-${navKey}')?.click()`);
						}
						if (want.includes("provopen")) {
							await new Promise((r) => setTimeout(r, 300));
							await win.webContents.executeJavaScript(`document.querySelector('.prov-head')?.click()`);
						}
						if (want.includes("provadd")) {
							await new Promise((r) => setTimeout(r, 300));
							await win.webContents.executeJavaScript(`document.querySelector('.settings-add button')?.click()`);
						}
						if (want.includes("provpreset")) {
							await new Promise((r) => setTimeout(r, 300));
							await win.webContents.executeJavaScript(`document.querySelector('.prov-preset')?.click()`);
						}
						if (want.includes("provmodel")) {
							await new Promise((r) => setTimeout(r, 300));
							await win.webContents.executeJavaScript(`document.querySelector('.prov-model-add')?.click()`);
						}
						// 模型列表在面板下方；需要看思考档位映射时确保面板打开、滚到底，并回报结构
						if (want.includes("scrollend")) {
							await new Promise((r) => setTimeout(r, 400));
							const probe = await win.webContents.executeJavaScript(`(() => {
								const ov = document.querySelector('.settings-overlay');
								if (!ov || ov.hidden) document.getElementById('settings-btn')?.click();
								const body = document.querySelector('.settings-body');
								if (body) body.scrollTop = body.scrollHeight;
								const cells = document.querySelectorAll('.prov-think-cell');
								return JSON.stringify({
									overlay: !!ov && !ov.hidden,
									cells: cells.length,
									first: (cells[0]?.textContent || '').trim().slice(0, 40),
									disabled: document.querySelectorAll('.prov-think-cell .settings-input:disabled').length,
								});
							})()`);
							log("[dev] think map", probe);
							await new Promise((r) => setTimeout(r, 300));
						}
						await new Promise((r) => setTimeout(r, 900));
					} catch (e) {
						log("[dev] settings demo failed", e.message);
					}
				}
				if (/rp-(files|changes|tree)/.test(want)) {
					const tab = want.includes("rp-changes") ? "changes" : want.includes("rp-tree") ? "tree" : "files";
					try {
						const ok = await win.webContents.executeJavaScript(
							`(async () => { for (let i = 0; i < 40; i++) { if (window.__piRightPanelDemo) return true; await new Promise((r) => setTimeout(r, 100)); } return false; })()`,
						);
						if (ok) await win.webContents.executeJavaScript(`window.__piRightPanelDemo("${tab}")`);
						else log("[dev] right panel demo unavailable");
						await new Promise((r) => setTimeout(r, 2000));
						if (want.includes("preview")) {
							const imgMode = want.includes("previewimg");
							const info = await win.webContents.executeJavaScript(`(async () => {
								const rows = [...document.querySelectorAll('.rp-pane .rp-row')];
								const hit = ${imgMode}
									? rows.find((r) => /\\.(png|jpe?g|gif|webp|svg)$/i.test(r.textContent || ""))
									: rows.find((r) => /README|main\\.js|package\\.json/.test(r.textContent || "")) || rows.find((r) => !r.classList.contains('rp-dir'));
								if (!hit) return JSON.stringify({ clicked: false });
								hit.click();
								await new Promise((r) => setTimeout(r, 1800));
								return JSON.stringify({ clicked: true, head: !!document.querySelector('.rp-file-head'), code: !!document.querySelector('.rp-code'), img: !!document.querySelector('.rp-img'), chars: (document.querySelector('.rp-code')?.textContent || '').length });
							})()`);
							log("[dev] rp preview", info);
						}
					} catch (e) {
						log("[dev] right panel demo failed", e.message);
					}
				}
				if (want.includes("linkprev")) {
					const target = "D:/fangzi/package.json";
					const info = await win.webContents.executeJavaScript(`(async () => {
						const a = document.createElement("span");
						a.className = "flink";
						a.dataset.path = ${JSON.stringify(target)};
						a.textContent = "file";
						document.querySelector("#stream").append(a);
						a.click();
						await new Promise((r) => setTimeout(r, 1800));
						const head = document.querySelector(".rp-file-head .rp-file-name");
						const out = JSON.stringify({ head: head ? head.textContent : "", code: !!document.querySelector(".rp-code"), open: !!document.querySelector("#rp-panel") && document.querySelector("#rp-panel").getBoundingClientRect().width > 100, chars: (document.querySelector(".rp-code")?.textContent || "").length });
						a.remove();
						return out;
					})()`);
					log("[dev] linkprev", info);
				}
				if (want.includes("sbar")) {
					try {
						const r = await win.webContents.executeJavaScript(`(() => {
							const grip = document.querySelector('.sbar-grip');
							const side = document.getElementById('side');
							const root = document.documentElement;
							const before = getComputedStyle(root).getPropertyValue('--sidebar-width').trim();
							const beforeW = Math.round(side?.getBoundingClientRect().width || 0);
							root.style.setProperty('--sidebar-width', '360px');
							const afterW = Math.round(side?.getBoundingClientRect().width || 0);
							root.style.setProperty('--sidebar-width', before || '275px');
							return JSON.stringify({
								grip: !!grip,
								role: grip?.getAttribute('role') || '',
								tabindex: grip?.tabIndex,
								label: grip?.getAttribute('aria-label') || '',
								before,
								beforeW,
								afterW,
								composerRing: getComputedStyle(document.getElementById('input')).outlineStyle,
							});
						})()`);
						log("[dev] sbar", r);
					} catch (e) {
						log("[dev] sbar failed", e.message);
					}
				}
				if (want.includes("perf")) {
					try {
						const perf = await win.webContents.executeJavaScript(`(async () => {
							const t0 = performance.now();
							for (let i = 0; i < 20; i++) await window.pi.command({ type: "get_state" });
							const ipcMs = (performance.now() - t0) / 20;
							const m = await window.pi.perf();
							return JSON.stringify({
								ipcMs: Number(ipcMs.toFixed(2)),
								heapMB: Number(((performance.memory?.usedJSHeapSize || 0) / 1048576).toFixed(1)),
								domNodes: document.querySelectorAll("*").length,
								styles: document.querySelectorAll("style").length,
								mainRssMB: Math.round(m.rss / 1048576),
								mainHeapMB: Math.round(m.heapUsed / 1048576),
								uptimeMs: m.uptime,
							});
						})()`);
						log(`[perf] ${perf}`);
					} catch (e) {
						log("[perf] failed", e.message);
					}
				}
				if (want.includes("dumprows")) {
					try {
						const s = await win.webContents.executeJavaScript(
							`JSON.stringify({ last: localStorage.getItem("pi-mini.lastSession"), cwd: document.getElementById("cwd-name")?.textContent, empty: (document.querySelector(".empty")?.innerText || "").slice(0, 200), streamLen: (document.querySelector("#stream")?.innerText || "").length, summary: document.querySelectorAll(".run-summary").length, rows: [...document.querySelectorAll(".row.assistant")].map(r => ({ a: !!r.querySelector(":scope > .acts"), c: r.className, hc: !!r.querySelector(".caret"), rm: !!r.querySelector(".meta.running"), nx: (r.nextElementSibling?.className || null) })) })`,
						);
						log("[dev] dumprows", s);
					} catch (e) {
						log("[dev] dumprows failed", e.message);
					}
				}
				if (want.includes("mcpcheck")) {
					try {
						const before = await win.webContents.executeJavaScript(`window.pi.listMcp()`);
						const added = await win.webContents.executeJavaScript(
							`window.pi.saveMcp({ name: "pi-mini-test", command: "node", args: ["-e", "process.exit(0)"], description: "temporary probe entry", exposure: "deferred" })`,
						);
						const after = await win.webContents.executeJavaScript(`window.pi.listMcp()`);
						const removed = await win.webContents.executeJavaScript(`window.pi.deleteMcp("pi-mini-test")`);
						const final = await win.webContents.executeJavaScript(`window.pi.listMcp()`);
						const skills = await win.webContents.executeJavaScript(`window.pi.listSkills()`);
						log(
							"[dev] mcpcheck",
							JSON.stringify({
								before: before?.servers?.map?.((s) => s.name) ?? before,
								added: added?.ok ?? added,
								after: after?.servers?.map?.((s) => s.name) ?? after,
								removed: removed?.ok ?? removed,
								final: final?.servers?.map?.((s) => s.name) ?? final,
								skills: (skills?.skills || []).map((s) => s.name),
							}),
						);
					} catch (e) {
						log("[dev] mcpcheck failed", e.message);
					}
				}
				if (want.includes("resumecheck")) {
					try {
						await win.webContents.executeJavaScript(`(() => {
							const i = document.getElementById("input");
							i.value = "我上一条消息让你做什么？只回答原文。";
							i.dispatchEvent(new Event("input", { bubbles: true }));
							i.focus();
							i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
							return true;
						})()`);
						let last = "";
						for (let i = 0; i < 200; i++) {
							await new Promise((r) => setTimeout(r, 300));
							const st = await win.webContents.executeJavaScript(`(() => {
								const rows = [...document.querySelectorAll(".row.assistant")];
								const r = rows[rows.length - 1];
								return JSON.stringify({ streaming: !!document.querySelector(".row.assistant .meta.running, .row.assistant .caret"), text: (r?.innerText || "") });
							})()`);
							const j = JSON.parse(st);
							if (j.text && j.text !== last && !j.streaming) {
								last = j.text;
								log("[dev] resumecheck", JSON.stringify({ text: j.text.slice(0, 300), rows: 0 }));
								break;
							}
						}
					} catch (e) {
						log("[dev] resumecheck failed", e.message);
					}
				}
				if (want.includes("browsertab")) {
					try {
						const r = await win.webContents.executeJavaScript(
							`(async () => {
								const toggle = document.getElementById("rp-toggle");
								if (toggle?.getAttribute("aria-expanded") !== "true") toggle?.click();
								document.getElementById("rp-tab-browser")?.click();
								await new Promise(r => setTimeout(r, 150));
								const input = document.querySelector(".rp-url");
								if (!input) return JSON.stringify({ err: "no url bar" });
								input.value = "file:///C:/Windows/win.ini";
								input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
								await new Promise(r => setTimeout(r, 100));
								const blocked = (document.querySelector(".rp-bnote")?.textContent || "");
								input.value = "http://127.0.0.1:58133/";
								input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
								const t0 = Date.now();
								let wvUrl = "";
								while (Date.now() - t0 < 6000) {
									const wv = document.querySelector("webview");
									try {
										wvUrl = wv?.getURL?.() || "";
									} catch {}
									if (wvUrl) break;
									await new Promise(r => setTimeout(r, 150));
								}
								const wv = document.querySelector("webview");
								let wvUrl2 = "";
								try {
									wvUrl2 = wv?.getURL?.() || "";
								} catch {}
								return JSON.stringify({ hasWv: !!wv, blocked, url: wvUrl2, note: document.querySelector(".rp-bnote")?.textContent || "" });
							})()`,
						);
						log("[dev] browsertab", r);
					} catch (e) {
						log("[dev] browsertab failed", e.message);
					}
				}
				if (want.includes("think")) {
					try {
						await win.webContents.executeJavaScript(`(() => {
							const i = document.getElementById("input");
							i.value = "9.11 和 9.9 哪个大？先认真思考，分两段说明理由，最后只回答数字。";
							i.dispatchEvent(new Event("input", { bubbles: true }));
							i.focus();
							i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
							return true;
						})()`);
						const st = await win.webContents.executeJavaScript(`(async () => {
							let thinkSeen = false, summary = "";
							for (let i = 0; i < 600; i++) {
								const t = document.querySelector(".think");
								if (t) {
									thinkSeen = true;
									summary = t.querySelector(".think-summary")?.textContent || "";
								}
								const s = window.__piui?.state;
								if (s && !s.streaming && thinkSeen) break;
								await new Promise((r) => setTimeout(r, 200));
							}
							const t = document.querySelector(".think");
							t?.scrollIntoView({ block: "end" });
							return JSON.stringify({
								thinkSeen,
								summary,
								open: t?.dataset.open,
								state: t?.dataset.state,
								rows: document.querySelectorAll(".row").length,
							});
						})()`);
						log("[dev] think", st);
						await new Promise((r) => setTimeout(r, 400));
						const opened = await win.webContents.executeJavaScript(`(() => {
							const t = document.querySelector(".think");
							if (!t) return JSON.stringify({ ok: false });
							t.querySelector(".think-row")?.click();
							t.scrollIntoView({ block: "center" });
							const body = t.querySelector(".think-body");
							return JSON.stringify({
								open: t.dataset.open,
								expanded: t.querySelector(".think-row")?.getAttribute("aria-expanded"),
								bodyLen: (body?.textContent || "").length,
								bodyH: body?.getBoundingClientRect().height || 0,
							});
						})()`);
						log("[dev] think open", opened);
						await new Promise((r) => setTimeout(r, 500));
					} catch (e) {
						log("[dev] think failed", e.message);
					}
				}
				if (want.includes("livetool")) {
					try {
						await win.webContents.executeJavaScript(`(() => {
							const i = document.getElementById("input");
							i.value = "用 bash 执行命令：ping -n 8 127.0.0.1";
							i.dispatchEvent(new Event("input", { bubbles: true }));
							i.focus();
							i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
						})()`);
						await new Promise((r) => setTimeout(r, 2600));
						await win.webContents.executeJavaScript(`(() => {
							const rows = [...document.querySelectorAll(".row")];
							rows[rows.length - 1]?.scrollIntoView({ block: "end" });
						})()`);
						const st = await win.webContents.executeJavaScript(
							`JSON.stringify({streaming: !!window.__piui?.state?.streaming, running: document.querySelectorAll(".tool.running").length, tools: document.querySelectorAll(".tool").length, meta: document.querySelector(".row.assistant .meta.running")?.textContent || ""})`,
						);
						log(`[dev] livetool ${st}`);
					} catch (e) {
						log("[dev] livetool failed", e.message);
					}
				}
				if (want.includes("toolfold")) {
					try {
						await win.webContents.executeJavaScript(`(() => {
							const i = document.getElementById("input");
							i.value = "用 bash 执行命令：ping -n 6 127.0.0.1";
							i.dispatchEvent(new Event("input", { bubbles: true }));
							i.focus();
							i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
						})()`);
						await new Promise((r) => setTimeout(r, 1800));
						const before = await win.webContents.executeJavaScript(`(() => {
							const list = [...document.querySelectorAll(".tool")];
							const t = list[list.length - 1];
							t?.querySelector(".hdr")?.click();
							return JSON.stringify({ tools: list.length, open: document.querySelectorAll('.tool[data-open="1"]').length, last: t?.dataset.open });
						})()`);
						let after = "";
						for (let k = 0; k < 80; k++) {
							await new Promise((r) => setTimeout(r, 500));
							after = await win.webContents.executeJavaScript(
								`JSON.stringify({streaming: !!window.__piui?.state?.streaming, open: document.querySelectorAll('.tool[data-open="1"]').length, last: (() => { const a = [...document.querySelectorAll(".tool")]; return a[a.length - 1]?.dataset.open; })()})`,
							);
							if (!/"streaming":true/.test(after)) break;
						}
						log(`[dev] toolfold ${before} -> ${after}`);
						await win.webContents.executeJavaScript(`(() => {
							const rows = [...document.querySelectorAll(".row")];
							rows[rows.length - 1]?.scrollIntoView({ block: "end" });
						})()`);
					} catch (e) {
						log("[dev] toolfold failed", e.message);
					}
				}
				if (want.includes("live") && !want.includes("livetool")) {
					try {
						await win.webContents.executeJavaScript(`(() => {
							const i = document.getElementById("input");
							i.value = "只回复 OK，不要调用工具。";
							i.dispatchEvent(new Event("input", { bubbles: true }));
							i.focus();
							i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
							return true;
						})()`);
						// 等真实回合：先等 streaming 起来，再等 agent_settled / streaming=false
						const settled = await win.webContents.executeJavaScript(`(async () => {
							let started = false;
							for (let i = 0; i < 600; i++) {
								const s = window.__piui?.state;
								if (s?.streaming) started = true;
								else if (started) return true;
								await new Promise((r) => setTimeout(r, 200));
							}
							return started;
						})()`);
						await new Promise((r) => setTimeout(r, 800));
						await win.webContents.executeJavaScript(`(() => {
							const rows = [...document.querySelectorAll(".row.assistant")];
							rows[rows.length - 1]?.scrollIntoView({ block: "end" });
						})()`);
						const counts = await win.webContents.executeJavaScript(
							`JSON.stringify({settled: ${JSON.stringify(settled)}, rows: document.querySelectorAll(".row").length, tools: document.querySelectorAll(".tool").length})`,
						);
						log(`[dev] live ${counts}`);
					} catch (e) {
						log("[dev] live failed", e.message);
					}
				}
				if (want.includes("attach")) {
					try {
						await win.webContents.executeJavaScript("window.__piAttachDemo && window.__piAttachDemo()");
						await new Promise((r) => setTimeout(r, 1500));
					} catch (e) {
						log("[dev] attach demo failed", e.message);
					}
				}
				if (want.includes("booterr")) {
					try {
						await win.webContents.executeJavaScript(`(async () => {
							window.__piBootError && window.__piBootError("找不到 pi 的 cli.js，请确认 pi 已全局安装");
							await new Promise((r) => setTimeout(r, 200));
							document.querySelector(".boot-error")?.scrollIntoView({ block: "center" });
							await new Promise((r) => setTimeout(r, 200));
							return JSON.stringify({ error: !!document.querySelector(".boot-error"), retry: !!document.querySelector(".boot-retry") });
						})()`).then((s) => log("[dev] booterr", s));
					} catch (e) {
						log("[dev] booterr failed", e.message);
					}
				}
				if (want.includes("forkdemo")) {
					try {
						const st = await win.webContents.executeJavaScript(`(async () => {
							const rows = [...document.querySelectorAll(".row.mine")];
							const row = rows.reverse().find((r) => (r.querySelector(":scope > .user")?.textContent || "").includes("只回复")) || rows[0];
							if (!row) return JSON.stringify({ row: false });
							row.scrollIntoView({ block: "center" });
							row.classList.add("acts-on");
							const btn = row.querySelector(':scope > .acts [data-act="fork"]');
							if (!btn) return JSON.stringify({ row: true, btn: false });
							btn.click();
							await new Promise((r) => setTimeout(r, 1600));
							const pop = document.querySelector(".fork-pop");
							const acts = row.querySelector(":scope > .acts");
							return JSON.stringify({
								row: true,
								btn: true,
								pop: pop ? !pop.hidden : false,
								pinned: row.classList.contains("acts-pin"),
								actsOpacity: acts ? getComputedStyle(acts).opacity : "",
							});
						})()`);
						log("[dev] forkdemo", st);
						await new Promise((r) => setTimeout(r, 500));
					} catch (e) {
						log("[dev] forkdemo failed", e.message);
					}
				}
				if (want.includes("lasttext")) {
					try {
						const txt = await win.webContents.executeJavaScript(
							"([...document.querySelectorAll('.row.assistant .body')].pop()?.innerText || '').slice(-200)",
						);
						log("[dev] lasttext", JSON.stringify(txt));
					} catch (e) {
						log("[dev] lasttext failed", e.message);
					}
				}
				if (want.includes("streamparagraphs")) {
					try {
						await win.webContents.executeJavaScript(`(() => {
							const i = document.getElementById("input");
							i.value = "用三段话介绍海洋。每段之间空一行，不要调用工具，不要写标题。";
							i.dispatchEvent(new Event("input", { bubbles: true }));
							i.focus();
							i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
							return true;
						})()`);
						const st = await win.webContents.executeJavaScript(`(async () => {
							let frozen = 0, tailLen = 0, streaming = false;
							for (let i = 0; i < 400; i++) {
								streaming = !!window.__piui?.state?.streaming;
								frozen = document.querySelectorAll(".live-frozen .live-block").length;
								tailLen = (document.querySelector(".live-tail")?.textContent || "").length;
								if (frozen >= 1) break;
								if (!streaming && frozen === 0 && i > 20) break;
								await new Promise((r) => setTimeout(r, 100));
							}
							return JSON.stringify({ frozen, tailLen, streaming });
						})()`);
						log("[dev] streamparagraphs", st);
						await new Promise((r) => setTimeout(r, 300));
					} catch (e) {
						log("[dev] streamparagraphs failed", e.message);
					}
				}
				if (want.includes("meterdemo")) {
					try {
						const started = await win.webContents.executeJavaScript(`!!(window.__piTpsDemo && window.__piTpsDemo(6000))`);
						log("[dev] meterdemo", String(started));
						if (started) {
							await new Promise((r) => setTimeout(r, 2200));
							if (want.includes("metercard")) {
								await win.webContents.executeJavaScript(`document.querySelector(".tps-gauge")?.click()`);
								await new Promise((r) => setTimeout(r, 300));
							}
							setTimeout(() => {
								if (win && !win.isDestroyed()) win.webContents.executeJavaScript("window.__piTpsDemoClear?.()").catch(() => {});
							}, 7000);
						}
					} catch (e) {
						log("[dev] meterdemo failed", e.message);
					}
				}
				if (want.includes("empty")) {
					try {
						await win.webContents.executeJavaScript("document.querySelector('.newchat')?.click()");
						await new Promise((r) => setTimeout(r, 1200));
					} catch (e) {
						log("[dev] empty state failed", e.message);
					}
				}
				if (want.includes("imgdbg")) {
					try {
						const dbg = await win.webContents.executeJavaScript(`(() => {
							const imgs = [...document.querySelectorAll(".tool-img")];
							const before = document.querySelector(".imgbox")?.hidden;
							imgs[0]?.click();
							const b = document.querySelector(".imgbox");
							return JSON.stringify({ n: imgs.length, api: typeof window.__piImageOpen, before, after: b?.hidden, hasBox: !!b, scrolling: window.__piui?.state?.streaming });
						})()`);
						log("[dev] imgdbg", dbg);
						await new Promise((r) => setTimeout(r, 400));
					} catch (e) {
						log("[dev] imgdbg failed", e.message);
					}
				} else if (want.includes("img")) {
					try {
						await win.webContents.executeJavaScript(`(() => {
							const i = document.getElementById("input");
							i.value = "read C:/Users/Luke/projects/pi-mini/live.png 并只回复这个词：ok";
							i.dispatchEvent(new Event("input", { bubbles: true }));
							i.focus();
							i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
							return true;
						})()`);
						const got = await win.webContents.executeJavaScript(`(async () => {
							for (let i = 0; i < 240; i++) {
								if (document.querySelector(".tool-img")) return true;
								await new Promise((r) => setTimeout(r, 250));
							}
							return false;
						})()`);
						await new Promise((r) => setTimeout(r, 700));
						if (want.includes("imgbox")) {
							const st = await win.webContents.executeJavaScript(`(() => {
								const i = document.querySelector(".tool-img");
								i?.click();
								const b = document.querySelector(".imgbox");
								return JSON.stringify({ n: document.querySelectorAll(".tool-img").length, box: !!b, hidden: b?.hidden });
							})()`);
							log("[dev] imgbox", st);
							await new Promise((r) => setTimeout(r, 500));
						}
						log(`[dev] img demo ${got ? "ok" : "timeout"}`);
					} catch (e) {
						log("[dev] img demo failed", e.message);
					}
				}
				try {
					if (win.isMinimized()) win.restore();
					win.showInactive();
					let img = null;
					for (let attempt = 0; attempt < 4 && !img; attempt++) {
						try {
							img = await win.webContents.capturePage();
						} catch (e) {
							log("[dev] capture retry", attempt, e.message);
							await new Promise((r) => setTimeout(r, 250));
						}
					}
					if (!img) throw new Error("capture failed");
					writeFileSync(join(dir, "live.png"), img.toPNG());
					const counts = await win.webContents.executeJavaScript(
						`JSON.stringify({time: document.querySelectorAll(".time").length, tools: document.querySelectorAll(".tool").length, diffs: document.querySelectorAll(".diff").length, shiki: document.querySelectorAll(".shiki").length, links: document.querySelectorAll(".flink").length, xlinks: document.querySelectorAll(".xlink").length, rows: document.querySelectorAll(".row").length, sug: document.querySelectorAll(".sug-item").length, padd: document.querySelectorAll(".proj-add").length})`,
					);
					log(`[dev] shot -> live.png  ${counts}`);
				} catch (e) {
					log("[dev] shot failed", e.message);
				} finally {
					clearTimeout(shotGuard);
					shotBusy = false;
				}
			}
		});
	} catch (e) {
		log("[dev] watch failed", e.message);
	}
	log("[dev] watching for changes");
}

// ---------- 托盘与退出 ----------
const TRAY_ICON = join(import.meta.dirname, "assets", "icon.ico");

function showMainWindow() {
	if (!win || win.isDestroyed()) return;
	if (win.isMinimized()) win.restore();
	if (!win.isVisible()) win.show();
	win.focus();
}

function destroyTray() {
	if (!tray) return;
	try {
		tray.destroy();
	} catch {}
	tray = null;
}

function createTray() {
	if (process.platform !== "win32" || tray) return;
	if (!existsSync(TRAY_ICON)) {
		log("[tray] icon missing", TRAY_ICON);
		return;
	}
	try {
		tray = new Tray(TRAY_ICON);
	} catch (e) {
		log("[tray] create failed", e.message);
		tray = null;
		return;
	}
	tray.setToolTip("myna");
	tray.setContextMenu(
		Menu.buildFromTemplate([
			{ label: "显示主窗口", click: () => showMainWindow() },
			{ type: "separator" },
			{ label: "退出", click: () => app.quit() },
		]),
	);
	// 单击/双击托盘图标都把窗口拉回来
	tray.on("click", () => showMainWindow());
	tray.on("double-click", () => showMainWindow());
	log("[tray] ready");
}

// 首次收进托盘只提示一次：标记落 ~/.myna.json，之后不再打扰
let trayHintShown = loadState().trayHintShown === true;

function notifyHiddenToTray() {
	if (trayHintShown) return;
	trayHintShown = true;
	saveState({ trayHintShown: true });
	const title = "myna";
	const body = "myna 仍在后台运行，可从托盘恢复";
	try {
		if (Notification.isSupported()) {
			const note = new Notification({ title, body, icon: nativeImage.createFromPath(TRAY_ICON) });
			note.on("click", () => showMainWindow());
			note.show();
			return;
		}
	} catch (e) {
		log("[tray] notification failed", e.message);
	}
	try {
		tray?.displayBalloon({ title, content: body });
	} catch {}
}

// 渲染层是否还在生成回复；窗口/渲染进程已销毁时按「没有流式」处理，直接放行退出
function rendererIsStreaming() {
	return new Promise((resolve) => {
		if (!win || win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) return resolve(false);
		let done = false;
		let timer = 0;
		const finish = (v) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve(v);
		};
		// 渲染层卡死时别把退出流程一直挂着
		timer = setTimeout(() => finish(false), 1500);
		try {
			win.webContents.executeJavaScript("window.__piStreaming === true").then(
				(v) => finish(v === true),
				() => finish(false),
			);
		} catch {
			finish(false);
		}
	});
}

async function confirmQuitWhileStreaming() {
	if (!(await rendererIsStreaming())) return true;
	try {
		const options = {
			type: "warning",
			buttons: ["取消", "仍然退出"],
			defaultId: 0,
			cancelId: 0,
			noLink: true,
			title: "myna",
			message: "当前回合还在生成中",
			detail: "退出会中断正在生成的回复，确定要退出吗？",
		};
		// 窗口藏在托盘里时不要把对话框挂到隐藏窗口上，否则用户看不到
		const res = win && !win.isDestroyed() && win.isVisible() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
		return res.response === 1;
	} catch {
		return true;
	}
}

function createWindow() {
	// 窗口位置/大小随上次会话恢复；working area 变了也要保证至少露出一角
	const savedWin = loadState().window;
	const base = { width: 1280, height: 820 };
	if (savedWin && Number.isFinite(savedWin.width) && Number.isFinite(savedWin.height)) {
		const area = screen.getDisplayMatching({ x: savedWin.x ?? 0, y: savedWin.y ?? 0, width: savedWin.width, height: savedWin.height }).workArea;
		base.width = Math.max(720, Math.min(savedWin.width, area.width));
		base.height = Math.max(480, Math.min(savedWin.height, area.height));
		base.x = Math.max(area.x - base.width + 120, Math.min(savedWin.x ?? area.x, area.x + area.width - 120));
		base.y = Math.max(area.y, Math.min(savedWin.y ?? area.y, area.y + area.height - 80));
		log("[window] restore", JSON.stringify({ w: base.width, h: base.height, x: base.x, y: base.y, maximized: !!savedWin.maximized }));
	}
	win = new BrowserWindow({
		...base,
		minWidth: 720,
		minHeight: 480,
		backgroundColor: "#FFFFFF",
		title: "myna",
		icon: join(import.meta.dirname, "assets", "icon.ico"),
		show: false,
		autoHideMenuBar: true,
		webPreferences: {
			preload: join(import.meta.dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
			webviewTag: true, // 右栏浏览器用 <webview>，只允许 http(s)
		},
	});
	// 缩放要在每次导航后重设，否则 did-finish-load 会把 factor 重置回 1
	const applyZoom = () => {
		if (!win || win.isDestroyed()) return;
		try {
			win.webContents.setZoomFactor(zoomFactor);
		} catch {}
	};
	applyZoom();
	win.webContents.on("did-finish-load", applyZoom);
	// 记住窗口几何（拖动/缩放/最大化后 400ms 落盘）
	let boundsTimer = 0;
	const persistBounds = () => {
		clearTimeout(boundsTimer);
		boundsTimer = setTimeout(() => {
			if (!win || win.isDestroyed()) return;
			// 启动阶段的 resize/move 是窗口初始化带出来的，存下来会造成每次启动尺寸漂移
			if (Date.now() - T0 < 4000) return;
			const b = win.getNormalBounds();
			saveState({ window: { width: b.width, height: b.height, x: b.x, y: b.y, maximized: win.isMaximized() } });
		}, 400);
	};
	for (const ev of ["resize", "move", "maximize", "unmaximize"]) win.on(ev, persistBounds);
	// 锁死导航：拖文件到页面空白处不得把窗口导航到 file://（preload 仍会注入）
	win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	win.webContents.on("will-navigate", (e) => e.preventDefault());
	win.loadURL("app://bundle/index.html");
	win.webContents.once("did-finish-load", () => log("[perf] window ready", Date.now() - T0, "ms"));
	win.once("ready-to-show", () => {
		win.show();
		if (savedWin?.maximized) win.maximize();
	});
	// 关窗收进托盘（Windows 主场景）；真退出时放行。
	// 托盘没建起来时保持原行为（关窗即退出），否则窗口隐藏后用户无法恢复。
	win.on("close", (e) => {
		if (quitting) return;
		if (process.platform !== "win32" || !tray) return;
		e.preventDefault();
		win.hide();
		notifyHiddenToTray();
	});
	if (process.env.PI_MINI_DEV) startDevWatch();

	win.webContents.on("console-message", (event) => {
		const { level, message, lineNumber, sourceId } = event;
		if (level === "error" || level === "warning") log(`[renderer:${level}] ${message} (${sourceId}:${lineNumber})`);
	});
	win.webContents.on("preload-error", (_e, path, error) => log("[preload-error]", path, error.message));
	let rendererReloads = 0;
	let rendererReloadTimer = 0;
	win.webContents.on("render-process-gone", (_e, details) => {
		log("[renderer-gone]", JSON.stringify(details));
		if (details.reason === "clean-exit" || !win || win.isDestroyed()) return;
		// 渲染进程偶尔会被 OOM/GPU 杀掉：自动重载一次，频繁崩溃则停止恢复并留日志
		if (rendererReloads >= 3) {
			log("[renderer-gone] 连续重载 3 次，停止自动恢复");
			return;
		}
		rendererReloads++;
		setTimeout(() => {
			if (win && !win.isDestroyed()) win.reload();
		}, 400);
		clearTimeout(rendererReloadTimer);
		rendererReloadTimer = setTimeout(() => {
			rendererReloads = 0;
		}, 60000);
	});
	win.webContents.on("did-fail-load", (_e, code, description, url, isMainFrame) => {
		if (!isMainFrame || code === -3) return;
		log("[did-fail-load]", code, description, url);
	});


	// ---------- 端到端：PI_MINI_E2E=<name,name> 跑完断言就退出，不截图、不调模型 ----------
	const e2eTargets = String(process.env.PI_MINI_E2E || "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (e2eTargets.length) {
		const consoleErrors = [];
		win.webContents.on("console-message", (event) => {
			if (event.level === "error") consoleErrors.push(String(event.message).slice(0, 200));
		});
		const startE2E = () => {
			// 先哨兵一行：管道/时序出问题时，至少能分辨“没启动”和“启动了但结果丢了”
			process.stdout.write(`E2E_START ${e2eTargets.join(",")}\n`);
			log("[e2e] start", e2eTargets.join(","));
			setTimeout(async () => {
				const report = { scenarios: [], ok: true, consoleErrors };
				try {
					const { scenarios } = await import("./scripts/e2e/scenarios.mjs");
					const names = e2eTargets.includes("all")
						? Object.keys(scenarios).filter((n) => !/^debug/.test(n))
						: e2eTargets;
					for (const name of names) {
						const source = scenarios[name];
						if (!source) {
							report.scenarios.push({ name, ok: false, checks: [{ name: "scenario exists", ok: false, detail: name }] });
							report.ok = false;
							continue;
						}
						const started = Date.now();
						e2eScenario = name;
						e2eCapturedPrompt = null;
						try {
							// 图片探针：从真实会话里取第一个 image block 的 base64，交给渲染层试加载
							if (name === "debugImg" || name === "histImage" || name === "debugMine") {
								try {
									const dir = join(homedir(), ".pi", "agent", "sessions", "--C--Users-Luke--");
									let probe = null;
									for (const file of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
										const raw = readFileSync(join(dir, file), "utf8");
										if (!raw.includes('"image"')) continue;
										for (const line of raw.split("\n")) {
											if (!line.includes('"image"')) continue;
											try {
												const rec = JSON.parse(line);
												const blocks = Array.isArray(rec.message?.content) ? rec.message.content : [];
												const b = blocks.find((x) => x?.type === "image" && x.data);
												if (b) {
													probe = { data: b.data, mime: b.mimeType || "image/png", file, sessionPath: join(dir, file) };
													break;
												}
											} catch {}
										}
										if (probe) break;
									}
									await win.webContents.executeJavaScript(
										`window.__e2eImageProbe = ${JSON.stringify(probe)}; true`,
									);
								} catch (e) {
									log("[e2e] image probe failed", e.message);
								}
							}
							// 崩溃恢复场景：先在主进程侧杀掉 pi 子进程，再让渲染层验证自愈
							if (name === "crashRecovery") {
								const pid = child?.pid;
								log("[e2e] killing pi child", String(pid));
								try {
									process.kill(pid);
								} catch (e) {
									log("[e2e] kill failed", e.message);
								}
								await new Promise((r) => setTimeout(r, 1500));
							}
							const checks = await win.webContents.executeJavaScript(source);
							if (name === "doc") {
								const msg = String(e2eCapturedPrompt?.message || "");
								const checks2 = [
									["prompt captured", !!e2eCapturedPrompt],
									["docx text extracted", /季度总结报告/.test(msg) && /63%/.test(msg)],
									["pptx text extracted", /产品路线图/.test(msg) && /稳定性/.test(msg)],
									["xlsx text extracted", /服务器/.test(msg) && /120000/.test(msg)],
									["pdf text extracted", /Quarterly Report 2026/.test(msg) && /Southeast Asia/.test(msg)],
									["filename headers present", /\[report\.docx\]/.test(msg) && /\[notes\.pdf\]/.test(msg)],
									["no images sent", !e2eCapturedPrompt?.images],
								];
								for (const [n, okv] of checks2) checks.push({ name: n, ok: okv, detail: okv ? "" : msg.slice(0, 120) });
							}
							if (name === "attach") {
								const imgs = e2eCapturedPrompt?.images;
								const keys = Array.isArray(imgs) && imgs[0] ? Object.keys(imgs[0]).sort().join(",") : "none";
								checks.push({ name: "prompt intercepted (no model call)", ok: !!e2eCapturedPrompt, detail: (Array.isArray(imgs) ? imgs.length : 0) + " image(s)" });
								checks.push({ name: "RPC payload trimmed", ok: keys === "data,mimeType,type", detail: keys });
							}
							const passed = Array.isArray(checks) && checks.every((c) => c.ok);
							report.scenarios.push({ name, ok: passed, ms: Date.now() - started, checks });
							if (!passed) report.ok = false;
						} catch (err) {
							report.scenarios.push({ name, ok: false, ms: Date.now() - started, checks: [{ name: "throws", ok: false, detail: err.message }] });
							report.ok = false;
						}
					}
				} catch (err) {
					report.ok = false;
					report.error = err.message;
				}
				// 结果同时落盘 + 走管道：Windows 上 stdout 时序不可靠，文件才是权威来源
				try {
					writeFileSync(join(app.getPath("temp"), "myna-e2e.json"), JSON.stringify(report), "utf8");
				} catch {}
				process.stdout.write(`E2E_RESULT ${JSON.stringify(report)}\n`, () => {
					setTimeout(() => app.exit(report.ok ? 0 : 1), 60);
				});
			}, Number(process.env.PI_MINI_E2E_DELAY || 2500));
		};
		// 页面可能在我们注册之前就已经加载完（loadURL 上面已经调过）：两种都接上
		if (win.webContents.isLoadingMainFrame()) win.webContents.once("did-finish-load", startE2E);
		else startE2E();
	}

	if (process.env.PI_MINI_PROBE) {
		win.webContents.once("did-finish-load", () => {
			setTimeout(async () => {
				const out = await win.webContents.executeJavaScript(`(() => {
					const thin = [];
					for (const el of document.querySelectorAll("*")) {
						const r = el.getBoundingClientRect();
						if (r.width > 0 && r.width < 10 && r.height > 8) {
							thin.push(el.tagName + " w=" + r.width.toFixed(1) + " h=" + r.height.toFixed(1) + " x=" + r.x.toFixed(0) + " y=" + r.y.toFixed(0) + " cls=" + el.className);
						}
					}
					return thin.join(" | ");
				})()`);
				console.log("THIN:", out);
			}, 2500);
		});
	}

	const shot = process.env.PI_MINI_SHOT;
	if (shot) {
		win.webContents.once("did-finish-load", () => {
			setTimeout(async () => {
				try {
					const img = await win.webContents.capturePage();
					writeFileSync(shot, img.toPNG());
					console.log("screenshot:", shot);
				} catch (e) {
					console.error("screenshot failed:", e.message);
				}
				app.quit();
			}, Number(process.env.PI_MINI_SHOT_DELAY || 3000));
		});
	}
}

process.on("uncaughtException", (err) => {
	log("[main:uncaught]", err?.stack || err?.message || String(err));
});
process.on("unhandledRejection", (reason) => {
	log("[main:rejection]", reason?.stack || reason?.message || String(reason));
});

app.whenReady().then(() => {
	// 任务栏归组与图标（Windows）：与 packaged exe 的 AppUserModelID 无关，仅影响进程分组/通知
	if (process.platform === "win32") app.setAppUserModelId("com.may5921.pi-mini");
	log("[perf] app ready", Date.now() - T0, "ms");
	const ROOT = import.meta.dirname;
	protocol.handle("app", async (request) => {
		const { pathname } = new URL(request.url);
		const rel = decodeURIComponent(pathname).replace(/^\/+/, "");
		const target = join(ROOT, rel);
		// 字符串前缀比较可被 ..\pi-mini-evil\x 绕过，必须比到分隔符
		if (target !== ROOT && !target.startsWith(ROOT + sep)) return new Response("forbidden", { status: 403 });
		const res = await net.fetch(pathToFileURL(target).toString());
		// 开发热重载必须绕过 Chromium 的模块缓存，否则改完 JS 还是旧代码
		const headers = new Headers(res.headers);
		headers.set("cache-control", "no-store");
		return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
	});
	createWindow();
	// 托盘必须在窗口之后建：close-to-hide 依赖 tray 存在，建不起来就退回「关窗即退出」
	createTray();
});

// 真退出（托盘「退出」/ app.quit / 系统关机）：先按需确认流式回合，再放行关闭并清理子进程。
async function beginQuit() {
	quitPending = true;
	let proceed = false;
	try {
		if (!quitConfirmed) {
			// 渲染层已销毁时 rendererIsStreaming() 直接返回 false，等于放行
			const ok = await confirmQuitWhileStreaming();
			if (!ok) {
				log("[quit] cancelled while streaming");
				return;
			}
			quitConfirmed = true;
		}
		quitting = true;
		proceed = true;
		destroyTray();
		stopPi();
	} catch (e) {
		// 清理失败也必须退出，否则进程会卡在没有窗口也没有托盘的状态
		log("[quit] cleanup failed", e?.message || String(e));
		quitting = true;
		proceed = true;
	} finally {
		quitPending = false;
		if (proceed) app.quit();
	}
}

app.on("before-quit", (e) => {
	// 已放行：第二次 app.quit() 进来时不再拦截，窗口 close 也随之放行
	if (quitting) return;
	e.preventDefault();
	// 确认框/清理进行中：挡住重复的 app.quit()，避免叠出多个对话框
	if (quitPending) return;
	void beginQuit();
});

app.on("window-all-closed", () => {
	// 托盘常驻：即使窗口真被关掉也保持进程（正常关窗会在 close 里被拦成收进托盘）
	if (process.platform === "win32" && tray) return;
	if (quitting) return;
	// 其余情况沿用原行为：走统一退出流程（含流式确认与子进程清理）
	app.quit();
});

app.on("will-quit", () => destroyTray());

// Windows 关机/注销不会触发 before-quit：至少把托盘和子进程钩掉
app.on("session-end", () => {
	quitting = true;
	destroyTray();
	stopPi();
});
