// 端到端驱动器：启动真实 Electron，跑 scenarios.mjs 里的断言，汇总结果。
// 用法：
//   node scripts/e2e.mjs            # 跑全部场景
//   node scripts/e2e.mjs fold boot  # 只跑指定场景
// 不需要 API Key，不会调用模型。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const targets = args.length ? args : ["all"];

const electronBin = join(root, "node_modules", "electron", "dist", "electron.exe");
const isWindows = process.platform === "win32";
const command = isWindows && existsSync(electronBin) ? electronBin : join(root, "node_modules", ".bin", isWindows ? "electron.cmd" : "electron");
if (!existsSync(electronBin) && !existsSync(command)) {
	console.error("找不到 electron，可先运行 npm install");
	process.exit(2);
}

const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT || 120000);
const started = Date.now();
const child = spawn(command, ["."], {
	cwd: root,
	env: {
		...process.env,
		MYNA_E2E: targets.join(","),
		MYNA_E2E_ONBOARDING: targets.includes("onboarding") || targets.includes("all") ? "1" : "",
		// 测试期间不要被 dev watcher 干扰，也不要写开发日志噪音
		MYNA_DEV: "",
	},
	stdio: ["ignore", "pipe", "pipe"],
	windowsHide: true,
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => {
	stdout += d.toString();
});
child.stderr.on("data", (d) => {
	stderr += d.toString();
});

const killSoon = () => {
	try {
		child.kill();
	} catch {}
};

const timer = setTimeout(() => {
	console.error(`\n✗ 端到端超时（${TIMEOUT_MS} ms），强制结束`);
	console.error(stderr.split("\n").slice(-15).join("\n"));
	killSoon();
	process.exit(124);
}, TIMEOUT_MS);

child.on("exit", (code) => {
	clearTimeout(timer);
	const line = stdout.split("\n").reverse().find((l) => l.startsWith("E2E_RESULT "));
	if (!line) {
		console.error("✗ 没有拿到 E2E_RESULT");
		const tail = (stdout + "\n" + stderr).split("\n").filter(Boolean).slice(-20).join("\n");
		if (tail) console.error(tail);
		process.exit(code === 0 ? 3 : code || 3);
	}
	let report;
	try {
		report = JSON.parse(line.slice("E2E_RESULT ".length));
	} catch (e) {
		console.error("✗ E2E_RESULT 不是合法 JSON:", e.message);
		process.exit(3);
	}

	const icon = (v) => (v ? "✓" : "✗");
	let failed = 0;
	const verbose = process.env.E2E_VERBOSE === "1";
	for (const sc of report.scenarios) {
		const bad = sc.checks.filter((c) => !c.ok);
		const head = `${icon(sc.ok)} ${sc.name}${sc.ms != null ? `  ${sc.ms}ms` : ""}`;
		console.log(head);
		for (const c of sc.checks) {
			if (c.ok && !verbose) continue;
			console.log(`    ${c.ok ? "·" : "✗"} ${c.name}${c.detail ? `  [${c.detail}]` : ""}`);
		}
		if (bad.length) failed += bad.length;
	}
	if (report.consoleErrors?.length) {
		console.log(`\n渲染层 error 日志 ${report.consoleErrors.length} 条：`);
		for (const e of report.consoleErrors.slice(0, 5)) console.log("  ! " + e);
	}
	const totalChecks = report.scenarios.reduce((n, s) => n + s.checks.length, 0);
	const total = ((Date.now() - started) / 1000).toFixed(1);
	console.log(
		`\n${report.ok && !failed ? "通过" : "失败"}：${report.scenarios.length} 场景 / ${totalChecks} 断言 / 失败 ${failed} / ${total}s`,
	);
	process.exit(report.ok && !failed ? 0 : 1);
});
