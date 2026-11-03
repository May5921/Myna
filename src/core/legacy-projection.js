// IR → 旧 pi 事件的投影层。
// 渲染层（src/app.js / src/features/*）本期不改，主进程把适配器产出的 IR 事件
// 投影成它们已经认识的事件。只依赖 IR 契约，不 import electron。
// 映射表见 docs/ADAPTER-CONTRACT.md §7。

function textBlock(text) {
	return { type: "text", text };
}

// IR 会话 → 旧会话列表项。path 与会话 id 相同：UI 用它当会话键，
// 这里不是文件路径，也不伪造任何文件系统路径。
export function projectSessions(sessions, fallbackCwd = "") {
	const list = Array.isArray(sessions) ? sessions : [];
	return list
		.map((session) => {
			const id = String(session?.id ?? "");
			return {
				path: id,
				id,
				cwd: typeof session?.cwd === "string" && session.cwd ? session.cwd : fallbackCwd,
				timestamp: session?.updatedAt ?? null,
				name: null,
				title: typeof session?.title === "string" ? session.title : "",
			};
		})
		.filter((session) => session.id);
}

// IR 历史消息 → 旧渲染层的消息形状。IR 契约只要求 { role, text }，
// 但 renderHistory() 读的是 message.content，这里补成 content block。
export function projectHistory(messages) {
	const list = Array.isArray(messages) ? messages : [];
	return list.map((message) => {
		const text = typeof message?.text === "string" ? message.text : "";
		const content = Array.isArray(message?.content)
			? message.content
			: text
				? [textBlock(text)]
				: [];
		return {
			role: message?.role === "user" ? "user" : "assistant",
			content,
			...(typeof message?.text === "string" ? { text: message.text } : {}),
			...(message?.ts !== undefined ? { ts: message.ts } : {}),
		};
	});
}

// 旧渲染层命令 → IR 命令。返回 null 表示适配器层不支持，由调用方明确报
// `unsupported: <type>`，不许静默返回空对象。
export function toIRCommand(command) {
	if (!command || typeof command !== "object") return null;
	switch (command.type) {
		case "prompt": {
			const text = String(command.text ?? command.message ?? "");
			const images = Array.isArray(command.images) && command.images.length ? { images: command.images } : {};
			return { type: "prompt", text, ...images };
		}
		case "abort":
			return { type: "abort" };
		case "compact":
			return { type: "compact" };
		case "get_messages":
			return { type: "load_history", ...(command.sessionId ? { sessionId: String(command.sessionId) } : {}) };
		case "get_available_models":
			return { type: "list_models" };
		case "set_model": {
			const modelId = command.modelId ?? command.id ?? command.model;
			if (!modelId) return null;
			const full = command.provider ? `${command.provider}/${modelId}` : String(modelId);
			return { type: "set_model", modelId: full };
		}
		case "set_session_name":
			return { type: "rename", title: String(command.name ?? command.title ?? "") };
		case "fork": {
			const messageId = command.entryId ?? command.messageId;
			return { type: "fork", ...(messageId ? { messageId: String(messageId) } : {}) };
		}
		case "switch_session":
			return { type: "switch_session", sessionId: String(command.sessionId ?? command.path ?? "") };
		case "new_session":
			return { type: "new_session" };
		case "rename":
			return { type: "rename", ...(command.title != null ? { title: String(command.title) } : {}) };
		case "list_sessions":
			return { type: "list_sessions", ...(command.limit ? { limit: command.limit } : {}) };
		case "load_history":
			return { type: "load_history", ...(command.sessionId ? { sessionId: String(command.sessionId) } : {}) };
		case "list_models":
			return { type: "list_models" };
		default:
			return null;
	}
}

// 每个后端实例一个投影器。reason 文本按轮缓冲，在 message_end 里补成
// thinking block，渲染层的 thinkText() 才能拿到完整思考内容。
export function createProjection(options = {}) {
	const emit = typeof options.emit === "function" ? options.emit : () => {};
	let reason = "";
	let usage = null;
	// 当前 assistant 消息是否还在吐字。usage 只贴给「下一条 text.done」；
		// 消息已经定稿后才到的 usage 直接丢弃，宁可退回估算，
	// 也不能把这一步的 token 记到下一处。
	let messageOpen = false;

	function reset() {
		reason = "";
		usage = null;
		messageOpen = false;
	}

	function push(event) {
		if (!event || typeof event.type !== "string") return;
		switch (event.type) {
			case "turn.start":
				reset();
				emit({ type: "agent_start" });
				break;
			case "reason.delta":
				if (typeof event.delta !== "string" || !event.delta) break;
				messageOpen = true;
				reason += event.delta;
				emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: event.delta } });
				break;
			case "text.delta":
				if (typeof event.delta !== "string" || !event.delta) break;
				messageOpen = true;
				emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: event.delta } });
				break;
			case "text.done": {
				const text = typeof event.text === "string" ? event.text : "";
				// 空定稿不覆盖流式缓冲：交给 agent_settled 用 state.liveRaw 收尾。
				// 但这一步的 usage 不能留到下一条消息上。
				if (!text) {
					usage = null;
					messageOpen = false;
					break;
				}
				const content = [];
				if (reason) content.push({ type: "thinking", thinking: reason });
				content.push(textBlock(text));
				emit({ type: "message_end", message: { role: "assistant", content, ...(usage ? { usage } : {}) } });
				reason = "";
				usage = null;
				messageOpen = false;
				break;
			}
			case "tool.start":
				emit({
					type: "tool_execution_start",
					toolCallId: String(event.toolCallId ?? ""),
					toolName: String(event.name ?? "tool"),
					args: event.args && typeof event.args === "object" ? event.args : {},
				});
				break;
			case "tool.end": {
				const content = typeof event.output === "string" && event.output ? [textBlock(event.output)] : [];
				const result = { content };
				if (typeof event.diff === "string" && event.diff) result.details = { diff: event.diff };
				emit({
					type: "tool_execution_end",
					toolCallId: String(event.toolCallId ?? ""),
					isError: event.ok === false,
					result,
					...(Number.isFinite(event.durationMs) ? { durationMs: event.durationMs } : {}),
				});
				break;
			}
			case "usage":
				// 消息定稿后到达的 usage 属于上一条消息，丢掉；不能贴给下一条
				if (!messageOpen) break;
				usage = {
					input: Number.isFinite(event.input) ? event.input : 0,
					output: Number.isFinite(event.output) ? event.output : 0,
					...(Number.isFinite(event.cost) ? { cost: event.cost } : {}),
				};
				break;
			case "session.meta":
				emit({
					type: "session_info_changed",
					...(typeof event.title === "string" ? { name: event.title } : {}),
					...(event.model ? { model: event.model } : {}),
				});
				break;
			case "turn.end":
				emit({ type: "agent_settled" });
				break;
			case "error": {
				// 旧渲染层没有通用 error 事件，新增一个 "error" 分支显示原因；
				// 致命错误再用 process_exit 收掉流式态。
				const message = typeof event.message === "string" && event.message ? event.message : "发生错误";
				emit({ type: "error", message, ...(event.fatal ? { fatal: true } : {}) });
				if (event.fatal) {
					reset();
					emit({ type: "process_exit", code: null, message });
				}
				break;
			}
			default:
				break;
		}
	}

	return { push, reset };
}
