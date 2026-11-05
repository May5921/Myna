// 真实 pi 回合探针：必须显式设置 MYNA_REAL_TURN=1 才会发送 prompt。
// 只发一条「只回复 ok」，用于验收首 token、thinking、usage 和 session 恢复。
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { sanitizePiEnv } from "../src/core/pi-env.js";

if (process.env.MYNA_REAL_TURN !== "1") {
	console.error("为避免误调用模型，请设置 MYNA_REAL_TURN=1 后再运行");
	process.exit(2);
}

const statePath = join(homedir(), ".myna.json");
let saved = {};
try {
	saved = JSON.parse(readFileSync(statePath, "utf8"));
} catch {}
const sessionFile = String(saved.sessionFile || "");
const cwd = String(saved.cwd || process.cwd());
if (!sessionFile || !existsSync(sessionFile)) {
	console.error("~/.myna.json 没有可恢复的 sessionFile");
	process.exit(2);
}

const root = process.cwd();
const cli = process.env.PI_CLI && existsSync(process.env.PI_CLI)
	? process.env.PI_CLI
	: join(process.env.APPDATA || "", "npm", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
if (!existsSync(cli)) {
	console.error(`找不到 pi CLI: ${cli}`);
	process.exit(2);
}

const startedAt = performance.now();
const child = spawn(process.execPath, [cli, "--mode", "rpc", "--session", sessionFile], {
	cwd,
	stdio: ["pipe", "pipe", "pipe"],
	windowsHide: true,
	env: sanitizePiEnv(process.env),
});

const stateId = "myna-real-turn-state";
const promptId = "myna-real-turn-prompt";
const report = {
	cwd,
	sessionFile,
	cli,
	prompt: "只回复 ok",
	startedAt: new Date().toISOString(),
	state: null,
	agentStartMs: null,
	messageStartMs: null,
	firstThinkingMs: null,
	firstTextMs: null,
	messageEndMs: null,
	agentSettledMs: null,
	thinkingChars: 0,
	textChars: 0,
	usage: null,
	stopReason: null,
	finalText: "",
	commandResponse: null,
	stderr: "",
};
let buffer = "";
let done = false;
let promptSent = false;
let timer = null;

const elapsed = () => Math.round(performance.now() - startedAt);
const finish = (code, error = "") => {
	if (done) return;
	done = true;
	clearTimeout(timer);
	if (error) report.error = error;
	console.log(JSON.stringify(report, null, 2));
	try { child.kill(); } catch {}
	setTimeout(() => process.exit(code), 30);
};

function textOf(content) {
	return (Array.isArray(content) ? content : [])
		.filter((block) => block?.type === "text")
		.map((block) => String(block.text || ""))
		.join("");
}

function send(command) {
	child.stdin.write(`${JSON.stringify(command)}\n`);
}

function handle(record) {
	if (record.type === "response") {
		if (record.id === stateId) {
			report.state = { success: !!record.success, data: record.data || null, error: record.error || null };
			if (!record.success) return finish(1, record.error || "get_state failed");
			if (!promptSent) {
				promptSent = true;
				send({ id: promptId, type: "prompt", message: report.prompt });
			}
		} else if (record.id === promptId) {
			report.commandResponse = { success: !!record.success, data: record.data || null, error: record.error || null };
			if (!record.success) finish(1, record.error || "prompt failed");
		}
		return;
	}
	const at = elapsed();
	if (record.type === "agent_start") report.agentStartMs = at;
	if (record.type === "message_start" && record.message?.role === "assistant") report.messageStartMs = at;
	if (record.type === "message_update") {
		const event = record.assistantMessageEvent || {};
		if (event.type === "thinking_delta") {
			if (report.firstThinkingMs == null) report.firstThinkingMs = at;
			report.thinkingChars += String(event.delta || "").length;
		}
		if (event.type === "text_delta") {
			if (report.firstTextMs == null) report.firstTextMs = at;
			report.textChars += String(event.delta || "").length;
		}
	}
	if (record.type === "message_end" && record.message?.role === "assistant") {
		report.messageEndMs = at;
		report.stopReason = record.message.stopReason || null;
		report.usage = record.message.usage || null;
		report.finalText = textOf(record.message.content);
	}
	if (record.type === "agent_settled") {
		report.agentSettledMs = at;
		finish(record.aborted ? 1 : 0, record.aborted ? "agent aborted" : "");
	}
}

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
	buffer += chunk;
	let index;
	while ((index = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (!line) continue;
		try { handle(JSON.parse(line)); } catch {}
	}
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
	report.stderr = `${report.stderr}${chunk}`.slice(-2000);
});
child.on("error", (error) => finish(1, error.message));
child.on("exit", (code) => {
	if (!done) finish(1, `pi exited before settle: ${code}`);
});

timer = setTimeout(() => finish(1, "real turn timeout (120s)"), 120000);
send({ id: stateId, type: "get_state" });
