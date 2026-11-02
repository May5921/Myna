// 右栏抽屉：文件 / 变更 / 会话。只新增本文件，样式自注入（.rp- 前缀），
// 不改 index.html / app.js / preload.cjs / base.css / 其他 feature。
//
// 数据契约（ctx.pi，见 preload.cjs + main.js）：
//   listFiles(cwd) → { cwd, files: [{ path, dir }], truncated }   path 用 "/" 分隔
//   gitChanges()   → [{ status, staged, path }]                    status: "M" / "A" / "D" / "??" …
//   gitDiff(path)  → string                                        空串 = 未跟踪或无差异
//   openPath(path) → boolean
//   command({ type: "get_tree" }) → { tree: SessionTreeNode[], leafId: string | null }
//     SessionTreeNode = { entry: SessionEntry, children: SessionTreeNode[], label?, labelTimestamp? }
//     SessionEntry    = { type, id, parentId, timestamp }
//       type "message" 时 entry.message 是 AgentMessage（role: "user" | "assistant" | "toolResult"）
//       其余 type：compaction / branch_summary / model_change / thinking_level_change /
//                  usage / custom / custom_message / context_edit / label / session_info

const TABS = [
	{ key: "files", label: "文件" },
	{ key: "changes", label: "变更" },
	{ key: "tree", label: "会话" },
];

const MAX_SUMMARY = 40; // 会话节点摘要字数
const MAX_DIFF_LINES = 400; // 单个 diff 最多渲染行数
const MAX_ERR = 140;
const DEMO_MS = 8000; // 演示钩子兜底：取不到数据也不阻塞
const FLASH_MS = 3000;

const PANEL_ICON =
	'<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2.2" y="3" width="11.6" height="10" rx="1.6"/><path d="M9.6 3v10"/></svg>';
const CHEV_ICON =
	'<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M3.6 1.8 7 5l-3.4 3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// 非消息条目的短标签（完整 type 放 title）；get_tree 里这些节点不带 message
const SYS_TAG = {
	compaction: "compact",
	branch_summary: "branch",
	model_change: "model",
	thinking_level_change: "think",
	usage: "usage",
	custom: "custom",
	custom_message: "custom",
	context_edit: "edit",
	label: "label",
	session_info: "session",
};

const CSS = `
.rp-toggle {
	width: 28px;
	height: 28px;
	border-radius: 6px;
	display: grid;
	place-items: center;
	color: var(--faint);
	flex: none;
	transition: background-color 120ms ease, color 120ms ease;
}
.rp-toggle:hover { background: var(--hover); color: var(--text); }
.rp-toggle[aria-expanded="true"] { background: var(--sel); color: var(--text); }
.rp-toggle:focus-visible { outline: 1px solid var(--faint); outline-offset: -1px; }

.rp-panel {
	/* diff 配色：docs/STYLE.md §2 的 diff 规格给出的值，token 块里没有对应的绿，局部收口在这里 */
	--rp-add: #1a7f37;
	--rp-add-bg: #e6f4ea;
	--rp-del: #c0342b;
	--rp-del-bg: #fdecec;

	position: fixed;
	top: var(--titlebar-height);
	right: 0;
	bottom: 0;
	width: 300px;
	z-index: 40;
	display: flex;
	flex-direction: column;
	background: var(--bg);
	border-left: 1px solid var(--line);
	transform: translateX(100%);
	visibility: hidden;
	transition: transform 120ms ease, visibility 0s linear 120ms;
}
.rp-panel.rp-is-open {
	transform: none;
	visibility: visible;
	transition: transform 120ms ease, visibility 0s;
}

/* 抽屉打开时把主界面让出 300px，避免盖住输入框右侧的模型/发送键 */
body.rp-open #app {
	padding-right: 300px;
	transition: padding-right 120ms ease;
}

.rp-tabs {
	flex: none;
	height: 36px;
	display: flex;
	align-items: center;
	gap: 2px;
	padding: 0 6px;
	border-bottom: 1px solid var(--line);
}
.rp-tab {
	height: 24px;
	padding: 0 8px;
	border-radius: 6px;
	font-size: 12.5px;
	line-height: 1;
	color: var(--faint);
	transition: background-color 120ms ease, color 120ms ease;
}
.rp-tab:hover { background: var(--hover); color: var(--text); }
.rp-tab.rp-is-on { background: var(--sel); color: var(--text); }
.rp-tab:focus-visible { outline: 1px solid var(--faint); outline-offset: -1px; }
.rp-grow { flex: 1; }
.rp-close {
	width: 24px;
	height: 24px;
	border-radius: 6px;
	display: grid;
	place-items: center;
	font-size: 14px;
	line-height: 1;
	color: var(--faint);
	transition: background-color 120ms ease, color 120ms ease;
}
.rp-close:hover { background: var(--hover); color: var(--text); }
.rp-close:focus-visible { outline: 1px solid var(--faint); outline-offset: -1px; }

.rp-body { flex: 1; min-height: 0; display: flex; }
.rp-pane {
	flex: 1;
	min-width: 0;
	min-height: 0;
	overflow-y: auto;
	padding: 4px 6px 10px;
}
.rp-pane[hidden] { display: none; }

.rp-row {
	display: flex;
	align-items: center;
	gap: 2px;
	width: 100%;
	height: 26px;
	padding: 0 6px;
	border-radius: 6px;
	text-align: left;
	font-size: 12.5px;
	line-height: 1;
	color: var(--dim);
	transition: background-color 120ms ease, color 120ms ease;
}
.rp-row:hover { background: var(--hover); color: var(--text); }
.rp-row:focus-visible { outline: 1px solid var(--faint); outline-offset: -1px; }
.rp-chev {
	flex: none;
	width: 14px;
	height: 14px;
	display: grid;
	place-items: center;
	color: var(--faint);
	transition: transform 120ms ease;
}
.rp-chev.rp-is-open { transform: rotate(90deg); }
.rp-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rp-dir > .rp-name { color: var(--text); font-weight: var(--weight-shell); }

.rp-state {
	padding: 12px 6px;
	font-size: 12px;
	line-height: 1.5;
	color: var(--faint);
	word-break: break-word;
}
.rp-state-err { margin-top: 4px; font-size: 11px; line-height: 1.45; color: var(--err); }
.rp-note {
	margin: 6px 0 0;
	padding: 8px 6px 0;
	border-top: 1px solid var(--line);
	font-size: 11px;
	line-height: 1.45;
	color: var(--faint);
}
.rp-note.rp-is-err { color: var(--err); }

.rp-bar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	height: 28px;
	padding: 0 4px;
}
.rp-bar-t { font-size: 11px; color: var(--faint); }
.rp-refresh {
	height: 22px;
	padding: 0 6px;
	border-radius: 6px;
	font-size: 12px;
	line-height: 1;
	color: var(--faint);
	transition: background-color 120ms ease, color 120ms ease;
}
.rp-refresh:hover:not(:disabled) { background: var(--hover); color: var(--text); }
.rp-refresh:focus-visible { outline: 1px solid var(--faint); outline-offset: -1px; }
.rp-refresh:disabled { opacity: 0.45; cursor: default; }

.rp-group {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 10px 4px 4px;
	font-size: 11px;
	color: var(--faint);
}
.rp-group-n { font-variant-numeric: tabular-nums; }

.rp-chg {
	display: flex;
	align-items: center;
	gap: 8px;
	width: 100%;
	height: 26px;
	padding: 0 6px;
	border-radius: 6px;
	text-align: left;
	transition: background-color 120ms ease;
}
.rp-chg:hover { background: var(--hover); }
.rp-chg:focus-visible { outline: 1px solid var(--faint); outline-offset: -1px; }
.rp-chg.rp-is-on { background: var(--sel); }
.rp-st {
	flex: none;
	min-width: 16px;
	max-width: 22px;
	overflow: hidden;
	font-family: var(--mono);
	font-size: 11px;
	line-height: 1;
	text-align: center;
	color: var(--faint);
}
.rp-st.rp-is-add { color: var(--rp-add); }
.rp-st.rp-is-del { color: var(--rp-del); }
.rp-chg-path {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-size: 12.5px;
	line-height: 1;
	color: var(--dim);
}
.rp-chg.rp-is-on .rp-chg-path { color: var(--text); }

.rp-diff {
	margin: 2px 0 6px 6px;
	padding: 4px 0;
	background: var(--code-bg);
	border-radius: 8px;
	overflow-x: auto;
}
.rp-dl {
	padding: 0 8px;
	font-family: var(--mono);
	font-size: 12px;
	line-height: 1.55;
	color: var(--dim);
	white-space: pre;
}
.rp-dl.rp-dl-add { color: var(--rp-add); background: var(--rp-add-bg); }
.rp-dl.rp-dl-del { color: var(--rp-del); background: var(--rp-del-bg); }
.rp-dl.rp-dl-hunk { color: var(--link); background: var(--accent-soft); }
.rp-dl.rp-dl-meta { color: var(--faint); }
.rp-empty { padding: 10px 6px 4px; font-size: 12px; line-height: 1.5; color: var(--faint); }

.rp-node {
	display: flex;
	align-items: center;
	gap: 6px;
	width: 100%;
	height: 26px;
	padding: 0 6px;
	border-radius: 6px;
	text-align: left;
	transition: background-color 120ms ease;
}
.rp-node:hover { background: var(--hover); }
.rp-node:focus-visible { outline: 1px solid var(--faint); outline-offset: -1px; }
.rp-node.rp-is-active { background: var(--sel); }
.rp-role {
	flex: none;
	max-width: 96px;
	overflow: hidden;
	font-family: var(--mono);
	font-size: 11px;
	line-height: 1;
	text-overflow: ellipsis;
	white-space: nowrap;
	color: var(--faint);
}
.rp-sum {
	flex: 1;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-size: 12.5px;
	line-height: 1;
	color: var(--dim);
}
.rp-node.rp-is-active .rp-role,
.rp-node.rp-is-active .rp-sum { color: var(--text); }
.rp-node.rp-is-sys .rp-role,
.rp-node.rp-is-sys .rp-sum { color: var(--faint); }
.rp-leaf {
	flex: none;
	width: 5px;
	height: 5px;
	border-radius: 999px;
	background: var(--send-bg);
}

@media (prefers-reduced-motion: reduce) {
	.rp-panel,
	.rp-toggle,
	.rp-tab,
	.rp-close,
	.rp-row,
	.rp-chev,
	.rp-chg,
	.rp-node,
	.rp-refresh { transition: none; }
}
`;

export function init(ctx) {
	if (!ctx?.pi) return;
	const topbar = document.getElementById("topbar");
	if (!topbar) return;
	if (document.getElementById("rp-toggle")) return; // 幂等（热重载会重新 init）

	// ---------- 小工具 ----------
	const el = (tag, cls, text) => {
		const n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text != null) n.textContent = text;
		return n;
	};

	const brief = (err) => {
		const t = String(err?.message ?? err ?? "")
			.replace(/\s+/g, " ")
			.trim();
		if (!t) return "未知错误";
		return t.length > MAX_ERR ? `${t.slice(0, MAX_ERR)}…` : t;
	};

	const oneLine = (v, n = MAX_SUMMARY) => {
		const t = String(v ?? "")
			.replace(/\s+/g, " ")
			.trim();
		if (!t) return "";
		return t.length > n ? `${t.slice(0, n)}…` : t;
	};

	// AgentMessage.content：字符串 或 (TextContent | ImageContent | ToolCall)[]
	const blockText = (content) => {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		const out = [];
		for (const b of content) {
			if (!b || typeof b !== "object") continue;
			if (typeof b.text === "string") out.push(b.text);
			else if (b.type === "toolCall" && b.name) out.push(`[${b.name}]`);
		}
		return out.join(" ");
	};

	const stateEl = (text, detail) => {
		const box = el("div", "rp-state", text);
		if (detail) box.append(el("div", "rp-state-err", detail));
		return box;
	};

	// ---------- 顶栏按钮 ----------
	const toggle = document.createElement("button");
	toggle.type = "button";
	toggle.id = "rp-toggle";
	toggle.className = "rp-toggle";
	toggle.title = "右栏";
	toggle.setAttribute("aria-label", "切换右栏");
	toggle.setAttribute("aria-expanded", "false");
	toggle.setAttribute("aria-controls", "rp-panel");
	toggle.innerHTML = PANEL_ICON;

	const spacer = topbar.querySelector(".spacer");
	if (spacer) spacer.insertAdjacentElement("afterend", toggle);
	else topbar.append(toggle);

	// 插到设置齿轮左边。settings.js 可能比本模块晚加载，等它出现再挪一次。
	let mo = null;
	const placeBeforeGear = () => {
		const gear = document.getElementById("settings-btn");
		if (!gear || gear.parentElement !== topbar) return false;
		if (gear.previousElementSibling !== toggle) topbar.insertBefore(toggle, gear);
		if (mo) {
			mo.disconnect();
			mo = null;
		}
		return true;
	};
	if (!placeBeforeGear()) {
		try {
			mo = new MutationObserver(() => {
				placeBeforeGear();
			});
			mo.observe(topbar, { childList: true });
		} catch {}
	}

	// ---------- 面板骨架 ----------
	const style = document.createElement("style");
	style.textContent = CSS;
	document.head.append(style);

	const panel = document.createElement("aside");
	panel.id = "rp-panel";
	panel.className = "rp-panel";
	panel.setAttribute("aria-label", "右栏");
	panel.setAttribute("aria-hidden", "true");

	const tabsBar = el("div", "rp-tabs");
	tabsBar.setAttribute("role", "tablist");
	tabsBar.setAttribute("aria-label", "右栏视图");
	const tabBtn = new Map();
	for (const t of TABS) {
		const b = el("button", "rp-tab", t.label);
		b.type = "button";
		b.id = `rp-tab-${t.key}`;
		b.setAttribute("role", "tab");
		b.setAttribute("aria-selected", "false");
		b.setAttribute("aria-controls", `rp-pane-${t.key}`);
		b.onclick = () => setTab(t.key);
		tabsBar.append(b);
		tabBtn.set(t.key, b);
	}
	tabsBar.append(el("span", "rp-grow"));

	const closeBtn = el("button", "rp-close", "×");
	closeBtn.type = "button";
	closeBtn.title = "关闭右栏";
	closeBtn.setAttribute("aria-label", "关闭右栏");
	closeBtn.onclick = (e) => {
		e.preventDefault();
		setOpen(false);
	};
	tabsBar.append(closeBtn);

	const body = el("div", "rp-body");
	const pane = new Map();
	for (const t of TABS) {
		const p = el("div", "rp-pane");
		p.id = `rp-pane-${t.key}`;
		p.setAttribute("role", "tabpanel");
		p.setAttribute("aria-labelledby", `rp-tab-${t.key}`);
		p.hidden = t.key !== "files";
		body.append(p);
		pane.set(t.key, p);
	}

	panel.append(tabsBar, body);
	document.body.append(panel);

	// ---------- 模块状态（不落 localStorage）----------
	let open = false;
	let tab = "files";
	let actionErr = "";
	let actionTimer = 0;

	const data = { files: null, changes: null, tree: null };
	const busy = { files: false, changes: false, tree: false };
	const errors = { files: "", changes: "", tree: "" };

	const expanded = new Set(); // 文件树已展开的目录（用 "/" 路径标识）
	let expandedSeeded = false;

	const openDiffs = new Set(); // 变更行的展开状态："s|u:path"
	const diffText = new Map(); // 同上 key → diff 文本
	const diffErr = new Map();
	const diffBusy = new Set();

	// ---------- 文件树 ----------
	const buildFileTree = (files) => {
		const root = { name: "", path: "", dir: true, kids: [], map: new Map() };
		for (const f of files) {
			const raw = String(f?.path ?? "")
				.replace(/\\/g, "/")
				.replace(/^\/+|\/+$/g, "");
			if (!raw) continue;
			const segs = raw.split("/").filter(Boolean);
			let cur = root;
			let acc = "";
			for (let i = 0; i < segs.length; i++) {
				const seg = segs[i];
				acc = acc ? `${acc}/${seg}` : seg;
				let next = cur.map.get(seg);
				if (!next) {
					next = { name: seg, path: acc, dir: false, kids: [], map: new Map() };
					cur.map.set(seg, next);
					cur.kids.push(next);
				}
				if (i < segs.length - 1) next.dir = true;
				cur = next;
			}
			if (f?.dir) cur.dir = true;
		}
		const sort = (node) => {
			node.kids.sort((a, b) => {
				if (a.dir !== b.dir) return a.dir ? -1 : 1;
				const la = a.name.toLowerCase();
				const lb = b.name.toLowerCase();
				return la < lb ? -1 : la > lb ? 1 : 0;
			});
			for (const k of node.kids) if (k.kids.length) sort(k);
		};
		sort(root);
		return root;
	};

	const seedExpand = (root) => {
		for (const kid of root.kids) if (kid.dir) expanded.add(kid.path);
	};

	const fullPathOf = (relPath) => {
		const base = String(data.files?.cwd || ctx.state?.cwd || "").replace(/[\\/]+$/, "");
		const rel = String(relPath ?? "").replace(/\//g, "\\");
		return base ? `${base}\\${rel}` : rel;
	};

	async function openFile(relPath) {
		const full = fullPathOf(relPath);
		try {
			const ok = await ctx.pi.openPath(full);
			if (ok === false) flash("打不开这个文件");
		} catch (e) {
			flash(brief(e));
		}
	}

	function flash(text) {
		actionErr = text;
		clearTimeout(actionTimer);
		actionTimer = setTimeout(() => {
			actionErr = "";
			renderFiles();
		}, FLASH_MS);
		renderFiles();
	}

	// ---------- 数据加载 ----------
	// 同一时刻只跑一个同类请求；load() 返回在途 promise，演示钩子可以等它（或 8s 超时）
	const pending = { files: null, changes: null, tree: null };

	async function loadFiles() {
		busy.files = true;
		errors.files = "";
		renderFiles();
		try {
			const want = String(ctx.state?.cwd || "");
			const res = await ctx.pi.listFiles(want);
			if (!res || typeof res !== "object") throw new Error("文件列表不可用");
			const cwd = String(res.cwd || want || "");
			const list = Array.isArray(res.files) ? res.files : [];
			const root = buildFileTree(list);
			const changed = data.files?.cwd !== cwd;
			data.files = { cwd, tree: root, truncated: !!res.truncated, count: list.length };
			if (changed || !expandedSeeded) {
				expanded.clear();
				expandedSeeded = true;
				seedExpand(root);
			}
		} catch (e) {
			errors.files = brief(e);
		} finally {
			busy.files = false;
			renderFiles();
		}
	}

	async function loadChanges(force) {
		busy.changes = true;
		errors.changes = "";
		if (force) {
			diffText.clear();
			diffErr.clear();
		}
		renderChanges();
		try {
			const res = await ctx.pi.gitChanges();
			if (!Array.isArray(res)) throw new Error("变更列表不可用");
			data.changes = res
				.filter((c) => c && c.path)
				.map((c) => ({
					status: String(c.status || "?"),
					staged: !!c.staged,
					path: String(c.path),
				}));
		} catch (e) {
			errors.changes = brief(e);
		} finally {
			busy.changes = false;
			renderChanges();
		}
	}

	async function loadTree() {
		busy.tree = true;
		errors.tree = "";
		renderTree();
		try {
			const res = await ctx.pi.command({ type: "get_tree" });
			if (!res || !Array.isArray(res.tree)) throw new Error("返回结构里没有 tree 数组");
			data.tree = { tree: res.tree, leafId: typeof res.leafId === "string" ? res.leafId : null };
		} catch (e) {
			errors.tree = brief(e);
		} finally {
			busy.tree = false;
			renderTree();
		}
	}

	const loaders = { files: loadFiles, changes: loadChanges, tree: loadTree };

	function load(key, force) {
		if (pending[key]) return pending[key];
		if (!force && data[key] && !errors[key]) return Promise.resolve();
		const p = Promise.resolve()
			.then(() => loaders[key](true))
			.catch(() => {});
		pending[key] = p;
		p.finally(() => {
			if (pending[key] === p) pending[key] = null;
		});
		return p;
	}

	async function ensureDiff(key, relPath) {
		if (diffText.has(key) || diffErr.has(key) || diffBusy.has(key)) return;
		diffBusy.add(key);
		try {
			const text = await ctx.pi.gitDiff(relPath);
			diffText.set(key, typeof text === "string" ? text : "");
		} catch (e) {
			diffErr.set(key, brief(e));
		} finally {
			diffBusy.delete(key);
			if (openDiffs.has(key) && tab === "changes") renderChanges();
		}
	}

	// ---------- 渲染：文件 ----------
	function renderFiles() {
		const host = pane.get("files");
		const keep = host.scrollTop;
		host.textContent = "";

		if (!data.files) {
			host.append(stateEl(errors.files ? "文件列表不可用" : busy.files ? "读取中…" : "还没加载", errors.files));
			return;
		}

		const root = data.files.tree;
		if (!root.kids.length) {
			host.append(stateEl("工作区里没有可索引的文件"));
		} else {
			const frag = document.createDocumentFragment();
			const walk = (kids, depth) => {
				for (const node of kids) {
					const row = el("button", `rp-row${node.dir ? " rp-dir" : ""}`);
					row.type = "button";
					row.style.paddingLeft = `${6 + depth * 12}px`;
					row.title = node.path;

					const chev = el("span", "rp-chev");
					const isOpen = node.dir && expanded.has(node.path);
					if (node.dir) {
						chev.innerHTML = CHEV_ICON;
						if (isOpen) chev.classList.add("rp-is-open");
						row.setAttribute("aria-expanded", isOpen ? "true" : "false");
					}
					row.append(chev, el("span", "rp-name", node.name));

					if (node.dir) {
						row.onclick = () => {
							if (expanded.has(node.path)) expanded.delete(node.path);
							else expanded.add(node.path);
							renderFiles();
						};
					} else {
						row.onclick = () => openFile(node.path);
					}

					frag.append(row);
					if (isOpen) walk(node.kids, depth + 1);
				}
			};
			walk(root.kids, 0);
			host.append(frag);
			if (data.files.truncated) host.append(el("div", "rp-note", "仅索引前 2000 个文件"));
		}
		if (errors.files) host.append(el("div", "rp-note rp-is-err", errors.files));
		if (actionErr) host.append(el("div", "rp-note rp-is-err", actionErr));
		host.scrollTop = keep;
	}

	// ---------- 渲染：变更 ----------
	const ST_CLASS = { M: "mod", A: "add", D: "del", "??": "new", R: "mod", C: "mod", U: "del" };

	function diffRows(text) {
		const frag = document.createDocumentFragment();
		const lines = String(text).replace(/\r\n/g, "\n").split("\n");
		while (lines.length && lines[lines.length - 1] === "") lines.pop();
		for (const line of lines.slice(0, MAX_DIFF_LINES)) {
			let cls = "rp-dl";
			if (line.startsWith("@@")) cls += " rp-dl-hunk";
			else if (line.startsWith("+++") || line.startsWith("---")) cls += " rp-dl-meta";
			else if (line.startsWith("+")) cls += " rp-dl-add";
			else if (line.startsWith("-")) cls += " rp-dl-del";
			else if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("\\")) cls += " rp-dl-meta";
			frag.append(el("div", cls, line || " "));
		}
		if (lines.length > MAX_DIFF_LINES) {
			frag.append(el("div", "rp-dl rp-dl-meta", `… 已截断，还有 ${lines.length - MAX_DIFF_LINES} 行`));
		}
		return frag;
	}

	function changeRows(list, staged) {
		const wrap = document.createDocumentFragment();
		if (!list.length) {
			wrap.append(el("div", "rp-empty", staged ? "没有已暂存的改动" : "没有未暂存的改动"));
			return wrap;
		}
		for (const c of list) {
			const key = `${staged ? "s" : "u"}:${c.path}`;
			const row = el("button", `rp-chg${openDiffs.has(key) ? " rp-is-on" : ""}`);
			row.type = "button";
			row.title = c.path;
			const stCls = ST_CLASS[c.status] || "mod";
			row.append(el("span", `rp-st rp-is-${stCls}`, c.status), el("span", "rp-chg-path", c.path));
			row.onclick = () => {
				if (openDiffs.has(key)) openDiffs.delete(key);
				else openDiffs.add(key);
				renderChanges();
				if (openDiffs.has(key) && !diffText.has(key) && !diffErr.has(key)) ensureDiff(key, c.path);
			};
			wrap.append(row);

			if (!openDiffs.has(key)) continue;
			const box = el("div", "rp-diff");
			if (diffText.has(key)) {
				const text = diffText.get(key);
				if (text.trim()) box.append(diffRows(text));
				else box.append(el("div", "rp-empty", "未跟踪文件或无差异"));
			} else if (diffErr.has(key)) {
				box.append(el("div", "rp-empty", diffErr.get(key)));
			} else {
				box.append(el("div", "rp-empty", "读取中…"));
				ensureDiff(key, c.path);
			}
			wrap.append(box);
		}
		return wrap;
	}

	function renderChanges() {
		const host = pane.get("changes");
		const keep = host.scrollTop;
		host.textContent = "";

		const bar = el("div", "rp-bar");
		bar.append(el("span", "rp-bar-t", "工作区变更"));
		const refresh = el("button", "rp-refresh", busy.changes ? "读取中" : "刷新");
		refresh.type = "button";
		refresh.title = "重新拉取 git 变更";
		refresh.disabled = busy.changes;
		refresh.onclick = () => load("changes", true);
		bar.append(refresh);
		host.append(bar);

		if (!data.changes) {
			host.append(stateEl(errors.changes ? "变更列表不可用" : busy.changes ? "读取中…" : "还没加载", errors.changes));
			return;
		}

		const staged = data.changes.filter((c) => c.staged);
		const unstaged = data.changes.filter((c) => !c.staged);

		const head = (label, n) => {
			const row = el("div", "rp-group");
			row.append(el("span", null, label), el("span", "rp-group-n", String(n)));
			return row;
		};

		host.append(head("已暂存", staged.length), changeRows(staged, true));
		host.append(head("未暂存", unstaged.length), changeRows(unstaged, false));
		if (errors.changes) host.append(el("div", "rp-note rp-is-err", errors.changes));
		host.scrollTop = keep;
	}

	// ---------- 渲染：会话树 ----------
	const nodeInfo = (node) => {
		const entry = node?.entry && typeof node.entry === "object" ? node.entry : {};
		const msg = entry.message && typeof entry.message === "object" ? entry.message : null;

		if (msg) {
			if (msg.role === "user") return { role: "user", text: oneLine(blockText(msg.content)), sys: false };
			if (msg.role === "assistant") {
				const calls = Array.isArray(msg.content)
					? msg.content.filter((b) => b?.type === "toolCall" && b.name).map((b) => b.name)
					: [];
				const text = oneLine(blockText(msg.content)) || (calls.length ? `调用 ${calls.join(", ")}` : "");
				return { role: "assistant", text, sys: false };
			}
			if (msg.role === "toolResult") {
				const name = String(msg.toolName || "tool");
				const text = oneLine(blockText(msg.content));
				return { role: "tool", text: text ? `${name} · ${text}` : name, sys: false };
			}
			return { role: String(msg.role || "message"), text: oneLine(blockText(msg.content)), sys: false };
		}

		const type = String(entry.type || "entry");
		let text = "";
		if (type === "compaction" || type === "branch_summary") text = oneLine(entry.summary);
		else if (type === "model_change") text = oneLine([entry.provider, entry.modelId].filter(Boolean).join("/"));
		else if (type === "thinking_level_change") text = oneLine(entry.thinkingLevel);
		else if (type === "custom" || type === "custom_message") text = oneLine(entry.customType);
		else if (type === "label") text = oneLine(entry.label);
		else if (type === "session_info") text = oneLine(entry.name);
		else if (type === "usage") text = oneLine(entry.kind);
		return { role: SYS_TAG[type] || type, text, sys: true, type };
	};

	function treeRow(node, depth, leafId) {
		const info = nodeInfo(node);
		const row = el("button", `rp-node${info.sys ? " rp-is-sys" : ""}`);
		row.type = "button";
		row.style.paddingLeft = `${6 + depth * 12}px`;
		row.title = info.text || info.role;
		row.dataset.entryId = String(node?.entry?.id ?? "");

		const role = el("span", "rp-role", info.role);
		if (info.type) role.title = info.type;
		row.append(role, el("span", "rp-sum", info.text || "—"));

		if (leafId && node?.entry?.id === leafId) {
			const dot = el("span", "rp-leaf");
			dot.title = "当前分支末端";
			row.append(dot);
		}

		row.onclick = () => {
			const host = pane.get("tree");
			for (const on of host.querySelectorAll(".rp-node.rp-is-active")) on.classList.remove("rp-is-active");
			row.classList.add("rp-is-active");
		};
		return row;
	}

	function renderTree() {
		const host = pane.get("tree");
		const keep = host.scrollTop;
		host.textContent = "";

		if (!data.tree) {
			host.append(stateEl(errors.tree ? "会话树不可用" : busy.tree ? "读取中…" : "还没加载", errors.tree));
			return;
		}

		const flat = [];
		const walk = (nodes, depth) => {
			for (const n of nodes) {
				if (!n || typeof n !== "object") continue;
				flat.push([n, depth]);
				if (Array.isArray(n.children) && n.children.length) walk(n.children, depth + 1);
			}
		};
		walk(data.tree.tree, 0);

		if (!flat.length) {
			host.append(stateEl("这个会话还没有条目"));
			return;
		}

		const frag = document.createDocumentFragment();
		for (const [node, depth] of flat) frag.append(treeRow(node, depth, data.tree.leafId));
		host.append(frag);
		if (errors.tree) host.append(el("div", "rp-note rp-is-err", errors.tree));
		host.scrollTop = keep;
	}

	// ---------- 切换 / 开关 ----------
	function render() {
		for (const t of TABS) {
			const on = t.key === tab;
			const b = tabBtn.get(t.key);
			b.classList.toggle("rp-is-on", on);
			b.setAttribute("aria-selected", on ? "true" : "false");
			pane.get(t.key).hidden = !on;
		}
		if (tab === "files") renderFiles();
		else if (tab === "changes") renderChanges();
		else renderTree();
	}

	function setTab(key) {
		if (!TABS.some((t) => t.key === key)) return;
		if (tab !== key) {
			tab = key;
			render();
		}
		load(key);
	}

	function setOpen(next) {
		open = !!next;
		panel.classList.toggle("rp-is-open", open);
		document.body.classList.toggle("rp-open", open);
		panel.setAttribute("aria-hidden", open ? "false" : "true");
		toggle.setAttribute("aria-expanded", open ? "true" : "false");
		if (!open) return;
		render();
		load(tab, true);
	}

	toggle.onclick = (e) => {
		e.preventDefault();
		e.stopPropagation();
		setOpen(!open);
	};

	// Esc：只在面板打开且没有更高的 modal 时拦截（capture，挡掉 app.js 的 abort）
	const modalAbove = () =>
		[...document.querySelectorAll('[aria-modal="true"]')].some((n) => n.getClientRects().length > 0);

	document.addEventListener(
		"keydown",
		(e) => {
			if (!open) return;
			if (e.key !== "Escape" || e.isComposing) return;
			if (modalAbove()) return;
			e.preventDefault();
			e.stopPropagation();
			setOpen(false);
		},
		true,
	);

	render();

	// ---------- 演示钩子（截图用；取不到数据也不阻塞）----------
	window.__piRightPanelDemo = (which) => {
		const key = TABS.some((t) => t.key === which) ? which : "files";
		tab = key;
		setOpen(true);
		const job = load(key, true).catch(() => {});
		return Promise.race([Promise.resolve(job), new Promise((r) => setTimeout(r, DEMO_MS))]).then(() => true);
	};
}
