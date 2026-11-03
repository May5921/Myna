import { test } from "node:test";
import assert from "node:assert/strict";

import {
	activeChainUserEntries,
	messageText,
	pickForkEntry,
	treeFromEntries,
} from "../src/core/fork-target.js";

const userEntry = (id, parentId, text) => ({
	type: "message",
	id,
	parentId,
	message: { role: "user", content: [{ type: "text", text }] },
});
const assistantEntry = (id, parentId, text) => ({
	type: "message",
	id,
	parentId,
	message: { role: "assistant", content: [{ type: "text", text }] },
});
const node = (entry, ...children) => ({ entry, children });

// 活动链：u1 → a1 → u2 → a2 → u3；另一条分支从 u1 岔出去（追加时间更晚）
function fixture() {
	const u1 = userEntry("u1", null, "继续");
	const a1 = assistantEntry("a1", "u1", "好");
	const u2 = userEntry("u2", "a1", "继续");
	const a2 = assistantEntry("a2", "u2", "好");
	const u3 = userEntry("u3", "a2", "换个话题");
	const u2b = userEntry("u2b", "a1", "继续"); // 其它分支上的同名消息
	const a2b = assistantEntry("a2b", "u2b", "好");
	const tree = [node(u1, node(a1, node(u2, node(a2, node(u3))), node(u2b, node(a2b))))];
	return { tree, leafId: "u3" };
}

const chainOf = (tree, leafId) => activeChainUserEntries({ tree, leafId });

test("activeChainUserEntries 只取活动链、按 root→leaf 排序", () => {
	const { tree, leafId } = fixture();
	assert.deepEqual(chainOf(tree, leafId).map((e) => e.id), ["u1", "u2", "u3"]);
});

test("activeChainUserEntries 支持 get_entries 的扁平数组", () => {
	const { tree, leafId } = fixture();
	const entries = [];
	const collect = (n) => {
		entries.push(n.entry);
		for (const c of n.children) collect(c);
	};
	for (const r of tree) collect(r);
	// 打乱顺序，验证是按 parentId 建树而不是按数组顺序
	entries.reverse();
	assert.deepEqual(activeChainUserEntries({ entries, leafId }).map((e) => e.id), ["u1", "u2", "u3"]);
});

test("treeFromEntries 把孤儿/自环收成根，不丢条目", () => {
	const entries = [
		{ id: "a", parentId: null },
		{ id: "b", parentId: "missing" },
		{ id: "c", parentId: "c" },
		{ id: "d", parentId: "a" },
	];
	const { tree } = treeFromEntries(entries, "d");
	assert.equal(tree.length, 3);
	const ids = new Set(tree.map((n) => n.entry.id));
	assert.deepEqual([...ids].sort(), ["a", "b", "c"]);
});

test("activeChainUserEntries 对环和缺 id 不挂死", () => {
	const a = userEntry("a", "b", "x");
	const b = userEntry("b", "a", "y");
	const users = chainOf([node(a, node(b))], "b");
	assert.deepEqual(users.map((e) => e.id), ["a", "b"]);
	assert.deepEqual(activeChainUserEntries(null), []);
});

test("重复文本按从末尾数定位，而不是命中第一条", () => {
	const { tree, leafId } = fixture();
	const users = chainOf(tree, leafId);
	// DOM 里的第 2 条用户消息（u2），后面还有 1 条
	assert.deepEqual(pickForkEntry({ users, messages: [], text: "继续", rowIndexFromEnd: 1 }), {
		entryId: "u2",
		source: "tree",
	});
	// 第 1 条（u1），后面 2 条
	assert.equal(pickForkEntry({ users, messages: [], text: "继续", rowIndexFromEnd: 2 }).entryId, "u1");
});

test("纯图片消息没有文本，也能按位置定位", () => {
	const u1 = { type: "message", id: "u1", parentId: null, message: { role: "user", content: [] } };
	const a1 = assistantEntry("a1", "u1", "收到");
	const u2 = userEntry("u2", "a1", "下一步");
	const tree = [node(u1, node(a1, node(u2)))];
	const users = chainOf(tree, "u2");
	assert.deepEqual(pickForkEntry({ users, messages: [], text: "", rowIndexFromEnd: 1 }), {
		entryId: "u1",
		source: "tree",
	});
});

test("活动链数量与 DOM 不一致时，就近取同文本的消息", () => {
	const { tree, leafId } = fixture();
	// 假设 DOM 比活动链多了一条（本地回显），fromEnd 指向 u3，但文本是「继续」
	const users = chainOf(tree, leafId);
	assert.deepEqual(pickForkEntry({ users, messages: [], text: "继续", rowIndexFromEnd: 0 }), {
		entryId: "u2",
		source: "tree",
	});
});

test("get_entries 不可用时退回 fork 列表，同样按末尾对齐", () => {
	const messages = [
		{ entryId: "a", text: "继续" },
		{ entryId: "b", text: "继续" },
		{ entryId: "c", text: "换个话题" },
		{ entryId: "d", text: "继续" }, // 其它分支，追加更晚
	];
	assert.deepEqual(pickForkEntry({ users: [], messages, text: "继续", rowIndexFromEnd: 1 }), {
		entryId: "b",
		source: "fork-list",
	});
	assert.deepEqual(pickForkEntry({ users: [], messages, text: "换个话题", rowIndexFromEnd: 1 }), {
		entryId: "c",
		source: "fork-list",
	});
});

test("完全找不到时返回 null，不猜", () => {
	assert.equal(pickForkEntry({ users: [], messages: [{ entryId: "a", text: "甲" }], text: "乙", rowIndexFromEnd: 0 }), null);
	assert.equal(pickForkEntry({ users: [], messages: [], text: "", rowIndexFromEnd: 0 }), null);
});

test("messageText 只拼接 text 块", () => {
	assert.equal(messageText({ content: "abc" }), "abc");
	assert.equal(
		messageText({ content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] }),
		"ab",
	);
	assert.equal(messageText(null), "");
});
