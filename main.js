// pi-mini —— pi 的极简 Electron 前端
// 依赖：只有 electron。pi 通过 `pi --mode rpc` 子进程接入，不引入 pi 的 npm 包。
import { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, screen } from "electron";
import { spawn, execSync, execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, renameSync, openSync, readSync, closeSync, watch, unlinkSync, appendFileSync } from "node:fs";
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
// 渲染层当前打开的会话文件：持久化到 ~/.pi-mini.json，主进程重启也能续上
// （否则 relaunch 后 startPi 会开新会话，renderer 又把 lastSession 覆盖成空会话）
let activeSessionFile = (() => {
	const saved = loadState().sessionFile;
	return typeof saved === "string" && saved && existsSync(saved) ? saved : null;
})();
function resumeSessionFile() {
	return activeSessionFile && existsSync(activeSessionFile) ? activeSessionFile : null;
}

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

function startPi(cwd, sessionFile = null) {
	stopPi();
	const cli = resolvePiCli();
	if (!cli) throw new Error("找不到 pi 的 cli.js，请确认 pi 已全局安装");
	const resume = sessionFile && existsSync(sessionFile) ? sessionFile : null;
	currentCwd = cwd;
	saveState({ cwd });
	buffer = "";
	piReady = false;
	const args = [cli, "--mode", "rpc"];
	if (resume) args.push("--session", resume);
	log("[pi] spawn", resume ? "resume " + resume : "new session");
	const proc = spawn("node", args, {
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
		buffer = "";
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
			if (!child) startPi(currentCwd, resumeSessionFile());
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

function listSessions(perCwd = 20) {
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
	return picked.slice(0, 600);
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

// 只接受 id/name/reasoning/contextWindow/maxTokens/input 这几个能稳定表达的字段；
// 模型条目里其它字段（compat 等）按 id 从旧配置里原样保留。
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
		// 内置路由（如 opencode-go）可能没有 baseUrl/api，更新时只校验填了的字段
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
	if (!child) startPi(currentCwd, resumeSessionFile());
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
	activeSessionFile = null;
	saveState({ sessionFile: null });
	startPi(res.filePaths[0]);
	return { cwd: currentCwd, sessions: listSessions() };
});

// 侧栏点其他工作区：重启 pi 子进程切换 cwd（pi 单进程模型）
ipcMain.handle("pi:set-cwd", async (_e, cwd) => {
	if (typeof cwd !== "string" || !cwd || !existsSync(cwd)) throw new Error("目录不存在");
	if (cwd !== currentCwd) {
		activeSessionFile = null;
		saveState({ sessionFile: null });
		startPi(cwd);
	}
	await ensureReady();
	return { cwd: currentCwd, sessions: listSessions() };
});

ipcMain.handle("pi:sessions", async (_e, opts) => {
	const perCwd = Math.min(200, Math.max(20, Number(opts?.perCwd) || 20));
	return listSessions(perCwd);
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
	if (typeof path === "string" && path && existsSync(path)) {
		activeSessionFile = path;
		saveState({ sessionFile: path });
	}
	return { cancelled: false, messages: history?.messages ?? [], state };
});

ipcMain.handle("pi:new-session", async () => {
	activeSessionFile = null;
	saveState({ sessionFile: null });
	await sessionCall({ type: "new_session" });
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
						if (window.__piTermAPI?.isOpen && window.__piTermAPI.isOpen()) window.__piTermToggle?.();
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
				if (want.includes("settings")) {
					try {
						await win.webContents.executeJavaScript("window.__piSettingsDemo && window.__piSettingsDemo()");
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
		title: "pi",
		icon: join(import.meta.dirname, "assets", "icon.ico"),
		show: false,
		autoHideMenuBar: true,
		webPreferences: {
			preload: join(import.meta.dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
		},
	});
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
});
app.on("window-all-closed", () => {
	stopPi();
	app.quit();
});
app.on("before-quit", stopPi);
