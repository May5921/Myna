// 排队草稿的持久化纯函数：供 features/queue.js 和 node:test 共用。
// 只存文本；图片条目只活在本次运行，刷新后丢弃。

// 历史键名保留 pi-mini 前缀：改名后不能丢掉用户已经排队的草稿。
export const QUEUE_STORE_PREFIX = "pi-mini.queue.";
export const QUEUE_STORE_NEW = `${QUEUE_STORE_PREFIX}_new`;
export const QUEUE_STORE_MAX = 50;

export function queueStoreKey(sessionFile) {
	const f = typeof sessionFile === "string" ? sessionFile.trim() : "";
	return f ? `${QUEUE_STORE_PREFIX}${f}` : QUEUE_STORE_NEW;
}

// 容忍脏数据：非数组、坏 JSON、空文本、非对象条目都跳过；最多保留 max 条。
export function parseQueueStore(raw, max = QUEUE_STORE_MAX) {
	if (!raw) return [];
	let arr;
	try {
		arr = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(arr)) return [];
	const out = [];
	for (const it of arr) {
		const text = typeof it?.text === "string" ? it.text : "";
		if (!text.trim()) continue;
		out.push({ text });
		if (out.length >= max) break;
	}
	return out;
}
