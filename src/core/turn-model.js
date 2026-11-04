// pi 回合状态：只描述生命周期和统计，不碰 DOM、不依赖 Electron。
// 渲染层可以据此决定运行态、工具数量和结算结果。

import {
	applyAssistantEvent,
	createAssistantMessage,
	finishAssistantMessage,
	revealAllAssistantText,
	revealAssistantText,
	settleAssistantMessage,
	startAssistantMessage,
} from "./assistant-message.js";

export const TURN_PHASES = Object.freeze(["idle", "running", "settled"]);
export const TURN_OUTCOMES = Object.freeze(["ok", "aborted", "failed"]);

export function createTurnState() {
	return {
		phase: "idle",
		startedAt: 0,
		assistantMessages: 0,
		toolCount: 0,
		aborted: false,
		outcome: null,
		messages: [],
		activeMessageIndex: -1,
	};
}

export function beginTurn(state, startedAt = 0) {
	const current = state && typeof state === "object" ? state : createTurnState();
	if (current.phase === "running") return current;
	return {
		phase: "running",
		startedAt: Number.isFinite(startedAt) ? startedAt : 0,
		assistantMessages: 0,
		toolCount: 0,
		aborted: false,
		outcome: null,
		messages: [],
		activeMessageIndex: -1,
	};
}

export function noteAssistantMessage(state, message = {}) {
	const current = state && typeof state === "object" ? state : createTurnState();
	if (current.phase !== "running") return current;
	const nextMessage = startAssistantMessage(createAssistantMessage(), message);
	return {
		...current,
		assistantMessages: current.assistantMessages + 1,
		messages: [...current.messages, nextMessage],
		activeMessageIndex: current.messages.length,
	};
}

export function noteToolStart(state, toolCallId = null) {
	const current = state && typeof state === "object" ? state : createTurnState();
	if (current.phase !== "running") return current;
	if (toolCallId != null) {
		const active = currentAssistantMessage(current);
		const id = String(toolCallId);
		if (active?.tools.some((tool) => tool.id === id)) return current;
	}
	return { ...current, toolCount: current.toolCount + 1 };
}

export function requestAbort(state) {
	const current = state && typeof state === "object" ? state : createTurnState();
	if (current.phase !== "running") return current;
	return { ...current, aborted: true };
}

export function settleTurn(state, outcome = "ok") {
	const current = state && typeof state === "object" ? state : createTurnState();
	const normalized = TURN_OUTCOMES.includes(outcome) ? outcome : "failed";
	const messages = current.messages.map((message) =>
		message.phase === "settled" ? message : settleAssistantMessage(message, normalized),
	);
	return {
		...current,
		phase: "settled",
		outcome: normalized,
		aborted: normalized === "aborted" || current.aborted,
		messages,
	};
}

export function resetTurn() {
	return createTurnState();
}

export function currentAssistantMessage(state) {
	const current = state && typeof state === "object" ? state : createTurnState();
	return current.messages[current.activeMessageIndex] ?? null;
}

function updateCurrentMessage(state, update) {
	const current = state && typeof state === "object" ? state : createTurnState();
	const index = current.activeMessageIndex;
	if (index < 0 || !current.messages[index]) return current;
	const message = update(current.messages[index]);
	if (message === current.messages[index]) return current;
	const messages = current.messages.slice();
	messages[index] = message;
	return { ...current, messages };
}

function ensureActiveMessage(state) {
	const current = state && typeof state === "object" ? state : createTurnState();
	if (current.activeMessageIndex >= 0 || current.phase !== "running") return current;
	return noteAssistantMessage(current);
}

export function applyAssistantEventToTurn(state, event) {
	return updateCurrentMessage(ensureActiveMessage(state), (message) => applyAssistantEvent(message, event));
}

export function finishAssistantMessageInTurn(state, message) {
	return updateCurrentMessage(ensureActiveMessage(state), (current) => finishAssistantMessage(current, message));
}

export function revealAssistantTextInTurn(state, text) {
	return updateCurrentMessage(ensureActiveMessage(state), (current) => revealAssistantText(current, text));
}

export function revealAllAssistantTextInTurn(state) {
	return updateCurrentMessage(ensureActiveMessage(state), (current) => revealAllAssistantText(current));
}
