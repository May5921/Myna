export const THINKING_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const LEVEL_SET = new Set(THINKING_LEVELS);
const MAX_VALUE_LENGTH = 120;

export function normalizeThinkingLevelMap(value, fallback) {
	const source = value === undefined ? fallback : value;
	if (!source || typeof source !== "object" || Array.isArray(source)) return {};
	const out = {};
	for (const level of THINKING_LEVELS) {
		if (!Object.prototype.hasOwnProperty.call(source, level)) continue;
		const raw = source[level];
		if (raw === null) {
			out[level] = null;
			continue;
		}
		if (typeof raw !== "string") continue;
		const text = raw.trim();
		if (text && text.length <= MAX_VALUE_LENGTH) out[level] = text;
	}
	return out;
}

export function hasThinkingLevelMap(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).some((key) => LEVEL_SET.has(key)));
}

export function copyThinkingLevelMap(value) {
	const map = normalizeThinkingLevelMap(value);
	return hasThinkingLevelMap(map) ? map : undefined;
}
