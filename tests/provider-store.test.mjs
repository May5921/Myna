import { test } from "node:test";
import assert from "node:assert/strict";

import { PROVIDER_KEY, cleanProviderModels, maskKey } from "../src/core/provider-store.js";

test("maskKey 只回尾四位，保留环境变量表达式", () => {
	assert.equal(maskKey(""), "");
	assert.equal(maskKey("short"), "••••");
	assert.equal(maskKey("sk-1234567890"), "••••7890");
	assert.equal(maskKey("$OPENAI_API_KEY"), "$OPENAI_API_KEY");
	assert.equal(maskKey("!security find-password"), "!security find-password");
});

test("PROVIDER_KEY 拒绝前导符号和空值", () => {
	assert.equal(PROVIDER_KEY.test("openai"), true);
	assert.equal(PROVIDER_KEY.test("my.provider-1"), true);
	assert.equal(PROVIDER_KEY.test("-bad"), false);
	assert.equal(PROVIDER_KEY.test("bad key"), false);
});

test("cleanProviderModels 按 id 保留旧高级字段并规整输入", () => {
	const previous = [
		{
			id: "m1",
			name: "Old",
			reasoning: true,
			contextWindow: 999,
			maxTokens: 5,
			input: ["image"],
			thinkingLevelMap: { high: "high" },
			customField: "keep",
		},
	];
	const out = cleanProviderModels([{ id: " m1 ", name: "New" }], previous);
	assert.deepEqual(out, [
		{
			id: "m1",
			name: "New",
			reasoning: false,
			thinkingLevelMap: { high: "high" },
			input: ["image"],
			customField: "keep",
		},
	]);
});

test("cleanProviderModels 给新模型补默认 input 并过滤非法模态", () => {
	const out = cleanProviderModels(
		[
			{ id: "m2" },
			{ id: "m3", input: ["text", "audio", "image"], contextWindow: 1.6, maxTokens: 3.4 },
		],
		[],
	);
	assert.deepEqual(out[0], { id: "m2", reasoning: false, input: ["text"] });
	assert.deepEqual(out[1], {
		id: "m3",
		reasoning: false,
		contextWindow: 2,
		maxTokens: 3,
		input: ["text", "image"],
	});
});

test("cleanProviderModels 拒绝重复 ID 与空模型列表", () => {
	assert.throws(() => cleanProviderModels([{ id: "same" }, { id: "same" }], []), /重复/);
	assert.throws(() => cleanProviderModels([], []), /至少需要一个模型/);
	assert.deepEqual(cleanProviderModels([], [], true), []);
	// 只有空 id 等于没有模型：默认仍然报错，避免把用户的提供商清空
	assert.throws(() => cleanProviderModels([{ id: "  " }], []), /至少需要一个模型/);
});
