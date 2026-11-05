// 提供商配置的纯逻辑：主进程写 ~/.pi/agent/models.json 前的校验与字段保留。
// 不碰文件系统，方便 node:test 直接覆盖「写坏用户配置」的高风险路径。
import { copyThinkingLevelMap, hasThinkingLevelMap } from "./thinking-level-map.js";

// apiKey 只回掩码；$ENV 形式原样返回，让用户知道自己配的是环境变量。
export function maskKey(k) {
	const s = String(k || "");
	if (!s) return "";
	if (s.startsWith("$") || s.startsWith("!")) return s;
	return s.length <= 6 ? "••••" : `••••${s.slice(-4)}`;
}

export const PROVIDER_KEY = /^[a-z0-9][a-z0-9._-]*$/i;

// 接受 pi models.schema.json 的思考等级映射；其它高级模型字段按 id 从旧配置保留。
export function cleanProviderModels(list, previous, allowEmpty = false) {
	const prev = new Map((Array.isArray(previous) ? previous : []).map((m) => [String(m?.id || ""), m]));
	const seen = new Set();
	const out = [];
	for (const m of Array.isArray(list) ? list : []) {
		const id = String(m?.id || "").trim();
		if (!id) continue;
		if (seen.has(id)) throw new Error(`模型 ID「${id}」重复`);
		seen.add(id);
		const base = prev.get(id) || {};
		const next = { ...base, id };
		const name = String(m?.name || "").trim();
		if (name) next.name = name;
		else delete next.name;
		next.reasoning = Boolean(m?.reasoning);
		const map = copyThinkingLevelMap(m?.thinkingLevelMap ?? base.thinkingLevelMap);
		if (hasThinkingLevelMap(map)) next.thinkingLevelMap = map;
		else delete next.thinkingLevelMap;
		const ctx = Number(m?.contextWindow);
		if (Number.isFinite(ctx) && ctx > 0) next.contextWindow = Math.round(ctx);
		else delete next.contextWindow;
		const max = Number(m?.maxTokens);
		if (Number.isFinite(max) && max > 0) next.maxTokens = Math.round(max);
		else delete next.maxTokens;
		const modalities = Array.isArray(m?.input) ? m.input.filter((x) => x === "text" || x === "image") : null;
		if (modalities && modalities.length) next.input = modalities;
		else if (!Array.isArray(base.input) || !base.input.length) next.input = ["text"];
		out.push(next);
	}
	if (!out.length) {
		if (allowEmpty) return [];
		throw new Error("至少需要一个模型");
	}
	return out;
}
