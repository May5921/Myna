import { test } from "node:test";
import assert from "node:assert/strict";
import { imagesFromContent } from "../src/core/content-images.js";

test("imagesFromContent：识别 pi 的 data + mimeType", () => {
	const out = imagesFromContent([
		{ type: "text", text: "看图" },
		{ type: "image", data: "aGk=", mimeType: "image/jpeg" },
	]);
	assert.deepEqual(out, [{ url: "data:image/jpeg;base64,aGk=", name: "图片" }]);
});

test("imagesFromContent：兼容 source 形态与缺省 mime", () => {
	const out = imagesFromContent([
		{ type: "image", source: { data: "aGk=", media_type: "image/webp" } },
		{ type: "image", data: "aGk=" },
	]);
	assert.deepEqual(out.map((x) => x.url), [
		"data:image/webp;base64,aGk=",
		"data:image/png;base64,aGk=",
	]);
});

test("imagesFromContent：忽略空数据和非数组", () => {
	assert.deepEqual(imagesFromContent(null), []);
	assert.deepEqual(imagesFromContent([{ type: "image" }, { type: "text", text: "x" }]), []);
});
