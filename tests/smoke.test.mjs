// 冒烟测试：源码语法、CSP、依赖白名单、feature 文件与 app.js 的 FEATURES 清单一致。
// 只跑 Node，不启动 Electron，不访问网络，不产生 pi 子进程。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const readText = (rel) => readFileSync(path.join(root, rel), "utf8");

// 递归收集 src 下的 .js（跨平台，用 path 拼，不拼盘符）
function walkJs(relDir) {
	const files = [];
	const walk = (absDir) => {
		for (const entry of readdirSync(absDir, { withFileTypes: true })) {
			const full = path.join(absDir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".js")) files.push(path.relative(root, full));
		}
	};
	walk(path.join(root, relDir));
	return files.sort();
}

test("所有源码文件通过 node --check", () => {
	const files = ["main.js", "preload.cjs", ...walkJs("src")];
	assert.ok(files.length >= 19, `源码文件太少（${files.length}），疑似遍历失败`);
	for (const rel of files) {
		const abs = path.join(root, rel);
		const result = spawnSync(process.execPath, ["--check", abs], { encoding: "utf8" });
		assert.equal(result.error, undefined, `${rel} 无法执行 node --check：${result.error?.message}`);
		assert.equal(
			result.status,
			0,
			`${rel} 语法检查失败：\n${(result.stderr || result.stdout || "").trim()}`,
		);
	}
});

test("index.html 有 CSP 且 script-src 'self'", () => {
	const html = readText("index.html");
	const metas = html.match(/<meta\b[^>]*>/gi) ?? [];
	const cspMeta = metas.find((tag) =>
		/http-equiv\s*=\s*["']Content-Security-Policy["']/i.test(tag),
	);
	assert.ok(cspMeta, "index.html 缺少 Content-Security-Policy meta 标签");

	// content 属性可能用双引号或单引号；注意 CSP 值内部本身含单引号
	const match = /content\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(cspMeta);
	const content = match?.[1] ?? match?.[2] ?? "";
	assert.ok(content, "CSP meta 缺少 content 属性");
	assert.match(content, /default-src\s+'self'/, `CSP 缺 default-src 'self'：${content}`);
	assert.match(content, /script-src\s+'self'/, `CSP 缺 script-src 'self'：${content}`);
});

test("index.html 没有内联 <script>", () => {
	const html = readText("index.html");
	const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
	assert.ok(scripts.length > 0, "index.html 应至少有一个外链 <script src>");
	for (const [index, [, attrs, body]] of scripts.entries()) {
		assert.match(
			attrs,
			/\bsrc\s*=\s*["'][^"']+["']/i,
			`第 ${index + 1} 个 <script> 缺少 src（内联脚本被 CSP 禁止）`,
		);
		assert.equal(body.trim(), "", `第 ${index + 1} 个 <script> 带有内联内容`);
	}
});

test("依赖白名单：dependencies 只有 shiki + 文档解析的两个库，devDependencies 只有构建三件套", () => {
	const pkg = JSON.parse(readText("package.json"));
	assert.equal(pkg.type, "module");
	// fflate：解 docx/pptx/xlsx 的 ZIP；pdfjs-dist：抽 PDF 文本
	assert.deepEqual(Object.keys(pkg.dependencies ?? {}).sort(), ["fflate", "pdfjs-dist", "shiki"]);
	// rcedit：便携版写 exe 图标；electron-builder：生成 NSIS 安装包（都只在构建期用）
	assert.deepEqual(Object.keys(pkg.devDependencies ?? {}).sort(), ["electron", "electron-builder", "rcedit"]);
	assert.match(pkg.scripts?.test ?? "", /node --test/, "package.json 缺少 test script");
	assert.match(pkg.scripts?.check ?? "", /check-syntax\.mjs/, "check script 被改动");
});

test("src/app.js 的 FEATURES 每项都存在且 export init", () => {
	const app = readText("src/app.js");
	const block = /const\s+FEATURES\s*=\s*\[([\s\S]*?)\]\s*;/.exec(app);
	assert.ok(block, "在 src/app.js 中找不到 const FEATURES = [...]");

	const specs = [...block[1].matchAll(/["']([^"']+\.js)["']/g)].map((m) => m[1]);
	assert.ok(specs.length > 0, "FEATURES 为空");
	assert.equal(new Set(specs).size, specs.length, "FEATURES 有重复项");

	for (const spec of specs) {
		// FEATURES 里的路径相对 src/app.js 所在目录
		const abs = path.resolve(root, "src", spec);
		assert.ok(existsSync(abs), `FEATURES 引用了不存在的文件：${spec}`);
		const code = readFileSync(abs, "utf8");
		assert.match(
			code,
			/export\s+(?:async\s+)?function\s+init\s*\(/,
			`${spec} 没有 export function init(ctx)`,
		);
	}
});

test("运行时边界保持 pi-only", () => {
	const app = readText("src/app.js");
	const preload = readText("preload.cjs");
	const main = readText("main.js");
	const block = /const\s+FEATURES\s*=\s*\[([\s\S]*?)\]\s*;/.exec(app)?.[1] ?? "";

	assert.doesNotMatch(block, /omp-(?:todo|tasks)\.js/i, "OMP feature 不应进入运行时加载清单");
	assert.doesNotMatch(preload, /agentBackend/i, "pi-only preload 不应暴露后端切换 API");
	assert.doesNotMatch(main, /opencode/i, "pi-only 主进程不应保留 OpenCode 路径");
});
