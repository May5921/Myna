import { test } from "node:test";
import assert from "node:assert/strict";

import { modelLabel, onboardingDone, readableError } from "../src/features/onboarding.js";

test("onboardingDone 只认明确的完成标记", () => {
	assert.equal(onboardingDone({ getItem: () => "1" }), true);
	assert.equal(onboardingDone({ getItem: () => "0" }), false);
	assert.equal(onboardingDone({ getItem: () => null }), false);
	assert.equal(onboardingDone({ getItem: () => { throw new Error("blocked"); } }), false);
});

test("modelLabel 显示 provider 和模型 id", () => {
	assert.equal(modelLabel({ provider: "deepseek", id: "v4" }), "deepseek · v4");
	assert.equal(modelLabel({ provider: "openai" }), "openai · 未命名");
	assert.equal(modelLabel(null), "");
});

test("readableError 去掉 IPC 前缀并兜底", () => {
	assert.equal(readableError(new Error("Error invoking remote method 'x': boom")), "boom");
	assert.equal(readableError(new Error("Error: bad key")), "bad key");
	assert.equal(readableError(null), "操作失败");
});
