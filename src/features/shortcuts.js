// Ctrl/Cmd+K 命令面板 + Ctrl/Cmd+/ 快捷键参考。
// 自注入样式与 DOM，不改 index.html / app.js / base.css / 其他 feature。
// 接入：app.js 的 FEATURES 已登记 "./features/shortcuts.js"。
//
// 快捷键参考（Mod+/；也接受 Shift+/ 即 "?"，但只在输入框外生效）：
//   - 只登记在源码里真实存在的按键，逐条核对过 app.js / queue.js / terminal.js /
//     input-trigger.js / settings.js / 本文件的实现；不写“应该存在”的快捷键。
//   - 搜索过滤覆盖动作名、分组、按键与关键词（大小写不敏感）；↑/↓ 移动，Enter 关闭，
//     Esc 分层（有搜索词先清空，再按一次才关）／ 点遮罩关闭，Tab 焦点陷阱，
//     关闭后焦点回到打开前的元素（目标已失效则落到输入框，不留 body）。
//   - 已经有设置 / 命令面板 / 其他 dialog 时直接忽略，不叠层。
//
// 命令面板（Mod+K，开时再按一次收起）：
//   - 不可用项不进可执行列表，Enter 永远不会执行它们；列表里无可执行项时
//     Enter 会把首个不可用原因（或“没有匹配的命令”）toast 出来，不静默吞键。
//   - Esc 分层：有搜索词先清空，再按一次才关面板；底栏提示跟着切换。
//
// 命令可用性每次渲染都重查：顶栏按钮由 settings.js / right-panel.js / export-html.js
// 异步插入，取不到就禁用并在行尾写原因，不静默失败。
// 选择器依据（读 index.html / app.js / export-html.js 确认）：
//   - 设置 #settings-btn（settings.js 动态插入顶栏）
//   - 右栏 #rp-toggle（right-panel.js 动态插入顶栏）
//   - 新会话：index.html 里没有；app.js renderSessions() 里是 #list .newchat，
//     当前项目行是 [aria-label="在此工作区新建会话"]；都没有时回退 ctx.pi.newSession()
//   - 导出：export-html.js 的按钮只有 class .export-btn（无 id、无公开钩子），点它即走它自己的导出
//   - 终端：terminal.js 已登记进 FEATURES 并挂了 window.__piTermToggle；未接入时禁用并写明原因

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

// ---------- 快捷键参考：常量与数据 ----------
const HELP_ID = "kb-dialog";
const HELP_LIST_ID = "kb-list";
const HELP_INPUT_ID = "kb-input";

const NAV = typeof navigator === "undefined" ? {} : navigator;
const IS_MAC = /mac|iphone|ipad/i.test(NAV.platform || "") || /mac os x/i.test(NAV.userAgent || "");
const MOD_LABEL = IS_MAC ? "Cmd" : "Ctrl"; // 显示用：macOS 显示 Cmd，其余显示 Ctrl
const MOD_ALIAS = "mod ctrl cmd command control ⌘"; // 搜索用

const HELP_CSS = `
.kb-overlay {
	position: fixed;
	inset: 0;
	z-index: 1250;
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 24px;
	background: var(--kb-scrim, rgba(0, 0, 0, 0.18));
}
.kb-overlay[hidden] { display: none; }
.kb-dialog {
	display: flex;
	flex-direction: column;
	width: min(620px, calc(100vw - 48px));
	max-height: min(78vh, 720px);
	background: var(--bg);
	color: var(--text);
	border: 1px solid var(--line-strong);
	border-radius: var(--radius-xl);
	box-shadow: var(--shadow-menu);
	overflow: hidden;
	font-family: var(--ui);
	animation: kb-in 110ms ease-out;
}
@keyframes kb-in {
	from { opacity: 0; transform: translateY(4px) scale(0.985); }
	to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
	.kb-dialog { animation: none; }
}
.kb-head {
	flex: none;
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	padding: 12px 14px 0;
}
.kb-title { font-size: 14px; line-height: 20px; font-weight: 600; color: var(--text); }
.kb-close {
	flex: none;
	display: grid;
	place-items: center;
	width: 24px;
	height: 24px;
	border-radius: var(--radius-sm);
	color: var(--faint);
}
.kb-close:hover { background: var(--hover); color: var(--text); }
.kb-close:focus-visible { outline: 2px solid var(--line-strong); outline-offset: 1px; }
.kb-search {
	flex: none;
	display: flex;
	align-items: center;
	gap: 8px;
	margin: 8px 14px 0;
	padding: 7px 10px;
	background: var(--surface-2);
	border: 1px solid var(--line-strong);
	border-radius: var(--radius-md);
}
.kb-search:focus-within { border-color: var(--dim); }
.kb-search-icon { flex: none; display: grid; place-items: center; color: var(--faint); }
.kb-input {
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
.kb-input::placeholder { color: var(--faint); }
.kb-list {
	flex: 1 1 auto;
	min-height: 0;
	overflow-y: auto;
	overscroll-behavior: contain;
	padding: 4px 8px 12px;
}
.kb-group { padding: 10px 6px 2px; font-size: 12px; line-height: 18px; color: var(--faint); }
.kb-row {
	display: flex;
	align-items: center;
	gap: 12px;
	min-height: 32px;
	padding: 0 6px;
	border-radius: var(--radius-md);
}
.kb-row.is-on { background: var(--sel); }
.kb-name { flex: 1 1 auto; min-width: 0; font-size: 14px; line-height: 20px; color: var(--text); }
.kb-scope {
	flex: none;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-size: 12px;
	line-height: 18px;
	color: var(--faint);
}
.kb-keys { flex: none; display: flex; align-items: center; gap: 4px; }
.kb-sep { font-size: 11px; color: var(--faint); padding: 0 2px; }
.kb-key {
	display: inline-block;
	min-width: 18px;
	padding: 0 4px;
	text-align: center;
	font-family: var(--mono);
	font-size: 11px;
	line-height: 16px;
	color: var(--dim);
	background: var(--surface-2);
	border: 1px solid var(--line-strong);
	border-radius: var(--radius-xs);
}
.kb-empty { padding: 28px 12px; text-align: center; font-size: 12.5px; color: var(--faint); }
.kb-foot {
	flex: none;
	display: flex;
	align-items: center;
	gap: 12px;
	padding: 8px 14px;
	border-top: 1px solid var(--line);
	font-size: 11px;
	line-height: 16px;
	color: var(--faint);
}
.kb-note {
	flex: 1 1 auto;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	color: var(--dim);
}
.kb-foothint { flex: none; display: flex; align-items: center; gap: 4px; white-space: nowrap; }
`;

// 每条快捷键都在源码里核对过实现位置（见行尾注释），不写不存在的组合键。
// 新会话没有全局快捷键（app.js 只有 #newchat / 项目行按钮），因此不收录。
const SHORTCUT_GROUPS = [
	{
		id: "chat",
		label: "会话",
		items: [
			// 本文件 toggleKey（Ctrl/Cmd+K）
			{ label: "打开命令面板", keys: [["MOD", "K"]], hint: "全局", keywords: ["command", "palette", "命令", "命令面板", "面板"] },
			// 本文件 isSlashChord
			{
				label: "打开 / 关闭快捷键参考",
				keys: [["MOD", "/"]],
				hint: "也接受 Shift+/（输入框外）",
				keywords: ["shortcuts", "help", "keyboard", "/", "?", "斜杠", "问号", "快捷键", "帮助"],
			},
		],
	},
	{
		id: "input",
		label: "输入",
		items: [
			// app.js 输入框 keydown —— Enter 且非 Shift 才 submit
			{ label: "发送消息", keys: [["Enter"]], hint: "输入框内", keywords: ["send", "submit", "发送", "提交"] },
			// app.js 同一处理器：Shift+Enter 不拦截，走 textarea 默认换行
			{ label: "换行（不发送）", keys: [["Shift", "Enter"]], hint: "输入框内", keywords: ["newline", "linebreak", "换行"] },
			// queue.js onKeyDown —— 仅流式中且有草稿；默认 Enter 排队
			{ label: "排队发送", keys: [["Enter"]], hint: "流式回答中（设置可互换）", keywords: ["queue", "busy", "排队", "流式"] },
			// queue.js onKeyDown 的 steer 分支 —— Ctrl/Cmd 反转 busyEnter，默认 Enter 排队时它就是插话
			{ label: "插话发送", keys: [["MOD", "Enter"]], hint: "流式回答中（设置可互换）", keywords: ["steer", "busy", "插话", "流式"] },
			// app.js 的 document keydown —— 生成中 Esc = abortRun；模型菜单开着时先收菜单
			{
				label: "停止生成",
				keys: [["Esc"]],
				hint: "流式回答中；菜单打开时先关菜单",
				keywords: ["stop", "abort", "cancel", "停止", "中断"],
			},
		],
	},
	{
		id: "panel",
		label: "面板",
		items: [
			// terminal.js onDocKey —— 全局 Ctrl/Cmd+` 开关抽屉
			{ label: "显示 / 隐藏终端", keys: [["MOD", "`"]], hint: "全局", keywords: ["terminal", "toggle", "终端", "抽屉"] },
		],
	},
	{
		id: "view",
		label: "视图",
		items: [
			// 本文件 onKey；main.js 的 pi:set-zoom 负责 clamp 0.7–1.6
			{ label: "放大界面", keys: [["MOD", "="]], hint: "每次 10%", keywords: ["zoom", "in", "放大", "缩放", "界面缩放"] },
			{ label: "缩小界面", keys: [["MOD", "-"]], hint: "每次 10%", keywords: ["zoom", "out", "缩小", "缩放", "界面缩放"] },
			{ label: "还原为 100%", keys: [["MOD", "0"]], hint: "", keywords: ["zoom", "reset", "还原", "重置", "缩放", "界面缩放"] },
		],
	},
	{
		id: "menu",
		label: "菜单",
		items: [
			// input-trigger.js onKeyDown（补全菜单）、命令面板本文件 onKey、settings.js onMenuKey（下拉菜单）
			{
				label: "高亮菜单项",
				keys: [["↑"], ["↓"]],
				hint: "补全菜单 / 命令面板 / 设置菜单",
				keywords: ["navigate", "move", "menu", "移动", "选择", "高亮"],
			},
			// 命令面板本文件 onKey；settings.js:945-975
			{
				label: "跳到首 / 末项",
				keys: [["Home"], ["End"]],
				hint: "命令面板 / 设置菜单",
				keywords: ["first", "last", "menu", "首个", "末尾"],
			},
			// input-trigger.js Enter = accept；命令面板 Enter = 执行；settings.js 菜单项是原生 button
			{
				label: "选择 / 执行菜单项",
				keys: [["Enter"]],
				hint: "补全菜单 / 命令面板 / 设置菜单",
				keywords: ["run", "accept", "confirm", "选择", "执行", "确认"],
			},
			// input-trigger.js onKeyDown 的 Tab 分支 —— 有高亮时接受补全；命令面板里 Tab 回到搜索框
			{
				label: "接受补全项",
				keys: [["Tab"]],
				hint: "补全菜单有高亮时",
				keywords: ["tab", "accept", "complete", "补全", "选择"],
			},
			// input-trigger.js / 本文件命令面板 / app.js 模型菜单 / settings.js 下拉菜单
			{
				label: "关闭菜单 / 面板",
				keys: [["Esc"]],
				hint: "菜单、命令面板、设置、终端",
				keywords: ["close", "dismiss", "关闭", "取消"],
			},
		],
	},
];

const keyTokenText = (token) => (token === "MOD" ? `${MOD_LABEL} ${MOD_ALIAS}` : token.toLowerCase());

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
	style.textContent = CSS + HELP_CSS;
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
	// 遮罩自己带 id：真正控制显隐的是它，不是内层 dialog（测试/调试要能直接取）
	overlay.id = "cmdk-overlay";
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
	const hEscClear = keyHint(["Esc"], "清空搜索");
	const hEsc = keyHint(["Esc"], "关闭");
	keysEl.append(hNav, hGo, hEscClear, hEsc);
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

	// 可用性检查自己也可能抛（桥没起来 / 选择器写错），别让它把整次渲染带崩、
	// 把面板留在“开着但没有焦点”的半死状态
	const availabilityOf = (cmd) => {
		try {
			return cmd.available?.() || "";
		} catch (err) {
			return `可用性检查失败：${brief(err?.message || err)}`;
		}
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

			const reason = availabilityOf(cmd);
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
		// 底栏提示跟着 Esc 的分层行为走：有搜索词时 Esc 是「清空」，不是「关闭」
		hEscClear.hidden = !q;
		hEsc.hidden = !!q;
		sel = 0;
		setActive(0, false);
	};

	// ---------- 开 / 关 ----------
	// 归还焦点：目标还在、还能接收焦点就还给它；否则落到输入框，绝不把焦点留给 body
	// （目标可能已经 disabled / display:none，此时 focus() 静默无效）
	const restoreFocus = (back) => {
		if (back && back.isConnected && back !== doc.body && typeof back.focus === "function") {
			back.focus({ preventScroll: true });
			if (doc.activeElement === back) return;
		}
		ctx?.input?.focus?.({ preventScroll: true });
	};

	const openPanel = () => {
		if (open) return;
		open = true;
		lastFocus = doc.activeElement;
		input.value = "";
		overlay.hidden = false;
		render();
		list.scrollTop = 0; // 上一次可能滚过，重开时从顶部开始
		input.focus({ preventScroll: true });
	};

	const closePanel = () => {
		if (!open) return;
		open = false;
		overlay.hidden = true;
		const back = lastFocus;
		lastFocus = null;
		restoreFocus(back);
	};

	// Esc 分层：有搜索词先清空（回到完整列表）；返回 true 表示这一下 Esc 已被消费
	const clearQuery = () => {
		if (!input.value) return false;
		input.value = "";
		render();
		input.focus({ preventScroll: true });
		return true;
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

	// Enter 没有可执行项时别静默吞键：把「为什么不可用」说出来
	const explainBlocker = () => {
		const why = rows[0]?.reason || (rows.length ? "" : "没有匹配的命令");
		if (why) toast(why, { error: true });
	};

	// ---------- 键盘 ----------
	const composing = (e) => e.isComposing || e.keyCode === 229;
	const toggleKey = (e) =>
		(e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.code === "KeyK" || e.key === "k" || e.key === "K");

	const zoomTo = async (delta) => {
		try {
			const cur = (await window.pi.getZoom?.())?.factor || 1;
			const next = delta == null ? 1 : cur + delta;
			await window.pi.setZoom?.(next);
		} catch {}
	};

	const onKey = (e) => {
		if (composing(e)) return; // 输入法组合中一律不抢
		// Ctrl/Cmd + = / - / 0：整体界面缩放
		if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
			const zoomIn = e.key === "=" || e.key === "+" || e.code === "Equal" || e.code === "NumpadAdd";
			const zoomOut = e.key === "-" || e.code === "Minus" || e.code === "NumpadSubtract";
			const zoomReset = e.key === "0" || e.code === "Digit0" || e.code === "Numpad0";
			if (zoomIn || zoomOut || zoomReset) {
				e.preventDefault();
				e.stopPropagation();
				void zoomTo(zoomIn ? 0.1 : zoomOut ? -0.1 : null);
				return;
			}
		}
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
				// Esc 分层：先清搜索词，再关面板
				if (!clearQuery()) closePanel();
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
				else explainBlocker();
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

	// 焦点陷阱兜底：面板开着时，任何跑到面板外的焦点都拉回搜索框（和快捷键参考一致）。
	// closePanel 会先置 open=false 再归焦，所以这里不会被归还动作自己触发。
	doc.addEventListener("focusin", (e) => {
		if (!open) return;
		if (dialog.contains(e.target)) return;
		input.focus({ preventScroll: true });
	});

	// ======================================================================
	// 快捷键参考（Ctrl/Cmd+/）
	// ======================================================================
	const CLOSE_ICON =
		'<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3.6 3.6 10.4 10.4M10.4 3.6 3.6 10.4"/></svg>';

	const kbdChip = (text) => {
		const k = doc.createElement("kbd");
		k.className = "kb-key";
		k.textContent = text;
		return k;
	};

	// ---------- DOM ----------
	const helpOverlay = doc.createElement("div");
	helpOverlay.className = "kb-overlay";
	helpOverlay.hidden = true;

	const helpDialog = doc.createElement("div");
	helpDialog.id = HELP_ID;
	helpDialog.className = "kb-dialog";
	helpDialog.setAttribute("role", "dialog");
	helpDialog.setAttribute("aria-modal", "true");
	helpDialog.setAttribute("aria-labelledby", "kb-title");

	const helpHead = doc.createElement("div");
	helpHead.className = "kb-head";
	const helpTitle = doc.createElement("div");
	helpTitle.id = "kb-title";
	helpTitle.className = "kb-title";
	helpTitle.textContent = "键盘快捷键";
	const helpClose = doc.createElement("button");
	helpClose.type = "button";
	helpClose.className = "kb-close";
	helpClose.title = "关闭";
	helpClose.setAttribute("aria-label", "关闭快捷键参考");
	helpClose.innerHTML = CLOSE_ICON;
	helpHead.append(helpTitle, helpClose);

	const helpSearch = doc.createElement("div");
	helpSearch.className = "kb-search";
	const helpIcon = doc.createElement("span");
	helpIcon.className = "kb-search-icon";
	helpIcon.setAttribute("aria-hidden", "true");
	helpIcon.innerHTML = SEARCH_ICON;
	const helpInput = doc.createElement("input");
	helpInput.id = HELP_INPUT_ID;
	helpInput.className = "kb-input";
	helpInput.type = "text";
	helpInput.placeholder = "搜索动作或按键…";
	helpInput.autocomplete = "off";
	helpInput.spellcheck = false;
	helpInput.setAttribute("role", "combobox");
	helpInput.setAttribute("aria-expanded", "true");
	helpInput.setAttribute("aria-controls", HELP_LIST_ID);
	helpInput.setAttribute("aria-autocomplete", "list");
	helpInput.setAttribute("aria-label", "搜索快捷键");
	helpSearch.append(helpIcon, helpInput);

	const helpList = doc.createElement("div");
	helpList.id = HELP_LIST_ID;
	helpList.className = "kb-list";
	helpList.setAttribute("role", "listbox");
	helpList.setAttribute("aria-label", "快捷键");

	const helpFoot = doc.createElement("div");
	helpFoot.className = "kb-foot";
	const helpNote = doc.createElement("span");
	helpNote.className = "kb-note";
	helpNote.textContent = "快捷键暂为只读，后续支持自定义";
	const helpHint = doc.createElement("span");
	helpHint.className = "kb-foothint";
	helpHint.append(kbdChip(MOD_LABEL), kbdChip("K"), doc.createTextNode(" 打开命令面板"));
	helpFoot.append(helpNote, helpHint);

	helpDialog.append(helpHead, helpSearch, helpList, helpFoot);
	helpOverlay.append(helpDialog);
	doc.body.append(helpOverlay);

	// ---------- 状态 ----------
	let helpRows = []; // 本次渲染的行（按 DOM 顺序）
	let helpSel = -1; // 未预选：只有方向键 / 指针移动才出高亮（STYLE §2）
	let helpOpen = false;
	let helpLastFocus = null;

	// ---------- 渲染 ----------
	const helpHay = (group, it) => {
		const flat = it.keys.flat().map(keyTokenText).join(" ");
		const chords = it.keys.map((chord) => chord.map((t) => (t === "MOD" ? MOD_LABEL : t)).join("+")).join(" ");
		return `${group.label} ${it.label} ${it.hint || ""} ${flat} ${chords} ${(it.keywords || []).join(" ")}`.toLowerCase();
	};

	const renderHelp = () => {
		const terms = helpInput.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
		helpList.innerHTML = "";
		helpRows = [];
		helpSel = -1;
		helpInput.removeAttribute("aria-activedescendant");

		for (const group of SHORTCUT_GROUPS) {
			const matched = group.items.filter((it) => terms.every((t) => helpHay(group, it).includes(t)));
			if (!matched.length) continue;

			const wrap = doc.createElement("div");
			wrap.className = "kb-group-wrap";
			wrap.setAttribute("role", "group");
			wrap.setAttribute("aria-labelledby", `kb-g-${group.id}`);

			const heading = doc.createElement("div");
			heading.id = `kb-g-${group.id}`;
			heading.className = "kb-group";
			heading.setAttribute("role", "presentation");
			heading.textContent = group.label;
			wrap.append(heading);

			for (const it of matched) {
				const row = doc.createElement("div");
				row.className = "kb-row";
				row.id = `kb-opt-${helpRows.length}`;
				row.setAttribute("role", "option");
				row.setAttribute("aria-selected", "false");
				const keysText = it.keys
					.map((chord) => chord.map((t) => (t === "MOD" ? MOD_LABEL : t)).join("+"))
					.join(" 或 ");
				row.setAttribute("aria-label", `${keysText}，${it.label}${it.hint ? `（${it.hint}）` : ""}`);

				const name = doc.createElement("span");
				name.className = "kb-name";
				name.textContent = it.label;
				row.append(name);

				if (it.hint) {
					const scope = doc.createElement("span");
					scope.className = "kb-scope";
					scope.textContent = it.hint;
					row.append(scope);
				}

				const keys = doc.createElement("span");
				keys.className = "kb-keys";
				it.keys.forEach((chord, i) => {
					if (i) {
						const sep = doc.createElement("span");
						sep.className = "kb-sep";
						sep.textContent = "/";
						keys.append(sep);
					}
					for (const token of chord) keys.append(kbdChip(token === "MOD" ? MOD_LABEL : token));
				});
				row.append(keys);

				wrap.append(row);
				helpRows.push({ it, el: row });
				row.addEventListener("pointermove", () => {
					const at = helpRows.findIndex((r) => r.el === row);
					if (at >= 0) setHelpActive(at, false);
				});
			}
			helpList.append(wrap);
		}

		if (!helpRows.length) {
			const empty = doc.createElement("div");
			empty.className = "kb-empty";
			empty.textContent = "没有匹配的快捷键";
			helpList.append(empty);
		}
	};

	const setHelpActive = (i, scroll = true) => {
		if (!helpRows.length) {
			helpSel = -1;
			helpInput.removeAttribute("aria-activedescendant");
			return;
		}
		const n = helpRows.length;
		helpSel = ((i % n) + n) % n;
		for (let k = 0; k < n; k++) {
			const on = k === helpSel;
			helpRows[k].el.classList.toggle("is-on", on);
			helpRows[k].el.setAttribute("aria-selected", on ? "true" : "false");
		}
		const cur = helpRows[helpSel].el;
		helpInput.setAttribute("aria-activedescendant", cur.id);
		if (scroll) cur.scrollIntoView({ block: "nearest" });
	};

	// ---------- 开 / 关 ----------
	// 已经有模态层（设置、命令面板、图片灯箱、模型菜单等）时不抢：避免叠两层对话框。
	// 只查 [aria-modal] 不够：context-meter / message-fork 只有 role="dialog"。
	const isVisible = (n) => !!n && n.getClientRects().length > 0;
	const otherModalOpen = () =>
		[...doc.querySelectorAll('.settings-overlay, [role="dialog"], [aria-modal="true"], #menu')].some(
			(n) => n !== helpDialog && isVisible(n),
		);

	const openHelp = () => {
		if (helpOpen || otherModalOpen()) return false;
		helpOpen = true;
		helpLastFocus = doc.activeElement;
		helpInput.value = "";
		helpOverlay.hidden = false;
		renderHelp();
		helpInput.focus({ preventScroll: true });
		return true;
	};

	const closeHelp = () => {
		if (!helpOpen) return;
		helpOpen = false;
		helpOverlay.hidden = true;
		const back = helpLastFocus;
		helpLastFocus = null;
		helpSel = -1;
		restoreFocus(back);
	};

	// Esc 分层：参考面板里同样先清搜索词，再关（返回 true 表示这一下 Esc 已被消费）
	const clearHelpQuery = () => {
		if (!helpInput.value) return false;
		helpInput.value = "";
		renderHelp();
		helpInput.focus({ preventScroll: true });
		return true;
	};

	// ---------- 键盘 ----------
	// Mod+/；Shift+/（即 "?"）只在非输入区域生效，输入框里的 "/"、"?" 照常打字。
	const isEditable = (t) =>
		!!t && (t.isContentEditable === true || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ""));
	const isSlashChord = (e) => {
		if (e.altKey) return false;
		const slashKey = e.key === "/" || e.key === "?" || e.code === "Slash" || e.code === "NumpadDivide";
		if (!slashKey) return false;
		if (e.ctrlKey || e.metaKey) return true; // Ctrl/Cmd+/ 或 Ctrl/Cmd+Shift+/
		// 裸 Shift+/：只在非输入区域触发，避免用户打问号时弹层
		return e.key === "?" && !isEditable(e.target);
	};

	const trapHelpTab = (e) => {
		const items = [helpInput, helpClose].filter((n) => n.offsetParent !== null);
		if (!items.length) return;
		const at = items.indexOf(doc.activeElement);
		let next;
		if (e.shiftKey) next = at <= 0 ? items[items.length - 1] : items[at - 1];
		else next = at < 0 || at === items.length - 1 ? items[0] : items[at + 1];
		e.preventDefault();
		e.stopPropagation();
		next.focus();
	};

	// window 捕获：比 document 捕获更早，面板打开时能挡住 app.js / terminal.js /
	// right-panel.js 的全局 Esc（它们都在 document 捕获或冒泡阶段）。
	const onHelpKey = (e) => {
		if (composing(e)) return;

		if (helpOpen) {
			switch (e.key) {
				case "Escape":
					e.preventDefault();
					e.stopPropagation();
					// Esc 分层：先清搜索词，再关
					if (!clearHelpQuery()) closeHelp();
					return;
				case "ArrowDown":
					e.preventDefault();
					e.stopPropagation();
					setHelpActive(helpSel < 0 ? 0 : helpSel + 1);
					return;
				case "ArrowUp":
					e.preventDefault();
					e.stopPropagation();
					setHelpActive(helpSel < 0 ? helpRows.length - 1 : helpSel - 1);
					return;
				case "Home":
					e.preventDefault();
					e.stopPropagation();
					setHelpActive(0);
					return;
				case "End":
					e.preventDefault();
					e.stopPropagation();
					setHelpActive(helpRows.length - 1);
					return;
				case "PageDown":
					e.preventDefault();
					e.stopPropagation();
					setHelpActive((helpSel < 0 ? 0 : helpSel) + 6);
					return;
				case "PageUp":
					e.preventDefault();
					e.stopPropagation();
					setHelpActive((helpSel < 0 ? 0 : helpSel) - 6);
					return;
				case "Enter":
					// 只读参考：Enter 直接收起面板
					e.preventDefault();
					e.stopPropagation();
					closeHelp();
					return;
				case "Tab":
					trapHelpTab(e);
					return;
			}

			if (isSlashChord(e)) {
				e.preventDefault();
				e.stopPropagation();
				if (!e.repeat) closeHelp();
				return;
			}
			if (toggleKey(e)) {
				// Mod+K：切到命令面板（先归还焦点，命令面板再自己记一次）
				e.preventDefault();
				e.stopPropagation();
				if (e.repeat) return;
				closeHelp();
				openPanel();
				return;
			}
			return; // 其余按键交给搜索框；缩放等全局键继续冒泡给命令面板的处理器
		}

		if (e.repeat) return;
		if (!isSlashChord(e)) return;
		if (!openHelp()) return; // 已有设置 / 命令面板 / 其他模态层时不叠加
		e.preventDefault();
		e.stopPropagation();
	};
	window.addEventListener("keydown", onHelpKey, true);

	// 焦点陷阱兜底：即使有元素在面板外拿到焦点，也拉回搜索框
	doc.addEventListener("focusin", (e) => {
		if (!helpOpen) return;
		if (helpDialog.contains(e.target)) return;
		helpInput.focus({ preventScroll: true });
	});

	// ---------- 搜索框 ----------
	helpInput.addEventListener("compositionstart", () => {
		helpInput.dataset.composing = "1";
	});
	helpInput.addEventListener("compositionend", () => {
		delete helpInput.dataset.composing;
		renderHelp();
	});
	helpInput.addEventListener("input", () => {
		if (helpInput.dataset.composing === "1") return;
		renderHelp();
	});

	// 点遮罩关闭；点面板内部不关
	helpOverlay.addEventListener("pointerdown", (e) => {
		if (e.target === helpOverlay) closeHelp();
	});
	helpDialog.addEventListener("pointerdown", (e) => e.stopPropagation());
	helpClose.addEventListener("click", () => closeHelp());
}
