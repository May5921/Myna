// 把「DOM 里第几条用户消息」映射到 pi 的 entryId（fork 用）。
// pi 的 get_fork_messages 按追加顺序覆盖所有分支，而 DOM 只显示活动分支，
// 所以必须用 get_tree 先还原活动链，再按「从末尾数第几条」对齐；纯图片消息没有
// 文本可匹配，位置就是唯一依据。纯函数，方便 node:test 直接覆盖。

export function messageText(message) {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b) => b?.type === "text")
		.map((b) => b.text || "")
		.join("");
}

// 把 get_entries 的扁平数组还原成 get_tree 的形状。
// pi 的 get_tree 在大会话上会递归爆栈（实测 6.7MB / 3767 条条目直接
// "Maximum call stack size exceeded"），扁平数组没有这个问题。
export function treeFromEntries(entries, leafId) {
	const list = Array.isArray(entries) ? entries : [];
	const nodes = new Map();
	for (const entry of list) if (entry?.id) nodes.set(entry.id, { entry, children: [] });
	const roots = [];
	for (const entry of list) {
		if (!entry?.id) continue;
		const node = nodes.get(entry.id);
		const parent = entry.parentId ? nodes.get(entry.parentId) : null;
		if (parent && parent !== node) parent.children.push(node);
		else roots.push(node);
	}
	return { tree: roots, leafId: typeof leafId === "string" ? leafId : null };
}

// 活动分支（root → leaf）上的用户消息条目。接受 get_tree 或 get_entries 两种来源。
export function activeChainUserEntries(source) {
	const roots = Array.isArray(source?.tree)
		? source.tree
		: treeFromEntries(source?.entries, source?.leafId).tree;
	const leafId = source?.leafId;
	const nodes = [];
	// 迭代遍历：pi 的 get_tree 自己就死在递归上，这里不再踩同一个坑
	const stack = [...roots].reverse();
	while (stack.length) {
		const node = stack.pop();
		if (!node || typeof node !== "object") continue;
		nodes.push(node);
		const children = node.children || [];
		for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
	}
	if (!nodes.length) return [];

	const byId = new Map(nodes.map((n) => [n.entry?.id, n]));
	const out = [];
	const seen = new Set();
	let node = byId.get(leafId);
	while (node && node.entry && !seen.has(node.entry.id)) {
		seen.add(node.entry.id);
		const entry = node.entry;
		if (entry.type === "message" && entry.message?.role === "user") out.push(entry);
		node = entry.parentId ? byId.get(entry.parentId) : null;
	}
	return out.reverse();
}

// 返回 { entryId, source: "tree" | "fork-list" }，找不到返回 null。
// users 是 activeChainUserEntries() 的结果（root → leaf）。
export function pickForkEntry({ users, messages, text, rowIndexFromEnd }) {
	const fromEnd = Math.max(0, Number(rowIndexFromEnd) || 0);
	const want = String(text ?? "").trim();

	const chain = Array.isArray(users) ? users : [];
	if (chain.length) {
		const wanted = chain.length - 1 - fromEnd;
		let hit = chain[wanted] ?? null;
		if (want && (!hit || messageText(hit.message).trim() !== want)) {
			// DOM 尾部可能比活动链多/少一条（本地回显、压缩后上下文），就近取同文本的
			const matches = chain
				.map((entry, i) => ({ entry, i }))
				.filter(({ entry }) => messageText(entry.message).trim() === want);
			hit = matches.sort((a, b) => Math.abs(a.i - wanted) - Math.abs(b.i - wanted))[0]?.entry ?? null;
		}
		if (hit?.id) return { entryId: hit.id, source: "tree" };
	}

	// 活动链不可用（例如非 pi 后端）时退回 fork 列表的文本匹配
	const list = Array.isArray(messages) ? messages : [];
	const hits = list
		.map((m, i) => ({ m, i }))
		.filter(({ m }) => typeof m?.text === "string" && m.text.trim() === want);
	const wanted = list.length - 1 - fromEnd;
	const m = hits.find(({ i }) => i === wanted)?.m ?? hits.sort((a, b) => Math.abs(a.i - wanted) - Math.abs(b.i - wanted))[0]?.m ?? null;
	return m?.entryId ? { entryId: m.entryId, source: "fork-list" } : null;
}
