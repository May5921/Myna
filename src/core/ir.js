// IR：中性中间层。事件名/命令名/能力键的唯一来源。
// 契约见 docs/ADAPTER-CONTRACT.md。任何适配器都不得自行定义新的事件名。

export const EVENTS = Object.freeze([
	"turn.start",
	"turn.end",
	"text.delta",
	"text.done",
	"reason.delta",
	"tool.start",
	"tool.end",
	"error",
	"usage",
	"session.meta",
]);

export const COMMANDS = Object.freeze([
	"prompt",
	"abort",
	"list_sessions",
	"load_history",
	"new_session",
	"switch_session",
	"list_models",
	"set_model",
	"fork",
	"compact",
	"rename",
]);

export const CAPS = Object.freeze([
	"fork",
	"compact",
	"reason",
	"queue",
	"extUI",
	"models",
	"sessions",
]);

export const TURN_OUTCOMES = Object.freeze(["ok", "failed", "aborted"]);

const EVENT_SET = new Set(EVENTS);
const COMMAND_SET = new Set(COMMANDS);
const CAP_SET = new Set(CAPS);

export const isEvent = (type) => EVENT_SET.has(type);
export const isCommand = (type) => COMMAND_SET.has(type);
export const isCap = (key) => CAP_SET.has(key);

// 未实现的能力必须显式抛错，不允许静默返回空对象（见契约 §4）
export function unsupported(type) {
	return new Error(`unsupported: ${type}`);
}

// 契约 §3：error / usage 的 sessionId 是可选的，其余事件必须有。
const OPTIONAL_SESSION = new Set(["error", "usage"]);

// 契约 §6：一致性测试用的最小校验，不抛异常，返回问题列表
export function validateEvent(ev) {
	const problems = [];
	if (!ev || typeof ev !== "object") return ["event 不是对象"];
	if (!isEvent(ev.type)) problems.push(`未知事件类型: ${String(ev.type)}`);
	if (!OPTIONAL_SESSION.has(ev.type) && typeof ev.sessionId !== "string") problems.push(`${ev.type}: 缺 sessionId`);
	if (ev.type === "text.delta" && typeof ev.delta !== "string") problems.push("text.delta: delta 必须是字符串");
	if (ev.type === "text.done" && typeof ev.text !== "string") problems.push("text.done: text 必须是字符串");
	if (ev.type === "tool.end" && typeof ev.ok !== "boolean") problems.push("tool.end: ok 必须是布尔");
	if (ev.type === "turn.end" && !TURN_OUTCOMES.includes(ev.outcome)) {
		problems.push(`turn.end: outcome 必须是 ${TURN_OUTCOMES.join("/")}`);
	}
	return problems;
}
