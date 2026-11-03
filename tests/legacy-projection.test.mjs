// 投影层测试：IR 事件 → 旧 pi 事件，以及旧命令 → IR 命令。
import { test } from "node:test";
import assert from "node:assert/strict";

import { createProjection, projectHistory, projectSessions, toIRCommand } from "../src/core/legacy-projection.js";

function setup() {
	const events = [];
	const projection = createProjection({ emit: (event) => events.push(event) });
	return { events, projection };
}

test("正文与思考按旧事件形状投影，message_end 带上完整内容", () => {
	const { events, projection } = setup();
	projection.push({ type: "turn.start", sessionId: "s1" });
	projection.push({ type: "reason.delta", sessionId: "s1", delta: "想一" });
	projection.push({ type: "reason.delta", sessionId: "s1", delta: "想二" });
	projection.push({ type: "text.delta", sessionId: "s1", delta: "你" });
	projection.push({ type: "text.delta", sessionId: "s1", delta: "好" });
	projection.push({ type: "usage", sessionId: "s1", input: 10, output: 2, cost: 0.1 });
	projection.push({ type: "text.done", sessionId: "s1", text: "你好" });
	projection.push({ type: "turn.end", sessionId: "s1", outcome: "ok" });

	assert.deepEqual(events[0], { type: "agent_start" });
	assert.deepEqual(events[1], { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "想一" } });
	assert.deepEqual(events[3], { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "你" } });
	const end = events.find((event) => event.type === "message_end");
	assert.deepEqual(end.message, {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "想一想二" },
			{ type: "text", text: "你好" },
		],
		usage: { input: 10, output: 2, cost: 0.1 },
	});
	assert.deepEqual(events.at(-1), { type: "agent_settled" });
});

test("空 text.done 不覆盖流式缓冲；下一轮重置思考与 usage", () => {
	const { events, projection } = setup();
	projection.push({ type: "turn.start", sessionId: "s1" });
	projection.push({ type: "reason.delta", sessionId: "s1", delta: "旧思考" });
	projection.push({ type: "usage", sessionId: "s1", input: 1, output: 1 });
	projection.push({ type: "text.done", sessionId: "s1", text: "" });
	assert.equal(events.some((event) => event.type === "message_end"), false);

	projection.push({ type: "turn.start", sessionId: "s1" });
	projection.push({ type: "text.done", sessionId: "s1", text: "新" });
	const end = events.at(-1);
	assert.deepEqual(end.message.content, [{ type: "text", text: "新" }]);
	assert.equal(end.message.usage, undefined);
});

test("定稿后才到的 usage 丢弃，不贴给下一条消息", () => {
	const { events, projection } = setup();
	projection.push({ type: "turn.start", sessionId: "s1" });
	projection.push({ type: "text.delta", sessionId: "s1", delta: "一" });
	projection.push({ type: "text.done", sessionId: "s1", text: "一" });
	// usage 在正文定稿之后到达时应被丢弃
	projection.push({ type: "usage", sessionId: "s1", input: 9, output: 7 });
	projection.push({ type: "text.delta", sessionId: "s1", delta: "二" });
	projection.push({ type: "text.done", sessionId: "s1", text: "二" });

	const ends = events.filter((event) => event.type === "message_end");
	assert.equal(ends.length, 2);
	assert.equal(ends[0].message.usage, undefined);
	assert.equal(ends[1].message.usage, undefined, "usage 不能跨消息归属");
});

test("工具开始/结束映射成 tool_execution_*", () => {
	const { events, projection } = setup();
	projection.push({ type: "tool.start", sessionId: "s1", toolCallId: "t1", name: "bash", args: { cmd: "ls" } });
	projection.push({ type: "tool.end", sessionId: "s1", toolCallId: "t1", ok: false, output: "boom", diff: "-a\n+b", durationMs: 12 });

	assert.deepEqual(events[0], { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { cmd: "ls" } });
	assert.deepEqual(events[1], {
		type: "tool_execution_end",
		toolCallId: "t1",
		isError: true,
		result: { content: [{ type: "text", text: "boom" }], details: { diff: "-a\n+b" } },
		durationMs: 12,
	});
});

test("会话元信息与错误走旧事件", () => {
	const { events, projection } = setup();
	projection.push({ type: "session.meta", sessionId: "s1", title: "标题", model: "m" });
	projection.push({ type: "error", sessionId: "s1", message: "recoverable" });
	projection.push({ type: "error", sessionId: "s1", message: "dead", fatal: true });

	assert.deepEqual(events[0], { type: "session_info_changed", name: "标题", model: "m" });
	assert.deepEqual(events[1], { type: "error", message: "recoverable" });
	assert.deepEqual(events[2], { type: "error", message: "dead", fatal: true });
	assert.deepEqual(events[3], { type: "process_exit", code: null, message: "dead" });
});

test("历史消息补成渲染层读的 content block", () => {
	const rows = projectHistory([
		{ role: "user", text: "你好", ts: 1 },
		{ role: "assistant", text: "", content: [{ type: "text", text: "已有 content" }] },
	]);
	assert.deepEqual(rows, [
		{ role: "user", text: "你好", content: [{ type: "text", text: "你好" }], ts: 1 },
		{ role: "assistant", text: "", content: [{ type: "text", text: "已有 content" }] },
	]);
});

test("会话 id 映射到 UI 的 path 字段，不伪造文件路径", () => {	const rows = projectSessions([{ id: "ses_1", title: "T", updatedAt: 7, cwd: "C:/w" }], "C:/fallback");
	assert.deepEqual(rows, [{ path: "ses_1", id: "ses_1", cwd: "C:/w", timestamp: 7, name: null, title: "T" }]);
	assert.equal(projectSessions([{ title: "no id" }]).length, 0);
});

test("旧命令映射到 IR，不支持的命令返回 null", () => {
	assert.deepEqual(toIRCommand({ type: "prompt", message: "hi" }), { type: "prompt", text: "hi" });
	assert.deepEqual(toIRCommand({ type: "prompt", text: "hi", images: ["a"] }), { type: "prompt", text: "hi", images: ["a"] });
	assert.deepEqual(toIRCommand({ type: "get_messages" }), { type: "load_history" });
	assert.deepEqual(toIRCommand({ type: "get_available_models" }), { type: "list_models" });
	assert.deepEqual(toIRCommand({ type: "set_model", provider: "openai", modelId: "gpt" }), { type: "set_model", modelId: "openai/gpt" });
	assert.deepEqual(toIRCommand({ type: "set_session_name", name: "n" }), { type: "rename", title: "n" });
	assert.deepEqual(toIRCommand({ type: "fork", entryId: "e1" }), { type: "fork", messageId: "e1" });
	assert.deepEqual(toIRCommand({ type: "abort" }), { type: "abort" });
	assert.deepEqual(toIRCommand({ type: "compact" }), { type: "compact" });

	for (const type of ["get_tree", "get_session_stats", "get_commands", "follow_up", "steer", "set_thinking_level", "get_available_thinking_levels", "export_html"]) {
		assert.equal(toIRCommand({ type }), null, `${type} 应判为不支持`);
	}
});
