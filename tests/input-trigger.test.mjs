import { test } from "node:test";
import assert from "node:assert/strict";

import { atRangeAt, commandRangeAt, rankCommands, rankFiles } from "../src/core/input-trigger.js";

test("atRangeAt 识别 @ token、光标行与括号包装", () => {
	assert.deepEqual(atRangeAt("@", 1), { start: 0, end: 1, query: "", quoted: false });
	assert.deepEqual(atRangeAt("hi @fo", 6), { start: 3, end: 6, query: "fo", quoted: false });
	// 开括号可剥离，query 不含括号
	assert.deepEqual(atRangeAt("(@foo", 5), { start: 1, end: 5, query: "foo", quoted: false });
	// 只认光标所在行
	assert.deepEqual(atRangeAt("first line\n@src", 15), { start: 11, end: 15, query: "src", quoted: false });
});

test("atRangeAt 处理带空格路径与未闭合引号", () => {
	assert.deepEqual(atRangeAt('(@"C:/Program Files', 19), {
		start: 1,
		end: 19,
		query: "C:/Program Files",
		quoted: true,
	});
	assert.deepEqual(atRangeAt('@"a b', 5), { start: 0, end: 5, query: "a b", quoted: true });
});

test("atRangeAt 不在 token 中间或带选区时触发", () => {
	assert.equal(atRangeAt("a@b", 3), null);
	assert.equal(atRangeAt("email@example.com", 17), null);
	// 有选区（selectionEnd != caret）时不弹补全
	assert.equal(atRangeAt("@foo", 4, 2), null);
});

test("commandRangeAt 只在首行、无空格、无二级斜杠时触发", () => {
	assert.deepEqual(commandRangeAt("/", 1), { start: 0, end: 1, query: "" });
	assert.deepEqual(commandRangeAt("  /he", 5), { start: 2, end: 5, query: "he" });
	assert.equal(commandRangeAt("/model x", 8), null);
	assert.equal(commandRangeAt("first\n/model", 12), null);
	assert.equal(commandRangeAt("/a/b", 4), null);
	assert.equal(commandRangeAt("text /he", 8), null);
});

test("rankFiles 按名称、前缀、路径与目录加权排序", () => {
	const files = [
		{ path: "src/app.js", dir: false },
		{ path: "src", dir: true },
		{ path: "app.js", dir: false },
		{ path: "docs/app.md", dir: false },
		{ path: "a/b/c/app.js", dir: false },
	];
	assert.deepEqual(
		rankFiles(files, "app.js").map((f) => f.path),
		["app.js", "src/app.js", "a/b/c/app.js"],
	);
	assert.deepEqual(
		rankFiles(files, "app").map((f) => f.path),
		["app.js", "src/app.js", "docs/app.md", "a/b/c/app.js"],
	);
	// 空 query：浅层优先，同层目录优先
	assert.deepEqual(
		rankFiles(files, "").slice(0, 2).map((f) => f.path),
		["src", "app.js"],
	);
	// 子序列兜底
	assert.deepEqual(rankFiles(files, "apj").map((f) => f.path), ["app.js", "src/app.js", "a/b/c/app.js"]);
	assert.equal(rankFiles(files, "app", 2).length, 2);
});

test("rankCommands 让 skill: 前缀不压过真实命令名", () => {
	const commands = [
		{ name: "model" },
		{ name: "skill:pdf" },
		{ name: "compact" },
		{ name: "skill:model" },
	];
	assert.deepEqual(
		rankCommands(commands, "pdf").map((c) => c.name),
		["skill:pdf"],
	);
	// bare 前缀 90 分，name 前缀 85 分
	assert.deepEqual(
		rankCommands(commands, "model").map((c) => c.name),
		["model", "skill:model"],
	);
	assert.deepEqual(
		rankCommands(commands, "").map((c) => c.name),
		["compact", "model", "skill:model", "skill:pdf"],
	);
});
