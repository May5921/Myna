// pi-mini —— pi 的极简 Electron 前端
// 依赖：只有 electron。pi 通过 `pi --mode rpc` 子进程接入，不引入 pi 的 npm 包。
import { app, BrowserWindow, ipcMain, dialog, shell, protocol, net } from "electron";
import { spawn, execSync, execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, openSync, readSync, closeSync, watch, unlinkSync, appendFileSync } from "node:fs";
import { join, sep } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const T0 = Date.now();

// 自定义协议：让 ES module / fetch 在渲染层可用（file:// 会被 CORS 拦）
protocol.registerSchemesAsPrivileged([
	{
		scheme: "app",
		privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
	},
]);

const SESSIONS_ROOT = join(homedir(), ".pi", "agent", "sessions");
const LOG_FILE = join(homedir(), "AppData", "Local", "Temp", "pi-mini.log");
const STATE_FILE = join(homedir(), ".pi-mini.json");

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

// ---------- pi cli 定位 ----------
function resolvePiCli() {
	if (process.env.PI_CLI && existsSync(process.env.PI_CLI)) return process.env.PI_CLI;
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

function startPi(cwd) {
	stopPi();
	const cli = resolvePiCli();
	if (!cli) throw new Error("找不到 pi 的 cli.js，请确认 pi 已全局安装");
	currentCwd = cwd;
	saveState({ cwd });
	buffer = "";
	piReady = false;
	const proc = spawn("node", [cli, "--mode", "rpc"], {
		cwd,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
		env: { ...process.env },
	});
	child = proc;
	proc.stdout.setEncoding("utf8");
	proc.stdout.on("data", (d) => {
		if (child === proc) onData(d);
	});
	proc.stderr.setEncoding("utf8");
	proc.stderr.on("data", (d) => send("pi:stderr", String(d)));
	// 没有 'error' 监听时，写已关闭的 stdin 会抛 EPIPE 直接崩主进程
	proc.stdin.on("error", () => {});
	proc.on("exit", (code) => {
		// 死进程必须及时让位：否则后续命令会写进已关闭的 stdin（EPIPE/「pi 进程已停止」）
		if (child === proc) {
			child = null;
			piReady = false;
		}
		// 只让死进程自己的命令失败，别误伤刚切过来的新进程
		for (const [id, w] of waiting) {
			if (w.proc !== proc) continue;
			w.reject(new Error("pi 进程已停止"));
			waiting.delete(id);
		}
		buffer = "";
		send("pi:exit", code);
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
			proc.stdin.write(`${JSON.stringify({ id, ...cmd })}\n`);
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
			if (!child) startPi(currentCwd);
			try {
				await command({ type: "get_state" }, i < 4 ? 4000 : 1200);
				piReady = true;
				return;
			} catch {}
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
		startPi(currentCwd);
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

function listSessions() {
	const out = [];
	if (!existsSync(SESSIONS_ROOT)) return out;
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
	// 每个工作区各保留最近 20 条，避免某个目录的会话把其他项目挤掉
	const byCwd = new Map();
	for (const s of out) {
		const key = s.cwd || "";
		if (!byCwd.has(key)) byCwd.set(key, []);
		byCwd.get(key).push(s);
	}
	const picked = [];
	for (const list of byCwd.values()) {
		list.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
		picked.push(...list.slice(0, 20));
	}
	picked.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
	return picked.slice(0, 200);
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

// ---------- IPC ----------
let restorePending = process.env.PI_MINI_SESSION || null;
let relaunching = false;

ipcMain.handle("pi:boot", async () => {
	if (!child) startPi(currentCwd);
	await ensureReady().catch((e) => log("[boot] pi not ready", e.message));
	// 只在本进程第一次 boot 时恢复指定会话；renderer 热重载后直接用当前会话
	const restore = restorePending;
	restorePending = null;
	return { cwd: currentCwd, sessions: listSessions(), restore };
});

ipcMain.handle("pi:command", async (_e, cmd) => {
	await ensureReady();
	return command(cmd);
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
	startPi(res.filePaths[0]);
	return { cwd: currentCwd, sessions: listSessions() };
});

// 侧栏点其他工作区：重启 pi 子进程切换 cwd（pi 单进程模型）
ipcMain.handle("pi:set-cwd", async (_e, cwd) => {
	if (typeof cwd !== "string" || !cwd || !existsSync(cwd)) throw new Error("目录不存在");
	if (cwd !== currentCwd) startPi(cwd);
	await ensureReady();
	return { cwd: currentCwd, sessions: listSessions() };
});

ipcMain.handle("pi:sessions", async () => listSessions());

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
			shikiInstance = await createHighlighter({ themes: ["github-light"], langs: [] });
			return shikiInstance;
		});
	}
	return shikiLoading;
}

ipcMain.handle("pi:highlight", async (_e, items) => {
	if (!Array.isArray(items) || !items.length) return [];
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
			out[i] = hl.codeToHtml(String(items[i].code || ""), { lang, theme: "github-light" });
		} catch {}
	}
	return out;
});

ipcMain.handle("pi:switch-session", async (_e, path) => {
	const res = await sessionCall({ type: "switch_session", sessionPath: path });
	if (res?.cancelled) return { cancelled: true };
	const history = await sessionCall({ type: "get_messages" });
	const state = await sessionCall({ type: "get_state" });
	return { cancelled: false, messages: history?.messages ?? [], state };
});

ipcMain.handle("pi:new-session", async () => {
	await sessionCall({ type: "new_session" });
	return { sessions: listSessions() };
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
			if (/(^|\/)(node_modules|\.git)\//.test(name)) return;
			if (name === "main.js") {
				if (relaunching) return;
				relaunching = true;
				log("[dev] main.js changed -> relaunch");
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
				try {
					unlinkSync(join(dir, "shot.request"));
				} catch {}
				if (want.includes("diff")) {
					try {
						const ready = await win.webContents.executeJavaScript(
							`(async () => { for (let i = 0; i < 160; i++) { if (window.__ready) return true; await new Promise((r) => setTimeout(r, 250)); } return false; })()`,
						);
						if (ready) {
							await win.webContents.executeJavaScript("window.__selftest && window.__selftest()");
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
				// 清掉上一张截图留下的 demo 状态（设置弹窗 / 排队 / 附件 / 右栏）
				try {
					await win.webContents.executeJavaScript(`(() => {
						const ov = document.querySelector(".settings-overlay");
						if (ov && !ov.hidden) { const g = document.getElementById("settings-btn"); g && g.click(); }
						if (window.__piQueueDemoClear) window.__piQueueDemoClear();
						if (window.__piAttachClear) window.__piAttachClear();
						const t = document.getElementById("rp-toggle");
						if (t && t.getAttribute("aria-expanded") === "true") t.click();
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
				if (want.includes("settings")) {
					try {
						await win.webContents.executeJavaScript("window.__piSettingsDemo && window.__piSettingsDemo()");
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
					} catch (e) {
						log("[dev] right panel demo failed", e.message);
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
				if (want.includes("live")) {
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
				if (want.includes("empty")) {
					try {
						await win.webContents.executeJavaScript("document.querySelector('.newchat')?.click()");
						await new Promise((r) => setTimeout(r, 1200));
					} catch (e) {
						log("[dev] empty state failed", e.message);
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
					shotBusy = false;
				}
			}
		});
	} catch (e) {
		log("[dev] watch failed", e.message);
	}
	log("[dev] watching for changes");
}

function createWindow() {
	win = new BrowserWindow({
		width: 1280,
		height: 820,
		minWidth: 720,
		minHeight: 480,
		backgroundColor: "#FFFFFF",
		title: "pi",
		show: false,
		autoHideMenuBar: true,
		webPreferences: {
			preload: join(import.meta.dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
		},
	});
	// 锁死导航：拖文件到页面空白处不得把窗口导航到 file://（preload 仍会注入）
	win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	win.webContents.on("will-navigate", (e) => e.preventDefault());
	win.loadURL("app://bundle/index.html");
	win.webContents.once("did-finish-load", () => log("[perf] window ready", Date.now() - T0, "ms"));
	win.once("ready-to-show", () => win.show());
	if (process.env.PI_MINI_DEV) startDevWatch();

	win.webContents.on("console-message", (event) => {
		const { level, message, lineNumber, sourceId } = event;
		if (level === "error" || level === "warning") log(`[renderer:${level}] ${message} (${sourceId}:${lineNumber})`);
	});
	win.webContents.on("preload-error", (_e, path, error) => log("[preload-error]", path, error.message));
	win.webContents.on("render-process-gone", (_e, details) => log("[renderer-gone]", JSON.stringify(details)));


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

app.whenReady().then(() => {
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
});
app.on("window-all-closed", () => {
	stopPi();
	app.quit();
});
app.on("before-quit", stopPi);
