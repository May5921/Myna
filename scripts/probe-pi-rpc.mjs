// 只读 pi RPC 探针：验证 CLI、JSONL 桥和基础状态，不发送模型 prompt。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { sanitizePiEnv } from "../src/core/pi-env.js";

const cli = process.env.PI_CLI && existsSync(process.env.PI_CLI)
	? process.env.PI_CLI
	: join(process.env.APPDATA || "", "npm", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");

if (!existsSync(cli)) {
	console.error(`找不到 pi CLI: ${cli}`);
	process.exit(2);
}

const child = spawn(process.execPath, [cli, "--mode", "rpc"], {
	cwd: process.cwd(),
	stdio: ["pipe", "pipe", "pipe"],
	windowsHide: true,
	env: sanitizePiEnv(process.env),
});

const requests = [
	["state", { id: "myna-probe-state", type: "get_state" }],
	["models", { id: "myna-probe-models", type: "get_available_models" }],
	["commands", { id: "myna-probe-commands", type: "get_commands" }],
];
const results = {};
let buffer = "";
let stderr = "";
let done = false;

const finish = (code, value) => {
	if (done) return;
	done = true;
	console.log(JSON.stringify(value));
	try {
		child.kill();
	} catch {}
	setTimeout(() => process.exit(code), 20);
};

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
	buffer += chunk;
	let index;
	while ((index = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (!line) continue;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		if (record.type !== "response") continue;
		if (record.id === "myna-probe-state") {
			results.state = { success: !!record.success, keys: Object.keys(record.data || {}) };
		}
		if (record.id === "myna-probe-models") {
			results.models = {
				success: !!record.success,
				count: Array.isArray(record.data?.models) ? record.data.models.length : null,
			};
		}
		if (record.id === "myna-probe-commands") {
			const commands = Array.isArray(record.data?.commands) ? record.data.commands : [];
			results.commands = {
				success: !!record.success,
				count: commands.length,
				sources: [...new Set(commands.map((command) => command?.source).filter(Boolean))].sort(),
			};
		}
		if (results.state && results.models && results.commands) {
			finish(results.state.success && results.models.success && results.commands.success ? 0 : 1, results);
		}
	}
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
	stderr += chunk;
});
child.on("error", (error) => finish(1, { error: error.message }));
child.on("exit", (code) => {
	if (!done) finish(1, { error: `pi exited before responses: ${code}`, stderr: stderr.slice(-800) });
});

for (const [, request] of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
setTimeout(() => finish(1, { error: "probe timeout", stderr: stderr.slice(-800) }), 20000);
