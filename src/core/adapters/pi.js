// pi 适配器：把 pi --mode rpc 的 JSONL 协议转换成中性 IR。
// 该模块只依赖 Node 内置模块，不依赖 Electron 或渲染层。
import { spawn, execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { COMMANDS, unsupported } from "../ir.js";

export const id = "pi";
export const caps = Object.freeze({
	fork: true,
	compact: true,
	reason: true,
	queue: true,
	extUI: true,
	models: true,
	sessions: true,
});

const DEFAULT_TIMEOUT = 60_000;

function textFromContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("");
}

function getSessionId(state) {
	return typeof state?.sessionId === "string" ? state.sessionId : "";
}

function outcomeFromSettled(event) {
	if (event?.aborted === true || event?.reason === "aborted" || event?.stopReason === "aborted") return "aborted";
	if (event?.error || event?.isError === true || event?.reason === "error" || event?.stopReason === "error") return "failed";
	return "ok";
}

// 导出给契约测试和未来调试使用；生产路径只传递固定 IR 事件。
export function mapPiEvent(event, sessionId) {
	if (!event || typeof event !== "object") return [];
	const sid = typeof event.sessionId === "string" ? event.sessionId : sessionId;
	const a = event.assistantMessageEvent;
	const out = [];
	const push = (type, extra = {}) => out.push({ type, sessionId: sid, ...extra });

	switch (event.type) {
		case "agent_start":
			push("turn.start");
			break;
		case "agent_settled":
			push("turn.end", { outcome: outcomeFromSettled(event) });
			break;
		case "process_exit":
			push("turn.end", { outcome: "failed" });
			push("error", { message: `pi 进程已退出${event.code == null ? "" : `（${event.code}）`}`, fatal: true });
			break;
		case "message_update":
			if (a?.type === "text_delta" && typeof a.delta === "string") push("text.delta", { delta: a.delta });
			else if (a?.type === "thinking_delta" && typeof a.delta === "string") push("reason.delta", { delta: a.delta });
			break;
		case "message_end": {
			const message = event.message;
			const text = textFromContent(message?.content);
			// usage 必须在 text.done 之前发：投影层把它贴给紧随其后的 text.done，
			// 顺序反了会把这一步的 token 记到下一条消息上。
			const usage = message?.usage;
			if (usage && Number.isFinite(usage.input) && Number.isFinite(usage.output)) {
				const cost = usage.cost?.total ?? usage.cost?.totalCost;
				push("usage", {
					input: usage.input,
					output: usage.output,
					...(Number.isFinite(cost) ? { cost } : {}),
				});
			}
			if (text) push("text.done", { text });
			break;
		}
		case "tool_execution_start":
			push("tool.start", {
				toolCallId: String(event.toolCallId ?? ""),
				name: String(event.toolName ?? "tool"),
				args: event.args && typeof event.args === "object" ? event.args : {},
			});
			break;
		case "tool_execution_end": {
			const result = event.result;
			const output = textFromContent(result?.content);
			const diff = result?.details?.diff;
			push("tool.end", {
				toolCallId: String(event.toolCallId ?? ""),
				ok: event.isError !== true,
				...(output ? { output } : {}),
				...(typeof diff === "string" && diff ? { diff } : {}),
				...(Number.isFinite(event.durationMs) ? { durationMs: event.durationMs } : {}),
			});
			break;
		}
		case "session_info_changed":
			push("session.meta", {
				...(typeof event.name === "string" ? { title: event.name } : {}),
				...(event.model ? { model: event.model } : {}),
			});
			break;
		case "extension_ui_request":
			// 扩展 UI 仍保留原始载荷，供宿主桥接层处理；它不属于 IR 事件集合。
			return [];
		default:
			break;
	}
	return out.filter((ev) => typeof ev.sessionId === "string" && ev.sessionId.length > 0);
}

function resolveCli(cliPath) {
	if (cliPath && existsSync(cliPath)) return cliPath;
	if (process.env.PI_CLI && existsSync(process.env.PI_CLI)) return process.env.PI_CLI;
	const roots = [];
	try {
		roots.push(execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm root -g"], { encoding: "utf8", windowsHide: true }).trim());
	} catch {}
	if (process.env.APPDATA) roots.push(join(process.env.APPDATA, "npm", "node_modules"));
	if (process.env.HOME) roots.push(join(process.env.HOME, ".npm", "node_modules"));
	roots.push(join(homedir(), "AppData", "Roaming", "npm", "node_modules"));
	for (const root of roots) {
		const candidate = join(root, "@earendil-works", "pi-coding-agent", "dist", "cli.js");
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

function normalizeModels(data) {
	const models = Array.isArray(data?.models) ? data.models : [];
	return models.map((model) => ({
		id: String(model?.id ?? ""),
		name: String(model?.name ?? model?.id ?? ""),
		provider: String(model?.provider ?? ""),
	}));
}

function normalizeHistory(data) {
	const messages = Array.isArray(data?.messages) ? data.messages : [];
	return {
		messages: messages.map((message) => ({
			role: message?.role === "user" ? "user" : "assistant",
			text: textFromContent(message?.content),
			...(Number.isFinite(message?.timestamp) ? { ts: message.timestamp } : {}),
		})),
	};
}

function listPiSessions(root, cwd, limit = 50) {
	const out = [];
	if (!existsSync(root)) return out;
	for (const directory of readdirSync(root)) {
		const folder = join(root, directory);
		try {
			if (!statSync(folder).isDirectory()) continue;
		} catch {
			continue;
		}
		for (const file of readdirSync(folder)) {
			if (!file.endsWith(".jsonl")) continue;
			const path = join(folder, file);
			let head;
			try { head = readFileSync(path, "utf8").slice(0, 65_536); } catch { continue; }
			const firstLine = head.split(/\r?\n/, 1)[0];
			let header;
			try { header = JSON.parse(firstLine); } catch { continue; }
			if (cwd && header?.cwd && header.cwd !== cwd) continue;
			let title = "";
			for (const line of head.split(/\r?\n/)) {
				if (!line.includes('"role":"user"')) continue;
				try {
					const message = JSON.parse(line)?.message;
					const text = textFromContent(message?.content).replace(/\s+/g, " ").trim();
					if (text) { title = text.slice(0, 60); break; }
				} catch {}
			}
			let name = "";
			const match = head.match(/"type"\s*:\s*"session_info"[^\n]*?"name"\s*:\s*"((?:[^"\\]|\\.)*)"/);
			if (match) {
				try { name = JSON.parse(`"${match[1]}"`); } catch {}
			}
			out.push({
				id: String(header?.id || file.replace(/\.jsonl$/, "")),
				title: name || title,
				updatedAt: header?.timestamp || statSync(path).mtimeMs,
				cwd: header?.cwd || cwd,
				_path: path,
			});
		}
	}
	out.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
	return out.slice(0, Math.max(1, limit));
}

export function createAdapter(options = {}) {
	const cwd = options.cwd || process.cwd();
	const onEvent = typeof options.onEvent === "function" ? options.onEvent : () => {};
	const onLog = typeof options.onLog === "function" ? options.onLog : () => {};
	const nodePath = options.nodePath || process.execPath;
	const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT;
	let proc = null;
	let buffer = "";
	let sequence = 0;
	let sessionId = "";
	let sessionFile = options.sessionFile || null;
	let ready = false;
	const sessionIndex = new Map();
	const pending = new Map();

	function failPending(error) {
		for (const item of pending.values()) {
			clearTimeout(item.timer);
			item.reject(error);
		}
		pending.clear();
	}

	function handleLine(line) {
		if (!line.trim()) return;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			onLog(line);
			return;
		}
		if (record.type === "response") {
			const id = record.id;
			const item = id == null ? null : pending.get(id);
			if (!item) return;
			pending.delete(id);
			clearTimeout(item.timer);
			if (record.success) item.resolve(record.data ?? {});
			else item.reject(new Error(record.error || "pi 命令失败"));
			return;
		}
		for (const event of mapPiEvent(record, sessionId)) onEvent(event);
	}

	function handleData(chunk) {
		buffer += String(chunk);
		for (;;) {
			const index = buffer.indexOf("\n");
			if (index < 0) break;
			let line = buffer.slice(0, index);
			buffer = buffer.slice(index + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			handleLine(line);
		}
	}

	function send(rawCommand, commandTimeout = timeoutMs) {
		if (!proc || proc.killed || proc.exitCode != null || !proc.stdin?.writable) {
			return Promise.reject(new Error("pi 适配器未启动"));
		}
		const requestId = `pi-${++sequence}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(requestId);
				reject(new Error(`pi 命令超时: ${rawCommand.type}`));
			}, commandTimeout);
			pending.set(requestId, { resolve, reject, timer });
			try {
				proc.stdin.write(`${JSON.stringify({ id: requestId, ...rawCommand })}\n`);
			} catch (error) {
				pending.delete(requestId);
				clearTimeout(timer);
				reject(error);
			}
		});
	}

	async function start() {
		if (ready && proc) return;
		await stop();
		const cli = resolveCli(options.cliPath);
		if (!cli) throw new Error("找不到 pi 的 cli.js，请确认 pi 已安装或传入 cliPath");
		const args = [cli, "--mode", "rpc"];
		if (sessionFile && existsSync(sessionFile)) args.push("--session", sessionFile);
		buffer = "";
		const child = spawn(nodePath, args, {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			env: { ...process.env, ...(options.env || {}) },
		});
		proc = child;
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", handleData);
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (text) => onLog(String(text)));
		child.stdin.on("error", (error) => onLog(error.message));
		child.on("error", (error) => {
			if (proc !== child) return;
			ready = false;
			failPending(error);
			onEvent({ type: "error", sessionId, message: error.message, fatal: true });
		});
		child.on("exit", (code) => {
			const current = proc === child;
			if (current) {
				proc = null;
				ready = false;
			}
			failPending(new Error(`pi 进程已退出${code == null ? "" : `（${code}）`}`));
			if (current && code !== 0) onEvent({ type: "error", sessionId, message: `pi 进程已退出（${code ?? "未知"}）`, fatal: true });
		});
		const state = await send({ type: "get_state" });
		sessionId = getSessionId(state);
		sessionFile = state?.sessionFile || sessionFile;
		ready = true;
		return state;
	}

	async function stop() {
		const child = proc;
		proc = null;
		ready = false;
		if (!child) return;
		failPending(new Error("pi 适配器已停止"));
		const exited = child.exitCode != null
			? Promise.resolve()
			: new Promise((resolve) => child.once("exit", resolve));
		try { child.stdin?.end(); } catch {}
		try { child.kill(); } catch {}
		await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1_000))]);
	}

	async function call(command) {
		if (!command || typeof command.type !== "string") throw new Error("命令缺少 type");
		if (!COMMANDS.includes(command.type)) throw unsupported(command.type);
		if (!ready) await start();
		let response;
		switch (command.type) {
			case "prompt":
				response = await send({ type: "prompt", message: String(command.text ?? ""), ...(command.images ? { images: command.images } : {}) });
				return { messageId: `turn-${Date.now()}`, ...response };
			case "abort":
				return send({ type: "abort" });
			case "list_sessions":
				{
					const root = options.sessionsRoot || join(homedir(), ".pi", "agent", "sessions");
					const sessions = listPiSessions(root, cwd, command.limit);
					for (const item of sessions) sessionIndex.set(item.id, item._path);
					return { sessions: sessions.map(({ _path, ...item }) => item) };
				}
			case "load_history":
				return normalizeHistory(await send({ type: "get_messages" }));
			case "new_session":
				await send({ type: "new_session" });
				response = await send({ type: "get_state" });
				sessionId = getSessionId(response);
				sessionFile = response?.sessionFile || null;
				return { sessionId };
			case "switch_session":
				{
					const sessionPath = sessionIndex.get(command.sessionId) || command.sessionId;
					await send({ type: "switch_session", sessionPath });
				}
				response = await send({ type: "get_state" });
				sessionId = getSessionId(response);
				sessionFile = response?.sessionFile || command.sessionId;
				return { sessionId };
			case "list_models":
				return { models: normalizeModels(await send({ type: "get_available_models" })) };
			case "set_model": {
				const [provider, ...rest] = String(command.modelId ?? "").split("/");
				const modelId = rest.length ? rest.join("/") : provider;
				return send({ type: "set_model", provider: rest.length ? provider : "", modelId });
			}
			case "fork":
				response = await send({ type: "fork", entryId: command.messageId });
				return { sessionId, ...response };
			case "compact":
				return send({ type: "compact" });
			case "rename":
				return send({ type: "set_session_name", name: String(command.title ?? "") });
			default:
				throw unsupported(command.type);
		}
	}

	return { id, caps, start, stop, call, get sessionId() { return sessionId; }, get sessionFile() { return sessionFile; } };
}
