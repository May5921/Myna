import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSessionGroups, workspaceOrder } from "../src/core/session-groups.js";

test("workspaceOrder keeps current workspace first and removes duplicates", () => {
	// 顺序跟绑定顺序走，当前工作区不插队：否则每次切换整列都会跳一下
	assert.deepEqual(workspaceOrder("C:/work", ["C:/other", "C:/work", "C:/third"]), ["C:/other", "C:/work", "C:/third"]);
	// 当前工作区没绑定时补在末尾，保证它可见
	assert.deepEqual(workspaceOrder("C:/work", ["C:/other"]), ["C:/other", "C:/work"]);
});

test("buildSessionGroups applies search/archive filters and keeps pinned sessions first", () => {
	const sessions = [
		{ path: "s1", cwd: "C:/work", title: "普通会话" },
		{ path: "s2", cwd: "C:/work", title: "置顶会话" },
		{ path: "s3", cwd: "C:/other", title: "已归档" },
	];
	const groups = buildSessionGroups({
		sessions,
		cwd: "C:/work",
		projects: ["C:/other"],
		query: "会话",
		archiveFilter: "hide",
		archived: new Set(["s3"]),
		pinned: new Set(["s2"]),
	});
	assert.deepEqual(groups.map((group) => group.workspace), ["C:/other", "C:/work"]);
	assert.deepEqual(groups[0].sessions, []);
	assert.deepEqual(groups[1].sessions.map((session) => session.path), ["s2", "s1"]);
});

test("current archived session remains visible while hidden archive filter is active", () => {
	const groups = buildSessionGroups({
		sessions: [{ path: "s1", cwd: "C:/work", title: "已归档" }],
		cwd: "C:/work",
		projects: [],
		archiveFilter: "hide",
		archived: new Set(["s1"]),
		currentSession: "s1",
	});
	assert.deepEqual(groups[0].sessions.map((session) => session.path), ["s1"]);
});
