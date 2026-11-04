import { test } from "node:test";
import assert from "node:assert/strict";

import {
	applyAssistantEventToTurn,
	beginTurn,
	createTurnState,
	currentAssistantMessage,
	finishAssistantMessageInTurn,
	noteAssistantMessage,
	noteToolStart,
	requestAbort,
	revealAllAssistantTextInTurn,
	revealAssistantTextInTurn,
	resetTurn,
	settleTurn,
} from "../src/core/turn-model.js";

test("turn model tracks a pi turn from start to settle", () => {
	let turn = beginTurn(createTurnState(), 12);
	turn = noteAssistantMessage(turn);
	turn = noteToolStart(turn);
	turn = noteToolStart(turn);
	assert.deepEqual(turn, {
		phase: "running",
		startedAt: 12,
		assistantMessages: 1,
		toolCount: 2,
		aborted: false,
		outcome: null,
		messages: [
			{
				id: null,
				phase: "streaming",
				thinking: "",
				thinkingState: "idle",
				text: "",
				revealedText: "",
				pendingText: "",
				finalMessage: null,
				usage: null,
				tools: [],
			},
		],
		activeMessageIndex: 0,
	});
	assert.equal(settleTurn(turn, "ok").outcome, "ok");
});

test("duplicate start does not reset an active turn", () => {
	let turn = beginTurn(createTurnState(), 10);
	turn = noteToolStart(turn);
	assert.equal(beginTurn(turn, 20).startedAt, 10);
	assert.equal(beginTurn(turn, 20).toolCount, 1);
});

test("duplicate tool starts with the same call id are counted once", () => {
	let turn = beginTurn(createTurnState(), 10);
	turn = noteAssistantMessage(turn, { id: "m-tool" });
	turn = noteToolStart(turn, "call-1");
	turn = applyAssistantEventToTurn(turn, { type: "tool_execution_start", toolCallId: "call-1", toolName: "read" });
	turn = noteToolStart(turn, "call-1");
	assert.equal(turn.toolCount, 1);
});

test("abort is preserved when the late settle event arrives", () => {
	let turn = requestAbort(beginTurn(createTurnState(), 10));
	turn = settleTurn(turn, "ok");
	assert.equal(turn.phase, "settled");
	assert.equal(turn.aborted, true);
	assert.equal(resetTurn().phase, "idle");
});

test("turn model keeps multiple assistant messages and their tool state", () => {
	let turn = beginTurn(createTurnState(), 10);
	turn = noteAssistantMessage(turn, { id: "m1" });
	turn = applyAssistantEventToTurn(turn, { type: "text_delta", delta: "第一段" });
	turn = applyAssistantEventToTurn(turn, {
		type: "tool_execution_start",
		toolCallId: "call-1",
		toolName: "read",
	});
	turn = applyAssistantEventToTurn(turn, { type: "tool_execution_end", toolCallId: "call-1", result: "ok" });
	turn = finishAssistantMessageInTurn(turn, { id: "m1", content: [{ type: "text", text: "第一段" }] });
	turn = noteAssistantMessage(turn, { id: "m2" });
	turn = applyAssistantEventToTurn(turn, { type: "text_delta", delta: "第二段" });

	assert.equal(turn.messages.length, 2);
	assert.equal(turn.activeMessageIndex, 1);
	assert.equal(turn.messages[0].text, "第一段");
	assert.equal(turn.messages[0].tools[0].id, "call-1");
	assert.equal(turn.messages[1].text, "第二段");
	assert.equal(currentAssistantMessage(turn).id, "m2");
	const settled = settleTurn(turn, "ok");
	assert.equal(settled.messages[0].phase, "settled");
	assert.equal(settled.messages[1].phase, "settled");
	assert.equal(settled.messages[1].outcome, "ok");
});

test("turn model keeps the latest partial tool result before final result", () => {
	let turn = beginTurn(createTurnState(), 10);
	turn = noteAssistantMessage(turn, { id: "m-update" });
	turn = applyAssistantEventToTurn(turn, {
		type: "tool_execution_start",
		toolCallId: "call-update",
		toolName: "bash",
	});
	turn = applyAssistantEventToTurn(turn, {
		type: "tool_execution_update",
		toolCallId: "call-update",
		partialResult: { content: [{ type: "text", text: "latest" }] },
	});
	assert.equal(currentAssistantMessage(turn).tools[0].partialResult.content[0].text, "latest");
});

test("late reveal does not replace the pi final text before settle", () => {
	let turn = beginTurn(createTurnState(), 10);
	turn = noteAssistantMessage(turn, { id: "m6" });
	turn = applyAssistantEventToTurn(turn, { type: "text_delta", delta: "流" });
	turn = finishAssistantMessageInTurn(turn, {
		id: "m6",
		content: [{ type: "text", text: "流式终稿" }],
	});
	turn = revealAssistantTextInTurn(turn, "流");
	assert.equal(currentAssistantMessage(turn).text, "流式终稿");
	assert.equal(currentAssistantMessage(turn).revealedText, "流");
	turn = revealAllAssistantTextInTurn(turn);
	assert.equal(currentAssistantMessage(turn).pendingText, "");
	assert.equal(settleTurn(turn, "ok").messages[0].phase, "settled");
});
