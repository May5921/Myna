import test from "node:test";
import assert from "node:assert/strict";
import {
	applyHistoryToolResult,
	applyAssistantEvent,
	assistantFromHistory,
	createAssistantMessage,
	finishAssistantMessage,
	startAssistantMessage,
} from "../src/core/assistant-message.js";

test("assistant message keeps pi thinking and text deltas in one state", () => {
	let state = startAssistantMessage(createAssistantMessage(), { id: "m1" });
	state = applyAssistantEvent(state, { type: "thinking_start" });
	state = applyAssistantEvent(state, { type: "thinking_delta", delta: "先看" });
	state = applyAssistantEvent(state, { type: "thinking_delta", delta: "上下文" });
	state = applyAssistantEvent(state, { type: "thinking_end" });
	state = applyAssistantEvent(state, { type: "text_delta", delta: "完成" });

	assert.equal(state.id, "m1");
	assert.equal(state.thinking, "先看上下文");
	assert.equal(state.thinkingState, "done");
	assert.equal(state.text, "完成");
	assert.equal(state.phase, "streaming");
});

test("message_end stores the pi final message without discarding streamed text", () => {
	let state = startAssistantMessage(createAssistantMessage(), { id: "m2" });
	state = applyAssistantEvent(state, { type: "text_delta", delta: "流式" });
	state = finishAssistantMessage(state, {
		id: "m2",
		role: "assistant",
		content: [{ type: "text", text: "流式终稿" }],
		usage: { output: 4 },
	});

	assert.equal(state.phase, "ended");
	assert.equal(state.text, "流式终稿");
	assert.equal(state.finalMessage.id, "m2");
	assert.deepEqual(state.usage, { output: 4 });
});

test("final thinking content wins when pi sends a complete block at the end", () => {
	let state = startAssistantMessage(createAssistantMessage(), { id: "m3" });
	state = applyAssistantEvent(state, { type: "thinking_delta", delta: "片段" });
	state = finishAssistantMessage(state, {
		content: [
			{ type: "thinking", thinking: "完整思考" },
			{ type: "text", text: "答案" },
		],
	});

	assert.equal(state.thinking, "完整思考");
	assert.equal(state.text, "答案");
});

test("a new assistant start creates an independent message state", () => {
	let state = startAssistantMessage(createAssistantMessage(), { id: "old" });
	state = applyAssistantEvent(state, { type: "text_delta", delta: "旧" });
	const next = startAssistantMessage(state, { id: "new" });

	assert.equal(next.id, "new");
	assert.equal(next.text, "");
	assert.equal(next.thinking, "");
	assert.equal(next.phase, "streaming");
});

test("tool start and end stay attached to the assistant message", () => {
	let state = startAssistantMessage(createAssistantMessage(), { id: "m4" });
	state = applyAssistantEvent(state, {
		type: "tool_execution_start",
		toolCallId: "call-1",
		toolName: "read",
		args: { path: "app.js" },
	});
	state = applyAssistantEvent(state, {
		type: "tool_execution_end",
		toolCallId: "call-1",
		result: { content: [{ type: "text", text: "ok" }] },
		durationMs: 12,
	});

	assert.deepEqual(state.tools, [
		{
			id: "call-1",
			name: "read",
			args: { path: "app.js" },
			status: "ended",
			partialResult: null,
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
			durationMs: 12,
		},
	]);
});

test("unknown or duplicate tool ends do not mutate the message", () => {
	let state = startAssistantMessage(createAssistantMessage(), { id: "m5" });
	const unknown = applyAssistantEvent(state, { type: "tool_execution_end", toolCallId: "missing" });
	assert.strictEqual(unknown, state);

	state = applyAssistantEvent(state, { type: "tool_execution_start", toolCallId: "call-2", toolName: "read" });
	state = applyAssistantEvent(state, { type: "tool_execution_end", toolCallId: "call-2", result: "first" });
	const duplicate = applyAssistantEvent(state, { type: "tool_execution_end", toolCallId: "call-2", result: "second" });
	assert.strictEqual(duplicate, state);
});

test("history assistant messages use the same text, thinking, and tool model", () => {
	let state = assistantFromHistory({
		id: "history-1",
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "先检查" },
			{ type: "text", text: "已完成" },
			{ type: "toolCall", id: "call-history", name: "read", arguments: { path: "app.js" } },
		],
	});
	assert.equal(state.phase, "ended");
	assert.equal(state.thinking, "先检查");
	assert.equal(state.text, "已完成");
	assert.equal(state.tools[0].status, "running");

	state = applyHistoryToolResult(state, {
		toolCallId: "call-history",
		content: [{ type: "text", text: "ok" }],
	});
	assert.equal(state.tools[0].status, "ended");
	assert.equal(state.tools[0].result.content[0].text, "ok");
});

test("tool updates replace the latest partial result and late updates are ignored", () => {
	let state = startAssistantMessage(createAssistantMessage(), { id: "m-update" });
	state = applyAssistantEvent(state, {
		type: "tool_execution_start",
		toolCallId: "call-update",
		toolName: "bash",
	});
	state = applyAssistantEvent(state, {
		type: "tool_execution_update",
		toolCallId: "call-update",
		partialResult: { content: [{ type: "text", text: "one" }] },
	});
	state = applyAssistantEvent(state, {
		type: "tool_execution_update",
		toolCallId: "call-update",
		partialResult: { content: [{ type: "text", text: "two" }] },
	});
	assert.equal(state.tools[0].partialResult.content[0].text, "two");
	state = applyAssistantEvent(state, {
		type: "tool_execution_end",
		toolCallId: "call-update",
		result: { content: [{ type: "text", text: "done" }] },
	});
	const late = applyAssistantEvent(state, {
		type: "tool_execution_update",
		toolCallId: "call-update",
		partialResult: { content: [{ type: "text", text: "late" }] },
	});
	assert.strictEqual(late, state);
	assert.equal(state.tools[0].partialResult, null);
});

test("nested tool events stay out of the top-level message", () => {
	let state = startAssistantMessage(createAssistantMessage(), { id: "m-nested" });
	const next = applyAssistantEvent(state, {
		type: "tool_execution_start",
		toolCallId: "child",
		toolName: "read",
		parentToolCallId: "parent",
	});
	assert.strictEqual(next, state);
});
