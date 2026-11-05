// 会话级吐字统计：纯函数，供渲染层累计/读取，也供 node:test 直接测。
// 口径与 DSH 一致：速度 = 输出 token / 纯解码时间（首 token → message_end），
// TTFT = message_start → 首 token。

export const METRICS_VERSION = 1;

export function emptyMetrics() {
	return { v: METRICS_VERSION, steps: 0, tokens: 0, decodeMs: 0, ttftMs: 0, ttftCount: 0 };
}

const num = (value) => {
	const n = Number(value);
	return Number.isFinite(n) && n >= 0 ? n : 0;
};

export function normalizeMetrics(raw) {
	const base = emptyMetrics();
	if (!raw || typeof raw !== "object") return base;
	return {
		v: METRICS_VERSION,
		steps: Math.trunc(num(raw.steps)),
		tokens: num(raw.tokens),
		decodeMs: num(raw.decodeMs),
		ttftMs: num(raw.ttftMs),
		ttftCount: Math.trunc(num(raw.ttftCount)),
	};
}

// 一步 = 一条 assistant 消息。没有正文/解码时间的步骤不计速度，避免工具回合拉低均值。
export function addStep(metrics, step) {
	const next = normalizeMetrics(metrics);
	const tokens = num(step?.tokens);
	const decodeMs = num(step?.decodeMs);
	const ttftMs = num(step?.ttftMs);
	if (tokens <= 0 || decodeMs <= 0) return next;
	next.steps += 1;
	next.tokens += tokens;
	next.decodeMs += decodeMs;
	if (ttftMs > 0) {
		next.ttftMs += ttftMs;
		next.ttftCount += 1;
	}
	return next;
}

export function mergeMetrics(a, b) {
	const left = normalizeMetrics(a);
	const right = normalizeMetrics(b);
	return {
		v: METRICS_VERSION,
		steps: left.steps + right.steps,
		tokens: left.tokens + right.tokens,
		decodeMs: left.decodeMs + right.decodeMs,
		ttftMs: left.ttftMs + right.ttftMs,
		ttftCount: left.ttftCount + right.ttftCount,
	};
}

export function summarizeMetrics(metrics) {
	const m = normalizeMetrics(metrics);
	return {
		steps: m.steps,
		tokens: m.tokens,
		avgTps: m.decodeMs > 0 ? m.tokens / (m.decodeMs / 1000) : 0,
		avgTtftMs: m.ttftCount > 0 ? m.ttftMs / m.ttftCount : 0,
	};
}

export function parseMetrics(text) {
	if (typeof text !== "string" || !text) return emptyMetrics();
	try {
		return normalizeMetrics(JSON.parse(text));
	} catch {
		return emptyMetrics();
	}
}

// 与 DSH 的 formatTokensPerSecond 一致：≥10 取整，<10 保留一位
export function formatTokSpeed(value) {
	const n = Math.max(0, Number(value) || 0);
	return n >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
}

// 运行中计时用 H:MM:SS：长回合不再显示「993.4s」这种越来越长的秒数
export function formatClockMs(ms) {
	const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
