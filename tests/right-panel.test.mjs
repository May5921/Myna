import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeUrl } from "../src/features/right-panel.js";

test("normalizeUrl 补全裸域名并只放行 http(s)", () => {
	assert.equal(normalizeUrl("example.com"), "https://example.com/");
	assert.equal(normalizeUrl("example.com/a?b=1"), "https://example.com/a?b=1");
	assert.equal(normalizeUrl("localhost:3000"), "http://localhost:3000/");
	assert.equal(normalizeUrl("127.0.0.1"), "http://127.0.0.1/");
	assert.equal(normalizeUrl("http://example.com/x"), "http://example.com/x");
	assert.equal(normalizeUrl("https://example.com"), "https://example.com/");
});

test("normalizeUrl 拒绝空值、非 http(s) 与无法解析的输入", () => {
	assert.equal(normalizeUrl(""), null);
	assert.equal(normalizeUrl("   "), null);
	assert.equal(normalizeUrl("ftp://example.com"), null);
	assert.equal(normalizeUrl("file:///C:/Windows"), null);
	assert.equal(normalizeUrl("javascript:alert(1)"), null);
	assert.equal(normalizeUrl("http://"), null);
});
