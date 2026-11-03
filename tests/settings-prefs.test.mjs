// src/app.js 里读偏好依赖顶层 document/localStorage 与 Electron 运行时，无法在纯 Node 下导入。
// 这里改为直接测 src/features 里现成的纯函数模块（json-view、extension-ui），
// 它们不碰 DOM、不碰 ctx，可被 Node 22 直接 import。
import { test } from "node:test";
import assert from "node:assert/strict";

import {
	buildTree,
	parseJsonText,
	summarizeValue,
	MAX_JSON_BYTES,
} from "../src/features/json-view.js";
import {
	buildResponse,
	isModalMethod,
	remainingMs,
	stripAnsi,
	visibleStatusRows,
} from "../src/features/extension-ui.js";

test("parseJsonText：只接受 object / array，其余按原因拒绝", () => {
	assert.deepEqual(parseJsonText('{"a":1}'), { ok: true, value: { a: 1 } });
	assert.deepEqual(parseJsonText(" [1,2] "), { ok: true, value: [1, 2] });

	assert.equal(parseJsonText(42).reason, "type");
	assert.equal(parseJsonText("   ").reason, "empty");
	assert.equal(parseJsonText("not json").reason, "invalid");
	assert.equal(parseJsonText("null").reason, "scalar");
	assert.equal(parseJsonText("123").reason, "scalar");
	assert.equal(parseJsonText('"str"').reason, "scalar");
	// 用很小的 maxBytes 验证大小限制（不真的构造 2MB 字符串）
	assert.equal(parseJsonText('{"a":1}', 3).reason, "too-large");
	assert.equal(MAX_JSON_BYTES, 2 * 1024 * 1024);
});

test("summarizeValue：类型、摘要与 size", () => {
	assert.deepEqual(summarizeValue([1, 2, 3]), { kind: "array", summary: "[…]", size: 3 });
	assert.deepEqual(summarizeValue({ a: 1 }), { kind: "object", summary: "{…}", size: 1 });
	assert.equal(summarizeValue(null).kind, "null");
	assert.equal(summarizeValue(true).summary, "true");
	assert.equal(summarizeValue(false).summary, "false");
	assert.equal(summarizeValue(7).summary, "7");
	assert.equal(summarizeValue("hi").summary, '"hi"');
});

test("buildTree：预序建树、openDepth 与 maxNodes 截断", () => {
	const { root, count, omitted, truncated } = buildTree({ a: { b: { c: 1 } } });
	assert.equal(root.kind, "object");
	assert.equal(root.open, true); // depth 0 < 2
	assert.equal(root.children[0].open, true); // depth 1 < 2
	assert.equal(root.children[0].children[0].open, false); // depth 2，不再展开
	assert.equal(count, 4);
	assert.equal(truncated, false);

	const big = buildTree(Array.from({ length: 10 }, (_, i) => i), { maxNodes: 3 });
	assert.equal(big.count, 3);
	assert.equal(big.omitted, 8);
	assert.equal(big.truncated, true);
});

test("isModalMethod / buildResponse：只回应阻塞式弹窗", () => {
	assert.equal(isModalMethod("select"), true);
	assert.equal(isModalMethod("editor"), true);
	assert.equal(isModalMethod("notify"), false);
	assert.equal(isModalMethod(undefined), false);

	assert.equal(buildResponse({ id: "", method: "select" }, { value: "x" }), null);
	assert.equal(buildResponse({ id: "1", method: "notify" }, { value: "x" }), null);

	assert.deepEqual(buildResponse({ id: "2", method: "confirm" }), {
		type: "extension_ui_response",
		id: "2",
		confirmed: false,
	});
	assert.deepEqual(buildResponse({ id: "3", method: "confirm" }, { confirmed: true }), {
		type: "extension_ui_response",
		id: "3",
		confirmed: true,
	});
	assert.deepEqual(buildResponse({ id: "4", method: "input" }, { value: 42 }), {
		type: "extension_ui_response",
		id: "4",
		value: "42",
	});
	// cancelled 优先于具体字段
	assert.deepEqual(buildResponse({ id: "5", method: "select" }, { cancelled: true, value: "x" }), {
		type: "extension_ui_response",
		id: "5",
		cancelled: true,
	});
});

test("remainingMs：倒计时永不为负", () => {
	assert.equal(remainingMs(1000, 400), 600);
	assert.equal(remainingMs(1000, 1000), 0);
	assert.equal(remainingMs(1000, 2000), 0);
	assert.equal(remainingMs(undefined, 1), 0);
});

test("stripAnsi：剥掉 CSI / OSC / 落单 ESC", () => {
	assert.equal(stripAnsi("plain"), "plain");
	assert.equal(stripAnsi("\u001b[31mred\u001b[39m"), "red");
	assert.equal(stripAnsi("\u001b[38;2;51;126;88m● 完成\u001b[39m"), "● 完成");
	assert.equal(stripAnsi("\u001b]0;title\u0007ok"), "ok");
	assert.equal(stripAnsi("\u001b[?25lhidden"), "hidden");
	assert.equal(stripAnsi(null), "");
});

test("visibleStatusRows：按行数截断并加省略号", () => {
	const rows = visibleStatusRows(
		[
			{ key: "a", lines: ["1", "2", "3"] },
			{ key: "b", lines: ["4"] },
		],
		2,
	);
	assert.deepEqual(rows, [{ key: "a", lines: ["1", "2…"] }]);

	// 空输入与无 lines 的条目安全跳过
	assert.deepEqual(visibleStatusRows(null, 3), []);
	assert.deepEqual(visibleStatusRows([{ key: "x" }], 3), []);
});
