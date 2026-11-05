// 右栏抽屉：文件 / 变更 / 会话。只新增本文件，样式自注入（.rp- 前缀），
// 不改 index.html / app.js / preload.cjs / base.css / 其他 feature。
//
// 数据契约（ctx.pi，见 preload.cjs + main.js）：
//   listFiles(cwd) → { cwd, files: [{ path, dir }], truncated }   path 用 "/" 分隔
//   gitChanges()   → [{ status, staged, path }]                    status: "M" / "A" / "D" / "??" …
//   gitDiff(path)  → string                                        空串 = 未跟踪或无差异
//   openPath(path) → boolean
//   command({ type: "get_tree" }) → { tree: SessionTreeNode[], leafId: string | null }
//     大会话上 pi 的 get_tree 会递归爆栈，此时退回 get_entries + treeFromEntries()
//     （见 src/core/fork-target.js）。
//     SessionTreeNode = { entry: SessionEntry, children: SessionTreeNode[], label?, labelTimestamp? }
//     SessionEntry    = { type, id, parentId, timestamp }
//       type "message" 时 entry.message 是 AgentMessage（role: "user" | "assistant" | "toolResult"）
//       其余 type：compaction / branch_summary / model_change / thinking_level_change /
//                  usage / custom / custom_message / context_edit / label / session_info

import { treeFromEntries } from "../core/fork-target.js";

const TABS = [
	{ key: "files", label: "文件" },
	{ key: "changes", label: "变更" },
	{ key: "tree", label: "会话" },
	{ key: "browser", label: "浏览器" },
];

const LOADABLE = new Set(["files", "changes", "tree"]);

const MAX_SUMMARY = 40; // 会话节点摘要字数
const MAX_DIFF_LINES = 400; // 单个 diff 最多渲染行数
const MAX_ERR = 140;
const DEMO_MS = 8000; // 演示钩子兜底：取不到数据也不阻塞
const FLASH_MS = 3000;

// 快速打开（Mod+P）：文件索引缓存 5s，和主进程 pi:list-files 的缓存窗口一致
const PALETTE_CACHE_MS = 5000;
const PALETTE_MAX = 50;

// 落盘范围：只有「当前 tab」和「抽屉宽度」。面板开合、全屏状态都不持久化。
const LS_TAB = "pi-mini.rpTab";
const LS_WIDTH = "pi-mini.rpWidth";
const DEFAULT_W = 300;
const MIN_W = 260;
const MAX_W = 560;

const PANEL_ICON =
	'<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2.2" y="3" width="11.6" height="10" rx="1.6"/><path d="M9.6 3v10"/></svg>';
const CHEV_ICON =
	'<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M3.6 1.8 7 5l-3.4 3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CLOSE_ICON =
	'<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M2.7 2.7 9.3 9.3M9.3 2.7 2.7 9.3"/></svg>';
// 「+」和「⤢」同样用描边图标而不是字形：⤢(U+2922) 在多数 CJK 字体里缺码位，
// 会退回成方框或换一个粗细不搭的字体。
const PLUS_ICON =
	'<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M6 2.4v7.2M2.4 6h7.2"/></svg>';
const EXPAND_ICON =
	'<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M7.2 2.4h2.4v2.4M4.8 9.6H2.4V7.2M9.6 2.4 6.6 5.4M2.4 9.6l3-3"/></svg>';
const SHRINK_ICON =
	'<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M4.8 2.4H2.4v2.4M7.2 9.6h2.4V7.2M2.4 2.4 5.4 5.4M9.6 9.6 6.6 6.6"/></svg>';
const RELOAD_ICON =
	'<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M10 5.1A4.1 4.1 0 1 0 10.1 7"/><path d="M10.1 2.4v2.7H7.4"/></svg>';

// 文件树图标：16px 线性、单色（STYLE §3 不做彩色填充，所以类型只靠形状区分）
const ICONS = {
	folder:
		'<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"><path d="M2.1 5c0-.5.4-.9.9-.9h3l1.4 1.6h5.6c.5 0 .9.4.9.9v5.4c0 .5-.4.9-.9.9H3c-.5 0-.9-.4-.9-.9V5Z"/></svg>',
	file: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"><path d="M4.4 2.1h4.2l3 3v8.8H4.4V2.1Z"/><path d="M8.4 2.2v3.1h3"/></svg>',
	code: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d="M5.8 5.8 3.4 8l2.4 2.2M10.2 5.8 12.6 8l-2.4 2.2"/></svg>',
	data: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M6.4 3.2c-1.2 0-1.6.5-1.6 1.6 0 1-.3 1.5-1.2 1.7.9.2 1.2.7 1.2 1.7 0 1.1.4 1.6 1.6 1.6M9.6 3.2c1.2 0 1.6.5 1.6 1.6 0 1 .3 1.5 1.2 1.7-.9.2-1.2.7-1.2 1.7 0 1.1-.4 1.6-1.6 1.6"/></svg>',
	image:
		'<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"><rect x="2.3" y="3.4" width="11.4" height="9.2" rx="1.4"/><circle cx="6.1" cy="6.7" r=".9"/><path d="m3.4 11.4 3-2.8 2.5 2.1 1.9-1.5 2 1.8"/></svg>',
	text: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"><path d="M3.4 4.6h9.2M3.4 8h9.2M3.4 11.4h6"/></svg>',
};

const EXT_KIND = {
	js: "code", mjs: "code", cjs: "code", jsx: "code", ts: "code", tsx: "code", css: "code",
	scss: "code", less: "code", html: "code", vue: "code", py: "code", rs: "code", go: "code",
	java: "code", sh: "code", ps1: "code", bat: "code", sql: "code",
	json: "data", jsonl: "data", csv: "data", yml: "data", yaml: "data", toml: "data",
	lock: "data", ini: "data", env: "data",
	png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "image",
	ico: "image", bmp: "image",
	md: "text", mdx: "text", txt: "text", log: "text",
};

const fileKind = (name) => {
	const s = String(name || "").toLowerCase();
	const i = s.lastIndexOf(".");
	return i > 0 ? EXT_KIND[s.slice(i + 1)] || "file" : "file";
};

// 非消息条目的角色标签（完整 type 放 title）；get_tree 里这些节点不带 message。
// 用中文两字/三字：定宽 36px 内对齐，英文 assistant/thinking_level_change 塞不下。
const SYS_ROLE = {
	compaction: "压缩",
	branch_summary: "分支",
	model_change: "模型",
	thinking_level_change: "思考",
	usage: "用量",
	custom: "自定义",
	custom_message: "自定义",
	context_edit: "编辑",
	label: "标签",
	session_info: "会话",
};

const CSS = `
/* 抽屉宽度只在这里定：panel 宽、主区让位宽度、窄窗断点共用同一个值 */
:root { --rp-w: 300px; }

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
	width: var(--rp-w);
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

/* 抽屉打开时让「对话列」窄出抽屉的宽度。只动 #stream / #composer，不动 #app：
   给 #app 加 padding 会连顶栏一起缩，右上角的右栏开关和设置齿轮会从你刚点的地方滑走。
   用 margin 而不是 padding——滚动条才会跟着内容列的右沿一起退到抽屉边上。 */
body.rp-open #stream,
body.rp-open #composer { margin-right: var(--rp-w); }
/* transition 挂在元素本体：只写在打开态的话，关闭时声明被撤掉，收起会瞬移。 */
#stream,
#composer { transition: margin-right 120ms ease; }

/* 全屏覆盖：inset 0 连顶栏一起盖掉，宽度 100%，主区让位归零。
   让位规则和 body.rp-open 的优先级相同（都是一类一 id），所以必须排在其后。 */
.rp-panel.rp-is-full {
	top: 0;
	left: 0;
	width: 100%;
	border-left: none;
}
body.rp-full #stream,
body.rp-full #composer { margin-right: 0; }

/* 275 侧栏 + 300 抽屉之后正文列不足 400px，窄窗改为覆盖式，不再挤主对话 */
@media (max-width: 980px) {
	body.rp-open #stream,
	body.rp-open #composer { margin-right: 0; }
}

.rp-tabs {
	flex: none;
	height: 36px;
	display: flex;
	align-items: center;
	gap: 2px;
	padding: 0 4px;
	border-bottom: 1px solid var(--line);
}
.rp-tab {
	height: 24px;
	min-width: 0;
	flex: 0 1 auto;
	padding: 0 8px;
	border-radius: 6px;
	font-size: 12.5px;
	line-height: 1;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
	color: var(--faint);
	transition: background-color 120ms ease, color 120ms ease;
}
.rp-tab:hover { background: var(--hover); color: var(--text); }
.rp-tab.rp-is-on { background: var(--sel); color: var(--text); }
.rp-tab:focus-visible { outline: 1px solid var(--faint); outline-offset: -1px; }
.rp-grow { flex: 1; }
/* tab strip 末端的三个方形按钮共用一套尺寸：视图菜单 / 全屏 / 关闭 */
.rp-close,
.rp-plus,
.rp-expand {
	flex: none;
	width: 24px;
	height: 24px;
	border-radius: 6px;
	display: grid;
	place-items: center;
	color: var(--faint);
	transition: background-color 120ms ease, color 120ms ease;
}
.rp-close:hover,
.rp-plus:hover,
.rp-expand:hover { background: var(--hover); color: var(--text); }
.rp-close:focus-visible,
.rp-plus:focus-visible,
.rp-expand:focus-visible { outline: 1px solid var(--faint); outline-offset: -1px; }
/* 有状态的两个按钮：开着就点亮，和 .rp-tab.rp-is-on 同一套选中色 */
.rp-plus[aria-expanded="true"],
.rp-expand[aria-pressed="true"] { background: var(--sel); color: var(--text); }

/* 「+」的轻量视图菜单：贴着 tab strip 下沿，panel 是 fixed，absolute 直接锚在面板上 */
.rp-menu {
	position: absolute;
	top: 34px;
	right: 6px;
	z-index: 3;
	min-width: 116px;
	padding: 4px;
	background: var(--bg);
	border: 1px solid var(--line);
	border-radius: 10px;
	box-shadow: var(--shadow-menu);
}
.rp-menu[hidden] { display: none; }
.rp-menu-i {
	display: block;
	width: 100%;
	height: 28px;
	padding: 0 8px;
	border-radius: 6px;
	text-align: left;
	font-size: 12.5px;
	line-height: 1;
	color: var(--dim);
	transition: background-color 120ms ease, color 120ms ease;
}
.rp-menu-i:hover { background: var(--hover); color: var(--text); }
.rp-menu-i:focus-visible { outline: 1px solid var(--faint); outline-offset: -1px; }
.rp-menu-i[aria-checked="true"] { background: var(--sel); color: var(--text); }

/* 左沿拖拽手柄：热区 7px、视觉线只有 1px，跨在面板左边框上。
   touch-action:none 才拿得到 pointermove（否则触控板拖动会被当滚动吞掉）。 */
.rp-grip {
	position: absolute;
	top: 0;
	bottom: 0;
	left: 0;
	width: 7px;
	z-index: 2;
	transform: translateX(-50%);
	cursor: col-resize;
	touch-action: none;
}
.rp-grip[hidden] { display: none; }
.rp-grip::after {
	content: "";
	position: absolute;
	top: 0;
	bottom: 0;
	left: 3px;
	width: 1px;
	background: var(--faint);
	opacity: 0;
	transition: opacity 120ms ease;
}
.rp-grip:hover::after,
.rp-grip:focus-visible::after,
.rp-grip.is-dragging::after { opacity: 0.5; }
.rp-grip:focus-visible { outline: none; }
.rp-grip.is-dragging::after { opacity: 1; width: 2px; left: 2.5px; }

/* 拖拽中：让位宽度必须跟手，120ms 的 margin 过渡会拖出一段橡皮筋 */
body.rp-resizing { cursor: col-resize; user-select: none; }
body.rp-resizing #stream,
body.rp-resizing #composer,
body.rp-resizing .rp-panel { transition: none; }

.rp-body { flex: 1; min-height: 0; display: flex; }
.rp-pane {
	flex: 1;
	min-width: 0;
	min-height: 0;
	overflow-y: auto;
	/* 横向溢出必须收在 pane 内：否则树节点会把整个页面撑出横向滚动条 */
	overflow-x: hidden;
	/* 常驻滚动条槽：切 tab 时内容列不横向跳动 */
	scrollbar-gutter: stable;
	padding: 4px 4px 10px;
}
.rp-pane[hidden] { display: none; }

/* 对话 / 浏览器要占满抽屉高度，自带内部滚动；文件和变更保持块级滚动 */
#rp-pane-chat:not([hidden]),
#rp-pane-browser:not([hidden]) {
	display: flex;
	flex-direction: column;
	overflow: hidden;
	padding: 0;
}

.rp-row {
	display: flex;
	align-items: center;
	gap: 2px;
	width: 100%;
	height: 26px;
	padding: 0 4px;
	border-radius: 6px;
	text-align: left;
	font-size: 12.5px;
	line-height: 1;
	color: var(--dim);
	transition: background-color 120ms ease, color 120ms ease;
}
.rp-row:hover { background: var(--hover); color: var(--text); }
.rp-row:focus-visible { outline: 1px solid var(--faint); outline-offset: -1px; }
/* 图标槽：目录/文件都占 16px，缩进步长也用 16，
   子级 chevron 才会落在父级图标下方，而不是压到父级文字左沿 */
.rp-chev,
.rp-ico {
	flex: none;
	width: 16px;
	height: 16px;
	display: grid;
	place-items: center;
	color: var(--faint);
}
.rp-chev { transition: transform 120ms ease; }
.rp-chev.rp-is-open { transform: rotate(90deg); }
.rp-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rp-dir > .rp-name { color: var(--text); font-weight: var(--weight-shell); }

.rp-state {
	padding: 12px 4px;
	font-size: 12px;
	line-height: 1.5;
	color: var(--faint);
	word-break: break-word;
}
.rp-state-err { margin-top: 4px; font-size: 11px; line-height: 1.45; color: var(--err); }
/* 拉取失败后没有别的入口能重来（load() 只在重开面板/切 tab 时才重试），给一个显式重试 */
.rp-retry {
	margin-top: 8px;
	height: 22px;
	padding: 0 8px;
	border: 1px solid var(--line);
	border-radius: 6px;
	font-size: 12px;
	line-height: 1;
	color: var(--dim);
	transition: background-color 120ms ease, color 120ms ease;
}
.rp-retry:hover { background: var(--hover); color: var(--text); }
.rp-retry:focus-visible { outline: 1px solid var(--faint); outline-offset: -1px; }
.rp-note {
	margin: 6px 0 0;
	padding: 8px 4px 0;
	border-top: 1px solid var(--line);
	font-size: 11px;
	line-height: 1.45;
	color: var(--faint);
}
.rp-note.rp-is-err { color: var(--err); }

.rp-file-head {
	position: sticky;
	top: 0;
	z-index: 1;
	display: flex;
	align-items: center;
	gap: 6px;
	height: 30px;
	padding: 0 2px 0 0;
	border-bottom: 1px solid var(--line);
	background: var(--bg);
}
.rp-file-back {
	display: grid;
	place-items: center;
	width: 22px;
	height: 22px;
	border-radius: 6px;
	color: var(--dim);
}
.rp-file-back svg { width: 12px; height: 12px; transform: rotate(180deg); }
.rp-file-back:hover { background: var(--hover); color: var(--text); }
.rp-file-name {
	min-width: 0;
	font-size: 12px;
	color: var(--text);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.rp-file-open {
	flex: none;
	height: 22px;
	padding: 0 6px;
	border-radius: 6px;
	font-size: 11px;
	color: var(--faint);
	white-space: nowrap;
}
.rp-file-open:hover { background: var(--hover); color: var(--text); }
.rp-file-open:focus-visible { outline: 1px solid var(--faint); outline-offset: -1px; }
.rp-file-open:disabled { opacity: 0.45; cursor: default; }
/* 重载是图标按钮：文字留给「用系统程序打开」，宽度让给文件名 */
.rp-file-reload {
	width: 24px;
	padding: 0;
	display: grid;
	place-items: center;
}
.rp-file-reload svg { width: 12px; height: 12px; }
.rp-code { margin: 8px 0 0; overflow: auto; position: relative; }
/* 行号定位的高亮带放在代码下面一层，文字和 shiki 的 span 仍然可读 */
.rp-code > .shiki,
.rp-code > pre.code-plain { position: relative; z-index: 1; }
.rp-line-mark {
	position: absolute;
	left: 0;
	background: var(--sel);
	opacity: 0.7;
	border-radius: 2px;
	pointer-events: none;
	z-index: 0;
}
.rp-code .shiki {
	margin: 0;
	padding: 8px 10px;
	background: transparent !important;
	font-family: var(--mono);
	font-size: 11.5px;
	line-height: 1.55;
}
.rp-code pre.code-plain {
	margin: 0;
	padding: 8px 10px;
	font-family: var(--mono);
	font-size: 11.5px;
	line-height: 1.55;
	white-space: pre;
}
.rp-img {
	display: block;
	max-width: 100%;
	margin: 10px 0 0;
	border: 1px solid var(--line);
	border-radius: 6px;
}
/* HTML 只在这个内联沙箱里渲染：sandbox="" 同时禁掉脚本、表单、同源和弹窗，
   文件里的 <script>/onclick 不会碰到应用本身。 */
.rp-html-frame {
	display: block;
	width: 100%;
	height: calc(100vh - 120px);
	min-height: 320px;
	margin: 8px 0 0;
	border: 1px solid var(--line);
	border-radius: 8px;
	background: #fff;
}

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
	padding: 0 4px;
	border-radius: 6px;
	text-align: left;
	transition: background-color 120ms ease;
}
.rp-chg:hover { background: var(--hover); }
.rp-chg:focus-visible { outline: 1px solid var(--faint); outline-offset: -1px; }
.rp-chg.rp-is-on { background: var(--sel); }
.rp-st {
	flex: 0 0 16px;
	overflow: hidden;
	font-family: var(--mono);
	font-size: 11px;
	line-height: 1;
	text-align: center;
	color: var(--faint);
}
.rp-st.rp-is-add { color: var(--rp-add); }
.rp-st.rp-is-del { color: var(--rp-del); }
/* 长路径：目录段先牺牲（省略号），文件名保到最后一刻，否则 300px 宽只剩 "…"。
   两段都不 grow：留在右边的空白不做分配，路径才会紧贴左边、不往右顶。 */
.rp-chg-path {
	display: flex;
	flex: 1 1 auto;
	min-width: 0;
	overflow: hidden;
	font-size: 12.5px;
	line-height: 1;
}
.rp-chg-dir {
	flex: 0 8 auto;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	color: var(--faint);
}
.rp-chg-base {
	flex: 0 1 auto;
	min-width: 0;
	max-width: 68%;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	color: var(--dim);
}
/* 没有目录段时文件名可以吃满整行 */
.rp-chg-path.rp-is-flat > .rp-chg-base { flex: 1 1 auto; max-width: 100%; }
.rp-chg.rp-is-on .rp-chg-base { color: var(--text); }

.rp-diff {
	margin: 2px 0 6px 6px;
	padding: 4px 0;
	background: var(--code-bg);
	border-radius: 8px;
	overflow-x: auto;
}
.rp-dl {
	/* 行高锁 18px（= 正文 diff 的 11.8/1.55 取整），底色整条铺满横向滚动宽度 */
	width: max-content;
	min-width: 100%;
	padding: 0 8px;
	font-family: var(--mono);
	font-size: 12px;
	line-height: 18px;
	color: var(--dim);
	white-space: pre;
}
.rp-dl.rp-dl-add { color: var(--rp-add); background: var(--rp-add-bg); }
.rp-dl.rp-dl-del { color: var(--rp-del); background: var(--rp-del-bg); }
/* hunk 只染色不加底：整行蓝底会把 +/- 的绿红压掉（STYLE §3 不做彩色填充） */
.rp-dl.rp-dl-hunk { color: var(--link); }
.rp-dl.rp-dl-meta { color: var(--faint); }
.rp-empty { padding: 10px 4px 4px; font-size: 12px; line-height: 1.5; color: var(--faint); }

.rp-node {
	display: flex;
	align-items: center;
	gap: 6px;
	width: 100%;
	height: 26px;
	padding: 0 4px;
	border-radius: 6px;
	text-align: left;
	transition: background-color 120ms ease;
}
.rp-node:hover { background: var(--hover); }
.rp-node:focus-visible { outline: 1px solid var(--faint); outline-offset: -1px; }
.rp-node.rp-is-active { background: var(--sel); }
/* 角色列定宽：不定宽时每行文字起点随标签长短浮动，树看起来是斜的 */
.rp-role {
	flex: 0 0 36px;
	overflow: hidden;
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
/* 叶标槽：每行都占位、只有末端行点亮，免得正文列被顶出一个参差的右边界 */
.rp-leaf {
	flex: 0 0 5px;
	width: 5px;
	height: 5px;
	border-radius: 999px;
	background: var(--send-bg);
}
.rp-leaf.rp-is-off { background: transparent; }

@media (prefers-reduced-motion: reduce) {
	#stream,
	#composer,
	.rp-panel,
	.rp-toggle,
	.rp-tab,
	.rp-close,
	.rp-plus,
	.rp-expand,
	.rp-menu-i,
	.rp-grip::after,
	.rp-row,
	.rp-chev,
	.rp-chg,
	.rp-node,
	.rp-retry,
	.rp-refresh { transition: none; }
}

/* 浏览器 tab */
.rp-browser { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.rp-bbar { display: flex; align-items: center; gap: 4px; padding: 8px 10px; border-bottom: 1px solid var(--line); flex: none; }
.rp-bbtn { width: 24px; height: 24px; border-radius: 6px; display: grid; place-items: center; color: var(--faint); flex: none; }
.rp-bbtn:hover { background: var(--hover); color: var(--text); }
.rp-bbtn:disabled { opacity: .35; cursor: default; }
.rp-url { flex: 1; min-width: 0; height: 26px; border: 1px solid var(--line); border-radius: 7px; padding: 0 8px; font: 12px/1.4 var(--mono); color: var(--text); background: var(--bg); }
.rp-url:focus { outline: none; border-color: var(--faint); }
.rp-bnote { display: none; padding: 6px 12px; font-size: 11.5px; color: var(--err); border-bottom: 1px solid var(--line); flex: none; }
.rp-bnote.on { display: block; }
.rp-bview { flex: 1; min-height: 0; display: flex; background: #fff; }
.rp-bview webview { width: 100%; height: 100%; border: 0; display: inline-flex; }
.rp-bempty { margin: auto; padding: 24px; text-align: center; font-size: 12px; color: var(--faint); }

.rp-palette-back {
	position: fixed;
	inset: 0;
	z-index: 1200;
	display: flex;
	align-items: flex-start;
	justify-content: center;
	padding: min(14vh, 120px) 16px 24px;
	background: rgba(0, 0, 0, 0.22);
}
.rp-palette-back[hidden] { display: none; }
.rp-palette {
	display: flex;
	flex-direction: column;
	width: min(620px, 100%);
	max-height: 60vh;
	overflow: hidden;
	background: var(--bg);
	color: var(--text);
	border: 1px solid var(--line);
	border-radius: 12px;
	box-shadow: var(--shadow-menu);
}
.rp-palette-head {
	flex: none;
	display: flex;
	align-items: center;
	padding: 0 12px;
	border-bottom: 1px solid var(--line);
}
.rp-palette-input {
	flex: 1;
	min-width: 0;
	height: 42px;
	padding: 0;
	border: 0;
	outline: 0;
	background: transparent;
	color: var(--text);
	font: 13px/1.4 var(--ui);
}
.rp-palette-input::placeholder { color: var(--faint); }
.rp-palette-list {
	position: relative;
	flex: 1 1 auto;
	min-height: 0;
	overflow-y: auto;
	overscroll-behavior: contain;
	padding: 6px;
}
.rp-palette-row {
	display: flex;
	align-items: baseline;
	gap: 4px;
	width: 100%;
	height: 28px;
	padding: 0 8px;
	border-radius: 6px;
	font-size: 12.5px;
	line-height: 28px;
	white-space: nowrap;
	cursor: pointer;
}
.rp-palette-row.rp-is-active { background: var(--sel); color: var(--text); }
.rp-palette-dir {
	flex: 0 1 auto;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	color: var(--faint);
}
.rp-palette-base {
	flex: 0 1 auto;
	min-width: 0;
	max-width: 78%;
	overflow: hidden;
	text-overflow: ellipsis;
	color: var(--dim);
}
.rp-palette-row.rp-is-active .rp-palette-base { color: var(--text); }
.rp-palette-empty {
	padding: 20px 12px;
	text-align: center;
	font-size: 12.5px;
	line-height: 1.6;
	color: var(--faint);
}
.rp-palette-empty.rp-is-err { color: var(--err); text-align: left; }
.rp-palette-foot {
	flex: none;
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 7px 12px;
	border-top: 1px solid var(--line);
	font-size: 11px;
	color: var(--faint);
}
.rp-palette-hint {
	flex: 0 1 auto;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.rp-palette-trunc {
	flex: 0 1 auto;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	color: var(--err);
}
.rp-palette-trunc[hidden] { display: none; }
.rp-palette-count {
	flex: none;
	margin-left: auto;
	font-variant-numeric: tabular-nums;
}
`;

// 右栏浏览器只接受 http(s)；裸域名补 https，localhost/回环补 http。
// 纯函数导出给 node:test，避免把地址校验只留在 e2e 里。
export function normalizeUrl(raw) {
	let s = String(raw || "").trim();
	if (!s) return null;
	if (!/^https?:\/\//i.test(s)) {
		// 其它协议（file/ftp/javascript…）一律拒绝；裸主机或 localhost:port 才补协议。
		if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) return null;
		const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#]|$)/i.test(s);
		s = (isLocal ? "http://" : "https://") + s;
	}
	let u;
	try {
		u = new URL(s);
	} catch {
		return null;
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") return null;
	return u.href;
}

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

	// ---------- 偏好读写（localStorage 在 file:// / 隐私模式下可能抛，一律兜住）----------
	const readPref = (key, fallback) => {
		try {
			const v = localStorage.getItem(key);
			return v == null ? fallback : v;
		} catch {
			return fallback;
		}
	};
	const writePref = (key, value) => {
		try {
			localStorage.setItem(key, String(value));
		} catch {}
	};

	// 宽度上限 min(560px, 50vw)。窗口窄到 50vw < 260 时让 260 赢——
	// 低于 260 面板里的文件名和 diff 都没法看了，宁可覆盖半个屏幕。
	const maxWidth = () => Math.max(MIN_W, Math.min(MAX_W, Math.round(window.innerWidth / 2)));
	// 窄窗阀值：低于这个宽度时右栏不再挤主对话，直接占满整块区域
	const NARROW_W = 768;
	const isNarrow = () => window.innerWidth < NARROW_W;
	const clampWidth = (n) => {
		const v = Math.round(Number(n));
		if (!Number.isFinite(v)) return DEFAULT_W;
		return Math.min(Math.max(v, MIN_W), maxWidth());
	};
	// --rp-w 是 panel 宽度和主区让位宽度的唯一来源，改这一个变量两边一起走
	const applyWidth = (n) => {
		const px = clampWidth(n);
		document.documentElement.style.setProperty("--rp-w", `${px}px`);
		return px;
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

	const stateEl = (text, detail, onRetry) => {
		const box = el("div", "rp-state", text);
		box.setAttribute("role", "status"); // 加载/错误都是异步到达，读屏要能播报
		if (detail) box.append(el("div", "rp-state-err", detail));
		if (detail && onRetry) {
			const again = el("button", "rp-retry", "重试");
			again.type = "button";
			again.onclick = onRetry;
			box.append(again);
		}
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
	// tab 和宽度先于骨架定下来：面板一画出来就是上次的样子，不会先按默认值闪一帧
	const savedTab = readPref(LS_TAB, "");
	let tab = TABS.some((t) => t.key === savedTab) ? savedTab : "files";
	let width = applyWidth(readPref(LS_WIDTH, DEFAULT_W));

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

	// 「+」：轻量视图菜单，只列已有的三个 tab（终端是另一个独立功能，不在这里）
	const plusBtn = el("button", "rp-plus");
	plusBtn.innerHTML = PLUS_ICON;
	plusBtn.type = "button";
	plusBtn.title = "切换视图";
	plusBtn.setAttribute("aria-label", "切换右栏视图");
	plusBtn.setAttribute("aria-haspopup", "menu");
	plusBtn.setAttribute("aria-expanded", "false");
	plusBtn.onclick = (e) => {
		e.preventDefault();
		e.stopPropagation();
		setMenu(!menuOpen);
	};

	// 「⤢」：全屏覆盖 / 恢复抽屉
	const expandBtn = el("button", "rp-expand");
	expandBtn.innerHTML = EXPAND_ICON;
	expandBtn.type = "button";
	expandBtn.title = "全屏";
	expandBtn.setAttribute("aria-label", "全屏");
	expandBtn.setAttribute("aria-pressed", "false");
	expandBtn.onclick = (e) => {
		e.preventDefault();
		setFull(!full);
	};

	const closeBtn = el("button", "rp-close");
	closeBtn.innerHTML = CLOSE_ICON; // 用图标而不是 "×"：字形随字体回退变化，和 1.4px 描边图标也不搭
	closeBtn.type = "button";
	closeBtn.title = "关闭右栏";
	closeBtn.setAttribute("aria-label", "关闭右栏");
	closeBtn.onclick = (e) => {
		e.preventDefault();
		setOpen(false);
	};
	tabsBar.append(plusBtn, expandBtn, closeBtn);

	const menu = el("div", "rp-menu");
	menu.hidden = true;
	menu.setAttribute("role", "menu");
	menu.setAttribute("aria-label", "右栏视图");
	const menuItem = new Map();
	for (const t of TABS) {
		const b = el("button", "rp-menu-i", t.label);
		b.type = "button";
		b.setAttribute("role", "menuitemradio");
		b.setAttribute("aria-checked", "false");
		b.onclick = () => {
			setTab(t.key);
			setMenu(false, true);
		};
		menu.append(b);
		menuItem.set(t.key, b);
	}

	// 左沿拖拽手柄：热区跨在面板边框上，所以是 absolute + translateX(-50%)
	const grip = el("div", "rp-grip");
	grip.setAttribute("role", "separator");
	grip.setAttribute("aria-orientation", "vertical");
	grip.setAttribute("aria-label", "调整右栏宽度");
	grip.setAttribute("aria-valuemin", String(MIN_W));
	grip.setAttribute("aria-valuemax", String(maxWidth()));
	grip.setAttribute("aria-valuenow", String(width));
	grip.tabIndex = 0;
	grip.title = "拖动调整宽度";

	const body = el("div", "rp-body");
	const pane = new Map();
	for (const t of TABS) {
		const p = el("div", "rp-pane");
		p.id = `rp-pane-${t.key}`;
		p.setAttribute("role", "tabpanel");
		p.setAttribute("aria-labelledby", `rp-tab-${t.key}`);
		p.hidden = t.key !== tab;
		body.append(p);
		pane.set(t.key, p);
	}

	panel.append(tabsBar, menu, body, grip);
	document.body.append(panel);

	// ---------- 模块状态（tab / 宽度已在上面恢复；开合与全屏只在内存里）----------
	let open = false;
	let full = false;
	let menuOpen = false;
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

	// 文件 tab 的内嵌预览：null = 显示树；对象 = 显示该文件的只读内容
	let preview = null;
	let previewSeq = 0;

	// 快速打开面板的状态（DOM 首次 Mod+P 时才创建）
	let paletteUI = null;
	let paletteOpen = false;
	let paletteFocus = null;
	let paletteCache = null; // { cwd, at, files, truncated }
	let paletteSeq = 0;
	let paletteLoading = false;
	let paletteError = "";
	let paletteResults = [];
	let paletteTotal = 0;
	let paletteSel = 0;
	let paletteQuery = "";
	const PREVIEW_LANG = {
		js: "javascript",
		mjs: "javascript",
		cjs: "javascript",
		jsx: "jsx",
		ts: "typescript",
		tsx: "tsx",
		py: "python",
		rb: "ruby",
		go: "go",
		rs: "rust",
		java: "java",
		c: "c",
		h: "c",
		cpp: "cpp",
		cc: "cpp",
		cs: "csharp",
		sh: "bash",
		ps1: "powershell",
		json: "json",
		md: "markdown",
		yml: "yaml",
		yaml: "yaml",
		toml: "toml",
		css: "css",
		scss: "scss",
		html: "html",
		xml: "xml",
		svg: "xml",
		sql: "sql",
		php: "php",
		swift: "swift",
		kt: "kotlin",
		vue: "vue",
		svelte: "svelte",
		ini: "ini",
		gitignore: "text",
	};
	const fmtSize = (n) => {
		const v = Number(n) || 0;
		if (v < 1024) return `${v} B`;
		if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
		return `${(v / 1024 / 1024).toFixed(1)} MB`;
	};

	// ---------- 文件树 ----------
	// 点目录（.git 已在主进程跳过，其余如 .cache/.anaconda）不进树，避免家目录被噪音淹没；
	// 仓库相关目录放行，点文件（.gitignore/.env）照常显示。
	const HIDDEN_DIR_KEEP = new Set([".github", ".vscode", ".devcontainer", ".claude", ".pi"]);
	const buildFileTree = (files) => {
		const root = { name: "", path: "", dir: true, kids: [], map: new Map() };
		for (const f of files) {
			const raw = String(f?.path ?? "")
				.replace(/\\/g, "/")
				.replace(/^\/+|\/+$/g, "");
			if (!raw) continue;
			const segs = raw.split("/").filter(Boolean);
			const hiddenSeg = segs.slice(0, -1).find((s) => s.startsWith(".") && !HIDDEN_DIR_KEEP.has(s));
			if (hiddenSeg) continue;
			if (f?.dir && segs[segs.length - 1]?.startsWith(".") && !HIDDEN_DIR_KEEP.has(segs[segs.length - 1])) continue;
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

	// 点文件：在面板内打开只读预览；预览头部的按钮再用系统程序打开
	async function openFile(relPath, line) {
		return openAbsolute(fullPathOf(relPath), String(relPath || "").split("/").pop(), { line });
	}

	// 预览代码高亮。shiki 侧只固定了 github-light/github-dark 两套主题，
	// 所以读文件时要把当前主题一起传过去，否则暗色下会拿到浅色底。
	const highlightCode = async (res) => {
		if (!res || res.kind !== "text" || !res.content) return null;
		const lang = PREVIEW_LANG[String(res.ext || "").replace(/^\./, "").toLowerCase()] || "text";
		try {
			const arr = await ctx.pi.highlight([{ code: res.content, lang }], {
				dark: document.documentElement.dataset.theme === "dark",
			});
			return Array.isArray(arr) ? arr[0] || null : null;
		} catch {
			return null;
		}
	};

	// 绝对路径预览：工作区内外都走这里（聊天里的路径可能在工作区外）
	async function openAbsolute(full, nameHint, opts = {}) {
		const seq = ++previewSeq;
		const name = nameHint || String(full || "").split(/[\\/]/).pop();
		const line = Math.max(0, Math.floor(Number(opts.line) || 0));
		preview = {
			path: full,
			name,
			busy: true,
			error: "",
			line,
			lineDone: false,
			reloading: false,
			htmlMode: false,
		};
		renderFiles();
		try {
			const res = await ctx.pi.readFile(full);
			if (seq !== previewSeq) return;
			// 目录没有可预览的内容，退回系统程序打开（和聊天里的目录链接行为一致）
			if (res && res.kind === "dir") {
				preview = null;
				renderFiles();
				Promise.resolve(ctx.pi.openPath(full)).catch(() => {});
				return;
			}
			const html = await highlightCode(res);
			if (seq !== previewSeq) return;
			preview = {
				...res,
				busy: false,
				error: "",
				html,
				line,
				lineDone: false,
				reloading: false,
				htmlMode: false,
			};
		} catch (e) {
			if (seq !== previewSeq) return;
			preview = { ...preview, busy: false, error: brief(e), reloading: false };
		}
		renderFiles();
	}

	// 重新读取当前预览。不先切到 busy 状态：保留旧内容直到新内容到达，
	// 这样滚动位置不会在读取期间被清空重置。
	async function reloadPreview() {
		const cur = preview;
		if (!cur?.path || cur.busy || cur.reloading) return;
		const host = pane.get("files");
		const keep = host.scrollTop;
		const seq = ++previewSeq;
		cur.reloading = true;
		host.setAttribute("aria-busy", "true");
		const btn = host.querySelector(".rp-file-reload");
		if (btn) {
			btn.disabled = true;
			btn.title = "读取中…";
			btn.setAttribute("aria-busy", "true");
		}
		try {
			const res = await ctx.pi.readFile(cur.path);
			if (seq !== previewSeq) return;
			if (res && res.kind === "dir") {
				preview = null;
				renderFiles();
				return;
			}
			const html = await highlightCode(res);
			if (seq !== previewSeq) return;
			preview = {
				...res,
				busy: false,
				error: "",
				html,
				line: cur.line || 0,
				lineDone: true,
				reloading: false,
				htmlMode: !!cur.htmlMode,
			};
		} catch (e) {
			if (seq !== previewSeq) return;
			preview = { ...cur, busy: false, error: brief(e), reloading: false };
		}
		renderFiles();
		host.scrollTop = keep;
	}

	async function openExternally() {
		if (!preview?.path) return;
		try {
			const ok = await ctx.pi.openPath(preview.path);
			if (ok === false) flash("系统程序无法打开这个文件");
		} catch (e) {
			flash(brief(e));
		}
	}

	// 行定位高亮：约 1 行的高度必须和 .rp-code 里的 font-size/line-height 同步。
	// 目的行在 .rp-code 内部，但纵向滚动发生在 .rp-pane 上，所以按 pane 的坐标算。
	const PREVIEW_LINE_H = 11.5 * 1.55;
	function scrollPreviewLine(box, line) {
		const host = pane.get("files");
		const total = String(preview?.content || "").replace(/\r\n/g, "\n").split("\n").length;
		const n = Math.max(1, total ? Math.min(line, total) : line);
		const top = 8 + (n - 1) * PREVIEW_LINE_H;
		requestAnimationFrame(() => {
			if (!box.isConnected || preview?.line !== line) return;
			const mark = el("div", "rp-line-mark");
			mark.style.top = `${top}px`;
			mark.style.height = `${PREVIEW_LINE_H}px`;
			mark.style.width = `${Math.max(box.scrollWidth, box.clientWidth)}px`;
			box.append(mark);
			const br = box.getBoundingClientRect();
			const hr = host.getBoundingClientRect();
			const y = br.top - hr.top + host.scrollTop + top;
			host.scrollTop = Math.max(0, y - host.clientHeight / 3);
		});
	}

	function renderPreview(host) {
		const head = el("div", "rp-file-head");
		const back = el("button", "rp-file-back");
		back.type = "button";
		back.innerHTML = CHEV_ICON;
		back.title = "返回文件树";
		back.setAttribute("aria-label", "返回文件树");
		back.onclick = () => {
			previewSeq++;
			preview = null;
			renderFiles();
		};
		const name = el("span", "rp-file-name", preview.name || "");
		name.title = preview.line ? `${preview.path || ""}:${preview.line}` : preview.path || "";
		// HTML 默认仍显示源码；只有用户点「预览」才进内联沙箱。加载中/出错/截断时不提供，
		// 因为半截文档的渲染结果没有参考价值。
		const canRenderHtml =
			preview.kind === "text" &&
			!preview.busy &&
			!preview.error &&
			!preview.truncated &&
			/\.html?$/i.test(String(preview.ext || ""));
		const modeBtn = canRenderHtml
			? el("button", "rp-file-open rp-file-mode", preview.htmlMode ? "源码" : "预览")
			: null;
		if (modeBtn) {
			modeBtn.type = "button";
			modeBtn.title = preview.htmlMode
				? "显示 HTML 源码"
				: "在沙箱中渲染 HTML（脚本已禁用）";
			modeBtn.setAttribute("aria-label", modeBtn.title);
			modeBtn.setAttribute("aria-pressed", preview.htmlMode ? "true" : "false");
			modeBtn.onclick = () => {
				preview.htmlMode = !preview.htmlMode;
				preview.lineDone = false;
				renderFiles();
			};
		}
		const reloadBtn = el("button", "rp-file-open rp-file-reload");
		reloadBtn.type = "button";
		reloadBtn.innerHTML = RELOAD_ICON;
		reloadBtn.title = preview.reloading ? "读取中…" : "重新读取当前文件";
		reloadBtn.setAttribute("aria-label", "重新读取当前文件");
		reloadBtn.disabled = !preview.path || !!preview.busy || !!preview.reloading;
		if (preview.reloading) reloadBtn.setAttribute("aria-busy", "true");
		reloadBtn.onclick = () => reloadPreview();
		const openBtn = el("button", "rp-file-open", "用系统程序打开");
		openBtn.type = "button";
		openBtn.onclick = openExternally;
		const headItems = [back, name, el("span", "rp-grow")];
		if (modeBtn) headItems.push(modeBtn);
		headItems.push(reloadBtn, openBtn);
		head.append(...headItems);
		host.append(head);

		if (preview.busy) {
			host.append(el("div", "rp-note", "读取中…"));
			return;
		}
		if (preview.error) {
			host.append(el("div", "rp-note rp-is-err", preview.error));
			return;
		}
		if (preview.kind === "image") {
			const img = document.createElement("img");
			img.className = "rp-img";
			img.alt = preview.name || "图片";
			img.src = `data:${preview.mime || "image/png"};base64,${preview.data || ""}`;
			host.append(img);
			return;
		}
		if (preview.kind === "binary") {
			host.append(el("div", "rp-note", `二进制文件（${fmtSize(preview.size)}），用系统程序打开。`));
			return;
		}
		if (canRenderHtml && preview.htmlMode) {
			const frame = document.createElement("iframe");
			frame.className = "rp-html-frame";
			// sandbox="" = 全部限制：无脚本、无表单、无同源、无弹窗；srcdoc 不会被当成应用文档
			frame.setAttribute("sandbox", "");
			frame.setAttribute("referrerpolicy", "no-referrer");
			frame.setAttribute("title", `${preview.name || "HTML"} 预览（脚本已禁用）`);
			frame.srcdoc = String(preview.content || "");
			host.append(frame);
			return;
		}
		const box = document.createElement("div");
		box.className = "rp-code";
		if (preview.html) {
			box.innerHTML = preview.html;
		} else {
			const pre = document.createElement("pre");
			pre.className = "code-plain";
			const code = document.createElement("code");
			code.textContent = preview.content || "";
			pre.append(code);
			box.append(pre);
		}
		host.append(box);
		if (preview.truncated) {
			host.append(el("div", "rp-note", `文件较大，只显示前 512 KB（共 ${fmtSize(preview.size)}）。`));
		}
		if (preview.line > 0 && !preview.lineDone) {
			preview.lineDone = true;
			scrollPreviewLine(box, preview.line);
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
			const wantNorm = normCwd(want);
			const res = await ctx.pi.listFiles(want);
			// 请求期间切了工作区：丢弃这次结果，按新 cwd 重新拉
			if (workCwd() !== wantNorm) {
				dataCwd.files = "";
				setTimeout(() => load("files", true), 0);
				return;
			}
			if (!res || typeof res !== "object") throw new Error("文件列表不可用");
			const cwd = String(res.cwd || want || "");
			const list = Array.isArray(res.files) ? res.files : [];
			const root = buildFileTree(list);
			const changed = data.files?.cwd !== cwd;
			data.files = { cwd, tree: root, truncated: !!res.truncated, count: list.length };
			dataCwd.files = wantNorm;
			// 换了工作区，旧的预览路径不再可靠，回到文件树
			if (changed) {
				previewSeq++;
				preview = null;
			}
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
			const wantNorm = workCwd();
			const res = await ctx.pi.gitChanges();
			if (workCwd() !== wantNorm) {
				dataCwd.changes = "";
				setTimeout(() => load("changes", true), 0);
				return;
			}
			if (!Array.isArray(res)) throw new Error("变更列表不可用");
			data.changes = res
				.filter((c) => c && c.path)
				.map((c) => ({
					status: String(c.status || "?"),
					staged: !!c.staged,
					path: String(c.path),
				}));
			dataCwd.changes = wantNorm;
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
			let res;
			try {
				res = await ctx.pi.command({ type: "get_tree" });
			} catch (e) {
				res = null;
			}
			if (!res || !Array.isArray(res.tree)) {
				// get_tree 在大会话上会爆栈（pi 侧递归），改用扁平数组自己建树
				const flat = await ctx.pi.command({ type: "get_entries" });
				if (!flat || !Array.isArray(flat.entries)) throw new Error("返回结构里没有 tree/entries 数组");
				res = treeFromEntries(flat.entries, flat.leafId);
			}
			data.tree = { tree: res.tree, leafId: typeof res.leafId === "string" ? res.leafId : null };
		} catch (e) {
			errors.tree = brief(e);
		} finally {
			busy.tree = false;
			renderTree();
		}
	}

	const loaders = { files: loadFiles, changes: loadChanges, tree: loadTree };

	// 文件/变更缓存必须按工作区隔离：切项目后继续用旧 cwd 的缓存，
	// 会让文件树指向旧目录、点文件必然报“不在当前工作区”。
	const dataCwd = { files: "", changes: "" };
	const normCwd = (value) => String(value || "").replace(/[\\/]+$/, "").toLowerCase();
	const workCwd = () => normCwd(ctx.state?.cwd);
	function cacheFresh(key) {
		if (!data[key] || errors[key]) return false;
		if (key === "files" || key === "changes") return dataCwd[key] === workCwd();
		return true;
	}

	function load(key, force) {
		if (!loaders[key]) return Promise.resolve();
		if (pending[key]) return pending[key];
		if (!force && cacheFresh(key)) return Promise.resolve();
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
		host.setAttribute("aria-busy", busy.files ? "true" : "false");

		if (preview) {
			renderPreview(host);
			return;
		}

		if (!data.files) {
			host.append(
				stateEl(
					errors.files ? "文件列表不可用" : busy.files ? "读取中…" : "还没加载",
					errors.files,
					() => load("files", true),
				),
			);
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
					// 缩进步长 = 图标槽 16px：子级 chevron 落在父级图标下方，而不是压住父级文字
					row.style.paddingLeft = `${4 + Math.min(depth, 10) * 16}px`;
					row.title = node.path;

					const chev = el("span", "rp-chev");
					const isOpen = node.dir && expanded.has(node.path);
					// 空目录没有可展开的东西，别给一个点不动的 chevron
					if (node.dir && node.kids.length) {
						chev.innerHTML = CHEV_ICON;
						if (isOpen) chev.classList.add("rp-is-open");
						row.setAttribute("aria-expanded", isOpen ? "true" : "false");
					}
					const ico = el("span", "rp-ico");
					ico.innerHTML = node.dir ? ICONS.folder : ICONS[fileKind(node.name)] || ICONS.file;
					row.append(chev, ico, el("span", "rp-name", node.name));

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
			const st = el("span", `rp-st rp-is-${ST_CLASS[c.status] || "mod"}`, c.status);
			st.title = `${staged ? "已暂存" : "未暂存"} · ${c.status}`;
			// 目录段单独一段：截断先吃目录，文件名尽量留全
			const shown = c.path.replace(/\\/g, "/");
			const cut = shown.lastIndexOf("/") + 1;
			const pathEl = el("span", "rp-chg-path");
			if (cut > 0) pathEl.append(el("span", "rp-chg-dir", shown.slice(0, cut)));
			else pathEl.classList.add("rp-is-flat");
			pathEl.append(el("span", "rp-chg-base", shown.slice(cut)));
			row.append(st, pathEl);
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
		host.setAttribute("aria-busy", busy.changes ? "true" : "false");

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
			host.append(
				stateEl(
					errors.changes ? "变更列表不可用" : busy.changes ? "读取中…" : "还没加载",
					errors.changes,
					() => load("changes", true),
				),
			);
			return;
		}

		const staged = data.changes.filter((c) => c.staged);
		const unstaged = data.changes.filter((c) => !c.staged);

		// 两组都空时不再排 "已暂存 0 / 没有… / 未暂存 0 / 没有…" 四行废话，只留一句空态
		if (!staged.length && !unstaged.length) {
			host.append(stateEl("工作区没有变更"));
			if (errors.changes) host.append(el("div", "rp-note rp-is-err", errors.changes));
			host.scrollTop = keep;
			return;
		}

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
			if (msg.role === "user") return { role: "用户", text: oneLine(blockText(msg.content)), sys: false };
			if (msg.role === "assistant") {
				const calls = Array.isArray(msg.content)
					? msg.content.filter((b) => b?.type === "toolCall" && b.name).map((b) => b.name)
					: [];
				const text = oneLine(blockText(msg.content)) || (calls.length ? `调用 ${calls.join(", ")}` : "");
				return { role: "助手", text, sys: false };
			}
			if (msg.role === "toolResult") {
				const name = String(msg.toolName || "工具");
				const text = oneLine(blockText(msg.content));
				return { role: "工具", text: text ? `${name} · ${text}` : name, sys: false };
			}
			return { role: String(msg.role || "消息"), text: oneLine(blockText(msg.content)), sys: false };
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
		return { role: SYS_ROLE[type] || type, text, sys: true, type };
	};

	function treeRow(node, depth, leafId, onSelect) {
		const info = nodeInfo(node);
		const row = el("button", `rp-node${info.sys ? " rp-is-sys" : ""}`);
		row.type = "button";
		// 会话树深度可能几十层（工具链）：缩进封顶，否则文字会被推出面板
		row.style.paddingLeft = `${4 + Math.min(depth, 8) * 14}px`;
		// get_tree 的 label/labelTimestamp 之前被整个丢掉，至少让它在 title 里可见
		const label = typeof node?.label === "string" ? node.label : "";
		row.title = [label, info.text].filter(Boolean).join(" · ") || info.role;
		row.dataset.entryId = String(node?.entry?.id ?? "");

		const role = el("span", "rp-role", info.role);
		if (info.type) role.title = info.type;
		row.append(role, el("span", "rp-sum", info.text || "—"));

		const isLeaf = !!leafId && node?.entry?.id === leafId;
		const dot = el("span", "rp-leaf");
		if (isLeaf) {
			dot.title = "当前分支末端";
			row.setAttribute("aria-current", "true");
		} else {
			dot.classList.add("rp-is-off");
		}
		row.append(dot);

		row.onclick = () => {
			const host = pane.get("tree");
			for (const on of host.querySelectorAll(".rp-node.rp-is-active")) on.classList.remove("rp-is-active");
			row.classList.add("rp-is-active");
			onSelect?.(node);
		};
		return row;
	}

	function renderTree() {
		const host = pane.get("tree");
		const keep = host.scrollTop;
		host.textContent = "";
		host.setAttribute("aria-busy", busy.tree ? "true" : "false");

		if (!data.tree) {
			host.append(
				stateEl(
					errors.tree ? "会话树不可用" : busy.tree ? "读取中…" : "还没加载",
					errors.tree,
					() => load("tree", true),
				),
			);
			return;
		}

		const flat = [];
		const walk = (nodes, depth) => {
			for (const n of nodes) {
				if (!n || typeof n !== "object") continue;
				flat.push([n, depth]);
				const kids = Array.isArray(n.children) ? n.children : [];
				if (!kids.length) continue;
				// 单子链不增加缩进：普通会话是一条直线，逐级缩进会变成斜塔；
				// 只有真正分叉（多个子节点）才需要上一层来区分分支。
				walk(kids, kids.length > 1 ? depth + 1 : depth);
			}
		};
		walk(data.tree.tree, 0);

		if (!flat.length) {
			host.append(stateEl("这个会话还没有条目"));
			return;
		}

		// 活动分支：从 leafId 顺着 parentId 回到根，顺序 = 主对话历史顺序
		const byId = new Map();
		for (const [node] of flat) {
			const id = String(node?.entry?.id ?? "");
			if (id) byId.set(id, node);
		}
		const chain = [];
		const seen = new Set();
		let cursor = data.tree.leafId;
		while (cursor && byId.has(cursor) && !seen.has(cursor)) {
			seen.add(cursor);
			const node = byId.get(cursor);
			chain.unshift(node);
			cursor = node?.entry?.parentId;
		}
		const chatChain = chain.filter((node) => {
			const role = node?.entry?.message?.role;
			return node?.entry?.type === "message" && (role === "user" || role === "assistant");
		});

		let noteTimer = 0;
		const note = (text) => {
			host.querySelector(".rp-tree-note")?.remove();
			const line = el("div", "rp-note rp-is-err rp-tree-note", text);
			host.append(line);
			clearTimeout(noteTimer);
			noteTimer = setTimeout(() => line.remove(), 2600);
		};

		const select = (node) => {
			if (ctx.state?.streaming) {
				note("生成中，结束后再定位");
				return;
			}
			// toolResult / custom 条目向上找到最近的 user/assistant 再定位
			let target = node;
			let index = chatChain.indexOf(target);
			let guard = 0;
			while (index < 0 && target?.entry?.parentId && guard++ < 200) {
				target = byId.get(target.entry.parentId);
				if (!target) break;
				index = chatChain.indexOf(target);
			}
			if (index >= 0 && ctx.focusMessage?.(index)) return;
			note(chain.includes(node) ? "这个条目没有可定位的正文" : "该条目在其它分支，主对话只显示当前分支");
		};

		const frag = document.createDocumentFragment();
		for (const [node, depth] of flat) frag.append(treeRow(node, depth, data.tree.leafId, select));
		host.append(frag);
		if (errors.tree) host.append(el("div", "rp-note rp-is-err", errors.tree));
		host.scrollTop = keep;
	}

	// ---------- 浏览器 ----------
	const LS_BROWSER_URL = "pi-mini.browserUrl";
	let browserUI = null;

	function browserShowNote(text) {
		if (!browserUI) return;
		browserUI.note.textContent = text || "";
		browserUI.note.classList.toggle("on", !!text);
	}

	function browserNavigate(raw) {
		const url = normalizeUrl(raw);
		if (!url) {
			browserShowNote("只支持 http:// 和 https:// 地址");
			return;
		}
		browserShowNote("");
		browserUI.input.value = url;
		try {
			localStorage.setItem(LS_BROWSER_URL, url);
		} catch {}
		if (!browserUI.view) {
			const view = document.createElement("webview");
			view.setAttribute("partition", "persist:pi-mini-browser");
			view.setAttribute("src", url);
			view.addEventListener("did-navigate", (e) => {
				browserUI.input.value = e.url;
				try {
					localStorage.setItem(LS_BROWSER_URL, e.url);
				} catch {}
			});
			view.addEventListener("did-navigate-in-page", (e) => {
				if (e.isMainFrame) browserUI.input.value = e.url;
			});
			view.addEventListener("did-fail-load", (e) => {
				if (e.errorCode !== -3) browserShowNote(`加载失败：${e.errorDescription || e.errorCode}`);
			});
			browserUI.empty?.remove();
			browserUI.empty = null;
			browserUI.view = view;
			browserUI.stage.append(view);
		} else {
			browserUI.view.setAttribute("src", url);
		}
	}

	function renderBrowser() {
		const host = pane.get("browser");
		if (!browserUI) {
			host.textContent = "";
			const wrap = el("div", "rp-browser");
			const bar = el("div", "rp-bbar");
			const back = el("button", "rp-bbtn", "‹");
			const fwd = el("button", "rp-bbtn", "›");
			const reload = el("button", "rp-bbtn", "↻");
			back.title = "后退";
			fwd.title = "前进";
			reload.title = "刷新";
			back.onclick = () => {
				try {
					browserUI.view?.goBack();
				} catch {}
			};
			fwd.onclick = () => {
				try {
					browserUI.view?.goForward();
				} catch {}
			};
			reload.onclick = () => {
				try {
					browserUI.view?.reload();
				} catch {}
			};
			const input = el("input", "rp-url");
			input.type = "text";
			input.spellcheck = false;
			input.placeholder = "输入网址，Enter 打开（只支持 http/https）";
			input.onkeydown = (e) => {
				if (e.key === "Enter" && !e.isComposing) {
					e.preventDefault();
					browserNavigate(input.value);
				}
			};
			const open = el("button", "rp-bbtn", "↗");
			open.title = "在系统浏览器打开";
			open.onclick = () => {
				const url = normalizeUrl(input.value);
				if (url) ctx.pi.openExternal?.(url);
			};
			const note = el("div", "rp-bnote");
			const stage = el("div", "rp-bview");
			bar.append(back, fwd, reload, input, open);
			wrap.append(bar, note, stage);
			host.append(wrap);
			browserUI = { wrap, bar, back, fwd, reload, input, open, note, stage, view: null, empty: null };
			let saved = "";
			try {
				saved = localStorage.getItem(LS_BROWSER_URL) || "";
			} catch {}
			if (saved) {
				input.value = saved;
				browserNavigate(saved);
			} else {
				const empty = el("div", "rp-bempty");
				empty.textContent = "输入网址后按 Enter。浏览器与主界面隔离，只允许 http/https。";
				stage.append(empty);
				browserUI.empty = empty;
			}
		}
		requestAnimationFrame(() => {
			try {
				browserUI.input.focus();
			} catch {}
		});
	}

	// ---------- 切换 / 开关 ----------
	function render() {
		for (const t of TABS) {
			const on = t.key === tab;
			const b = tabBtn.get(t.key);
			b.classList.toggle("rp-is-on", on);
			b.setAttribute("aria-selected", on ? "true" : "false");
			b.tabIndex = on ? 0 : -1; // roving tabindex：Tab 只停一次，剩余切换交给方向键
			pane.get(t.key).hidden = !on;
			const mi = menuItem.get(t.key);
			mi.classList.toggle("rp-is-on", on);
			mi.setAttribute("aria-checked", on ? "true" : "false");
		}
		if (tab === "files") renderFiles();
		else if (tab === "changes") renderChanges();
		else if (tab === "tree") renderTree();
		// 关闭状态不建 webview：否则应用一启动就联网
		else if (tab === "browser") {
			if (open) renderBrowser();
		}
	}

	function setTab(key) {
		if (!TABS.some((t) => t.key === key)) return;
		if (tab !== key) {
			tab = key;
			writePref(LS_TAB, tab);
			render();
		}
		if (LOADABLE.has(key)) load(key);
	}

	function setOpen(next) {
		open = !!next;
		// 收起时顺手退出全屏和菜单：留着的话下次打开会直接盖满整屏，很吓人
		if (!open) {
			setFull(false);
			setMenu(false);
		}
		panel.classList.toggle("rp-is-open", open);
		document.body.classList.toggle("rp-open", open);
		panel.setAttribute("aria-hidden", open ? "false" : "true");
		toggle.setAttribute("aria-expanded", open ? "true" : "false");
		if (!open) {
			// 焦点连续性（同 DSH close-focus）：收起后焦点不能留在 aria-hidden 子树里
			if (panel.contains(document.activeElement)) toggle.focus({ preventScroll: true });
			return;
		}
		// 窄窗口下不挤主对话：直接占满（同 DSH：低于 768px 自动全屏）
		if (isNarrow() && !full) setFull(true);
		// 先 load 后 render：load 在 await 前就同步置 busy 并画出「读取中…」，
		// 反过来会先闪一帧「还没加载」
		load(tab, true);
		render();
	}

	// ---------- 全屏覆盖 ----------
	// 不持久化：全屏是「现在看一眼」的状态，下次启动回到普通抽屉
	function setFull(next) {
		full = !!next;
		panel.classList.toggle("rp-is-full", full);
		document.body.classList.toggle("rp-full", full);
		expandBtn.innerHTML = full ? SHRINK_ICON : EXPAND_ICON;
		expandBtn.setAttribute("aria-pressed", full ? "true" : "false");
		expandBtn.title = full ? "退出全屏" : "全屏";
		expandBtn.setAttribute("aria-label", expandBtn.title);
		grip.hidden = full; // 全屏宽度 100%，没有可拖的余量
	}

	// 窄屏退出全屏时收起右栏（同 DSH）：窄窗全屏退出后留一个压住内容的抽屉没意义。
	// 只在「即将退出全屏」这一下生效：窗口变宽不自动重新打开。
	expandBtn.addEventListener(
		"click",
		() => {
			if (full && isNarrow()) setOpen(false);
		},
		true,
	);

	// ---------- 「+」视图菜单 ----------
	const onDocDown = (e) => {
		if (menu.contains(e.target) || plusBtn.contains(e.target)) return;
		setMenu(false);
	};

	function setMenu(next, refocus) {
		const want = !!next;
		if (menuOpen === want) return;
		menuOpen = want;
		menu.hidden = !menuOpen;
		plusBtn.setAttribute("aria-expanded", menuOpen ? "true" : "false");
		if (menuOpen) {
			document.addEventListener("pointerdown", onDocDown, true);
			(menuItem.get(tab) || menuItem.get("files")).focus();
		} else {
			document.removeEventListener("pointerdown", onDocDown, true);
			if (refocus) plusBtn.focus({ preventScroll: true });
		}
	}

	// ---------- 拖拽调宽 ----------
	let dragging = false;
	let dragX0 = 0;
	let dragW0 = 0;

	function setWidth(n, persist) {
		width = applyWidth(n);
		grip.setAttribute("aria-valuenow", String(width));
		grip.setAttribute("aria-valuemax", String(maxWidth()));
		if (persist) writePref(LS_WIDTH, width);
	}

	grip.addEventListener("pointerdown", (e) => {
		if (full || e.button !== 0) return;
		e.preventDefault();
		dragging = true;
		dragX0 = e.clientX;
		dragW0 = width;
		grip.classList.add("is-dragging");
		document.body.classList.add("rp-resizing");
		// 不在这里 focus()：鼠标拖宽不应该把焦点从文件树/预览里抢走
	});

	// 监听挂在 window 上：不依赖 pointer capture，指针甩出面板外也收得到 up
	window.addEventListener("pointermove", (e) => {
		if (!dragging) return;
		// 用相对起点的位移换算，而不是每次累加：拖到边缘被 clamp 之后指针回来能立刻跟上
		setWidth(dragW0 - (e.clientX - dragX0), false);
	});

	const endDrag = () => {
		if (!dragging) return;
		dragging = false;
		grip.classList.remove("is-dragging");
		document.body.classList.remove("rp-resizing");
		writePref(LS_WIDTH, width); // 松手才落盘，拖拽途中不写
	};

	window.addEventListener("pointerup", endDrag);
	window.addEventListener("pointercancel", endDrag);

	// 双击复位：宽度来回拉之后给一条确定性退路
	grip.addEventListener("dblclick", (e) => {
		e.preventDefault();
		setWidth(DEFAULT_W, true);
	});

	// 键盘等价操作：方向键 16px 一步，Home/End 到两端（每次即落盘）
	grip.addEventListener("keydown", (e) => {
		let next = null;
		if (e.key === "ArrowLeft") next = width + 16;
		else if (e.key === "ArrowRight") next = width - 16;
		else if (e.key === "Home") next = MIN_W;
		else if (e.key === "End") next = maxWidth();
		else if (e.key === "Enter" || e.key === " ") next = DEFAULT_W;
		if (next == null) return;
		e.preventDefault();
		setWidth(next, true);
	});

	// 窗口变窄后旧宽度可能越过 50vw：只收紧不落盘，下次拖拽再定
	window.addEventListener("resize", () => {
		if (!full && width > maxWidth()) setWidth(width, false);
	});

	// 菜单的方向键：role="menu" 的既有语义，按当前焦点算，不按当前 tab
	menu.addEventListener("keydown", (e) => {
		if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
		const keys = TABS.map((t) => t.key);
		const cur = keys.findIndex((k) => menuItem.get(k) === document.activeElement);
		const step = e.key === "ArrowDown" ? 1 : -1;
		e.preventDefault();
		menuItem.get(keys[(Math.max(cur, 0) + step + keys.length) % keys.length]).focus();
	});

	// tablist 键盘导航：ARIA tabs 模式要求方向键切 tab（配合 render() 里的 roving tabindex）
	tabsBar.addEventListener("keydown", (e) => {
		const i = TABS.findIndex((t) => t.key === tab);
		let next = -1;
		if (e.key === "ArrowRight") next = (i + 1) % TABS.length;
		else if (e.key === "ArrowLeft") next = (i - 1 + TABS.length) % TABS.length;
		else if (e.key === "Home") next = 0;
		else if (e.key === "End") next = TABS.length - 1;
		if (next < 0) return;
		e.preventDefault();
		const t = TABS[next];
		setTab(t.key);
		tabBtn.get(t.key).focus();
	});

	toggle.onclick = (e) => {
		e.preventDefault();
		e.stopPropagation();
		setOpen(!open);
	};

	// Esc：面板打开且上方没有弹层时才拦截（capture，挡掉 app.js 的 abort）。
	// 注意只查 [aria-modal] 不够：context-meter / message-fork 只有 role="dialog"，会被漏掉。
	const overlayAbove = () =>
		[...document.querySelectorAll('[role="dialog"], [aria-modal="true"], #menu')].some(
			(n) => n.getClientRects().length > 0,
		);

	document.addEventListener(
		"keydown",
		(e) => {
			if (!open) return;
			if (e.key !== "Escape" || e.isComposing) return;
			const active = document.activeElement;
			// 侧边输入框：Esc 先停侧边回合，不关整块面板
			if (active instanceof Element && panel.contains(active) && chat && active === chat.input) {
				e.preventDefault();
				e.stopPropagation();
				if (chat.streaming) chatStop();
				else setOpen(false);
				return;
			}
			// 菜单开着时 Esc 先收菜单、面板留着：一次 Esc 只关一层，和弹层叠放的直觉一致
			if (menuOpen) {
				e.preventDefault();
				e.stopPropagation();
				setMenu(false, true);
				return;
			}
			if (overlayAbove()) return;
			// 主对话生成中：Esc 必须留给 app.js 的 abortRun（document 冒泡监听）
			if (ctx.state?.streaming) return;
			e.preventDefault();
			e.stopPropagation();
			setOpen(false);
		},
		true,
	);

	// 切工作区：文件/变更缓存立即作废，面板开着就自动重拉
	window.addEventListener("pi:cwd-changed", () => {
		dataCwd.files = "";
		dataCwd.changes = "";
		paletteCache = null;
		if (paletteOpen) closePalette();
		if (preview) {
			previewSeq++;
			preview = null;
		}
		if (open && (tab === "files" || tab === "changes")) load(tab, true);
	});

	render();

	// 先定 tab 再开面板：反过来 setOpen 会按旧 tab（可能是浏览器）先渲染一帧，
	// 甚至拉起 webview。
	function showFilesTab() {
		if (tab === "files") return;
		if (open) setTab("files");
		else {
			tab = "files";
			writePref(LS_TAB, tab);
		}
	}

	// 供聊天里的路径链接调用：在右栏打开只读预览。
	// 传绝对路径或相对 cwd 的路径；工作区外的返回 false，由调用方退回系统程序打开。
	// 支持 path:12 / path:12:5 / path#L12 形式：后缀只用于定位，不参与读取。
	async function previewPath(inputPath) {
		const raw = String(inputPath || "").trim();
		let line = 0;
		let spec = raw;
		const suffix = /(?:#L(\d+)(?:C\d+)?|:(\d+)(?::\d+)?)$/i.exec(raw);
		if (suffix && raw.length > suffix[0].length) {
			line = Math.floor(Number(suffix[1] || suffix[2]) || 0);
			spec = raw.slice(0, raw.length - suffix[0].length);
		}
		const cwd = String(ctx.state?.cwd || data.files?.cwd || "").replace(/[\\/]+$/, "");
		let p = spec.replace(/\//g, "\\");
		if (!p || !cwd) return false;
		// 相对路径按当前工作区补全；绝对路径也必须在工作区内，否则交给系统程序
		if (!/^[A-Za-z]:/.test(p) && !p.startsWith("\\\\")) p = `${cwd}\\${p.replace(/^\\+/, "")}`;
		const base = cwd.replace(/\//g, "\\");
		if (!p.toLowerCase().startsWith(`${base.toLowerCase()}\\`)) return false;
		showFilesTab();
		if (!open) setOpen(true);
		if (!data.files || (data.files.cwd && data.files.cwd !== cwd)) await load("files", true);
		const rel = p.slice(base.length + 1).replace(/\\/g, "/");
		if (!rel) return false;
		await openFile(rel, line);
		return true;
	}
	ctx.rightPanel = { preview: previewPath };

	// ---------- 快速打开文件（Mod+P）----------
	const paletteModP = (e) =>
		(e.ctrlKey || e.metaKey) &&
		!e.altKey &&
		!e.shiftKey &&
		(e.code === "KeyP" || String(e.key || "").toLowerCase() === "p");

	// 子序列匹配：按顺序出现即可（"rpn" 命中 "right-panel.js"）
	const paletteSubsequence = (hay, needle) => {
		let at = 0;
		for (let i = 0; i < needle.length; i++) {
			at = hay.indexOf(needle[i], at);
			if (at < 0) return false;
			at += 1;
		}
		return true;
	};

	// 文件名命中优先于目录名/整路径命中；返回值越小越靠前
	const paletteScore = (path, query) => {
		const cut = path.lastIndexOf("/") + 1;
		const base = path.slice(cut);
		if (base === query) return 0;
		if (base.startsWith(query)) return 1;
		if (base.includes(query)) return 2;
		if (paletteSubsequence(base, query)) return 3;
		if (path.includes(query)) return 4;
		if (paletteSubsequence(path, query)) return 5;
		return -1;
	};

	const computePaletteResults = () => {
		const query = paletteQuery.trim().toLowerCase();
		const files = (paletteCache?.files || [])
			.filter((f) => f && !f.dir && typeof f.path === "string" && f.path)
			.map((f) => ({ path: f.path.replace(/\\/g, "/") }));
		if (!query) {
			files.sort((a, b) => a.path.localeCompare(b.path));
			paletteTotal = files.length;
			paletteResults = files.slice(0, PALETTE_MAX);
			return;
		}
		const scored = [];
		for (const f of files) {
			const score = paletteScore(f.path.toLowerCase(), query);
			if (score >= 0) scored.push({ ...f, score });
		}
		scored.sort(
			(a, b) => a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path),
		);
		paletteTotal = scored.length;
		paletteResults = scored.slice(0, PALETTE_MAX).map((f) => ({ path: f.path }));
	};

	function renderPalette() {
		if (!paletteUI) return;
		const { list, input, count, trunc } = paletteUI;
		list.textContent = "";
		trunc.hidden = !paletteCache?.truncated;
		input.setAttribute("aria-expanded", paletteOpen ? "true" : "false");
		if (paletteLoading) {
			count.textContent = "读取中…";
			list.append(el("div", "rp-palette-empty", "正在读取文件索引…"));
			input.removeAttribute("aria-activedescendant");
			return;
		}
		if (paletteError) {
			count.textContent = "读取失败";
			list.append(el("div", "rp-palette-empty rp-is-err", `读取失败：${paletteError}`));
			input.removeAttribute("aria-activedescendant");
			return;
		}
		computePaletteResults();
		if (!paletteResults.length) {
			count.textContent = "0 项";
			list.append(
				el("div", "rp-palette-empty", paletteQuery.trim() ? "没有匹配的文件" : "工作区里没有可打开的文件"),
			);
			input.removeAttribute("aria-activedescendant");
			return;
		}
		if (paletteSel >= paletteResults.length) paletteSel = paletteResults.length - 1;
		if (paletteSel < 0) paletteSel = 0;
		const frag = document.createDocumentFragment();
		paletteResults.forEach((item, i) => {
			const row = el("div", `rp-palette-row${i === paletteSel ? " rp-is-active" : ""}`);
			row.id = `rp-palette-opt-${i}`;
			row.setAttribute("role", "option");
			row.setAttribute("aria-selected", i === paletteSel ? "true" : "false");
			row.title = item.path;
			const cut = item.path.lastIndexOf("/") + 1;
			if (cut > 0) row.append(el("span", "rp-palette-dir", item.path.slice(0, cut)));
			row.append(el("span", "rp-palette-base", item.path.slice(cut)));
			// 按下时保住输入框焦点：选区靠 aria-activedescendant，不靠行内焦点
			row.addEventListener("mousedown", (e) => e.preventDefault());
			row.onclick = () => choosePalette(i);
			frag.append(row);
		});
		list.append(frag);
		count.textContent =
			paletteTotal > paletteResults.length
				? `前 ${paletteResults.length} / ${paletteTotal} 项`
				: `${paletteResults.length} 项`;
		input.setAttribute("aria-activedescendant", `rp-palette-opt-${paletteSel}`);
		const active = list.querySelector(".rp-palette-row.rp-is-active");
		if (active) {
			const top = active.offsetTop;
			const bottom = top + active.offsetHeight;
			if (top < list.scrollTop) list.scrollTop = top;
			else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
		}
	}

	function buildPalette() {
		const back = el("div", "rp-palette-back");
		back.hidden = true;
		const box = el("div", "rp-palette");
		box.setAttribute("role", "dialog");
		box.setAttribute("aria-modal", "true");
		box.setAttribute("aria-label", "快速打开文件");
		const head = el("div", "rp-palette-head");
		const input = el("input", "rp-palette-input");
		input.type = "text";
		input.spellcheck = false;
		input.autocomplete = "off";
		input.placeholder = "搜索文件路径…";
		input.setAttribute("role", "combobox");
		input.setAttribute("aria-label", "搜索文件");
		input.setAttribute("aria-autocomplete", "list");
		input.setAttribute("aria-expanded", "false");
		input.setAttribute("aria-controls", "rp-palette-list");
		const list = el("div", "rp-palette-list");
		list.id = "rp-palette-list";
		list.setAttribute("role", "listbox");
		list.setAttribute("aria-label", "文件结果");
		const foot = el("div", "rp-palette-foot");
		const hint = el("span", "rp-palette-hint", "↑↓ 选择 · Enter 打开 · Esc 关闭");
		const trunc = el("span", "rp-palette-trunc", "文件索引已截断，部分文件可能搜不到");
		trunc.title = "主进程只索引前 2000 个文件";
		trunc.hidden = true;
		const count = el("span", "rp-palette-count");
		count.setAttribute("aria-live", "polite");
		foot.append(hint, trunc, count);
		head.append(input);
		box.append(head, list, foot);
		back.append(box);
		document.body.append(back);
		back.addEventListener("pointerdown", (e) => {
			if (e.target === back) closePalette();
		});
		input.addEventListener("input", () => {
			paletteQuery = input.value;
			paletteSel = 0;
			renderPalette();
		});
		paletteUI = { back, box, input, list, hint, trunc, count };
	}

	// 设置 / cmd+k / 其它 aria-modal 压在上面时不抢 Mod+P：
	// 这些模态有自己的焦点管理和 Esc 语义，两层叠在一起焦点会打架。
	const paletteBlocked = () => {
		const settings = document.querySelector(".settings-overlay");
		if (settings && !settings.hidden && settings.getClientRects().length) return true;
		const cmdk = document.getElementById("cmdk-panel");
		if (cmdk && cmdk.getClientRects().length) return true;
		return [...document.querySelectorAll('[aria-modal="true"]')].some(
			(n) => n !== paletteUI?.back && n.getClientRects().length > 0,
		);
	};

	function openPalette() {
		if (paletteOpen) return;
		if (paletteBlocked()) return;
		if (!paletteUI) buildPalette();
		paletteOpen = true;
		paletteFocus = document.activeElement;
		paletteQuery = "";
		paletteSel = 0;
		paletteError = "";
		paletteResults = [];
		paletteTotal = 0;
		paletteUI.input.value = "";
		paletteUI.back.hidden = false;
		// 5s 内且工作区一致：直接用缓存；否则重新向主进程要索引
		const want = workCwd();
		const fresh =
			paletteCache &&
			Date.now() - paletteCache.at < PALETTE_CACHE_MS &&
			(!want || normCwd(paletteCache.cwd) === want);
		if (fresh) {
			paletteLoading = false;
			renderPalette();
		} else {
			paletteLoading = true;
			renderPalette();
			loadPaletteFiles();
		}
		paletteUI.input.focus({ preventScroll: true });
	}

	function closePalette() {
		if (!paletteOpen) return;
		paletteOpen = false;
		if (paletteUI) {
			paletteUI.back.hidden = true;
			paletteUI.input.setAttribute("aria-expanded", "false");
			paletteUI.input.removeAttribute("aria-activedescendant");
		}
		const back = paletteFocus;
		paletteFocus = null;
		// 焦点不能丢在 hidden 的模态里；回不到原处就交给主输入框
		if (back && back.isConnected && back !== document.body && typeof back.focus === "function") {
			back.focus({ preventScroll: true });
			return;
		}
		ctx.input?.focus?.({ preventScroll: true });
	}

	async function loadPaletteFiles() {
		const seq = ++paletteSeq;
		const want = ctx.state?.cwd;
		try {
			const res = await ctx.pi.listFiles(want);
			if (seq !== paletteSeq) return;
			if (!res || typeof res !== "object") throw new Error("文件列表不可用");
			paletteCache = {
				cwd: String(res.cwd || want || ""),
				at: Date.now(),
				files: Array.isArray(res.files) ? res.files : [],
				truncated: !!res.truncated,
			};
			paletteLoading = false;
			if (paletteOpen) {
				paletteSel = 0;
				renderPalette();
			}
		} catch (e) {
			if (seq !== paletteSeq) return;
			paletteLoading = false;
			paletteError = brief(e);
			if (paletteOpen) renderPalette();
		}
	}

	const joinAbs = (base, rel) => {
		const b = String(base || "").replace(/[\\/]+$/, "");
		const r = String(rel || "")
			.replace(/^[\\/]+/, "")
			.replace(/\//g, "\\");
		return b ? `${b}\\${r}` : r;
	};

	async function choosePalette(i) {
		const item = paletteResults[i];
		if (!item) return;
		const cwd = String(paletteCache?.cwd || ctx.state?.cwd || "");
		closePalette();
		// 面板关着时直接把 tab 定到 files 再 setOpen：否则 setOpen 会先
		// 按旧 tab（可能是浏览器）渲染一帧。
		showFilesTab();
		if (!open) setOpen(true);
		// 等文件树就绪再开预览：loadFiles 在首次加载时会把 preview 清掉，
		// 不 await 的话刚打开的预览会被它覆盖回文件树。
		await load("files");
		openAbsolute(joinAbs(cwd, item.path), item.path.split("/").pop());
	}

	// 全局快捷键。capture 阶段拦截：Esc 不落到 app.js 的 abortRun。
	document.addEventListener(
		"keydown",
		(e) => {
			if (e.isComposing || e.keyCode === 229) return; // 输入法组合中不抢
			if (paletteOpen) {
				if (paletteModP(e)) {
					e.preventDefault();
					e.stopPropagation();
					if (!e.repeat) closePalette();
					return;
				}
				if (e.key === "Escape") {
					e.preventDefault();
					e.stopPropagation();
					closePalette();
					return;
				}
				if (e.key === "Tab") {
					e.preventDefault();
					e.stopPropagation();
					paletteUI?.input.focus({ preventScroll: true });
					return;
				}
				if (e.key === "ArrowDown" || e.key === "ArrowUp") {
					if (!paletteResults.length) return;
					e.preventDefault();
					e.stopPropagation();
					const step = e.key === "ArrowDown" ? 1 : -1;
					paletteSel = (paletteSel + step + paletteResults.length) % paletteResults.length;
					renderPalette();
					return;
				}
				if (e.key === "Home" || e.key === "End") {
					if (!paletteResults.length) return;
					e.preventDefault();
					e.stopPropagation();
					paletteSel = e.key === "Home" ? 0 : paletteResults.length - 1;
					renderPalette();
					return;
				}
				if (e.key === "Enter") {
					if (!paletteResults.length) return;
					e.preventDefault();
					e.stopPropagation();
					choosePalette(paletteSel);
				}
				return;
			}
			if (!paletteModP(e)) return;
			// 精确的 Mod+P 在输入框里也放行（这是全局唤起快捷键）；带 Shift/Alt 的变体
			// 不算精确，走上面的 return，输入框行为保持不变。
			if (paletteBlocked()) return;
			e.preventDefault();
			e.stopPropagation();
			if (e.repeat) return;
			openPalette();
		},
		true,
	);

	// ---------- 演示钩子（截图用；取不到数据也不阻塞）----------
	window.__piRightPanelDemo = (which) => {
		const key = TABS.some((t) => t.key === which) ? which : "files";
		setTab(key); // 走 setTab 才能和手动切换一样落 localStorage
		setOpen(true);
		const job = load(key, true).catch(() => {});
		return Promise.race([Promise.resolve(job), new Promise((r) => setTimeout(r, DEMO_MS))]).then(() => true);
	};
}
