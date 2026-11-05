// 输入触发与候选排序的纯逻辑：供 features/input-trigger.js 和 node:test 共用。
// 不碰 DOM、不读全局状态；所有输入显式传入。

export const MAX_ITEMS = 20;

// 与 pi 一致：空白、引号、等号与 CJK 标点分隔 token；CJK 字母属于路径本身
const DELIMS = /[\s"'=]/;
const CJK_PUNCT = /[，．：；！？（）［］｛｝“”‘’…—]/;
const WRAPPERS = { "(": ")", "[": "]", "{": "}", "<": ">", "`": "`" };

export const isDelim = (ch) => !!ch && (DELIMS.test(ch) || CJK_PUNCT.test(ch));

export const baseName = (path) => {
	const i = path.lastIndexOf("/");
	return i < 0 ? path : path.slice(i + 1);
};

export const dirName = (path) => {
	const i = path.lastIndexOf("/");
	return i < 0 ? "" : path.slice(0, i);
};

export const depthOf = (path) => path.split("/").length;

export const isSubsequence = (text, query) => {
	let i = 0;
	for (const ch of text) {
		if (ch === query[i]) i++;
		if (i === query.length) return true;
	}
	return i === query.length;
};

const boundaryOk = (line, i) => {
	if (i <= 0) return true;
	const prev = line[i - 1];
	return isDelim(prev) || Object.prototype.hasOwnProperty.call(WRAPPERS, prev);
};

const unclosedQuoteStart = (line) => {
	let inQuote = false;
	let start = -1;
	for (let i = 0; i < line.length; i++) {
		if (line[i] !== '"') continue;
		inQuote = !inQuote;
		start = inQuote ? i : -1;
	}
	return inQuote ? start : -1;
};

const tokenStart = (line) => {
	let i = line.length;
	while (i > 0 && !isDelim(line[i - 1])) i--;
	return i;
};

const stripWrappers = (line, i) => {
	while (i < line.length) {
		const closer = WRAPPERS[line[i]];
		if (!closer || line.indexOf(closer, i + 1) !== -1) break;
		i++;
	}
	return i;
};

// 光标所在行的 @ 触发范围；无触发时返回 null。
export function atRangeAt(value, caret, selectionEnd = caret) {
	if (selectionEnd !== caret) return null;
	const text = String(value ?? "");
	const pos = Number.isFinite(caret) ? Math.max(0, Math.min(text.length, caret)) : text.length;
	const nl = pos > 0 ? text.lastIndexOf("\n", pos - 1) : -1;
	const lineStart = nl + 1;
	const line = text.slice(lineStart, pos);

	const q = unclosedQuoteStart(line);
	if (q >= 0) {
		let start = q;
		if (q > 0 && line[q - 1] === "@") start = q - 1;
		if (line[start] !== "@" || !boundaryOk(line, start)) return null;
		return { start: lineStart + start, end: pos, query: line.slice(q + 1), quoted: true };
	}

	const start = stripWrappers(line, tokenStart(line));
	if (line[start] !== "@" || !boundaryOk(line, start)) return null;
	return { start: lineStart + start, end: pos, query: line.slice(start + 1), quoted: false };
}

// / 命令触发范围：仅首行、尚未输入空格、query 里不能再有 /。
export function commandRangeAt(value, caret, selectionEnd = caret) {
	if (selectionEnd !== caret) return null;
	const text = String(value ?? "");
	const pos = Number.isFinite(caret) ? Math.max(0, Math.min(text.length, caret)) : text.length;
	const before = text.slice(0, pos);
	if (before.includes("\n")) return null;
	const lead = before.length - before.trimStart().length;
	const body = before.slice(lead);
	if (!body.startsWith("/")) return null;
	if (/\s/.test(body)) return null;
	const query = body.slice(1);
	if (query.includes("/")) return null;
	return { start: lead, end: pos, query };
}

// 文件候选：精确名 > 前缀 > 包含 > 路径前缀 > 路径包含 > 子序列；目录有加权。
export function rankFiles(files, query, limit = MAX_ITEMS) {
	const q = String(query ?? "").toLowerCase().replace(/\\/g, "/");
	const scored = [];
	for (const f of Array.isArray(files) ? files : []) {
		if (!f || typeof f.path !== "string") continue;
		const base = baseName(f.path).toLowerCase();
		const full = f.path.toLowerCase();
		let score = 0;
		if (!q) {
			score = 1;
		} else if (base === q) {
			score = 100;
		} else if (base.startsWith(q)) {
			score = 80;
		} else if (base.includes(q)) {
			score = 50;
		} else if (full.startsWith(q)) {
			score = 44;
		} else if (full.includes(q)) {
			score = 30;
		} else if (isSubsequence(base, q)) {
			score = 18;
		} else {
			continue;
		}
		if (f.dir) score += 8;
		scored.push({ f, score });
	}
	scored.sort((a, b) => {
		// 空 query 时先列浅层条目，否则深目录会把根目录文件挤掉
		if (!q) {
			return (
				depthOf(a.f.path) - depthOf(b.f.path) ||
				(b.f.dir ? 1 : 0) - (a.f.dir ? 1 : 0) ||
				a.f.path.length - b.f.path.length ||
				a.f.path.localeCompare(b.f.path)
			);
		}
		return (
			b.score - a.score ||
			depthOf(a.f.path) - depthOf(b.f.path) ||
			a.f.path.length - b.f.path.length ||
			a.f.path.localeCompare(b.f.path)
		);
	});
	return scored.slice(0, limit).map((x) => x.f);
}

// 命令候选：去掉 skill: 前缀后再比，避免 skill 名被前缀压过。
export function rankCommands(commands, query, limit = MAX_ITEMS) {
	const q = String(query ?? "").toLowerCase();
	const scored = [];
	for (const c of Array.isArray(commands) ? commands : []) {
		if (!c || typeof c.name !== "string") continue;
		const name = c.name.toLowerCase();
		const bare = name.startsWith("skill:") ? name.slice(6) : name;
		let score = 0;
		if (!q) {
			score = 1;
		} else if (bare.startsWith(q)) {
			score = 90;
		} else if (name.startsWith(q)) {
			score = 85;
		} else if (bare.includes(q)) {
			score = 60;
		} else if (name.includes(q)) {
			score = 55;
		} else if (isSubsequence(bare, q) || isSubsequence(name, q)) {
			score = 25;
		} else {
			continue;
		}
		scored.push({ c, score });
	}
	scored.sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name));
	return scored.slice(0, limit).map((x) => x.c);
}
