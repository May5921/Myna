// pi 原生 assistant 消息状态。
// 只保存事件语义，不保存 DOM；渲染层可以按自己的节奏消费 snapshot。

const textFromContent = (content) => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block?.type === "text")
		.map((block) => String(block.text ?? ""))
		.join("");
};

const thinkingFromContent = (content) => {
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block?.type === "thinking" && block.thinking)
		.map((block) => String(block.thinking))
		.join("\n\n");
};

export function createAssistantMessage(id = null) {
	return {
		id: id == null ? null : String(id),
		phase: "idle",
		thinking: "",
		thinkingState: "idle",
		text: "",
		revealedText: "",
		pendingText: "",
		finalMessage: null,
		usage: null,
		tools: [],
	};
}

export function startAssistantMessage(previous, message = {}) {
	const next = createAssistantMessage(message?.id ?? null);
	next.phase = "streaming";
	return next;
}

export function applyAssistantEvent(previous, event = {}) {
	const state = previous ?? createAssistantMessage();
	const type = event?.type;
	if (type === "thinking_start") {
		return { ...state, phase: "streaming", thinkingState: "running" };
	}
	if (type === "thinking_delta") {
		return {
			...state,
			phase: "streaming",
			thinking: state.thinking + String(event.delta ?? ""),
			thinkingState: "running",
		};
	}
	if (type === "thinking_end") {
		const content = thinkingFromContent(event.content) || String(event.content ?? "");
		return {
			...state,
			phase: "streaming",
			thinking: content || state.thinking,
			thinkingState: "done",
		};
	}
	if (type === "text_delta") {
		return {
			...state,
			phase: "streaming",
			text: state.text + String(event.delta ?? ""),
			pendingText: state.pendingText + String(event.delta ?? ""),
		};
	}
	if (type === "tool_execution_start") {
		if (event.parentToolCallId) return state;
		const id = event.toolCallId == null ? null : String(event.toolCallId);
		if (!id || state.tools.some((tool) => tool.id === id)) return state;
		return {
			...state,
			phase: "streaming",
			tools: [
				...state.tools,
				{
					id,
					name: String(event.toolName ?? ""),
					args: event.args ?? null,
					status: "running",
					partialResult: null,
					result: null,
					isError: false,
					durationMs: null,
				},
			],
		};
	}
	if (type === "tool_execution_update") {
		if (event.parentToolCallId) return state;
		const id = event.toolCallId == null ? null : String(event.toolCallId);
		if (!id) return state;
		let changed = false;
		const tools = state.tools.map((tool) => {
			if (tool.id !== id || tool.status === "ended") return tool;
			changed = true;
			return { ...tool, partialResult: event.partialResult ?? null };
		});
		return changed ? { ...state, tools } : state;
	}
	if (type === "tool_execution_end") {
		if (event.parentToolCallId) return state;
		const id = event.toolCallId == null ? null : String(event.toolCallId);
		if (!id) return state;
		let changed = false;
		const tools = state.tools.map((tool) => {
			if (tool.id !== id || tool.status === "ended") return tool;
			changed = true;
			return {
				...tool,
				status: "ended",
				partialResult: null,
				result: event.result ?? null,
				isError: Boolean(event.isError),
				durationMs: Number.isFinite(Number(event.durationMs)) ? Number(event.durationMs) : null,
			};
		});
		return changed ? { ...state, tools } : state;
	}
	return state;
}

export function finishAssistantMessage(previous, message = null) {
	const state = previous ?? createAssistantMessage();
	const finalText = textFromContent(message?.content);
	const finalThinking = thinkingFromContent(message?.content);
	return {
		...state,
		phase: "ended",
		text: finalText || state.text,
		thinking: finalThinking || state.thinking,
		thinkingState: state.thinking || finalThinking ? "done" : state.thinkingState,
		finalMessage: message ?? state.finalMessage,
		usage: message?.usage ?? state.usage,
	};
}

export function revealAssistantText(previous, text) {
	const state = previous ?? createAssistantMessage();
	const value = String(text ?? "");
	const pendingText = state.pendingText.startsWith(value) ? state.pendingText.slice(value.length) : state.pendingText;
	return { ...state, revealedText: state.revealedText + value, pendingText };
}

export function revealAllAssistantText(previous) {
	const state = previous ?? createAssistantMessage();
	return { ...state, revealedText: state.text, pendingText: "" };
}

export function settleAssistantMessage(previous, outcome = "ok") {
	const state = previous ?? createAssistantMessage();
	return {
		...state,
		phase: "settled",
		outcome: outcome === "aborted" || outcome === "failed" ? outcome : "ok",
	};
}

export function assistantTextFromContent(content) {
	return textFromContent(content);
}

export function assistantThinkingFromContent(content) {
	return thinkingFromContent(content);
}

export function assistantFromHistory(message = {}) {
	let state = startAssistantMessage(createAssistantMessage(), message);
	for (const block of Array.isArray(message.content) ? message.content : []) {
		if (block?.type === "thinking") {
			state = applyAssistantEvent(state, { type: "thinking_delta", delta: block.thinking ?? "" });
			state = applyAssistantEvent(state, { type: "thinking_end", content: block.thinking ?? "" });
		} else if (block?.type === "text") {
			state = applyAssistantEvent(state, { type: "text_delta", delta: block.text ?? "" });
		} else if (block?.type === "toolCall") {
			state = applyAssistantEvent(state, {
				type: "tool_execution_start",
				toolCallId: block.id,
				toolName: block.name,
				args: block.arguments,
			});
		}
	}
	const finished = finishAssistantMessage(state, message);
	return { ...finished, revealedText: finished.text, pendingText: "" };
}

export function applyHistoryToolResult(previous, message = {}) {
	return applyAssistantEvent(previous, {
		type: "tool_execution_end",
		toolCallId: message.toolCallId ?? message.tool_call_id ?? message.id,
		result: message,
		isError: message.isError,
		durationMs: message.durationMs,
	});
}
