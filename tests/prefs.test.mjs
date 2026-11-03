import { test } from "node:test";
import assert from "node:assert/strict";
import { clampFontSize, fontSizeSpec, resolveTheme, sanitizeFontFamily } from "../src/core/prefs.js";

test("resolveTheme：显式偏好优先，system 跟随系统", () => {
	assert.equal(resolveTheme("light", true), "light");
	assert.equal(resolveTheme("dark", false), "dark");
	assert.equal(resolveTheme("system", true), "dark");
	assert.equal(resolveTheme("system", false), "light");
	assert.equal(resolveTheme("garbage", true), "dark");
});

test("clampFontSize：夹在范围内，非法值回退，半像素取整", () => {
	assert.equal(clampFontSize(14, 14, 10, 22), 14);
	assert.equal(clampFontSize(9, 14, 10, 22), 10);
	assert.equal(clampFontSize(30, 14, 10, 22), 22);
	assert.equal(clampFontSize("12.5", 14, 10, 22), 12.5);
	assert.equal(clampFontSize("abc", 14, 10, 22), 14);
});

test("sanitizeFontFamily：去掉会截断 CSS 的字符并限长", () => {
	assert.equal(sanitizeFontFamily("Microsoft YaHei UI"), "Microsoft YaHei UI");
	assert.equal(sanitizeFontFamily("Foo; color:red }"), "Foo color:red");
	assert.equal(sanitizeFontFamily(123), "123");
	assert.equal(sanitizeFontFamily("x".repeat(300)).length, 160);
});

test("fontSizeSpec：三类字号的范围固定", () => {
	assert.deepEqual(fontSizeSpec("body"), { key: "body", fallback: 14, min: 10, max: 22 });
	assert.deepEqual(fontSizeSpec("code"), { key: "code", fallback: 12.5, min: 9, max: 20 });
	assert.deepEqual(fontSizeSpec("term"), { key: "term", fallback: 12.5, min: 9, max: 20 });
});
