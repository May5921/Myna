// Ctrl+K 命令面板 + 快捷键帮助。
// 自注入样式与 DOM，不改 index.html / app.js / base.css / 其他 feature。
// 接入：在 app.js 的 FEATURES 里加 "./features/shortcuts.js"（本次不改），或手动 init(ctx)。
//
// 命令可用性每次渲染都重查：顶栏按钮由 settings.js / right-panel.js / export-html.js
// 异步插入，取不到就禁用并在行尾写原因，不静默失败。
// 选择器依据（读 index.html / app.js / export-html.js 确认）：
//   - 设置 #settings-btn（settings.js 动态插入顶栏）
//   - 右栏 #rp-toggle（right-panel.js 动态插入顶栏）
//   - 新会话：index.html 里没有；app.js renderSessions() 里是 #list .newchat，
//     当前项目行是 [aria-label="在此工作区新建会话"]；都没有时回退 ctx.pi.newSession()
//   - 导出：export-html.js 的按钮只有 class .export-btn（无 id、无公开钩子），点它即走它自己的导出
//   - 终端：terminal.js 挂了 window.__piTermToggle（尚未进 FEATURES）；未接入时禁用并写明原因

const PANEL_ID = "cmdk-panel";
const LIST_ID = "cmdk-list";
const INPUT_ID = "cmdk-input";
const TOAST_MS = 3200;
const MAX_ERR = 180;
const GROUPS = ["导航", "会话", "工具"];

const SEARCH_ICON =
	'<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="7" cy="7" r="3.8"/><path d="M9.9 9.9 13 13" stroke-linecap="round"/></svg>';

const CSS = `
.cmdk-overlay {
	position: fixed;
	inset: 0;
	z-index: 1300;
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 24px;
	background: rgba(0, 0, 0, 0.18);
}
.cmdk-overlay[hidden] { display: none; }
.cmdk {
	display: flex;
	flex-direction: column;
	width: min(560px, calc(100vw - 48px));
	max-height: 60vh;
	background: var(--bg);
	color: var(--text);
	border: 1px solid var(--line-strong);
	border-radius: var(--radius-xl);
	box-shadow: var(--shadow-menu);
	overflow: hidden;
	font-family: var(--ui);
}
.cmdk-head {
	flex: none;
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 10px 12px;
	border-bottom: 1px solid var(--line);
}
.cmdk-search-icon { flex: none; display: grid; place-items: center; color: var(--faint); }
.cmdk-input {
	flex: 1;
	min-width: 0;
	padding: 0;
	border: 0;
	outline: 0;
	background: transparent;
	color: var(--text);
	font: inherit;
	font-size: 14px;
	line-height: 20px;
}
.cmdk-input::placeholder { color: var(--faint); }
.cmdk-list {
	flex: 1 1 auto;
	min-height: 0;
	overflow-y: auto;
	overscroll-behavior: contain;
	padding: 6px;
}
.cmdk-group { padding: 8px 8px 4px; font-size: 11px; line-height: 16px; color: var(--faint); }
.cmdk-item {
	display: flex;
	align-items: baseline;
	gap: 12px;
	padding: 7px 8px;
	border-radius: var(--radius-sm);
	font-size: 13px;
	line-height: 18px;
	cursor: pointer;
}
.cmdk-item.is-on { background: var(--sel); }
.cmdk-item.is-off { color: var(--faint); cursor: default; }
.cmdk-item-label { flex: none; }
.cmdk-item-hint {
	margin-left: auto;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	text-align: right;
	font-size: 11.5px;
	color: var(--faint);
}
.cmdk-item.is-off .cmdk-item-hint { color: var(--err); }
.cmdk-empty { padding: 20px 12px; text-align: center; font-size: 12.5px; color: var(--faint); }
.cmdk-foot {
	flex: none;
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 7px 12px;
	border-top: 1px solid var(--line);
	font-size: 11.5px;
	line-height: 16px;
	color: var(--faint);
}
.cmdk-foot-count { flex: none; font-variant-numeric: tabular-nums; }
.cmdk-foot-keys { margin-left: auto; display: flex; align-items: center; gap: 12px; }
.cmdk-key { display: inline-flex; align-items: center; gap: 3px; }
.cmdk-key[hidden] { display: none; }
.cmdk-kbd {
	font-family: var(--mono);
	font-size: 10.5px;
	line-height: 15px;
	padding: 0 4px;
	color: var(--dim);
	background: var(--surface-2);
	border: 1px solid var(--line-strong);
	border-radius: var(--radius-xs);
}
.cmdk-toast {
	position: fixed;
	left: 50%;
	bottom: 96px;
	transform: translateX(-50%);
	z-index: 1310;
	max-width: min(520px, calc(100vw - 32px));
	padding: 8px 12px;
	background: var(--bg);
	border: 1px solid var(--line-strong);
	border-radius: var(--radius-lg);
	box-shadow: var(--shadow-menu);
	font-size: 12.5px;
	line-height: 1.4;
	color: var(--text);
}
.cmdk-toast.is-err { color: var(--err); }
`;

const brief = (s) => {
	const t = String(s ?? "").replace(/\s+/g, " ").trim() || "执行失败";
	return t.length > MAX_ERR ? `${t.slice(0, MAX_ERR)}…` : t;
};

const copyText = async (text) => {
	try {
		await navigator.clipboard.writeText(text);
	} catch {
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.style.position = "fixed";
		ta.style.opacity = "0";
		document.body.append(ta);
		ta.select();
		document.execCommand("copy");
		ta.remove();
	}
};

export function init(ctx) {
	const doc = document;
	if (doc.getElementById(PANEL_ID)) return; // 幂等（热重载会重新 init）

	// ---------- 样式 ----------
	const style = doc.createElement("style");
	style.id = "cmdk-style";
	style.textContent = CSS;
	doc.head.append(style);

	// ---------- 命令表 ----------
	const has = (sel) => !!doc.querySelector(sel);
	// pi 桥没起来时所有 RPC 命令都不可用；返回原因字符串，可用时返回空串
	const piReason = () => (typeof ctx?.pi?.command === "function" ? "" : "pi 桥未就绪（ctx.pi.command 不存在）");
	const newSessionBtn = () =>
		doc.querySelector('#list .proj.current .proj-actions .side-icon[aria-label="在此工作区新建会话"]') ||
		doc.querySelector("#list .newchat");

	const COMMANDS = [
		{
			id: "settings",
			group: "导航",
			label: "打开设置",
			hint: "模型、外观与快捷操作",
			keywords: ["settings", "preferences", "gear", "设置", "偏好"],
			available: () => (has("#settings-btn") ? "" : "设置按钮未接入（#settings-btn 不存在）"),
			run: () => doc.querySelector("#settings-btn")?.click(),
		},
		{
			id: "right-panel",
			group: "导航",
			label: "切换右栏",
			hint: "上下文 / 文件 / 变更",
			keywords: ["right", "panel", "sidebar", "右栏", "侧栏"],
			available: () => (has("#rp-toggle") ? "" : "右栏未接入（#rp-toggle 不存在）"),
			run: () => doc.querySelector("#rp-toggle")?.click(),
		},
		{
			id: "focus-input",
			group: "导航",
			label: "聚焦输入框",
			hint: "回到 composer",
			keywords: ["focus", "input", "composer", "输入框", "聚焦"],
			available: () => (ctx?.input ? "" : "输入框未接入（ctx.input 不存在）"),
			run: () => ctx.input.focus(),
		},
		{
			id: "new-session",
			group: "会话",
			label: "新建会话",
			hint: "在当前工作区开新聊天",
			keywords: ["new", "session", "chat", "新建", "新会话"],
			available: () => {
				if (ctx?.state?.streaming) return "正在生成回答，先停止再新建会话";
				if (newSessionBtn()) return "";
				if (typeof ctx?.pi?.newSession === "function") return "";
				return "找不到新建会话按钮，也没有 ctx.pi.newSession()";
			},
			run: async () => {
				const btn = newSessionBtn();
				if (btn) {
					btn.click();
					return;
				}
				if (typeof ctx?.pi?.newSession !== "function") throw new Error("找不到新建会话按钮");
				await ctx.pi.newSession();
				// 等价 app.js 的 newSession：清空消息区、回到空态、刷新标题
				ctx.reload?.([]);
				await ctx.refreshState?.();
			},
		},
		{
			id: "compact",
			group: "会话",
			label: "压缩上下文",
			hint: "归档旧消息，腾出上下文空间",
			keywords: ["compact", "compaction", "压缩", "上下文"],
			available: () => piReason(),
			run: async () => {
				await ctx.pi.command({ type: "compact" });
				toast("已压缩上下文");
			},
		},
		{
			id: "copy-last",
			group: "会话",
			label: "复制上一条回复",
			hint: "纯文本，不含工具输出",
			keywords: ["copy", "clipboard", "last", "复制", "回复"],
			available: () => piReason(),
			run: async () => {
				const d = await ctx.pi.command({ type: "get_last_assistant_text" });
				if (!d?.text) throw new Error("还没有助手回复");
				await copyText(d.text);
				toast("已复制上一条回复");
			},
		},
		{
			id: "terminal",
			group: "工具",
			label: "打开终端",
			hint: "底部终端面板",
			keywords: ["terminal", "shell", "term", "终端", "命令行"],
			available: () =>
				typeof window.__piTermToggle === "function" ? "" : "终端面板未接入（window.__piTermToggle 未定义）",
			run: () => window.__piTermToggle?.(),
		},
		{
			id: "export-html",
			group: "工具",
			label: "导出 HTML",
			hint: "把当前会话存成 .html",
			keywords: ["export", "html", "导出", "保存"],
			available: () => (doc.querySelector("#export-btn, .export-btn") ? "" : "导出按钮未接入（export-html.js 未加载）"),
			run: () => {
				const btn = doc.querySelector("#export-btn, .export-btn");
				if (!btn) throw new Error("导出按钮未接入");
				btn.click();
			},
		},
	];

	// ---------- DOM ----------
	const overlay = doc.createElement("div");
	overlay.className = "cmdk-overlay";
	overlay.hidden = true;

	const dialog = doc.createElement("div");
	dialog.id = PANEL_ID;
	dialog.className = "cmdk";
	dialog.setAttribute("role", "dialog");
	dialog.setAttribute("aria-modal", "true");
	dialog.setAttribute("aria-label", "命令面板");

	const head = doc.createElement("div");
	head.className = "cmdk-head";
	const icon = doc.createElement("span");
	icon.className = "cmdk-search-icon";
	icon.setAttribute("aria-hidden", "true");
	icon.innerHTML = SEARCH_ICON;

	const input = doc.createElement("input");
	input.id = INPUT_ID;
	input.className = "cmdk-input";
	input.type = "text";
	input.placeholder = "搜索命令…";
	input.autocomplete = "off";
	input.spellcheck = false;
	input.setAttribute("role", "combobox");
	input.setAttribute("aria-expanded", "true");
	input.setAttribute("aria-controls", LIST_ID);
	input.setAttribute("aria-autocomplete", "list");
	input.setAttribute("aria-label", "搜索命令");
	head.append(icon, input);

	const list = doc.createElement("div");
	list.id = LIST_ID;
	list.className = "cmdk-list";
	list.setAttribute("role", "listbox");
	list.setAttribute("aria-label", "命令");

	const kbd = (t) => {
		const k = doc.createElement("kbd");
		k.className = "cmdk-kbd";
		k.textContent = t;
		return k;
	};
	const keyHint = (keys, text) => {
		const box = doc.createElement("span");
		box.className = "cmdk-key";
		for (const k of keys) box.append(kbd(k));
		box.append(doc.createTextNode(` ${text}`));
		return box;
	};

	const foot = doc.createElement("div");
	foot.className = "cmdk-foot";
	const countEl = doc.createElement("span");
	countEl.className = "cmdk-foot-count";
	countEl.setAttribute("aria-live", "polite");
	const keysEl = doc.createElement("span");
	keysEl.className = "cmdk-foot-keys";
	const hNav = keyHint(["↑", "↓"], "选择");
	const hGo = keyHint(["Enter"], "执行");
	const hEsc = keyHint(["Esc"], "关闭");
	keysEl.append(hNav, hGo, hEsc);
	foot.append(countEl, keysEl);

	dialog.append(head, list, foot);
	overlay.append(dialog);
	doc.body.append(overlay);

	// ---------- 状态 ----------
	let rows = []; // 本次渲染的全部行（含禁用）
	let selectable = []; // 其中可执行的行
	let sel = 0; // selectable 下标
	let open = false;
	let lastFocus = null;
	let toastEl = null;
	let toastTimer = 0;

	// ---------- toast ----------
	const toast = (text, opts = {}) => {
		if (toastTimer) clearTimeout(toastTimer);
		toastEl?.remove();
		const el = doc.createElement("div");
		el.className = opts.error ? "cmdk-toast is-err" : "cmdk-toast";
		el.setAttribute("role", opts.error ? "alert" : "status");
		el.setAttribute("aria-live", opts.error ? "assertive" : "polite");
		el.textContent = text;
		el.title = text;
		el.addEventListener("click", () => el.remove());
		doc.body.append(el);
		toastEl = el;
		toastTimer = setTimeout(() => {
			el.remove();
			if (toastEl === el) toastEl = null;
		}, TOAST_MS);
	};

	// ---------- 选择 ----------
	const setActive = (i, scroll = true) => {
		if (!selectable.length) {
			input.removeAttribute("aria-activedescendant");
			return;
		}
		const n = selectable.length;
		sel = ((i % n) + n) % n;
		for (let k = 0; k < n; k++) {
			const on = k === sel;
			selectable[k].el.classList.toggle("is-on", on);
			selectable[k].el.setAttribute("aria-selected", on ? "true" : "false");
		}
		const cur = selectable[sel];
		input.setAttribute("aria-activedescendant", cur.el.id);
		if (scroll) cur.el.scrollIntoView({ block: "nearest" });
	};

	// ---------- 渲染 ----------
	const matchQuery = (cmd, q) => {
		if (!q) return true;
		const hay = `${cmd.label} ${cmd.hint || ""} ${cmd.group} ${(cmd.keywords || []).join(" ")}`.toLowerCase();
		return q
			.split(/\s+/)
			.filter(Boolean)
			.every((t) => hay.includes(t));
	};

	const render = () => {
		const q = input.value.trim().toLowerCase();
		const matched = COMMANDS.filter((c) => matchQuery(c, q));
		list.innerHTML = "";
		rows = [];
		selectable = [];

		let host = list;
		let lastGroup = "";
		for (const cmd of matched) {
			// 空搜索按分组显示；有搜索词时拍平成一张列表
			if (!q && cmd.group !== lastGroup) {
				lastGroup = cmd.group;
				const wrap = doc.createElement("div");
				wrap.className = "cmdk-group-wrap";
				wrap.setAttribute("role", "group");
				const gid = `cmdk-group-${GROUPS.indexOf(cmd.group)}`;
				wrap.setAttribute("aria-labelledby", gid);
				const label = doc.createElement("div");
				label.className = "cmdk-group";
				label.id = gid;
				label.setAttribute("role", "presentation");
				label.textContent = cmd.group;
				wrap.append(label);
				list.append(wrap);
				host = wrap;
			}

			const reason = cmd.available?.() || "";
			const el = doc.createElement("div");
			el.className = reason ? "cmdk-item is-off" : "cmdk-item";
			el.id = `cmdk-opt-${rows.length}`;
			el.setAttribute("role", "option");
			el.setAttribute("aria-selected", "false");
			if (reason) el.setAttribute("aria-disabled", "true");

			const label = doc.createElement("span");
			label.className = "cmdk-item-label";
			label.textContent = cmd.label;
			const hint = doc.createElement("span");
			hint.className = "cmdk-item-hint";
			hint.textContent = reason ? `不可用 · ${reason}` : cmd.hint || "";
			el.append(label, hint);
			host.append(el);

			const entry = { cmd, el, disabled: !!reason, reason };
			rows.push(entry);
			if (!reason) selectable.push(entry);

			// 按下就阻止默认，保住输入框焦点；真正执行放到 click
			el.addEventListener("pointerdown", (e) => e.preventDefault());
			el.addEventListener("pointermove", () => {
				const i = selectable.indexOf(entry);
				if (i >= 0) setActive(i, false);
			});
			el.addEventListener("click", () => {
				if (entry.disabled) {
					toast(entry.reason, { error: true });
					return;
				}
				run(entry.cmd);
			});
		}

		if (!matched.length) {
			const empty = doc.createElement("div");
			empty.className = "cmdk-empty";
			empty.textContent = "没有匹配的命令";
			list.append(empty);
		}

		countEl.textContent = matched.length ? `${matched.length} 项` : "无匹配";
		hNav.hidden = !selectable.length;
		hGo.hidden = !selectable.length;
		sel = 0;
		setActive(0, false);
	};

	// ---------- 开 / 关 ----------
	const openPanel = () => {
		if (open) return;
		open = true;
		lastFocus = doc.activeElement;
		input.value = "";
		overlay.hidden = false;
		render();
		input.focus({ preventScroll: true });
	};

	const closePanel = () => {
		if (!open) return;
		open = false;
		overlay.hidden = true;
		const back = lastFocus;
		lastFocus = null;
		if (back && back.isConnected && back !== doc.body && typeof back.focus === "function") {
			back.focus({ preventScroll: true });
			return;
		}
		ctx?.input?.focus?.({ preventScroll: true });
	};

	// ---------- 执行 ----------
	const run = async (cmd) => {
		closePanel(); // 先关再执行：焦点先回到原处，命令自己决定后续焦点
		try {
			await cmd.run();
		} catch (err) {
			toast(brief(err?.message || err), { error: true });
		}
	};

	// ---------- 键盘 ----------
	const composing = (e) => e.isComposing || e.keyCode === 229;
	const toggleKey = (e) =>
		(e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.code === "KeyK" || e.key === "k" || e.key === "K");

	const onKey = (e) => {
		if (composing(e)) return; // 输入法组合中一律不抢
		if (toggleKey(e)) {
			e.preventDefault();
			e.stopPropagation();
			if (e.repeat) return;
			if (open) closePanel();
			else openPanel();
			return;
		}
		if (!open) return; // 面板没开时只认 Ctrl/Cmd+K，其余键原样放行
		switch (e.key) {
			case "Escape":
				e.preventDefault();
				e.stopPropagation();
				closePanel();
				return;
			case "ArrowDown":
				e.preventDefault();
				e.stopPropagation();
				setActive(sel + 1);
				return;
			case "ArrowUp":
				e.preventDefault();
				e.stopPropagation();
				setActive(sel - 1);
				return;
			case "Home":
				e.preventDefault();
				e.stopPropagation();
				setActive(0);
				return;
			case "End":
				e.preventDefault();
				e.stopPropagation();
				setActive(selectable.length - 1);
				return;
			case "PageDown":
				e.preventDefault();
				e.stopPropagation();
				setActive(sel + 5);
				return;
			case "PageUp":
				e.preventDefault();
				e.stopPropagation();
				setActive(sel - 5);
				return;
			case "Enter":
				e.preventDefault();
				e.stopPropagation();
				if (selectable[sel]) run(selectable[sel].cmd);
				return;
			case "Tab":
				// 面板里只有输入框一个焦点目标，导航靠 aria-activedescendant
				e.preventDefault();
				e.stopPropagation();
				input.focus({ preventScroll: true });
				return;
		}
	};
	doc.addEventListener("keydown", onKey, true);

	// ---------- 搜索框 ----------
	input.addEventListener("compositionstart", () => {
		input.dataset.composing = "1";
	});
	input.addEventListener("compositionend", () => {
		delete input.dataset.composing;
		render();
	});
	input.addEventListener("input", () => {
		// 中文输入法组合期间不重建列表，否则 IME 会被打断
		if (input.dataset.composing === "1") return;
		render();
	});

	// 点遮罩关闭；点面板内部不关
	overlay.addEventListener("pointerdown", (e) => {
		if (e.target === overlay) closePanel();
	});
	dialog.addEventListener("pointerdown", (e) => e.stopPropagation());
}
