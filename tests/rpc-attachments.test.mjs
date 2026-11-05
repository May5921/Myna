import { test } from "node:test";
import assert from "node:assert/strict";

import { composeMessage, splitAttachments, toRpcImages } from "../src/core/rpc-attachments.js";

test("splitAttachments 把文档和图片分开，丢弃没有数据的图片", () => {
	const { docs, images } = splitAttachments([
		{ kind: "doc", name: "a.pdf", text: "pdf text" },
		{ data: "abc", mimeType: "image/png", name: "a.png" },
		{ data: "", mimeType: "image/png" },
		null,
	]);
	assert.equal(docs.length, 1);
	assert.equal(images.length, 1);
	assert.equal(images[0].name, "a.png");
});

test("composeMessage 把文档正文拼在用户文本后面", () => {
	assert.equal(composeMessage("看这个", [{ name: "a.pdf", text: "hello" }]), "看这个\n\n[a.pdf]\nhello");
	assert.equal(composeMessage("", [{ name: "a.pdf", text: "hello" }]), "[a.pdf]\nhello");
	assert.equal(composeMessage("  only text  ", []), "only text");
	assert.equal(composeMessage("", []), "");
});

test("toRpcImages 只保留 pi 认识的字段", () => {
	assert.deepEqual(
		toRpcImages([
			{ data: "abc", mimeType: "image/png", name: "a.png", url: "data:x", w: 10, h: 20 },
			{ data: "def" },
			{ data: "" },
		]),
		[
			{ type: "image", data: "abc", mimeType: "image/png" },
			{ type: "image", data: "def", mimeType: "image/jpeg" },
		],
	);
});
