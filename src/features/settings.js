// 设置：顶栏齿轮按钮 + 居中弹窗，把 pi RPC 能驱动的设置项集中到一处。
// 自注入样式与 DOM（#topbar .spacer 之后），不改 index.html / app.js / base.css / 其他 feature。
// RPC：get_state / get_available_models / set_model / get_available_thinking_levels /
//      set_thinking_level / set_auto_compaction / set_auto_retry（读不回，仅本地记录）/
//      set_steering_mode / set_follow_up_mode / set_session_name / compact / export_html /
//      get_session_stats

const RETRY_KEY = "pi-mini.auto-retry";
const ERR_MS = 3000;
const TOAST_MS = 4000;
const CONFIRM_MS = 2500;
const SAVED_MS = 1400;
const MENU_GAP = 6;
const MAX_ERR = 120;

// 档位兜底表（对齐 thinking-level.js）；真实值以 get_available_thinking_levels 为准
const FALLBACK_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const MODES = [
	{ key: "all", label: "全部" },
	{ key: "one-at-a-time", label: "一条一条" },
];

const GEAR_ICON =
	'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>';

const IS_ABS = (p) => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("/");

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");

const fmtNum = (n) => Math.round(n).toLocaleString("en-US");

// 紧凑 token：1.2k / 12k / 1.0M
const fmtCompact = (n) => {
	if (!isNum(n)) return "—";
	const a = Math.abs(n);
	if (a < 1000) return fmtNum(n);
	if (a < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (a < 1000000) return `${Math.round(n / 1000)}k`;
	if (a < 10000000) return `${(n / 1000000).toFixed(1)}M`;
	return `${Math.round(n / 1000000)}M`;
};

const fmtPct = (p) => `${p.toFixed(1).replace(/\.0$/, "")}%`;

const fmtCost = (n) => {
	if (!isNum(n)) return "—";
	if (n === 0) return "$0";
	if (n < 1) return `$${n.toFixed(4)}`;
	return `$${n.toFixed(2)}`;
};

const brief = (err) => {
	const t = String(err?.message ?? err ?? "")
		.replace(/\s+/g, " ")
		.trim();
	if (!t) return "操作失败";
	return t.length > MAX_ERR ? `${t.slice(0, MAX_ERR)}…` : t;
};

const CSS = `
.settings-gear {
	width: 28px;
	height: 28px;
	border-radius: 6px;
	display: grid;
	place-items: center;
	color: var(--faint);
	flex: none;
	transition: background-color 120ms ease, color 120ms ease;
}
.settings-gear:hover,
.settings-gear[aria-expanded="true"] { background: var(--hover); color: var(--text); }
.settings-gear:focus-visible { outline: 1px solid var(--faint); outline-offset: -1px; }

.settings-overlay {
	position: fixed;
	inset: 0;
	z-index: 60;
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 16px;
	background: rgba(26, 28, 31, 0.18);
}
.settings-overlay[hidden] { display: none; }

.settings-dialog {
	display: flex;
	flex-direction: column;
	width: min(560px, 100vw - 32px);
	max-height: 80vh;
	background: var(--bg);
	border: 1px solid var(--line);
	border-radius: 16px;
	box-shadow: var(--shadow-menu);
	overflow: hidden;
	outline: none;
}

.settings-head {
	flex: none;
	height: 52px;
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	padding: 0 16px;
	border-bottom: 1px solid var(--line);
}
.settings-title {
	font-size: 13px;
	font-weight: 600;
	letter-spacing: -0.01em;
	color: var(--text);
}
.settings-close {
	width: 28px;
	height: 28px;
	border-radius: 6px;
	display: grid;
	place-items: center;
	color: var(--faint);
	font-size: 16px;
	line-height: 1;
	transition: background-color 120ms ease, color 120ms ease;
}
.settings-close:hover { background: var(--hover); color: var(--text); }
.settings-close:focus-visible { outline: 1px solid var(--faint); outline-offset: -1px; }

.settings-body {
	flex: 1;
	min-height: 0;
	overflow-y: auto;
	padding: 4px 0 10px;
}
.settings-note {
	padding: 6px 16px 0;
	font-size: 11.5px;
	line-height: 1.35;
	color: var(--err);
}
.settings-note[hidden] { display: none; }

.settings-sec { padding-top: 2px; }
.settings-sec-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	padding: 10px 16px 4px;
}
.settings-sec-title { font-size: 12px; line-height: 1.4; color: var(--faint); }

.settings-row {
	display: grid;
	grid-template-columns: minmax(0, 1fr) auto;
	column-gap: 12px;
	align-items: center;
	min-height: 44px;
	padding: 0 16px;
	transition: background-color 120ms ease;
}
.settings-row:hover { background: var(--hover); }
.settings-main {
	display: flex;
	flex-direction: column;
	justify-content: center;
	gap: 1px;
	min-width: 0;
	padding: 4px 0;
}
.settings-label { font-size: 13px; line-height: 1.35; color: var(--text); }
.settings-sub { font-size: 11.5px; line-height: 1.35; color: var(--faint); }
.settings-ctl { display: flex; align-items: center; gap: 8px; justify-self: end; }
.settings-err {
	grid-column: 1 / -1;
	padding: 0 0 8px;
	font-size: 11.5px;
	line-height: 1.35;
	color: var(--err);
}

.settings-btn {
	height: 26px;
	padding: 0 10px;
	border: 1px solid var(--line);
	border-radius: 8px;
	font: 12.5px/1 var(--ui);
	color: var(--dim);
	white-space: nowrap;
	transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease;
}
.settings-btn:hover:not(:disabled) { background: var(--hover); color: var(--text); border-color: var(--line-strong); }
.settings-btn:focus-visible { outline: 1px solid var(--faint); outline-offset: -1px; }
.settings-btn:disabled { opacity: 0.45; cursor: default; }
.settings-btn.is-armed { color: var(--err); border-color: var(--line-strong); }

.settings-refresh {
	height: 22px;
	padding: 0 6px;
	border-radius: 6px;
	font: 12px/1 var(--ui);
	color: var(--faint);
	transition: background-color 120ms ease, color 120ms ease;
}
.settings-refresh:hover:not(:disabled) { background: var(--hover); color: var(--text); }
.settings-refresh:focus-visible { outline: 1px solid var(--faint); outline-offset: -1px; }
.settings-refresh:disabled { opacity: 0.45; cursor: default; }

.settings-input {
	width: 168px;
	height: 26px;
	padding: 0 8px;
	background: var(--bg);
	border: 1px solid var(--line);
	border-radius: 8px;
	font: 12.5px/1 var(--ui);
	color: var(--text);
	outline: none;
	transition: border-color 120ms ease;
}
.settings-input::placeholder { color: var(--faint); }
.settings-input:focus { border-color: var(--line-strong); }

.settings-switch {
	position: relative;
	flex: none;
	width: 34px;
	height: 20px;
	border-radius: 999px;
	background: var(--line);
	transition: background-color 120ms ease;
}
.settings-switch::after {
	content: "";
	position: absolute;
	top: 2px;
	left: 2px;
	width: 16px;
	height: 16px;
	border-radius: 999px;
	background: var(--bg);
	transition: transform 120ms ease;
}
.settings-switch[aria-checked="true"] { background: var(--send-bg); }
.settings-switch[aria-checked="true"]::after { transform: translateX(14px); }
.settings-switch:focus-visible { outline: 1px solid var(--faint); outline-offset: 2px; }
.settings-switch[aria-busy="true"] { opacity: 0.6; }

.settings-value {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	height: 26px;
	max-width: 260px;
	padding: 0 8px;
	border-radius: 8px;
	font: 12.5px/1 var(--ui);
	color: var(--dim);
	transition: background-color 120ms ease, color 120ms ease;
}
.settings-value:hover,
.settings-value[aria-expanded="true"] { background: var(--hover); color: var(--text); }
.settings-value:focus-visible { outline: 1px solid var(--faint); outline-offset: -1px; }
.settings-value-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.settings-chev { flex: none; font-size: 11px; line-height: 1; color: var(--faint); }

.settings-menu {
	position: fixed;
	z-index: 80;
	min-width: 168px;
	max-height: 60vh;
	overflow-y: auto;
	padding: 5px;
	background: var(--bg);
	border: 1px solid var(--line);
	border-radius: var(--radius-xl);
	box-shadow: var(--shadow-menu);
}
.settings-menu-item {
	display: flex;
	align-items: center;
	gap: 10px;
	width: 100%;
	height: 30px;
	padding: 0 8px;
	border-radius: 8px;
	font: 12.5px/1 var(--ui);
	color: var(--dim);
	text-align: left;
}
.settings-menu-item:hover,
.settings-menu-item:focus-visible { background: var(--hover); color: var(--text); }
.settings-menu-item.on { color: var(--text); }
.settings-menu-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.settings-menu-hint { flex: none; font-size: 11px; color: var(--faint); }
.settings-check { flex: none; width: 10px; text-align: center; color: var(--text); }

.settings-stats { padding: 2px 0 4px; }
.settings-stat {
	display: flex;
	align-items: baseline;
	justify-content: space-between;
	gap: 16px;
	min-height: 26px;
	padding: 2px 16px;
}
.settings-stat-k { font-size: 12px; color: var(--dim); }
.settings-stat-v {
	font: 12px/1.55 var(--mono);
	color: var(--text);
	font-variant-numeric: tabular-nums;
	text-align: right;
	white-space: nowrap;
}

.settings-toast {
	position: fixed;
	left: 50%;
	bottom: 24px;
	transform: translateX(-50%);
	z-index: 90;
	max-width: min(560px, calc(100vw - 32px));
	padding: 8px 12px;
	background: var(--bg);
	border: 1px solid var(--line);
	border-radius: var(--radius-xl);
	box-shadow: var(--shadow-menu);
	font-size: 12.5px;
	line-height: 1.4;
	color: var(--text);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.settings-toast.is-openable { cursor: pointer; }
.settings-toast.is-openable:hover { border-color: var(--line-strong); }

@media (prefers-reduced-motion: reduce) {
	.settings-gear,
	.settings-close,
	.settings-btn,
	.settings-refresh,
	.settings-input,
	.settings-switch,
	.settings-switch::after,
	.settings-value,
	.settings-row { transition: none; }
}
`;

export function init(ctx) {
	if (!ctx?.pi) return;
	const topbar = document.getElementById("topbar");
	if (!topbar) return;
	if (document.getElementById("settings-btn")) return; // 幂等

	const style = document.createElement("style");
	style.textContent = CSS;
	document.head.append(style);

	// ---------- 状态 ----------
	const st = {
		sessionName: "",
		model: null,
		thinkingLevel: null,
		autoCompaction: false,
		steering: "all",
		followUp: "all",
	};
	const busy = { name: false, export: false, compact: false, autoCompact: false };
	let models = Array.isArray(ctx.state?.models) ? ctx.state.models.slice() : [];
	let levels = FALLBACK_LEVELS.slice();
	let stats = null;
	let statsErr = "";
	let statsBusy = false;
	let armed = false;
	let armTimer = 0;
	let savedTimer = 0;
	let sessionTimer = 0;
	let lastFocus = null;

	// ---------- 小工具 ----------
	const el = (tag, cls, text) => {
		const n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text != null) n.textContent = text;
		return n;
	};

	// export_html 未传 outputPath 时返回相对 CLI cwd 的裸文件名，补成绝对路径
	const absolute = (p) => {
		const raw = String(p ?? "");
		if (!raw) return "";
		if (IS_ABS(raw)) return raw;
		const base = String(ctx.state?.cwd || "").replace(/[\\/]+$/, "");
		return base ? `${base}/${raw.replace(/^\.?[\\/]+/, "")}` : raw;
	};

	const loadRetryFlag = () => {
		try {
			return localStorage.getItem(RETRY_KEY) === "1";
		} catch {
			return false;
		}
	};

	const saveRetryFlag = (on) => {
		try {
			localStorage.setItem(RETRY_KEY, on ? "1" : "0");
		} catch {}
	};

	// ---------- 顶栏齿轮 ----------
	const gear = document.createElement("button");
	gear.type = "button";
	gear.id = "settings-btn";
	gear.className = "settings-gear";
	gear.title = "设置";
	gear.setAttribute("aria-label", "设置");
	gear.setAttribute("aria-haspopup", "dialog");
	gear.setAttribute("aria-expanded", "false");
	gear.innerHTML = GEAR_ICON;

	const spacer = topbar.querySelector(".spacer");
	if (spacer) spacer.insertAdjacentElement("afterend", gear);
	else topbar.append(gear);

	// ---------- 弹窗骨架 ----------
	const overlay = el("div", "settings-overlay");
	overlay.hidden = true;

	const dialog = el("div", "settings-dialog");
	dialog.tabIndex = -1;
	dialog.setAttribute("role", "dialog");
	dialog.setAttribute("aria-modal", "true");
	dialog.setAttribute("aria-labelledby", "settings-title");

	const head = el("div", "settings-head");
	const title = el("span", "settings-title", "设置");
	title.id = "settings-title";
	const closeBtn = el("button", "settings-close", "×");
	closeBtn.type = "button";
	closeBtn.title = "关闭";
	closeBtn.setAttribute("aria-label", "关闭设置");
	head.append(title, closeBtn);

	const panelBody = el("div", "settings-body");
	const headNote = el("div", "settings-note");
	headNote.hidden = true;
	headNote.setAttribute("role", "alert");
	panelBody.append(headNote);

	dialog.append(head, panelBody);
	overlay.append(dialog);
	document.body.append(overlay);

	// ---------- 菜单（fixed，避开弹窗滚动裁剪）----------
	let menu = null;
	let menuSeq = 0;

	const placeMenu = (anchor) => {
		if (!menu) return;
		const host = menu.el;
		const r = anchor.getBoundingClientRect();
		host.style.minWidth = `${Math.max(168, Math.round(r.width))}px`;
		host.style.top = "0px";
		host.style.left = "0px";
		const w = host.offsetWidth;
		const h = host.offsetHeight;
		let top = Math.round(r.bottom + MENU_GAP);
		if (top + h > window.innerHeight - 8) top = Math.max(8, Math.round(r.top - h - MENU_GAP));
		let left = Math.round(r.right - w);
		left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
		host.style.top = `${top}px`;
		host.style.left = `${left}px`;
	};

	const onMenuDown = (e) => {
		if (!menu) return;
		if (menu.el.contains(e.target) || menu.anchor.contains(e.target)) return;
		closeMenu();
	};

	const onMenuKey = (e) => {
		if (!menu || e.key !== "Escape") return;
		e.preventDefault();
		e.stopPropagation();
		const anchor = menu.anchor;
		closeMenu();
		anchor?.focus?.();
	};

	const onViewport = (e) => {
		if (!menu) return;
		if (e.type === "scroll" && e.target && e.target.nodeType === 1 && menu.el.contains(e.target)) return;
		closeMenu();
	};

	const closeMenu = () => {
		if (!menu) return;
		const { el: host, anchor } = menu;
		menu = null;
		host.remove();
		if (anchor?.isConnected) anchor.setAttribute("aria-expanded", "false");
		document.removeEventListener("pointerdown", onMenuDown, true);
		document.removeEventListener("keydown", onMenuKey, true);
		window.removeEventListener("resize", onViewport, true);
		window.removeEventListener("scroll", onViewport, true);
	};

	const openMenu = (anchor, items, currentKey, onPick) => {
		closeMenu();
		const host = el("div", "settings-menu");
		host.setAttribute("role", "menu");
		for (const item of items) {
			const on = item.key === currentKey;
			const b = el("button", "settings-menu-item" + (on ? " on" : ""));
			b.type = "button";
			b.setAttribute("role", "menuitemradio");
			b.setAttribute("aria-checked", on ? "true" : "false");
			const label = el("span", "settings-menu-label", item.label);
			b.append(label);
			if (item.hint) b.append(el("span", "settings-menu-hint", item.hint));
			b.append(el("span", "settings-check", on ? "✓" : ""));
			b.onclick = (e) => {
				e.preventDefault();
				e.stopPropagation();
				closeMenu();
				onPick(item);
			};
			host.append(b);
		}
		menu = { el: host, anchor };
		document.body.append(host);
		anchor.setAttribute("aria-expanded", "true");
		placeMenu(anchor);
		document.addEventListener("pointerdown", onMenuDown, true);
		document.addEventListener("keydown", onMenuKey, true);
		window.addEventListener("resize", onViewport, true);
		window.addEventListener("scroll", onViewport, true);
	};

	// ---------- 行 / 控件 ----------
	const makeRow = (label, sub) => {
		const row = el("div", "settings-row");
		const main = el("div", "settings-main");
		main.append(el("span", "settings-label", label));
		let subEl = null;
		if (sub) {
			subEl = el("span", "settings-sub", sub);
			main.append(subEl);
		}
		const ctl = el("div", "settings-ctl");
		row.append(main, ctl);
		return { row, ctl, subEl };
	};

	const section = (text, action) => {
		const wrap = el("div", "settings-sec");
		const secHead = el("div", "settings-sec-head");
		secHead.append(el("span", "settings-sec-title", text));
		if (action) secHead.append(action);
		wrap.append(secHead);
		panelBody.append(wrap);
		return wrap;
	};

	const actionBtn = (text, onClick) => {
		const b = el("button", "settings-btn", text);
		b.type = "button";
		b.onclick = onClick;
		return b;
	};

	const makeSwitch = (label) => {
		const b = el("button", "settings-switch");
		b.type = "button";
		b.setAttribute("role", "switch");
		b.setAttribute("aria-label", label);
		b.setAttribute("aria-checked", "false");
		return b;
	};

	const makeSelect = (value, onOpen) => {
		const b = el("button", "settings-value");
		b.type = "button";
		b.setAttribute("aria-haspopup", "menu");
		b.setAttribute("aria-expanded", "false");
		const text = el("span", "settings-value-text", value);
		const chev = el("span", "settings-chev", "⌄");
		chev.setAttribute("aria-hidden", "true");
		b.append(text, chev);
		b.onclick = (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (menu && menu.anchor === b) {
				closeMenu(); // 再点一次收起
				return;
			}
			onOpen(b);
		};
		return { btn: b, text };
	};

	// 行内错误：var(--err) 小字，3s 后自己消失
	const fail = (row, err) => {
		for (const old of row.querySelectorAll(".settings-err")) old.remove();
		const box = el("span", "settings-err", brief(err));
		box.setAttribute("role", "alert");
		row.append(box);
		setTimeout(() => box.remove(), ERR_MS);
	};

	// ---------- 1. 会话 ----------
	const secSession = section("会话");

	const nameRow = makeRow("会话名", "回车保存，留空不改");
	const nameInput = document.createElement("input");
	nameInput.type = "text";
	nameInput.className = "settings-input";
	nameInput.maxLength = 200;
	nameInput.placeholder = "未命名";
	nameInput.setAttribute("aria-label", "会话名称");
	nameInput.addEventListener("keydown", (e) => {
		e.stopPropagation();
		if (e.isComposing) return;
		if (e.key !== "Enter") return;
		e.preventDefault();
		saveName();
	});
	const nameSave = actionBtn("保存", () => saveName());
	nameRow.ctl.append(nameInput, nameSave);
	secSession.append(nameRow.row);

	const exportRow = makeRow("导出 HTML", "写入工作区根目录");
	const exportBtn = actionBtn("导出", () => runExport());
	exportRow.ctl.append(exportBtn);
	secSession.append(exportRow.row);

	const compactRow = makeRow("压缩上下文", "归档旧消息，腾出上下文空间");
	const compactBtn = actionBtn("压缩", () => runCompact());
	compactRow.ctl.append(compactBtn);
	secSession.append(compactRow.row);

	// ---------- 2. 模型与推理 ----------
	const secModel = section("模型与推理");

	const modelRow = makeRow("模型", "当前会话使用的模型");
	const modelSel = makeSelect("—", (anchor) => openModelMenu(anchor));
	modelRow.ctl.append(modelSel.btn);
	secModel.append(modelRow.row);

	const thinkRow = makeRow("思考档位", "推理强度");
	const thinkSel = makeSelect("—", (anchor) => openThinkingMenu(anchor));
	thinkRow.ctl.append(thinkSel.btn);
	secModel.append(thinkRow.row);

	// ---------- 3. 行为 ----------
	const secBehavior = section("行为");

	const autoCompactRow = makeRow("自动压缩", "接近上下文上限时自动压缩");
	const autoCompactSwitch = makeSwitch("自动压缩");
	autoCompactSwitch.onclick = (e) => {
		e.preventDefault();
		e.stopPropagation();
		toggleAutoCompact();
	};
	autoCompactRow.ctl.append(autoCompactSwitch);
	secBehavior.append(autoCompactRow.row);

	const retryRow = makeRow("自动重试", "本地记录，pi 无法读回当前值");
	const retrySwitch = makeSwitch("自动重试");
	retrySwitch.setAttribute("aria-checked", loadRetryFlag() ? "true" : "false");
	retrySwitch.onclick = (e) => {
		e.preventDefault();
		e.stopPropagation();
		toggleAutoRetry();
	};
	retryRow.ctl.append(retrySwitch);
	secBehavior.append(retryRow.row);

	const followRow = makeRow("排队模式", "流式期间的跟进消息");
	const followSel = makeSelect("—", (anchor) => openModeMenu(anchor, "followUp"));
	followRow.ctl.append(followSel.btn);
	secBehavior.append(followRow.row);

	const steerRow = makeRow("插话模式", "立即插入当前回合");
	const steerSel = makeSelect("—", (anchor) => openModeMenu(anchor, "steering"));
	steerRow.ctl.append(steerSel.btn);
	secBehavior.append(steerRow.row);

	// ---------- 4. 统计 ----------
	const refreshBtn = el("button", "settings-refresh", "刷新");
	refreshBtn.type = "button";
	refreshBtn.title = "重新读取会话统计";
	refreshBtn.setAttribute("aria-label", "刷新统计");
	refreshBtn.onclick = () => fetchStats(true);
	const secStats = section("统计", refreshBtn);

	const statsList = el("div", "settings-stats");
	const statValue = {};
	for (const [key, label] of [
		["ctx", "上下文"],
		["input", "输入"],
		["output", "输出"],
		["cacheRead", "缓存读"],
		["cacheWrite", "缓存写"],
		["cost", "费用"],
		["messages", "消息数"],
	]) {
		const row = el("div", "settings-stat");
		row.append(el("span", "settings-stat-k", label));
		const v = el("span", "settings-stat-v", "—");
		row.append(v);
		statsList.append(row);
		statValue[key] = v;
	}
	secStats.append(statsList);

	const statsNote = el("div", "settings-note");
	statsNote.hidden = true;
	secStats.append(statsNote);

	// ---------- 渲染 ----------
	function renderModel() {
		modelSel.text.textContent = st.model ? st.model.name || st.model.id || "—" : "—";
		modelSel.text.title = st.model ? `${st.model.name || st.model.id} · ${st.model.provider || ""}` : "";
		if (modelRow.subEl) modelRow.subEl.textContent = st.model?.provider || "当前会话使用的模型";
	}

	function renderThinking() {
		thinkSel.text.textContent = cap(st.thinkingLevel) || "—";
	}

	function renderModes() {
		const find = (m) => MODES.find((x) => x.key === m)?.label ?? (m || "—");
		followSel.text.textContent = find(st.followUp);
		steerSel.text.textContent = find(st.steering);
	}

	function renderSwitches() {
		autoCompactSwitch.setAttribute("aria-checked", st.autoCompaction ? "true" : "false");
	}

	function render() {
		renderModel();
		renderThinking();
		renderModes();
		renderSwitches();
	}

	function renderStats() {
		const tk = stats?.tokens && typeof stats.tokens === "object" ? stats.tokens : null;
		const cu = stats?.contextUsage && typeof stats.contextUsage === "object" ? stats.contextUsage : null;

		if (cu && isNum(cu.tokens)) {
			const parts = [];
			if (isNum(cu.percent)) parts.push(fmtPct(cu.percent));
			parts.push(
				isNum(cu.contextWindow) ? `${fmtCompact(cu.tokens)} / ${fmtCompact(cu.contextWindow)}` : fmtCompact(cu.tokens),
			);
			statValue.ctx.textContent = parts.join(" · ");
		} else {
			statValue.ctx.textContent = cu && isNum(cu.contextWindow) ? `— / ${fmtCompact(cu.contextWindow)}` : "—";
		}

		const fields = [
			["input", "input"],
			["output", "output"],
			["cacheRead", "cacheRead"],
			["cacheWrite", "cacheWrite"],
		];
		for (const [slot, key] of fields) {
			statValue[slot].textContent = tk && isNum(tk[key]) ? fmtNum(tk[key]) : "—";
		}
		statValue.cost.textContent = isNum(stats?.cost) ? fmtCost(stats.cost) : "—";
		statValue.messages.textContent = isNum(stats?.totalMessages) ? fmtNum(stats.totalMessages) : "—";

		statsNote.textContent = statsErr;
		statsNote.hidden = !statsErr;
	}

	// ---------- 数据 ----------
	async function loadState() {
		try {
			const s = await ctx.pi.command({ type: "get_state" });
			if (!s || typeof s !== "object") throw new Error("状态不可用");
			st.model = s.model ?? null;
			st.thinkingLevel = s.thinkingLevel ?? null;
			st.autoCompaction = !!s.autoCompactionEnabled;
			st.steering = s.steeringMode || "all";
			st.followUp = s.followUpMode || "all";
			st.sessionName = typeof s.sessionName === "string" ? s.sessionName : "";
			if (document.activeElement !== nameInput) nameInput.value = st.sessionName;
			headNote.hidden = true;
			headNote.textContent = "";
			render();
		} catch (e) {
			headNote.textContent = brief(e);
			headNote.hidden = false;
		}
	}

	async function fetchStats(manual) {
		if (statsBusy) return;
		statsBusy = true;
		refreshBtn.disabled = true;
		refreshBtn.setAttribute("aria-busy", "true");
		if (manual) refreshBtn.textContent = "读取中";
		try {
			const d = await ctx.pi.command({ type: "get_session_stats" });
			if (!d || typeof d !== "object") throw new Error("统计不可用");
			stats = d;
			statsErr = "";
		} catch (e) {
			statsErr = brief(e);
		} finally {
			statsBusy = false;
			refreshBtn.disabled = false;
			refreshBtn.removeAttribute("aria-busy");
			refreshBtn.textContent = "刷新";
		}
		renderStats();
	}

	// ---------- 动作 ----------
	async function saveName() {
		if (busy.name) return;
		const name = nameInput.value.trim();
		if (!name || name === st.sessionName) return;
		busy.name = true;
		nameSave.disabled = true;
		try {
			await ctx.pi.command({ type: "set_session_name", name });
			st.sessionName = name;
			ctx.state.sessionName = name;
			clearTimeout(savedTimer);
			nameSave.textContent = "已保存";
			savedTimer = setTimeout(() => {
				nameSave.textContent = "保存";
			}, SAVED_MS);
			ctx.refreshState?.();
		} catch (e) {
			fail(nameRow.row, e);
		} finally {
			busy.name = false;
			nameSave.disabled = false;
		}
	}

	async function runExport() {
		if (busy.export) return;
		busy.export = true;
		exportBtn.disabled = true;
		exportBtn.setAttribute("aria-busy", "true");
		try {
			const r = await ctx.pi.command({ type: "export_html" });
			const path = absolute(r?.path);
			if (!path) throw new Error("pi 未返回导出路径");
			toast(`已导出 ${ctx.relPath?.(path) || path}`, { open: path });
		} catch (e) {
			fail(exportRow.row, e);
		} finally {
			busy.export = false;
			exportBtn.disabled = false;
			exportBtn.removeAttribute("aria-busy");
		}
	}

	function disarm() {
		if (armTimer) {
			clearTimeout(armTimer);
			armTimer = 0;
		}
		if (!armed) return;
		armed = false;
		compactBtn.textContent = "压缩";
		compactBtn.classList.remove("is-armed");
	}

	async function runCompact() {
		if (busy.compact) return;
		if (!armed) {
			armed = true;
			compactBtn.textContent = "确认压缩";
			compactBtn.classList.add("is-armed");
			armTimer = setTimeout(disarm, CONFIRM_MS);
			return;
		}
		disarm();
		busy.compact = true;
		compactBtn.disabled = true;
		compactBtn.setAttribute("aria-busy", "true");
		try {
			await ctx.pi.command({ type: "compact" });
			toast("已压缩上下文");
			fetchStats();
			ctx.refreshState?.();
		} catch (e) {
			fail(compactRow.row, e);
		} finally {
			busy.compact = false;
			compactBtn.disabled = false;
			compactBtn.removeAttribute("aria-busy");
		}
	}

	async function toggleAutoCompact() {
		if (busy.autoCompact) return;
		const next = autoCompactSwitch.getAttribute("aria-checked") !== "true";
		busy.autoCompact = true;
		autoCompactSwitch.setAttribute("aria-checked", next ? "true" : "false");
		autoCompactSwitch.setAttribute("aria-busy", "true");
		try {
			await ctx.pi.command({ type: "set_auto_compaction", enabled: next });
			st.autoCompaction = next;
		} catch (e) {
			autoCompactSwitch.setAttribute("aria-checked", next ? "false" : "true");
			fail(autoCompactRow.row, e);
		} finally {
			busy.autoCompact = false;
			autoCompactSwitch.removeAttribute("aria-busy");
		}
	}

	function toggleAutoRetry() {
		const next = retrySwitch.getAttribute("aria-checked") !== "true";
		retrySwitch.setAttribute("aria-checked", next ? "true" : "false");
		saveRetryFlag(next); // 读不回，先落本地
		ctx.pi.command({ type: "set_auto_retry", enabled: next }).catch((e) => {
			retrySwitch.setAttribute("aria-checked", next ? "false" : "true");
			saveRetryFlag(!next);
			fail(retryRow.row, e);
		});
	}

	// ---------- 菜单构建 ----------
	async function openModelMenu(anchor) {
		closeMenu();
		const seq = ++menuSeq;
		let list = models.slice();
		try {
			const d = await ctx.pi.command({ type: "get_available_models" });
			const got = Array.isArray(d?.models) ? d.models.filter((m) => m && (m.id || m.name)) : [];
			if (got.length) {
				models = got;
				list = got;
			}
		} catch (e) {
			if (!list.length) {
				fail(modelRow.row, e);
				return;
			}
		}
		if (seq !== menuSeq) return;
		if (!list.length) {
			fail(modelRow.row, "没有可用模型");
			return;
		}
		const items = list.map((m) => ({
			key: `${m.provider}::${m.id}`,
			label: m.name || m.id,
			hint: m.provider,
			model: m,
		}));
		const current = st.model ? `${st.model.provider}::${st.model.id}` : "";
		openMenu(anchor, items, current, (item) => pickModel(item.model));
	}

	async function pickModel(m) {
		const prev = st.model;
		st.model = { id: m.id, name: m.name, provider: m.provider };
		renderModel();
		try {
			const d = await ctx.pi.command({ type: "set_model", provider: m.provider, modelId: m.id });
			if (d && typeof d === "object" && d.id) st.model = d;
			ctx.state.model = st.model;
			renderModel();
			ctx.refreshState?.();
		} catch (e) {
			st.model = prev;
			renderModel();
			fail(modelRow.row, e);
		}
	}

	async function openThinkingMenu(anchor) {
		closeMenu();
		const seq = ++menuSeq;
		try {
			const d = await ctx.pi.command({ type: "get_available_thinking_levels" });
			const got = Array.isArray(d?.levels) ? d.levels.filter((x) => typeof x === "string") : [];
			if (got.length) levels = got;
		} catch {
			// 拉不到就用兜底档位表，菜单照开
		}
		if (seq !== menuSeq) return;
		const items = levels.map((l) => ({ key: l, label: cap(l) }));
		openMenu(anchor, items, st.thinkingLevel || "", (item) => pickThinking(item.key));
	}

	async function pickThinking(level) {
		const prev = st.thinkingLevel;
		st.thinkingLevel = level;
		renderThinking();
		try {
			await ctx.pi.command({ type: "set_thinking_level", level });
		} catch (e) {
			st.thinkingLevel = prev;
			renderThinking();
			fail(thinkRow.row, e);
		}
	}

	function openModeMenu(anchor, which) {
		const current = which === "steering" ? st.steering : st.followUp;
		openMenu(
			anchor,
			MODES.map((m) => ({ key: m.key, label: m.label })),
			current,
			async (item) => {
				if (item.key === current) return;
				const cmd =
					which === "steering"
						? { type: "set_steering_mode", mode: item.key }
						: { type: "set_follow_up_mode", mode: item.key };
				if (which === "steering") st.steering = item.key;
				else st.followUp = item.key;
				renderModes();
				try {
					await ctx.pi.command(cmd);
				} catch (e) {
					if (which === "steering") st.steering = current;
					else st.followUp = current;
					renderModes();
					fail(which === "steering" ? steerRow.row : followRow.row, e);
				}
			},
		);
	}

	// ---------- toast ----------
	let toastEl = null;
	let toastTimer = 0;

	function closeToast() {
		if (toastTimer) {
			clearTimeout(toastTimer);
			toastTimer = 0;
		}
		if (toastEl) {
			toastEl.remove();
			toastEl = null;
		}
	}

	function toast(text, opts = {}) {
		closeToast();
		const box = el("div", "settings-toast", text);
		box.setAttribute("role", "status");
		box.title = text;
		if (opts.open) {
			box.classList.add("is-openable");
			box.title = `${text}\n点击打开`;
			box.onclick = () => {
				try {
					ctx.pi.openPath?.(opts.open);
				} catch {}
				closeToast();
			};
		}
		document.body.append(box);
		toastEl = box;
		toastTimer = setTimeout(closeToast, TOAST_MS);
	}

	// ---------- 开关 ----------
	function openDialog() {
		if (!overlay.hidden) return;
		closeMenu();
		menuSeq++;
		lastFocus = document.activeElement;
		overlay.hidden = false;
		gear.setAttribute("aria-expanded", "true");
		dialog.focus();
		return Promise.allSettled([loadState(), fetchStats()]);
	}

	function closeDialog() {
		if (overlay.hidden) return;
		closeMenu();
		disarm();
		overlay.hidden = true;
		gear.setAttribute("aria-expanded", "false");
		const back = lastFocus && lastFocus.isConnected ? lastFocus : gear;
		lastFocus = null;
		try {
			back.focus();
		} catch {}
	}

	function focusables() {
		const nodes = dialog.querySelectorAll(
			'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
		);
		return [...nodes].filter((n) => n.offsetParent !== null && !n.hidden);
	}

	function onDocKey(e) {
		if (overlay.hidden) return;
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation(); // 别让 app.js 的全局 Esc 触发 abort
			if (menu) closeMenu();
			else closeDialog();
			return;
		}
		if (e.key !== "Tab") return;
		const items = focusables();
		if (!items.length) return;
		const first = items[0];
		const last = items[items.length - 1];
		const active = document.activeElement;
		const inside = active !== dialog && dialog.contains(active);
		if (e.shiftKey) {
			if (!inside || active === first) {
				e.preventDefault();
				last.focus();
			}
		} else if (!inside || active === last) {
			e.preventDefault();
			first.focus();
		}
	}

	// ---------- 5. 快捷操作（补齐 clone / cycle_* / abort_retry / last_text） ----------
	const secQuick = section("快捷操作");

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

	const lastRow = makeRow("复制上一条回复", "只取纯文本，不含工具输出");
	const lastBtn = actionBtn("复制", async () => {
		try {
			const d = await ctx.pi.command({ type: "get_last_assistant_text" });
			if (!d?.text) throw new Error("还没有助手回复");
			await copyText(d.text);
			toast("已复制上一条回复");
		} catch (e) {
			fail(lastRow.row, e);
		}
	});
	lastRow.ctl.append(lastBtn);
	secQuick.append(lastRow.row);

	const cloneRow = makeRow("复制会话", "克隆当前会话，历史保留");
	const cloneBtn = actionBtn("复制", async () => {
		if (busy.clone) return;
		busy.clone = true;
		cloneBtn.disabled = true;
		try {
			const d = await ctx.pi.command({ type: "clone" });
			if (d?.cancelled) throw new Error("已取消");
			closeDialog();
			ctx.reload?.();
		} catch (e) {
			fail(cloneRow.row, e);
		} finally {
			busy.clone = false;
			cloneBtn.disabled = false;
		}
	});
	cloneRow.ctl.append(cloneBtn);
	secQuick.append(cloneRow.row);

	const cycleModelRow = makeRow("切换模型", "在可用模型间循环");
	const cycleModelBtn = actionBtn("下一个", async () => {
		try {
			const d = await ctx.pi.command({ type: "cycle_model" });
			if (!d?.model) throw new Error("当前没有可切换的模型");
			st.model = d.model;
			st.thinkingLevel = d.thinkingLevel ?? st.thinkingLevel;
			render();
			ctx.refreshState?.();
		} catch (e) {
			fail(cycleModelRow.row, e);
		}
	});
	cycleModelRow.ctl.append(cycleModelBtn);
	secQuick.append(cycleModelRow.row);

	const cycleThinkRow = makeRow("切换思考档位", "在可用档位间循环");
	const cycleThinkBtn = actionBtn("下一个", async () => {
		try {
			const d = await ctx.pi.command({ type: "cycle_thinking_level" });
			if (!d?.level) throw new Error("当前没有可切换的档位");
			st.thinkingLevel = d.level;
			render();
			ctx.refreshState?.();
		} catch (e) {
			fail(cycleThinkRow.row, e);
		}
	});
	cycleThinkRow.ctl.append(cycleThinkBtn);
	secQuick.append(cycleThinkRow.row);

	const abortRetryRow = makeRow("停止自动重试", "中断 pi 正在进行的重试");
	const retryBtn = actionBtn("停止", async () => {
		try {
			await ctx.pi.command({ type: "abort_retry" });
			toast("已停止重试");
		} catch (e) {
			fail(abortRetryRow.row, e);
		}
	});
	abortRetryRow.ctl.append(retryBtn);
	secQuick.append(abortRetryRow.row);

	gear.onclick = (e) => {
		e.preventDefault();
		e.stopPropagation();
		if (overlay.hidden) openDialog();
		else closeDialog();
	};

	closeBtn.onclick = (e) => {
		e.preventDefault();
		closeDialog();
	};

	overlay.addEventListener("pointerdown", (e) => {
		if (e.target === overlay) closeDialog();
	});

	document.addEventListener("keydown", onDocKey, true);

	// 会话切换 / 重命名：弹窗开着就刷新
	try {
		ctx.pi.onEvent?.((ev) => {
			if (ev?.type !== "session_info_changed") return;
			if (overlay.hidden) return;
			clearTimeout(sessionTimer);
			sessionTimer = setTimeout(() => {
				if (overlay.hidden) return;
				menuSeq++;
				loadState();
				fetchStats();
			}, 300);
		});
	} catch {}

	// 验收钩子：供截图脚本调用，无参只读打开面板（拉 state + 统计，不改任何配置）
	window.__piSettingsDemo = () => {
		if (overlay.hidden) return openDialog().then(() => true);
		menuSeq++;
		return Promise.allSettled([loadState(), fetchStats()]).then(() => true);
	};

	render();
}
