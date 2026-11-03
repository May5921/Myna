import { test } from "node:test";
import assert from "node:assert/strict";

import {
	addStep,
	emptyMetrics,
	formatTokSpeed,
	mergeMetrics,
	normalizeMetrics,
	parseMetrics,
	summarizeMetrics,
} from "../src/core/metrics.js";

test("empty/normalize 把非法输入收成零值", () => {
	assert.deepEqual(emptyMetrics(), { v: 1, steps: 0, tokens: 0, decodeMs: 0, ttftMs: 0, ttftCount: 0 });
	assert.deepEqual(normalizeMetrics(null), emptyMetrics());
	assert.deepEqual(normalizeMetrics({ steps: -1, tokens: "x", decodeMs: NaN }), emptyMetrics());
});

test("addStep 累计 token/解码/TTFT，忽略没有正文的步骤", () => {
	let m = emptyMetrics();
	m = addStep(m, { tokens: 0, decodeMs: 0, ttftMs: 800 });
	assert.deepEqual(m, emptyMetrics(), "没有正文的步骤不计");

	m = addStep(m, { tokens: 100, decodeMs: 2000, ttftMs: 500 });
	m = addStep(m, { tokens: 50, decodeMs: 1000, ttftMs: 0 });
	assert.deepEqual(m, { v: 1, steps: 2, tokens: 150, decodeMs: 3000, ttftMs: 500, ttftCount: 1 });

	const sum = summarizeMetrics(m);
	assert.equal(sum.avgTps, 50);
	assert.equal(sum.avgTtftMs, 500);
	assert.equal(sum.steps, 2);
});

test("mergeMetrics 合并分桶并保留 TTFT 计数", () => {
	const a = addStep(emptyMetrics(), { tokens: 10, decodeMs: 1000, ttftMs: 200 });
	const b = addStep(emptyMetrics(), { tokens: 30, decodeMs: 3000, ttftMs: 0 });
	const merged = mergeMetrics(a, b);
	assert.deepEqual(merged, { v: 1, steps: 2, tokens: 40, decodeMs: 4000, ttftMs: 200, ttftCount: 1 });
});

test("parseMetrics 拒绝坏 JSON 和旧结构", () => {
	assert.deepEqual(parseMetrics("not json"), emptyMetrics());
	assert.deepEqual(parseMetrics(""), emptyMetrics());
	assert.deepEqual(parseMetrics(JSON.stringify({ steps: 3, tokens: 60, decodeMs: 2000 })), {
		v: 1,
		steps: 3,
		tokens: 60,
		decodeMs: 2000,
		ttftMs: 0,
		ttftCount: 0,
	});
});

test("formatTokSpeed 与 DSH 规则一致：≥10 取整，<10 一位小数", () => {
	assert.equal(formatTokSpeed(9.94), "9.9");
	assert.equal(formatTokSpeed(10), "10");
	assert.equal(formatTokSpeed(99.6), "100");
	assert.equal(formatTokSpeed(-5), "0");
	assert.equal(formatTokSpeed(NaN), "0");
});
