// 契约测试：feature 模块的导出/导入约束，以及 feature 用到的 ctx.pi.* 方法
// 必须都在 preload.cjs 的 contextBridge 暴露列表里。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const featuresDir = path.join(root, "src", "features");

const featureFiles = readdirSync(featuresDir, { withFileTypes: true })
	.filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
	.map((entry) => entry.name)
	.sort();

const featureCode = new Map(
	featureFiles.map((name) => {
		const code = readFileSync(path.join(featuresDir, name), "utf8");
		return [name, code];
	}),
);

// 去掉注释再做方法名扫描，避免把注释里的示例接口误判为真实调用
function stripComments(code) {
	return code
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^\s*\/\/.*$/gm, "")
		.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// 解析 preload.cjs 里 contextBridge.exposeInMainWorld("pi", { ... }) 的键名。
function exposedPiKeys() {
	const preload = readFileSync(path.join(root, "preload.cjs"), "utf8");
	const start = preload.indexOf('exposeInMainWorld("pi"');
	assert.notEqual(start, -1, 'preload.cjs 没找到 contextBridge.exposeInMainWorld("pi"');
	const rest = preload.slice(start);
	const open = rest.indexOf("{");
	const close = rest.indexOf("\n});", open);
	const body = close < 0 ? rest : rest.slice(0, close);
	const keys = [...body.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)].map((m) => m[1]);
	return new Set(keys);
}

test("每个 feature 文件都 export init，且不 import react / 不 require", () => {
	assert.ok(featureFiles.length > 0, "src/features 下没有 .js 文件");
	for (const [name, code] of featureCode) {
		assert.match(
			code,
			/export\s+(?:async\s+)?function\s+init\s*\(/,
			`${name} 缺少 export function init(ctx)`,
		);
		assert.doesNotMatch(
			code,
			/from\s+["']react(?:-dom)?["']/,
			`${name} 引入了 react（本项目不允许）`,
		);
		assert.doesNotMatch(
			code,
			/(?<![\w$.])require\s*\(/,
			`${name} 使用了 require()（只有 preload.cjs 允许）`,
		);
	}
});

test("preload.cjs 的暴露列表可解析且非空", () => {
	const keys = exposedPiKeys();
	assert.ok(keys.size >= 20, `暴露接口数量异常（${keys.size}）`);
	for (const required of ["command", "onEvent", "sendRaw", "openPath"]) {
		assert.ok(keys.has(required), `preload.cjs 缺少 ctx.pi.${required}`);
	}
});

test("feature 里用到的 ctx.pi.* 方法都在 preload.cjs 暴露列表里", () => {
	const keys = exposedPiKeys();
	const used = new Map(); // method -> 出现位置

	for (const [name, raw] of featureCode) {
		const code = stripComments(raw);
		const patterns = [
			/ctx\.pi\??\.([A-Za-z_$][\w$]*)/g, // ctx.pi.command / ctx.pi?.onEvent
			/(?<![\w$.])pi\??\.([A-Za-z_$][\w$]*)/g, // const pi = ctx.pi 之后的 pi.command
		];
		for (const re of patterns) {
			for (const match of code.matchAll(re)) {
				const method = match[1];
				if (!used.has(method)) used.set(method, `${name}:${method}`);
			}
		}
	}

	assert.ok(used.size > 0, "没有从 feature 文件里解析到任何 ctx.pi.* 调用");

	const missing = [...used.keys()].filter((method) => !keys.has(method)).sort();
	assert.deepEqual(
		missing,
		[],
		`以下 ctx.pi 方法未在 preload.cjs 暴露：${missing
			.map((method) => `${method}（${used.get(method)}）`)
			.join(", ")}`,
	);
});
