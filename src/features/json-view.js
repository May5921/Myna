// JSON 树形视图：工具结果里的 JSON 文本 → 可折叠树。
// 只接管 .tool .inner 里的原始输出；markdown 代码块（.body pre[data-lang]）归 code-toolbar。

export const MAX_JSON_BYTES = 2 * 1024 * 1024;
export const MAX_TREE_NODES = 2000;
export const DEFAULT_OPEN_DEPTH = 2;

const STRING_MAX = 120;
const DEBOUNCE_MS = 250;

// ---------- 纯函数（不依赖 DOM，可直接用 node 测）----------

// 解析工具输出：只接受 object / array；超限、非法、标量都跳过。
export function parseJsonText(text, maxBytes = MAX_JSON_BYTES) {
	if (typeof text !== "string") return { ok: false, reason: "type" };
	const src = text.trim();
	if (!src) return { ok: false, reason: "empty" };
	// 字节数 ≥ 字符数，先做一次廉价判断，避免对超大文本编码
	if (src.length > maxBytes || byteLength(src) > maxBytes) return { ok: false, reason: "too-large" };
	let value;
	try {
		value = JSON.parse(src);
	} catch {
		return { ok: false, reason: "invalid" };
	}
	if (value === null || typeof value !== "object") return { ok: false, reason: "scalar" };
	return { ok: true, value };
}

export function summarizeValue(value) {
	if (Array.isArray(value)) return { kind: "array", summary: "[…]", size: value.length };
	if (value === null) return { kind: "null", summary: "null", size: 0 };
	if (typeof value === "object") return { kind: "object", summary: "{…}", size: Object.keys(value).length };
	if (typeof value === "string") return { kind: "string", summary: quotePreview(value), size: 0 };
	if (typeof value === "number") return { kind: "number", summary: String(value), size: 0 };
	if (typeof value === "boolean") return { kind: "boolean", summary: value ? "true" : "false", size: 0 };
	return { kind: "unknown", summary: String(value), size: 0 };
}

// JSON.parse 后建树：DFS 预序，超过 maxNodes 立刻停止，omitted 是未渲染的队列长度。
export function buildTree(value, { maxNodes = MAX_TREE_NODES, openDepth = DEFAULT_OPEN_DEPTH } = {}) {
	const limit = Number.isFinite(maxNodes) && maxNodes > 0 ? Math.floor(maxNodes) : MAX_TREE_NODES;
	const state = { count: 0, limit, omitted: 0 };
	const root = buildNode(value, "", "root", 0, state, openDepth);
	return { root, count: state.count, omitted: state.omitted, truncated: state.omitted > 0 };
}

function buildNode(value, key, keyKind, depth, state, openDepth) {
	state.count += 1;
	const info = summarizeValue(value);
	const container = info.kind === "object" || info.kind === "array";
	const node = {
		key,
		keyKind,
		depth,
		kind: info.kind,
		summary: info.summary,
		size: info.size,
		open: container && depth < openDepth,
		children: null,
	};
	if (!container) return node;

	const kids = [];
	if (info.kind === "array") {
		for (let i = 0; i < value.length; i += 1) {
			if (state.count >= state.limit) {
				state.omitted += value.length - i;
				break;
			}
			kids.push(buildNode(value[i], `[${i}]`, "index", depth + 1, state, openDepth));
		}
	} else {
		const keys = Object.keys(value);
		for (let i = 0; i < keys.length; i += 1) {
			if (state.count >= state.limit) {
				state.omitted += keys.length - i;
				break;
			}
			const k = keys[i];
			kids.push(buildNode(value[k], k, "key", depth + 1, state, openDepth));
		}
	}
	node.children = kids;
	return node;
}

function quotePreview(value) {
	const cut = value.length > STRING_MAX ? `${value.slice(0, STRING_MAX)}…` : value;
	const quoted = JSON.stringify(cut);
	return quoted === undefined ? '""' : quoted;
}

function byteLength(text) {
	if (typeof TextEncoder === "function") return new TextEncoder().encode(text).byteLength;
	let n = 0;
	for (let i = 0; i < text.length; i += 1) {
		const c = text.charCodeAt(i);
		n += c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
	}
	return n;
}

// ---------- DOM ----------

function readBlockText(box) {
	const rows = box.querySelectorAll(":scope > .rline");
	if (!rows.length) return "";
	let out = "";
	rows.forEach((row, i) => {
		const tx = row.querySelector(".tx");
		out += (i ? "\n" : "") + (tx ? tx.textContent : "");
	});
	return out;
}

function targetText(target) {
	return target.classList.contains("readblock") ? readBlockText(target) : (target.textContent ?? "");
}

function renderNode(node) {
	const container = node.kind === "object" || node.kind === "array";
	const collapsible = container && node.children && node.children.length > 0;

	const wrap = document.createElement("div");
	wrap.className = "jt-node" + (node.open ? "" : " collapsed");
	wrap.dataset.kind = node.kind;

	const row = document.createElement("div");
	row.className = "jt-row";

	if (collapsible) {
		const chev = document.createElement("span");
		chev.className = "jt-chev";
		chev.setAttribute("aria-hidden", "true");
		chev.textContent = "›";
		row.append(chev);
	} else {
		const pad = document.createElement("span");
		pad.className = "jt-pad";
		row.append(pad);
	}

	const key = document.createElement("span");
	key.className = "jt-key" + (node.keyKind === "index" ? " idx" : "");
	key.textContent = node.keyKind === "key" ? `${node.key}:` : node.key;
	row.append(key);

	if (container) {
		const brace = document.createElement("span");
		brace.className = "jt-val";
		brace.textContent = node.summary;
		const count = document.createElement("span");
		count.className = "jt-count";
		count.textContent = `${node.size} 项`;
		row.append(brace, count);
	} else {
		const val = document.createElement("span");
		val.className = "jt-val";
		val.textContent = node.summary;
		const type = document.createElement("span");
		type.className = "jt-type";
		type.textContent = node.kind;
		row.append(val, type);
	}

	wrap.append(row);

	if (!collapsible) return wrap;

	row.setAttribute("role", "button");
	row.tabIndex = 0;
	row.setAttribute("aria-expanded", node.open ? "true" : "false");

	const kids = document.createElement("div");
	kids.className = "jt-kids";
	for (const child of node.children) kids.append(renderNode(child));
	wrap.append(kids);

	const setOpen = (open) => {
		wrap.classList.toggle("collapsed", !open);
		row.setAttribute("aria-expanded", open ? "true" : "false");
	};
	row.addEventListener("click", (e) => {
		e.preventDefault();
		setOpen(wrap.classList.contains("collapsed"));
	});
	row.addEventListener("keydown", (e) => {
		if (e.key !== "Enter" && e.key !== " ") return;
		e.preventDefault();
		setOpen(wrap.classList.contains("collapsed"));
	});

	return wrap;
}

function mount(target, value, ctx) {
	const model = buildTree(value);

	const box = document.createElement("div");
	box.className = "jtree";

	const bar = document.createElement("div");
	bar.className = "jt-bar";
	const tag = document.createElement("span");
	tag.className = "jt-tag";
	tag.textContent = "JSON";
	const meta = document.createElement("span");
	meta.className = "jt-meta";
	const rootKind = model.root.kind === "array" ? "数组" : "对象";
	meta.textContent = `${rootKind} · ${model.root.size} 项`;
	const toggle = document.createElement("button");
	toggle.type = "button";
	toggle.className = "jt-toggle";
	toggle.textContent = "原始";
	toggle.title = "显示原始 JSON";
	bar.append(tag, meta, toggle);

	const body = document.createElement("div");
	body.className = "jt-body";
	for (const child of model.root.children ?? []) body.append(renderNode(child));
	if (model.omitted > 0) {
		const more = document.createElement("div");
		more.className = "jt-more";
		more.textContent = `还有 ${model.omitted} 项未渲染`;
		body.append(more);
	}
	if (!body.firstChild) {
		const empty = document.createElement("div");
		empty.className = "jt-more";
		empty.textContent = "（空）";
		body.append(empty);
	}
	box.append(bar, body);

	let raw = false;
	toggle.onclick = (e) => {
		e.preventDefault();
		e.stopPropagation();
		raw = !raw;
		target.hidden = !raw;
		body.hidden = raw;
		toggle.textContent = raw ? "树形" : "原始";
		toggle.title = raw ? "显示树形视图" : "显示原始 JSON";
		ctx.follow?.();
	};

	target.after(box);
	target.hidden = true;
	ctx.follow?.();
}

export function init(ctx) {
	const stream = ctx?.stream;
	if (!stream) return;

	const CSS = `
	.jtree {
		margin: 2px 0 4px 22px;
		border: 1px solid var(--line);
		border-radius: 8px;
		background: var(--bg);
		overflow: hidden;
		font: 12px/1.65 var(--mono);
		color: var(--text);
	}
	.jt-bar {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 6px 4px 9px;
		border-bottom: 1px solid var(--line);
	}
	.jt-tag {
		flex: 0 0 auto;
		font: 10.5px/1.5 var(--ui);
		letter-spacing: 0.04em;
		color: var(--faint);
	}
	.jt-meta {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font: 11px/1.5 var(--ui);
		color: var(--faint);
		font-variant-numeric: tabular-nums;
	}
	.jt-toggle {
		flex: 0 0 auto;
		height: 19px;
		padding: 0 7px;
		border: 1px solid var(--line);
		border-radius: 8px;
		background: var(--bg);
		color: var(--dim);
		font: 11px/1.5 var(--ui);
	}
	.jt-toggle:hover { background: var(--hover); color: var(--text); }
	.jt-toggle:focus-visible { outline: 1px solid var(--faint); outline-offset: 1px; }
	.jt-body { max-height: 380px; overflow: auto; padding: 4px 0 6px; }
	.jt-node { min-width: 0; }
	.jt-row {
		display: flex;
		align-items: baseline;
		gap: 5px;
		padding: 1px 8px 1px 6px;
		border-radius: 8px;
		outline: none;
	}
	.jt-row[role="button"] { cursor: pointer; }
	.jt-row[role="button"]:hover { background: var(--hover); }
	.jt-row[role="button"]:focus-visible { outline: 1px solid var(--faint); outline-offset: -1px; }
	.jt-chev,
	.jt-pad {
		flex: 0 0 10px;
		width: 10px;
		color: var(--faint);
		font-size: 11px;
		line-height: inherit;
		user-select: none;
	}
	.jt-chev { transition: transform 120ms ease; }
	.jt-node:not(.collapsed) > .jt-row .jt-chev { transform: rotate(90deg); }
	.jt-node.collapsed > .jt-kids { display: none; }
	.jt-kids {
		margin-left: 16px;
		padding-left: 2px;
		border-left: 1px solid var(--line);
	}
	.jt-key {
		flex: 0 0 auto;
		max-width: 46%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--dim);
	}
	.jt-val {
		flex: 1 1 auto;
		min-width: 0;
		color: var(--text);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.jt-type,
	.jt-count {
		flex: 0 0 auto;
		font-size: 10.5px;
		color: var(--faint);
		font-variant-numeric: tabular-nums;
		user-select: none;
	}
	.jt-more {
		padding: 3px 8px 3px 28px;
		font: 11px/1.5 var(--ui);
		color: var(--faint);
	}
	@media (prefers-reduced-motion: reduce) { .jt-chev { transition: none; } }
	`;
	const style = document.createElement("style");
	style.textContent = CSS;
	document.head.append(style);

	let timer = 0;
	const scan = () => {
		// pre 是 pi 的纯文本结果；readblock 是 app.js 当前 read 工具的渲染，做兼容兜底。
		const targets = stream.querySelectorAll(".tool .inner pre, .tool .inner .readblock");
		for (const target of targets) {
			if (target.dataset.jsonView) continue;
			const tool = target.closest(".tool");
			if (!tool || tool.classList.contains("running")) continue;

			const parsed = parseJsonText(targetText(target));
			if (!parsed.ok) {
				// 行已结束，内容不会再变；标量/非法/超限都只算一次
				if (parsed.reason !== "empty") target.dataset.jsonView = "skip";
				continue;
			}
			target.dataset.jsonView = "1";
			try {
				mount(target, parsed.value, ctx);
			} catch (err) {
				target.dataset.jsonView = "skip";
				target.hidden = false;
				console.warn("[json-view] mount failed", err?.message);
			}
		}
	};
	const schedule = () => {
		clearTimeout(timer);
		timer = setTimeout(scan, DEBOUNCE_MS);
	};

	// 流式期间 pre 会变；防抖 + running 判断，等工具行结束再解析。
	const mo = new MutationObserver(schedule);
	mo.observe(stream, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
	scan();
}
