// 设置：顶栏齿轮按钮 + 居中弹窗，把 pi RPC 能驱动的设置项集中到一处。
// 自注入样式与 DOM（#topbar .spacer 之后），不改 index.html / app.js / base.css / 其他 feature。
// RPC：get_state / get_available_models / set_model / get_available_thinking_levels /
//      set_thinking_level / set_auto_compaction / set_auto_retry（读不回，仅本地记录）/
//      set_steering_mode / set_follow_up_mode / set_session_name / compact / export_html /
//      get_session_stats
import {
	getFontFamilies,
	getFontSizes,
	getThemePref,
	setFontFamily,
	setFontSize,
	setThemePref,
} from "../theme.js";
import { THINKING_LEVELS, copyThinkingLevelMap, hasThinkingLevelMap } from "../core/thinking-level-map.js";

const RETRY_KEY = "pi-mini.auto-retry";
const ERR_MS = 3000;
// 普通提示 3.5s（与 extension-ui 的 toast 一致）；带可点操作的多留 1.5s 给人按
const TOAST_MS = 3500;
const TOAST_ACTION_MS = 5000;
const CONFIRM_MS = 2500;
const SAVED_MS = 1400;
const MENU_GAP = 6;
const MAX_ERR = 120;

// 档位兜底表（对齐 thinking-level.js）；真实值以 get_available_thinking_levels 为准
const FALLBACK_LEVELS = THINKING_LEVELS;
const THINKING_LEVEL_LABELS = {
	off: "关闭",
	minimal: "最少",
	low: "低",
	medium: "中",
	high: "高",
	xhigh: "特高",
	max: "最大",
};

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
	display: grid;
	grid-template-columns: 208px minmax(0, 1fr);
	grid-template-rows: auto minmax(0, 1fr);
	grid-template-areas: "title header" "nav options";
	width: min(900px, calc(100vw - 48px));
	height: auto;
	min-height: min(620px, calc(100vh - 48px));
	max-height: calc(100vh - 48px);
	background: var(--bg);
	border: 1px solid var(--line);
	border-radius: 16px;
	box-shadow: var(--shadow-menu);
	overflow: hidden;
	outline: none;
}

.settings-title {
	grid-area: title;
	padding: 24px 12px 12px 24px;
	font-size: 15px;
	font-weight: 600;
	line-height: 22px;
	letter-spacing: -.01em;
	color: var(--text);
}

.settings-head {
	grid-area: header;
	min-height: 68px;
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 16px;
	padding: 14px 18px 12px 28px;
	border-bottom: 1px solid var(--line);
}
.settings-head-copy { min-width: 0; }
.settings-head-title { font-size: 17px; font-weight: 600; line-height: 23px; letter-spacing: -.015em; color: var(--text); }
.settings-head-sub { margin-top: 2px; font-size: 12px; line-height: 17px; color: var(--dim); }
.settings-close {
	width: 28px;
	height: 28px;
	border-radius: 8px;
	display: grid;
	place-items: center;
	color: var(--dim);
	transition: background-color 120ms ease, color 120ms ease;
}
.settings-close:hover { background: var(--hover); color: var(--text); }
.settings-close:focus-visible { outline: 1px solid var(--faint); outline-offset: -1px; }

.settings-nav {
	grid-area: nav;
	display: flex;
	flex-direction: column;
	gap: 3px;
	padding: 12px 12px 14px;
	background: var(--side-bg);
	overflow-y: auto;
}
.settings-nav-item {
	display: flex;
	align-items: center;
	gap: 8px;
	flex: none;
	height: 36px;
	padding: 8px 12px 8px 10px;
	border-radius: 8px;
	text-align: left;
	font-size: 13px;
	font-weight: 500;
	color: var(--dim);
	transition: background-color 100ms ease, color 100ms ease, box-shadow 100ms ease;
}
.settings-nav-item:hover { background: var(--hover); color: var(--text); }
.settings-nav-item.is-on { background: var(--sel); color: var(--text); box-shadow: inset 2px 0 var(--text); }
.settings-nav-item:focus-visible { outline: 1px solid var(--faint); outline-offset: -1px; }
.settings-nav-icon { display: grid; place-items: center; width: 16px; height: 16px; color: var(--dim); flex: none; }
.settings-nav-item.is-on .settings-nav-icon { color: var(--text); }
.settings-nav-group {
	flex: none;
	padding: 12px 10px 4px;
	font-size: 10px;
	font-weight: 650;
	line-height: 14px;
	letter-spacing: .06em;
	color: var(--faint);
}
.settings-nav-group:first-child { padding-top: 2px; }

.settings-body {
	grid-area: options;
	min-height: 0;
	overflow-y: auto;
	padding: 0 32px 28px;
	background: var(--bg);
}
.settings-pane[hidden] { display: none; }
.settings-pane { max-width: 720px; margin: 0 auto; padding-bottom: 8px; }


.settings-add { display: flex; justify-content: flex-start; padding: 12px 0 0; }
.settings-hint { padding: 8px 0 0; font-size: 11.5px; line-height: 1.45; color: var(--faint); }

.settings-exts-head {
	padding: 10px 16px 2px;
	font-size: 11.5px;
	color: var(--faint);
}
.settings-ext {
	display: flex;
	align-items: baseline;
	gap: 10px;
	padding: 6px 16px;
	border-top: 1px solid var(--line);
	font-size: 12.5px;
}
.settings-exts-head + .settings-ext { border-top: 0; }
.settings-ext-name {
	flex: 0 0 34%;
	max-width: 34%;
	font-family: var(--mono);
	font-size: 12px;
	color: var(--text);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.settings-ext-desc {
	flex: 1;
	min-width: 0;
	color: var(--dim);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.settings-exts-empty { padding: 10px 16px; font-size: 12.5px; color: var(--faint); }

.prov-list { display: flex; flex-direction: column; gap: 8px; padding: 12px 0 4px; }
.prov-card { border: 1px solid var(--line); border-radius: 12px; background: var(--bg); }
.prov-card[hidden] { display: none; }
.prov-add { margin-top: 10px; }
.prov-head {
	display: flex;
	align-items: center;
	gap: 8px;
	width: 100%;
	padding: 10px 12px;
	text-align: left;
	border-radius: 12px;
}
.prov-head:hover { background: var(--hover); }
.prov-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--line-strong, #d8d8d8); flex: none; }
.prov-dot.on { background: #3d9a4e; }
.prov-name,
.prov-route {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.prov-name { font-size: 13.5px; font-weight: 500; color: var(--text); }
.prov-route { font-family: var(--mono); font-size: 11.5px; color: var(--faint); }
.prov-sub {
	margin-left: auto;
	max-width: 55%;
	font-size: 11.5px;
	color: var(--faint);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.prov-chev { display: grid; place-items: center; color: var(--faint); transform: rotate(90deg); transition: transform 120ms ease; }
.prov-head[aria-expanded="true"] .prov-chev { transform: rotate(-90deg); }
.prov-editor { display: flex; flex-direction: column; gap: 10px; border-top: 1px solid var(--line); padding: 12px; }
.prov-key { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.prov-key .prov-key-input { flex: 1; min-width: 160px; }
.prov-key-hint { flex-basis: 100%; font-size: 11.5px; color: var(--faint); }
.prov-eye { width: 28px; height: 28px; border-radius: 6px; display: grid; place-items: center; color: var(--faint); flex: none; }
.prov-eye:hover { background: var(--hover); color: var(--text); }
.prov-details { border: 1px solid var(--line); border-radius: 10px; }
.prov-details > summary { padding: 8px 12px; font-size: 12.5px; color: var(--dim); cursor: pointer; }
.prov-details-body { display: flex; flex-direction: column; gap: 12px; padding: 4px 12px 14px; }
.prov-field { display: flex; flex-direction: column; gap: 6px; }
.prov-field-label { font-size: 12px; color: var(--dim); }
.prov-field-hint { font-size: 11.5px; color: var(--faint); }
.settings-input.prov-select { width: 100%; }
.prov-field .settings-input,
.prov-field .prov-select { width: 100%; }
.prov-models { display: flex; flex-direction: column; gap: 6px; }
.prov-model-list { display: flex; flex-direction: column; gap: 6px; }
.prov-model-wrap { display: flex; flex-direction: column; gap: 6px; padding: 6px; border: 1px solid transparent; border-radius: 9px; }
.prov-model-wrap:focus-within { border-color: var(--line); background: var(--surface-2); }
.prov-model { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr) 72px 72px auto 24px; gap: 6px; align-items: center; }
.prov-model .settings-input { width: 100%; min-width: 0; height: 28px; font-size: 12px; }
.prov-think { margin-top: 4px; border-top: 1px solid var(--line); }
.prov-think[hidden] { display: none; }
.prov-think > summary {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 7px 0 5px;
	font-size: 12px;
	line-height: 17px;
	color: var(--dim);
	cursor: pointer;
	list-style: none;
	user-select: none;
}
.prov-think > summary::-webkit-details-marker { display: none; }
.prov-think > summary::before { content: "›"; color: var(--faint); transition: transform 0.15s; }
.prov-think[open] > summary::before { transform: rotate(90deg); }
.prov-think > summary:hover { color: var(--text); }
.prov-think-map {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: 6px 14px;
	padding: 2px 0 4px;
	min-width: 0;
}
.prov-think-cell { display: grid; grid-template-columns: 32px minmax(0, 1fr) 22px; align-items: center; gap: 6px; min-width: 0; }
.prov-think-label { font-size: 11.5px; line-height: 16px; color: var(--faint); min-width: 0; }
.prov-think-input { width: 100%; min-width: 0; height: 26px; font-size: 11.5px; text-overflow: ellipsis; }
/* 禁用态用 --dim：--faint 在浅色/深色底上都低于 4.5:1，标为「不支持」后已填的值仍要能读 */
.prov-think-input:disabled { color: var(--dim); background: var(--side); cursor: default; }
.prov-think-off {
	width: 22px;
	height: 22px;
	border-radius: 5px;
	display: grid;
	place-items: center;
	color: var(--faint);
	transition: background-color 100ms ease, color 100ms ease;
}
.prov-think-off:hover { background: var(--hover); color: var(--text); }
.prov-think-off[aria-pressed="true"] { color: var(--err); }
/* 开关只有 12px 图标，1px --faint 的内描边在深色下几乎看不见；用 --link 两像素外描边 */
.prov-think-off:focus-visible { outline: 2px solid var(--link); outline-offset: 1px; }
.prov-think-note { grid-column: 1 / -1; margin-top: 2px; font-size: 11px; line-height: 16px; color: var(--faint); }
.prov-m-cap { text-align: right; }
.prov-chip {
	flex: none;
	height: 24px;
	padding: 0 8px;
	border-radius: 6px;
	font-size: 11px;
	color: var(--dim);
	border: 1px solid var(--line);
	white-space: nowrap;
}
.prov-chip[aria-pressed="true"] { background: #eaf4ec; border-color: #b9dcc1; color: #2f7a41; }
.prov-del { width: 22px; height: 22px; border-radius: 5px; display: grid; place-items: center; color: var(--faint); }
.prov-del:hover { background: var(--hover); color: var(--err); }
.prov-model-add { align-self: flex-start; font-size: 12px; color: var(--dim); padding: 4px 6px; border-radius: 6px; }
.prov-model-add:hover { background: var(--hover); color: var(--text); }
.prov-model-add:disabled { opacity: 0.5; cursor: default; }
.prov-model-tools { display: flex; align-items: center; gap: 4px; align-self: flex-start; }
.prov-presets { display: flex; flex-wrap: wrap; gap: 6px; padding: 2px 0 4px; }
.prov-preset { height: 26px; padding: 0 10px; border: 1px solid var(--line); border-radius: 999px; font-size: 12px; color: var(--dim); }
.prov-preset:hover { background: var(--hover); color: var(--text); border-color: var(--line-strong); }
/* 模型列表折叠：几十条时只占一行 */
.prov-fold { border-top: 1px solid var(--line); padding-top: 6px; margin-top: 2px; }
.prov-fold > summary { display: flex; align-items: center; gap: 6px; cursor: pointer; list-style: none; font-size: 12.5px; color: var(--dim); padding: 4px 0; user-select: none; }
.prov-fold > summary::-webkit-details-marker { display: none; }
.prov-fold > summary::before { content: "›"; display: inline-block; color: var(--faint); transition: transform 0.15s; }
.prov-fold[open] > summary::before { transform: rotate(90deg); }
.prov-fold > summary:hover { color: var(--text); }
.prov-model-empty { padding: 2px 0; font-size: 12px; color: var(--faint); }
.prov-foot { display: flex; align-items: center; gap: 8px; padding-top: 4px; }
.prov-foot-spacer { flex: 1; }
.prov-btn { height: 28px; padding: 0 12px; border-radius: 7px; border: 1px solid var(--line); font-size: 12.5px; color: var(--text); }
.prov-btn:hover { background: var(--hover); }
.prov-btn.primary { background: var(--send-bg, #1a1c1f); border-color: transparent; color: var(--bg); }
.prov-btn.primary:hover { background: var(--text); }
.prov-danger { height: 28px; padding: 0 10px; border-radius: 7px; font-size: 12.5px; color: var(--err); }
.prov-danger:hover, .prov-danger.armed { background: #fdeceb; }
.prov-empty {
	padding: 12px;
	font-size: 12.5px;
	color: var(--faint);
	text-align: center;
	border: 1px dashed var(--line);
	border-radius: 10px;
}

/* 技能与 MCP：只读技能列表 + 行内展开的 MCP 卡片 */
.skm-actions { display: flex; align-items: center; gap: 8px; }
.skm-list { display: flex; flex-direction: column; gap: 8px; padding: 12px 0 4px; }
.skm-skills { gap: 0; }
.skm-card { border: 1px solid var(--line); border-radius: 12px; background: var(--bg); }
.skm-head { display: flex; align-items: flex-start; gap: 12px; padding: 12px 14px; }
.skm-main { display: flex; flex-direction: column; gap: 3px; flex: 1; min-width: 0; }
.skm-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
.skm-name {
	min-width: 0;
	font-size: 14px;
	line-height: 20px;
	color: var(--text);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.skm-tag {
	flex: none;
	height: 20px;
	padding: 0 7px;
	border: 1px solid var(--line);
	border-radius: 6px;
	font: 11px/18px var(--mono);
	color: var(--dim);
	white-space: nowrap;
}
.skm-cmd {
	font: 12px/1.45 var(--mono);
	color: var(--dim);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.skm-desc {
	font-size: 12px;
	line-height: 1.45;
	color: var(--dim);
	display: -webkit-box;
	-webkit-line-clamp: 2;
	-webkit-box-orient: vertical;
	overflow: hidden;
}
.skm-ctl { display: flex; align-items: center; gap: 6px; flex: none; }
.skm-skill {
	display: flex;
	align-items: flex-start;
	gap: 12px;
	padding: 12px 0;
	border-bottom: 1px solid var(--line);
}
.skm-skill:last-child { border-bottom: 0; }
.skm-editor { display: flex; flex-direction: column; gap: 10px; border-top: 1px solid var(--line); padding: 12px 14px; }
.skm-card.skm-add .skm-editor { border-top: 0; }
.skm-select { width: 100%; max-width: none; justify-content: space-between; }
.skm-empty {
	padding: 12px 14px;
	font-size: 12.5px;
	line-height: 1.5;
	color: var(--faint);
	border: 1px dashed var(--line);
	border-radius: 12px;
}
.skm-empty-path { display: block; margin-top: 4px; font: 11.5px/1.4 var(--mono); overflow-wrap: anywhere; }

.settings-about-row {
	display: flex;
	align-items: baseline;
	gap: 16px;
	padding: 6px 16px;
	font-size: 12.5px;
}
.settings-about-k { flex: 0 0 96px; color: var(--faint); }
.settings-about-v {
	flex: 1;
	min-width: 0;
	color: var(--text);
	font-family: var(--mono);
	font-size: 11.5px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.settings-about-actions { display: flex; flex-wrap: wrap; gap: 8px; padding: 14px 16px 4px; }

.settings-note {
	padding: 8px 0 0;
	font-size: 12px;
	line-height: 1.35;
	color: var(--err);
}
.settings-note[hidden] { display: none; }

.settings-sec {
	padding-top: 0;
	margin-top: 28px;
	background: transparent;
	border: 0;
	border-radius: 0;
	box-shadow: none;
	overflow: visible;
}
.settings-pane > .settings-sec:first-child { margin-top: 22px; }
.settings-sec-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	padding: 0 0 9px;
}
.settings-sec-title {
	font-size: 11px;
	line-height: 16px;
	font-weight: 650;
	letter-spacing: .06em;
	color: var(--faint);
}

.settings-row {
	display: grid;
	grid-template-columns: minmax(0, 1fr) auto;
	column-gap: 16px;
	align-items: center;
	min-height: 0;
	padding: 13px 0;
	border-bottom: 1px solid var(--line);
	transition: none;
}
.settings-row:hover { background: var(--hover); }
.settings-main {
	display: flex;
	flex-direction: column;
	justify-content: center;
	gap: 4px;
	min-width: 0;
	padding: 0;
}
.settings-label { font-size: 14px; line-height: 20px; color: var(--text); }
.settings-sub { font-size: 12px; line-height: 18px; color: var(--dim); }
.settings-ctl { display: flex; align-items: center; gap: 8px; justify-self: end; }
.settings-err {
	grid-column: 1 / -1;
	padding: 0 0 8px;
	font-size: 12px;
	line-height: 1.35;
	color: var(--err);
}

.settings-btn {
	height: 32px;
	padding: 0 12px;
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
	height: 32px;
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
.settings-input:focus {
	border-color: var(--line-strong);
	box-shadow: 0 0 0 3px var(--accent-soft);
}
.settings-range { display: flex; align-items: center; gap: 10px; }
.settings-range input[type="range"] {
	width: 132px;
	height: 4px;
	accent-color: var(--text);
	cursor: pointer;
}
.settings-range-val { min-width: 42px; text-align: right; font: 12px/1 var(--mono); color: var(--dim); }
.settings-font { width: 168px; }

.settings-switch {
	position: relative;
	flex: none;
	width: 40px;
	height: 36px;
	border-radius: 999px;
	background: transparent;
	transition: background-color 120ms ease;
}
.settings-switch::before {
	content: "";
	position: absolute;
	top: 8px;
	left: 3px;
	width: 34px;
	height: 20px;
	border-radius: 999px;
	background: var(--line-strong);
	transition: background-color 120ms ease;
}
.settings-switch::after {
	content: "";
	position: absolute;
	top: 10px;
	left: 5px;
	width: 16px;
	height: 16px;
	border-radius: 999px;
	background: var(--bg);
	transition: transform 120ms ease;
}
.settings-switch[aria-checked="true"]::before { background: var(--send-bg); }
.settings-switch[aria-checked="true"]::after { transform: translateX(14px); }
.settings-switch:focus-visible { outline: 1px solid var(--faint); outline-offset: 2px; }
.settings-switch[aria-busy="true"] { opacity: 0.6; }

.settings-value {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	height: 32px;
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
	padding: 4px 16px;
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
	/* 与 composer 顶边（约 96px）齐平：24px 会压在输入框上 */
	bottom: 96px;
	transform: translateX(-50%);
	/* 与 extension / export 的 toast 同一层：要浮在设置遮罩(60)与扩展弹窗(100)之上，
	   否则弹窗一开，提示就被遮罩压成灰的（DSH 也是 toast 1100 > modal 1000） */
	z-index: 110;
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

:root[data-theme="dark"] .settings-nav-item.is-on { background: rgba(255, 255, 255, 0.1); }
:root[data-theme="dark"] .settings-nav-item:hover { background: var(--hover); }
:root[data-theme="dark"] .prov-chip[aria-pressed="true"] { background: rgba(78, 201, 120, 0.16); border-color: rgba(78, 201, 120, 0.35); color: #7fd39a; }
:root[data-theme="dark"] .prov-danger:hover,
:root[data-theme="dark"] .prov-danger.armed { background: rgba(255, 111, 102, 0.14); }

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

@media (max-width: 760px) {
	.settings-dialog { grid-template-columns: 164px minmax(0, 1fr); }
	.settings-title { padding-left: 16px; }
	.settings-head { padding-left: 18px; }
	.settings-body { padding-left: 16px; padding-right: 16px; }
	.settings-row { grid-template-columns: minmax(0, 1fr); gap: 8px; }
	.settings-ctl { justify-self: start; }
	.settings-err { grid-column: 1; }
	.prov-model { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
	.prov-model-tools { grid-column: 1 / -1; }
	.prov-model > .prov-del { grid-column: 2; justify-self: end; }
	/* 窄窗：档位映射改单列，格子固定列收窄、开关放大到 24px 便于点按，输入框仍占满剩余宽度 */
	.prov-think-map { grid-template-columns: minmax(0, 1fr); gap: 6px 0; }
	.prov-think-cell { grid-template-columns: 28px minmax(0, 1fr) 24px; }
	.prov-think-off { width: 24px; height: 24px; }
}

@media (max-width: 640px) {
	.settings-dialog {
		grid-template-columns: minmax(0, 1fr);
		grid-template-rows: auto auto auto minmax(0, 1fr);
		grid-template-areas: "title" "header" "nav" "options";
		width: calc(100vw - 24px);
		min-height: calc(100vh - 32px);
		max-height: calc(100vh - 32px);
	}
	.settings-title { padding: 18px 18px 8px; }
	.settings-head { min-height: 56px; padding: 8px 18px 12px; }
	.settings-nav {
		grid-area: nav;
		flex-direction: row;
		align-items: center;
		gap: 4px;
		padding: 8px 12px;
		overflow-x: auto;
		overflow-y: hidden;
		border-top: 1px solid var(--line);
		border-bottom: 1px solid var(--line);
	}
	.settings-nav-group,
	.settings-version { display: none; }
	.settings-nav-item { height: 34px; padding: 7px 10px; white-space: nowrap; }
	.settings-nav-icon { display: none; }
	.settings-body { padding: 0 16px 22px; }
	.prov-model { grid-template-columns: minmax(0, 1fr); }
	.prov-model-tools,
	.prov-model > .prov-del { grid-column: 1; justify-self: start; }
	.prov-think-map { grid-template-columns: minmax(0, 1fr); gap: 6px 0; }
	.prov-think-cell { grid-template-columns: 28px minmax(0, 1fr) 24px; }
	.prov-think-off { width: 24px; height: 24px; }
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

	const title = el("div", "settings-title", "设置");
	title.id = "settings-title";

	const head = el("div", "settings-head");
	const headCopy = el("div", "settings-head-copy");
	const headTitle = el("div", "settings-head-title", "通用偏好");
	const headSub = el("div", "settings-head-sub", "外观、启动与会话列表");
	headCopy.append(headTitle, headSub);
	const closeBtn = el("button", "settings-close");
	closeBtn.type = "button";
	closeBtn.title = "关闭";
	closeBtn.setAttribute("aria-label", "关闭设置");
	// 文本 "×" 的字形基线各家字体不一，居中靠猜；线框叉与顶栏图标同规格
	closeBtn.innerHTML =
		'<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3.6 3.6 10.4 10.4M10.4 3.6 3.6 10.4"/></svg>';
	head.append(headCopy, closeBtn);

	const nav = el("nav", "settings-nav");
	nav.setAttribute("role", "tablist");
	nav.setAttribute("aria-label", "设置分区");
	nav.setAttribute("aria-orientation", "vertical");
	const navFoot = el("div", "settings-version", "Myna");
	nav.append(navFoot);

	const panelBody = el("div", "settings-body");
	const headNote = el("div", "settings-note");
	headNote.hidden = true;
	headNote.setAttribute("role", "alert");
	panelBody.append(headNote);

	dialog.append(title, head, nav, panelBody);
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
		if (!menu) return;
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			const anchor = menu.anchor;
			closeMenu();
			anchor?.focus?.();
			return;
		}
		// STYLE §2：打开时不预选任何行；方向键才把焦点送进菜单，项间 roving
		if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
		const active = document.activeElement;
		if (!active || !(active === menu.anchor || menu.el.contains(active))) return;
		const items = [...menu.el.querySelectorAll(".settings-menu-item")];
		if (!items.length) return;
		e.preventDefault();
		e.stopPropagation();
		const at = items.indexOf(active);
		let next;
		if (e.key === "Home") next = items[0];
		else if (e.key === "End") next = items[items.length - 1];
		else if (e.key === "ArrowDown") next = at < 0 ? items[0] : items[(at + 1) % items.length];
		else next = at < 0 ? items[items.length - 1] : items[(at - 1 + items.length) % items.length];
		next.focus();
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
				const anchor = menu?.anchor;
				closeMenu();
				anchor?.focus?.(); // 项随 closeMenu 被移除，焦点别掉回 body
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

	// ---------- 分区（左导航 + 右侧面板）----------
	const NAV_ICONS = {
		general:
			'<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2.5 5h11M2.5 11h11"/><circle cx="6" cy="5" r="1.6"/><circle cx="10" cy="11" r="1.6"/></svg>',
		session:
			'<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M2.8 3.4h10.4v7.2H8l-3 2.2v-2.2H2.8Z"/></svg>',
		model:
			'<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><rect x="4" y="4" width="8" height="8" rx="1.6"/><path d="M6.5 2.2v1.8M9.5 2.2v1.8M6.5 12v1.8M9.5 12v1.8M2.2 6.5H4M2.2 9.5H4M12 6.5h1.8M12 9.5h1.8"/></svg>',
		providers:
			'<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><rect x="2.6" y="3" width="10.8" height="4.2" rx="1.4"/><rect x="2.6" y="8.8" width="10.8" height="4.2" rx="1.4"/><circle cx="5" cy="5.1" r=".8" fill="currentColor" stroke="none"/><circle cx="5" cy="10.9" r=".8" fill="currentColor" stroke="none"/></svg>',
		behavior:
			'<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2.4" y="5" width="11.2" height="6" rx="3"/><circle cx="10.4" cy="8" r="1.6"/></svg>',
		stats:
			'<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3 13V8M8 13V3.5M13 13V6.5"/></svg>',
		extensions:
			'<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2.6" y="2.6" width="10.8" height="10.8" rx="2.2"/><path d="M6.4 6.4h3.2v3.2H6.4Z"/></svg>',
		skillmcp:
			'<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6.2 2 7.05 4.35 9.4 5.2 7.05 6.05 6.2 8.4 5.35 6.05 3 5.2 5.35 4.35Z"/><rect x="8.3" y="8.3" width="5.2" height="5.2" rx="1.3"/></svg>',
		about:
			'<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="8" cy="8" r="5.4"/><path d="M8 7.2v3.9M8 5.2h.01"/></svg>',
		quick:
			'<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M8.8 2.4 4.6 9h2.8l-.4 4.6L11.4 7H8.6Z"/></svg>',
	};
	const NAV_GROUPS = {
		general: "核心偏好",
		session: "核心偏好",
		behavior: "核心偏好",
		providers: "模型服务",
		stats: "运行状态",
		extensions: "运行状态",
		skillmcp: "运行状态",
		about: "系统",
		quick: "系统",
	};
	const panes = new Map();
	const PANE_META = {
		general: ["通用偏好", "外观、启动与会话列表"],
		session: ["会话", "当前会话与历史操作"],
		providers: ["提供商", "pi 使用的模型服务与凭据"],
		behavior: ["行为", "流式期间的发送与压缩策略"],
		stats: ["统计", "当前会话的用量与性能"],
		extensions: ["扩展", "已加载的 pi 扩展与提示"],
		skillmcp: ["技能与 MCP", "pi 启用的技能和外部服务"],
		about: ["关于", "版本、路径与运行环境"],
		quick: ["快捷操作", "常用动作与键盘入口"],
	};
	const navGroups = new Set();
	let activePane = null;
	let selectPane = null;

	const pane = (key, label) => {
		const btn = el("button", "settings-nav-item");
		btn.type = "button";
		btn.id = `settings-nav-${key}`;
		btn.setAttribute("role", "tab");
		btn.setAttribute("aria-selected", "false");
		btn.setAttribute("aria-controls", `settings-pane-${key}`);
		btn.tabIndex = -1;
		btn.innerHTML = `<span class="settings-nav-icon">${NAV_ICONS[key] || ""}</span><span>${label}</span>`;
		const group = NAV_GROUPS[key];
		if (group && !navGroups.has(group)) {
			navGroups.add(group);
			nav.insertBefore(el("div", "settings-nav-group", group), navFoot);
		}
		const box = el("div", "settings-pane");
		box.id = `settings-pane-${key}`;
		box.setAttribute("role", "tabpanel");
		box.setAttribute("aria-labelledby", btn.id);
		box.hidden = true;
		btn.onclick = () => selectPane?.(key);
		nav.insertBefore(btn, navFoot);
		panelBody.append(box);
		panes.set(key, { btn, box, label });
		activePane = box;
		return box;
	};

	selectPane = (key, focus = true) => {
		const hit = panes.get(key);
		if (!hit) return;
		for (const [k, p] of panes) {
			const on = k === key;
			p.btn.classList.toggle("is-on", on);
			p.btn.setAttribute("aria-selected", on ? "true" : "false");
			p.btn.tabIndex = on ? 0 : -1;
			p.box.hidden = !on;
		}
		const meta = PANE_META[key] || [hit.label, ""];
		headTitle.textContent = meta[0];
		headSub.textContent = meta[1];
		panelBody.scrollTop = 0;
		if (focus) {
			hit.btn.focus({ preventScroll: true });
			hit.btn.scrollIntoView({ block: "nearest", inline: "nearest" });
		}
	};

	nav.addEventListener("keydown", (e) => {
		if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
		const keys = [...panes.keys()];
		if (!keys.length) return;
		const cur = keys.findIndex((k) => panes.get(k).btn.getAttribute("aria-selected") === "true");
		let next;
		if (e.key === "Home") next = 0;
		else if (e.key === "End") next = keys.length - 1;
		else if (e.key === "ArrowDown") next = (cur + 1 + keys.length) % keys.length;
		else next = (cur - 1 + keys.length) % keys.length;
		e.preventDefault();
		selectPane(keys[next]);
	});

	const section = (text, action) => {
		const wrap = el("div", "settings-sec");
		const secHead = el("div", "settings-sec-head");
		secHead.append(el("span", "settings-sec-title", text));
		if (action) secHead.append(action);
		wrap.append(secHead);
		(activePane || panelBody).append(wrap);
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

	// ---------- 0. 通用 ----------
	const RESTORE_KEY = "pi-mini.restore-session";
	const PAGE_KEY = "pi-mini.page-size";
	const readPref = (key, fallback) => {
		try {
			const v = localStorage.getItem(key);
			return v == null ? fallback : v;
		} catch {
			return fallback;
		}
	};
	const readPageSize = () => {
		const n = Number(readPref(PAGE_KEY, 20));
		return [20, 40, 60, 100].includes(n) ? n : 20;
	};

	pane("general", "通用偏好");
	const secLook = section("外观");
	const themeRow = makeRow("主题", "跟随系统时随 Windows 明暗模式切换");
	const themeSel = makeSelect(
		{ light: "浅色", dark: "深色", system: "跟随系统" }[getThemePref()],
		(anchor) =>
			openMenu(
				anchor,
				[
					{ key: "system", label: "跟随系统" },
					{ key: "light", label: "浅色" },
					{ key: "dark", label: "深色" },
				],
				getThemePref(),
				(item) => {
					setThemePref(item.key);
					themeSel.text.textContent = item.label;
				},
			),
	);
	themeRow.ctl.append(themeSel.btn);
	secLook.append(themeRow.row);

	const addSizeRow = (label, sub, kind, min, max, step = 0.5) => {
		const row = makeRow(label, sub);
		const wrap = el("div", "settings-range");
		const range = document.createElement("input");
		range.type = "range";
		range.min = String(min);
		range.max = String(max);
		range.step = String(step);
		range.value = String(getFontSizes()[kind]);
		range.setAttribute("aria-label", label);
		const val = el("span", "settings-range-val", `${getFontSizes()[kind]}px`);
		range.oninput = () => {
			const size = setFontSize(kind, range.value).size[kind];
			val.textContent = `${size}px`;
		};
		wrap.append(range, val);
		row.ctl.append(wrap);
		secLook.append(row.row);
	};
	addSizeRow("正文字号", "对话正文与输入框，10–22px", "body", 10, 22);
	addSizeRow("代码字号", "对话内代码块，9–20px", "code", 9, 20);
	addSizeRow("终端字号", "底部终端输出，9–20px", "term", 9, 20);

	const fonts = getFontFamilies();
	const addFontRow = (label, sub, kind, placeholder) => {
		const row = makeRow(label, sub);
		const inp = document.createElement("input");
		inp.type = "text";
		inp.className = "settings-input settings-font";
		inp.placeholder = placeholder;
		inp.value = fonts[kind] || "";
		inp.setAttribute("aria-label", label);
		inp.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Enter") inp.blur();
		});
		inp.addEventListener("change", () => setFontFamily(kind, inp.value));
		row.ctl.append(inp);
		secLook.append(row.row);
	};
	addFontRow("界面字体", "留空用系统默认；可填多个，逗号分隔", "ui", "例如 Microsoft YaHei UI");
	addFontRow("代码 / 终端字体", "留空用系统等宽字体", "mono", "例如 JetBrains Mono");

	const secGeneral = section("启动与会话列表");

	const restoreRow = makeRow("恢复上次会话", "启动时打开上次使用的会话");
	const restoreSwitch = makeSwitch("恢复上次会话");
	restoreSwitch.setAttribute("aria-checked", readPref(RESTORE_KEY, "1") !== "0" ? "true" : "false");
	restoreSwitch.onclick = (e) => {
		e.preventDefault();
		e.stopPropagation();
		const on = restoreSwitch.getAttribute("aria-checked") !== "true";
		restoreSwitch.setAttribute("aria-checked", on ? "true" : "false");
		try {
			localStorage.setItem(RESTORE_KEY, on ? "1" : "0");
		} catch {}
	};
	restoreRow.ctl.append(restoreSwitch);
	secGeneral.append(restoreRow.row);

	const pageRow = makeRow("会话每页", "侧栏每个工作区显示条数，切换工作区后生效");
	const pageSel = makeSelect(`${readPageSize()} 条`, (anchor) =>
		openMenu(
			anchor,
			[20, 40, 60, 100].map((n) => ({ key: n, label: `${n} 条` })),
			readPageSize(),
			(item) => {
				try {
					localStorage.setItem(PAGE_KEY, String(item.key));
				} catch {}
				pageSel.text.textContent = item.label;
			},
		),
	);
	pageRow.ctl.append(pageSel.btn);
	secGeneral.append(pageRow.row);

	const zoomRow = makeRow("界面缩放", "Ctrl+= 放大 · Ctrl+- 缩小 · Ctrl+0 还原");
	const zoomSel = makeSelect("100%", (anchor) =>
		openMenu(
			anchor,
			[70, 80, 90, 100, 110, 120, 130, 140, 150, 160].map((n) => ({ key: n, label: `${n}%` })),
			Math.round(((window.__piZoomFactor || 1) * 100)),
			(item) => {
				window.pi.setZoom?.(item.key / 100).catch(() => {});
				zoomSel.text.textContent = item.label;
			},
		),
	);
	zoomRow.ctl.append(zoomSel.btn);
	secGeneral.append(zoomRow.row);
	window.pi.getZoom?.()
		.then((r) => {
			window.__piZoomFactor = r?.factor || 1;
			zoomSel.text.textContent = `${Math.round(window.__piZoomFactor * 100)}%`;
		})
		.catch(() => {});

	// ---------- 1. 会话 ----------
	pane("session", "会话");
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

	// ---------- 2. 提供商 ----------
	// 常用供应商预填：字段来自 DSH 的 provider 目录（默认 Base URL + 环境变量名），
	// Base URL 补到能直接请求 /models 的形态。
	const PROVIDER_PRESETS = [
		{ key: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com", api: "openai-completions", env: "DEEPSEEK_API_KEY" },
		{ key: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", api: "openai-completions", env: "OPENAI_API_KEY" },
		{ key: "anthropic", label: "Anthropic", baseUrl: "https://api.anthropic.com/v1", api: "anthropic-messages", env: "ANTHROPIC_API_KEY" },
		{ key: "google", label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", api: "google-generative-ai", env: "GEMINI_API_KEY" },
		{ key: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions", env: "OPENROUTER_API_KEY" },
		{ key: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", api: "openai-completions", env: "GROQ_API_KEY" },
		{ key: "xai", label: "xAI", baseUrl: "https://api.x.ai/v1", api: "openai-completions", env: "XAI_API_KEY" },
		{ key: "moonshotai", label: "Moonshot", baseUrl: "https://api.moonshot.ai/v1", api: "openai-completions", env: "MOONSHOT_API_KEY" },
		{ key: "zai", label: "Z.ai", baseUrl: "https://api.z.ai/api/coding/paas/v4", api: "openai-completions", env: "ZAI_API_KEY" },
		{ key: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", api: "openai-completions", env: "MISTRAL_API_KEY" },
		{ key: "together", label: "Together", baseUrl: "https://api.together.ai/v1", api: "openai-completions", env: "TOGETHER_API_KEY" },
		{ key: "qwen", label: "Qwen", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", api: "openai-completions", env: "DASHSCOPE_API_KEY" },
	];
	// 模型默认上下文 / 最大输出：服务商 API 没给元数据时按家族兜底。
	// 取保守值（宁可比真实窗口小，不要填大导致 pi 误判上下文）。
	const MODEL_LIMITS = [
		[/^claude/i, 200000, 32000],
		[/^gpt-|^o[1-9]/i, 200000, 32000],
		[/^gemini/i, 1000000, 65536],
		[/^deepseek/i, 128000, 8192],
		[/^glm/i, 128000, 16384],
		[/^kimi/i, 256000, 32768],
		[/^grok/i, 256000, 32000],
		[/^qwen/i, 128000, 16384],
		[/^muse/i, 128000, 8192],
		[/^hy/i, 128000, 8192],
	];
	const DEFAULT_LIMITS = { contextWindow: 128000, maxTokens: 8192 };
	const limitsFor = (id) => {
		const value = String(id || "");
		for (const [re, contextWindow, maxTokens] of MODEL_LIMITS) {
			if (re.test(value)) return { contextWindow, maxTokens };
		}
		return { ...DEFAULT_LIMITS };
	};
	pane("providers", "提供商");

	// 常用供应商：点一下把添加表单填好，只需要补/确认密钥。顶部默认折叠，别占一屏。
	let presetBody = null;
	const presetToggle = actionBtn("展开", () => {
		if (!presetBody) return;
		presetBody.hidden = !presetBody.hidden;
		presetToggle.textContent = presetBody.hidden ? "展开" : "收起";
	});
	const secPresets = section("常用供应商", presetToggle);
	presetBody = el("div");
	presetBody.hidden = true;
	secPresets.append(presetBody);
	presetBody.append(el("div", "settings-hint", "点一个预填 Base URL / API 类型 / $ENV 密钥；模型列表用表单里的「从 API 获取」。与 pi 内置同名时会覆盖内置路由。"));
	const presetWrap = el("div", "prov-presets");
	for (const preset of PROVIDER_PRESETS) {
		const b = el("button", "prov-preset", preset.label);
		b.type = "button";
		b.title = `${preset.baseUrl}\n密钥：$${preset.env}`;
		b.onclick = () => {
			const exists = (provData?.providers || []).some((p) => p.key === preset.key);
			if (exists) {
				openKey = preset.key;
				renderProviders();
				toast("已存在，已打开编辑");
				return;
			}
			addOpen = true;
			addCard.hidden = false;
			renderAddCard(preset);
			addCard.scrollIntoView({ block: "nearest", behavior: "smooth" });
		};
		presetWrap.append(b);
	}
	presetBody.append(presetWrap);

	const provRefresh = el("button", "settings-refresh", "刷新");
	provRefresh.type = "button";
	provRefresh.title = "重新读取 models.json";
	provRefresh.setAttribute("aria-label", "刷新提供商");
	provRefresh.onclick = () => loadProviders(true);
	const secProv = section("提供商", provRefresh);
	const provList = el("div", "prov-list");
	secProv.append(provList);
	const provNote = el("div", "settings-note");
	provNote.hidden = true;
	secProv.append(provNote);

	const addWrap = el("div", "settings-add");
	const addBtn = actionBtn("添加提供商", () => {
		addOpen = !addOpen;
		addCard.hidden = !addOpen;
		if (addOpen) renderAddCard();
	});
	addWrap.append(addBtn);
	secProv.append(addWrap);
	const addCard = el("div", "prov-card prov-add");
	addCard.hidden = true;
	secProv.append(addCard);
	secProv.append(el("div", "settings-hint", "写入 ~/.pi/agent/models.json 前会先备份；pi 只在启动时读取，保存后重启应用生效。"));

	const API_OPTIONS = [
		{ key: "openai-completions", label: "OpenAI Chat Completions" },
		{ key: "openai-responses", label: "OpenAI Responses" },
		{ key: "anthropic-messages", label: "Anthropic Messages" },
		{ key: "google-generative-ai", label: "Google Generative AI" },
	];
	const apiLabel = (key) => (key ? (API_OPTIONS.find((o) => o.key === key) || {}).label || key : "pi 内置路由");

	let provData = null;
	let provLoading = false;
	let addOpen = false;
	let openKey = null;

	const errText = (e) =>
		brief(
			String(e?.message || e)
				.replace(/^Error invoking remote method '[^']+':\s*/, "")
				.replace(/^Error:\s*/, ""),
		);

	const mkInput = (cls, placeholder, value, type = "text") => {
		const i = document.createElement("input");
		i.type = type;
		i.className = cls;
		i.placeholder = placeholder || "";
		i.value = value == null ? "" : String(value);
		if (type !== "password") {
			i.autocomplete = "off";
			i.spellcheck = false;
		}
		return i;
	};

	const apiSelect = (value) => {
		const s = document.createElement("select");
		s.className = "settings-input prov-select";
		if (!value) {
			const opt = document.createElement("option");
			opt.value = "";
			opt.textContent = "沿用 pi 内置路由";
			s.append(opt);
		}
		for (const o of API_OPTIONS) {
			const opt = document.createElement("option");
			opt.value = o.key;
			opt.textContent = o.label;
			s.append(opt);
		}
		s.value = value && API_OPTIONS.some((o) => o.key === value) ? value : "";
		return s;
	};

	const keyField = (hintText, placeholder) => {
		const wrap = el("div", "prov-key");
		const input = mkInput("settings-input prov-key-input", placeholder, "", "password");
		input.autocomplete = "new-password";
		const eye = el("button", "prov-eye");
		eye.type = "button";
		eye.title = "显示 / 隐藏";
		eye.setAttribute("aria-label", "显示或隐藏 API Key");
		eye.setAttribute("aria-pressed", "false");
		eye.innerHTML =
			'<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><path d="M1.5 8C2.9 5.25 5.25 3.5 8 3.5C10.75 3.5 13.1 5.25 14.5 8C13.1 10.75 10.75 12.5 8 12.5C5.25 12.5 2.9 10.75 1.5 8Z"/><path d="M10 8C10 9.1 9.1 10 8 10C6.9 10 6 9.1 6 8C6 6.9 6.9 6 8 6C9.1 6 10 6.9 10 8Z"/></svg>';
		let shown = false;
		eye.onclick = () => {
			shown = !shown;
			input.type = shown ? "text" : "password";
			eye.setAttribute("aria-pressed", shown ? "true" : "false");
		};
		wrap.append(input, eye);
		if (hintText) wrap.append(el("div", "prov-key-hint", hintText));
		return { wrap, input };
	};

	// 模型列表：一行一个模型，字段直接写回 models.json。
	// creds() 提供当前 Base URL / API 类型 / 密钥，用于「从 API 获取」。
	const modelsEditor = (seed, creds) => {
		const box = el("div", "prov-models");
		// 模型多的时候（从 API 拉下来几十条）整块可折叠，summary 显示数量
		const details = document.createElement("details");
		details.className = "prov-fold";
		details.open = true;
		const summary = el("summary", "prov-fold-sum");
		const list = el("div", "prov-model-list");
		details.append(summary, list);
		const drafts = (Array.isArray(seed) ? seed : []).map((m) => {
			const id = String(m.id || "");
			// 历史配置里没填上限的（旧版本留下的空值）打开时补默认值，保存即落盘
			const lim = limitsFor(id);
			return {
				id,
				name: String(m.name || ""),
				reasoning: Boolean(m.reasoning),
				thinkingLevelMap: copyThinkingLevelMap(m.thinkingLevelMap),
				contextWindow: Number(m.contextWindow) || lim.contextWindow,
				maxTokens: Number(m.maxTokens) || lim.maxTokens,
			};
		});
		const syncSummary = () => {
			const n = drafts.filter((m) => m.id.trim()).length;
			summary.textContent = `模型 · ${n} 个`;
		};
		// 每个模型草稿的「思考档位映射」展开状态（WeakMap：不污染草稿对象、不落盘）
		const thinkOpen = new WeakMap();
		// 思考档位映射：默认折叠（高级项），只对标记为推理的模型可见。
		// 切换“不支持”时只就地同步本格状态，不重建整个列表，避免丢焦点。
		const renderThinkingMap = (m) => {
			const details = document.createElement("details");
			details.className = "prov-think";
			details.hidden = !m.reasoning;
			// render() 会重建整个列表（加/删模型、从 API 拉取），展开状态不记就丢。
			// 记忆放进 WeakMap，不往草稿对象上挂字段，免得被 read() 带进 models.json。
			if (thinkOpen.get(m)) details.open = true;
			details.addEventListener("toggle", () => thinkOpen.set(m, details.open));
			const summary = el("summary", "prov-think-sum");
			const wrap = el("div", "prov-think-map");
			const syncSummary = () => {
				const n = m.thinkingLevelMap ? Object.keys(m.thinkingLevelMap).length : 0;
				summary.textContent = n ? `思考档位映射 · ${n} 项` : "思考档位映射";
				summary.title = "把 pi 的思考档位映射成上游实际参数；留空则沿用 pi / 服务商默认";
			};
			for (const level of THINKING_LEVELS) {
				const cell = el("div", "prov-think-cell");
				const label = el("span", "prov-think-label", THINKING_LEVEL_LABELS[level]);
				const field = mkInput("settings-input prov-think-input", level, m.thinkingLevelMap?.[level] ?? "");
				field.setAttribute("aria-label", `${THINKING_LEVEL_LABELS[level]}档位的上游参数`);
				const toggle = el("button", "prov-think-off");
				toggle.type = "button";
				toggle.innerHTML =
					'<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.3"/><path d="M3 9 9 3"/></svg>';
				// 标为「不支持」时输入框会被清空并禁用，上一次填的值记在这里，切回时原样还原
				let lastValue = m.thinkingLevelMap?.[level] ?? "";
				const syncCell = () => {
					const off = m.thinkingLevelMap?.[level] === null;
					field.disabled = off;
					toggle.setAttribute("aria-pressed", off ? "true" : "false");
					toggle.title = off ? `恢复“${THINKING_LEVEL_LABELS[level]}”档位` : `把“${THINKING_LEVEL_LABELS[level]}”标记为不支持`;
					toggle.setAttribute("aria-label", toggle.title);
				};
				field.oninput = () => {
					const value = field.value.trim();
					lastValue = value; // 清空也算：避免「清空→标不支持→切回」把旧值复活
					if (value) (m.thinkingLevelMap ||= {})[level] = value;
					else if (m.thinkingLevelMap) {
						// 出空就整键删；删空了连对象一起删，不留 {} 进 models.json
						delete m.thinkingLevelMap[level];
						if (!hasThinkingLevelMap(m.thinkingLevelMap)) delete m.thinkingLevelMap;
					}
					syncSummary();
				};
				toggle.onclick = () => {
					if (m.thinkingLevelMap?.[level] === null) {
						delete m.thinkingLevelMap[level];
						if (!hasThinkingLevelMap(m.thinkingLevelMap)) delete m.thinkingLevelMap;
						// 输入框回填与映射同时恢复，两者不能脱节
						field.value = lastValue;
						if (lastValue) (m.thinkingLevelMap ||= {})[level] = lastValue;
					} else {
						lastValue = field.value.trim();
						(m.thinkingLevelMap ||= {})[level] = null;
						field.value = "";
					}
					syncCell();
					syncSummary();
				};
				syncCell();
				cell.append(label, field, toggle);
				wrap.append(cell);
			}
			wrap.append(
				el("div", "prov-think-note", "留空沿用 pi / 服务商默认；右侧按钮把该档位标为不支持，会从可选档位中移除。"),
			);
			syncSummary();
			details.append(summary, wrap);
			return details;
		};
		const render = () => {
			list.replaceChildren();
			drafts.forEach((m, index) => {
				const modelWrap = el("div", "prov-model-wrap");
				const row = el("div", "prov-model");
				const id = mkInput("settings-input prov-m-id", "模型 ID", m.id);
				const name = mkInput("settings-input prov-m-name", "显示名称（可选）", m.name);
				const ctx = mkInput("settings-input prov-m-cap", "上下文", m.contextWindow || "");
				const max = mkInput("settings-input prov-m-cap", "最大输出", m.maxTokens || "");
				const thinkBox = renderThinkingMap(m);
				const reason = el("button", "prov-chip");
				reason.type = "button";
				reason.textContent = "推理";
				reason.title = "标记为推理模型";
				const syncReason = () => {
					reason.setAttribute("aria-pressed", m.reasoning ? "true" : "false");
					reason.setAttribute("aria-label", m.reasoning ? "推理模型（已开启）" : "推理模型（未开启）");
				};
				syncReason();
				reason.onclick = () => {
					m.reasoning = !m.reasoning;
					syncReason();
					// 只切换映射区的可见性，不重建整行，避免丢焦点和折叠状态
					const hadFocus = thinkBox.contains(document.activeElement);
					thinkBox.hidden = !m.reasoning;
					// 隐藏含焦点的子树会让焦点掉回 body；交还给开关本身
					if (hadFocus && thinkBox.hidden) reason.focus();
				};
				const del = el("button", "prov-del");
				del.type = "button";
				del.title = "删除这个模型";
				del.setAttribute("aria-label", "删除模型");
				del.innerHTML =
					'<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M2.5 3.5h7M5 3.5V2.5h2v1M3.5 3.5l.5 6h4l.5-6"/></svg>';
				del.onclick = () => {
					drafts.splice(index, 1);
					render();
				};
				id.oninput = () => {
					m.id = id.value;
					// 填了 ID 还没填上限：按模型家族补默认值（用户手填过的不覆盖）
					if (!m.contextWindow) {
						const lim = limitsFor(m.id);
						m.contextWindow = lim.contextWindow;
						ctx.value = String(lim.contextWindow);
					}
					if (!m.maxTokens) {
						const lim = limitsFor(m.id);
						m.maxTokens = lim.maxTokens;
						max.value = String(lim.maxTokens);
					}
				};
				name.oninput = () => {
					m.name = name.value;
				};
				ctx.oninput = () => {
					m.contextWindow = Number(ctx.value.replace(/[^0-9]/g, "")) || 0;
				};
				max.oninput = () => {
					m.maxTokens = Number(max.value.replace(/[^0-9]/g, "")) || 0;
				};
				row.append(id, name, ctx, max, reason, del);
				modelWrap.append(row, thinkBox);
				list.append(modelWrap);
			});
			if (!drafts.length) list.append(el("div", "prov-model-empty", "没有自定义模型；pi 内置目录照常可用"));
			const add = el("button", "prov-model-add", "+ 添加模型");
			add.type = "button";
			add.onclick = () => {
				const lim = limitsFor("");
				drafts.push({ id: "", name: "", reasoning: false, thinkingLevelMap: undefined, contextWindow: lim.contextWindow, maxTokens: lim.maxTokens });
				render();
				const inputs = list.querySelectorAll(".prov-m-id");
				if (inputs.length) inputs[inputs.length - 1].focus();
			};
			const pull = el("button", "prov-model-add", "从 API 获取");
			pull.type = "button";
			pull.title = "用当前 Base URL 与密钥读取服务商的模型列表（带上下文/输出上限）";
			pull.onclick = async () => {
				const c = (typeof creds === "function" ? creds() : null) || {};
				if (!String(c.baseUrl || "").trim()) {
					toast("先在 Base URL 里填入服务地址");
					return;
				}
				const label = pull.textContent;
				pull.disabled = true;
				pull.textContent = "获取中…";
				try {
					const r = await ctx.pi.fetchModels?.({
						providerKey: c.providerKey,
						baseUrl: c.baseUrl,
						api: c.api,
						apiKey: c.apiKey,
					});
					const have = new Set(drafts.map((d) => d.id.trim()).filter(Boolean));
					let added = 0;
					for (const m of r?.models || []) {
						const id = String(m?.id || "").trim();
						if (!id || have.has(id)) continue;
						have.add(id);
						const lim = limitsFor(id);
						drafts.push({
							id,
							name: String(m?.name || ""),
							reasoning: false,
							contextWindow: Number(m?.contextWindow) || lim.contextWindow,
							maxTokens: Number(m?.maxTokens) || lim.maxTokens,
						});
						added += 1;
					}
					details.open = true;
					render();
					toast(added ? `已添加 ${added} 个模型（已填默认上下文），记得保存` : "没有新增模型（列表已是最新）");
				} catch (e) {
					toast(errText(e));
				} finally {
					pull.disabled = false;
					pull.textContent = label;
				}
			};
			const tools = el("div", "prov-model-tools");
			tools.append(add, pull);
			list.append(tools);
			syncSummary();
		};
		render();
		box.append(details);
		return { box, read: () => drafts.filter((m) => m.id.trim()) };
	};

	const field = (label, control, hintText) => {
		const wrap = el("div", "prov-field");
		wrap.append(el("span", "prov-field-label", label));
		wrap.append(control);
		if (hintText) wrap.append(el("span", "prov-field-hint", hintText));
		return wrap;
	};

	const saveBtnRow = (onCancel, onSave, onDelete) => {
		const foot = el("div", "prov-foot");
		if (onDelete) {
			const del = el("button", "prov-danger", "删除");
			del.type = "button";
			let armed = 0;
			del.onclick = () => {
				if (!armed) {
					armed = 1;
					del.textContent = "确认删除";
					del.classList.add("armed");
					setTimeout(() => {
						armed = 0;
						del.textContent = "删除";
						del.classList.remove("armed");
					}, 3000);
					return;
				}
				onDelete();
			};
			foot.append(del);
		}
		const cancel = el("button", "prov-btn", "取消");
		cancel.type = "button";
		cancel.onclick = onCancel;
		const save = el("button", "prov-btn primary", "保存");
		save.type = "button";
		save.onclick = () => onSave(save);
		foot.append(el("span", "prov-foot-spacer"), cancel, save);
		return foot;
	};

	const editorFor = (p) => {
		const box = el("div", "prov-editor");
		const note = el("div", "settings-note");
		note.hidden = true;
		const key = keyField(p.hasKey ? `已保存 ${p.apiKey}；留空保持不变` : "未设置密钥；可以直接填写", "sk-… 或 $ENV");
		const details = document.createElement("details");
		details.className = "prov-details";
		details.open = true;
		const summary = document.createElement("summary");
		summary.textContent = "自定义设置";
		details.append(summary);
		const body = el("div", "prov-details-body");
		const name = mkInput("settings-input", "显示名称", p.name || "");
		const base = mkInput("settings-input", "https://api.example.com/v1", p.baseUrl || "");
		const api = apiSelect(p.api);
		const models = modelsEditor(p.models, () => ({ providerKey: p.key, baseUrl: base.value, api: api.value, apiKey: key.input.value }));
		body.append(
			field("显示名称", name),
			field("Base URL", base, "留空表示沿用 pi 内置路由；自定义网关才需要填写"),
			field("API 类型", api),
			models.box,
		);
		details.append(body);
		box.append(key.wrap, note, details);
		box.append(
			saveBtnRow(
				() => {
					openKey = null;
					renderProviders();
				},
				async (save) => {
					save.disabled = true;
					save.textContent = "保存中…";
					note.hidden = true;
					try {
						await ctx.pi.saveProvider({
							key: p.key,
							create: false,
							name: name.value.trim(),
							baseUrl: base.value.trim(),
							api: api.value,
							apiKey: key.input.value.trim(),
							models: models.read(),
						});
						openKey = null;
						await loadProviders(true);
						toast("提供商已保存，重启应用后生效");
					} catch (e) {
						note.textContent = errText(e);
						note.hidden = false;
						save.disabled = false;
						save.textContent = "保存";
					}
				},
				async () => {
					note.hidden = true;
					try {
						await ctx.pi.deleteProvider(p.key);
						openKey = null;
						await loadProviders(true);
						toast("提供商已删除");
					} catch (e) {
						note.textContent = errText(e);
						note.hidden = false;
					}
				},
			),
		);
		return box;
	};

	const renderAddCard = (preset = null) => {
		addCard.replaceChildren();
		const note = el("div", "settings-note");
		note.hidden = true;
		const key = mkInput("settings-input", "acme-gateway", preset?.key || "");
		const name = mkInput("settings-input", "我的提供商", preset?.name || preset?.label || "");
		const base = mkInput("settings-input", "https://api.example.com/v1", preset?.baseUrl || "");
		const api = apiSelect(preset?.api || API_OPTIONS[0].key);
		const secret = keyField("也支持 $ENV 或 !command 形式", "sk-…");
		if (preset?.env) secret.input.value = `$${preset.env}`;
		const models = modelsEditor(
			Array.isArray(preset?.models) && preset.models.length ? preset.models : [{ id: "", name: "", reasoning: false }],
			() => ({ baseUrl: base.value, api: api.value, apiKey: secret.input.value }),
		);
		const body = el("div", "prov-details-body");
		body.append(
			field("标识", key, "provider key，小写字母开头，可含数字、点、下划线、短横线"),
			field("显示名称", name, "模型菜单里显示的名字，可留空"),
			field("Base URL", base),
			field("API Key", secret.wrap),
			field("API 类型", api),
			models.box,
		);
		addCard.append(body, note);
		let saving = false;
		addCard.append(
			saveBtnRow(
				() => {
					addOpen = false;
					addCard.hidden = true;
				},
				async (save) => {
					if (saving) return;
					saving = true;
					save.disabled = true;
					save.textContent = "添加中…";
					note.hidden = true;
					try {
						await ctx.pi.saveProvider({
							key: key.value.trim(),
							create: true,
							name: name.value.trim(),
							baseUrl: base.value.trim(),
							api: api.value,
							apiKey: secret.input.value.trim(),
							models: models.read(),
						});
						addOpen = false;
						addCard.hidden = true;
						await loadProviders(true);
						toast("提供商已添加，重启应用后生效");
					} catch (e) {
						note.textContent = errText(e);
						note.hidden = false;
						save.disabled = false;
						save.textContent = "添加";
					} finally {
						saving = false;
					}
				},
			),
		);
	};

	const renderProviders = () => {
		provList.replaceChildren();
		const items = provData?.providers || [];
		if (!items.length) provList.append(el("div", "prov-empty", "models.json 里还没有自定义提供商"));
		for (const p of items) {
			const card = el("div", "prov-card");
			const head = el("button", "prov-head");
			head.type = "button";
			head.setAttribute("aria-expanded", openKey === p.key ? "true" : "false");
			const dot = el("span", `prov-dot${p.hasKey ? " on" : ""}`);
			const nm = el("span", "prov-name", p.name || p.key);
			const route = el("span", "prov-route", p.key);
			const subParts = [apiLabel(p.api), `${p.modelCount} 个模型`];
			if (p.overrides) subParts.push(`${p.overrides} 个覆盖`);
			subParts.push(p.hasKey ? p.apiKey : "未设置密钥");
			const sub = el("span", "prov-sub", subParts.join(" · "));
			const chev = el("span", "prov-chev");
			chev.innerHTML =
				'<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M4.5 2.5 8 6l-3.5 3.5"/></svg>';
			head.append(dot, nm, route, sub, chev);
			head.onclick = () => {
				openKey = openKey === p.key ? null : p.key;
				renderProviders();
			};
			card.append(head);
			if (openKey === p.key) card.append(editorFor(p));
			provList.append(card);
		}
	};

	async function loadProviders(force) {
		if (provLoading) return;
		if (provData && !force) return;
		if (force && (openKey || addOpen)) {
			const proceed = window.confirm("刷新会丢弃当前未保存的提供商编辑，继续吗？");
			if (!proceed) return;
			openKey = null;
			addOpen = false;
			addCard.hidden = true;
		}
		provLoading = true;
		provRefresh.disabled = true;
		provRefresh.textContent = "读取中";
		try {
			provData = await ctx.pi.providers();
			renderProviders();
			provNote.hidden = true;
		} catch (e) {
			provNote.textContent = brief(e);
			provNote.hidden = false;
		} finally {
			provLoading = false;
			provRefresh.disabled = false;
			provRefresh.textContent = "刷新";
		}
	}

	// ---------- 3. 行为 ----------
	pane("behavior", "行为");
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

	const enterRow = makeRow("流式中 Enter", "Ctrl/Cmd+Enter 自动走另一种");
	const enterSel = makeSelect(
		readPref("pi-mini.busyEnter", "queue") === "steer" ? "插话发送" : "排队发送",
		(anchor) =>
			openMenu(
				anchor,
				[
					{ key: "queue", label: "排队发送" },
					{ key: "steer", label: "插话发送" },
				],
				readPref("pi-mini.busyEnter", "queue"),
				(item) => {
					try {
						localStorage.setItem("pi-mini.busyEnter", item.key);
					} catch {}
					enterSel.text.textContent = item.label;
				},
			),
	);
	enterRow.ctl.append(enterSel.btn);
	secBehavior.append(enterRow.row);

	// ---------- 4. 统计 ----------
	pane("stats", "统计");
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

	// ---------- 5. 扩展 ----------
	pane("extensions", "扩展");
	const extRefresh = el("button", "settings-refresh", "刷新");
	extRefresh.type = "button";
	extRefresh.title = "重新读取 pi 扩展与技能";
	extRefresh.setAttribute("aria-label", "刷新扩展");
	extRefresh.onclick = () => loadExtensions(true);
	const secExt = section("已加载的扩展", extRefresh);
	const extList = el("div", "settings-exts");
	secExt.append(extList);
	const extNote = el("div", "settings-note");
	extNote.hidden = true;
	secExt.append(extNote);

	// ---------- 5b. 技能与 MCP ----------
	pane("skillmcp", "技能与 MCP");

	const MCP_EXPOSURES = ["codemode", "deferred", "direct", "hidden"];
	const MCP_ADD = { add: true }; // "添加"表单的哨兵键，与服务名（字符串）不会相等
	let skillData = null;
	let skillErr = "";
	let skillLoading = false;
	let mcpData = null;
	let mcpErr = "";
	let mcpLoading = false;
	let mcpOpen = null; // 同时只展开一个编辑器：服务名 / MCP_ADD / null

	// --- 技能（只读）---
	const skillRefresh = el("button", "settings-refresh", "刷新");
	skillRefresh.type = "button";
	skillRefresh.title = "重新读取 ~/.pi/agent/skills";
	skillRefresh.setAttribute("aria-label", "刷新技能");
	skillRefresh.onclick = () => loadSkills(true);
	const secSkills = section("技能", skillRefresh);
	secSkills.append(el("div", "settings-hint", "技能目录由 pi 自动加载；增删目录后重启 pi 生效"));
	const skillList = el("div", "skm-list skm-skills");
	secSkills.append(skillList);
	const skillNote = el("div", "settings-note");
	skillNote.hidden = true;
	secSkills.append(skillNote);

	// --- MCP 服务（可编辑）---
	const mcpRefresh = el("button", "settings-refresh", "刷新");
	mcpRefresh.type = "button";
	mcpRefresh.title = "重新读取 ~/.pi/agent/mcp.json";
	mcpRefresh.setAttribute("aria-label", "刷新 MCP 服务");
	mcpRefresh.onclick = () => loadMcp(true);
	const mcpAddBtn = actionBtn("添加", () => {
		mcpOpen = mcpOpen === MCP_ADD ? null : MCP_ADD;
		renderMcp();
	});
	const mcpActions = el("div", "skm-actions");
	mcpActions.append(mcpRefresh, mcpAddBtn);
	const secMcp = section("MCP 服务", mcpActions);
	const mcpList = el("div", "skm-list");
	secMcp.append(mcpList);
	const mcpNote = el("div", "settings-note");
	mcpNote.hidden = true;
	secMcp.append(mcpNote);
	secMcp.append(el("div", "settings-hint", "写入前会备份 mcp.json；重启 pi 后生效"));

	// args 数组 ↔ 单行文本：含空格的参数加双引号，主进程按同样的引号规则解析回来
	const argsToText = (list) =>
		(Array.isArray(list) ? list : []).map((a) => (/\s/.test(String(a)) ? `"${a}"` : String(a))).join(" ");

	const mcpEditor = (seed, isNew) => {
		const box = el("div", "skm-editor");
		const note = el("div", "settings-note");
		note.hidden = true;
		const name = mkInput("settings-input", "服务名，字母或数字开头，可含 . _ -", seed.name || "");
		const command = mkInput("settings-input", "npx / uvx / 可执行文件路径", seed.command || "");
		const args = mkInput("settings-input", "空格分隔；含空格的参数用双引号包住", argsToText(seed.args));
		const desc = mkInput("settings-input", "说明（可选）", seed.description || "");
		let exposure = MCP_EXPOSURES.includes(seed.exposure) ? seed.exposure : "codemode";
		const expSel = makeSelect(exposure, (anchor) =>
			openMenu(
				anchor,
				MCP_EXPOSURES.map((k) => ({ key: k, label: k })),
				exposure,
				(item) => {
					exposure = item.key;
					expSel.text.textContent = item.key;
				},
			),
		);
		expSel.btn.classList.add("skm-select");
		box.append(
			field("名称", name),
			field("命令", command),
			field("参数", args),
			field("说明", desc),
			field("暴露方式", expSel.btn),
			note,
			saveBtnRow(
				() => {
					mcpOpen = null;
					renderMcp();
				},
				async (btn) => {
					btn.disabled = true;
					btn.textContent = "保存中…";
					note.hidden = true;
					try {
						await ctx.pi.saveMcp({
							originalName: isNew ? "" : seed.name,
							name: name.value.trim(),
							command: command.value.trim(),
							args: args.value.trim(),
							description: desc.value.trim(),
							exposure,
						});
						mcpOpen = null;
						await loadMcp(true);
						toast(isNew ? "MCP 服务已添加，重启 pi 后生效" : "MCP 服务已保存，重启 pi 后生效");
					} catch (e) {
						note.textContent = errText(e);
						note.hidden = false;
						btn.disabled = false;
						btn.textContent = "保存";
					}
				},
			),
		);
		return box;
	};

	function renderSkills() {
		skillList.replaceChildren();
		const items = skillData?.skills || [];
		if (!items.length) {
			const box = el("div", "skm-empty");
			if (!skillData) {
				box.append(el("span", null, skillErr ? "技能目录读取失败" : "读取中…"));
			} else {
				box.append(el("span", null, "~/.pi/agent/skills 下没有找到 SKILL.md"));
				if (skillData.root) box.append(el("span", "skm-empty-path", skillData.root));
			}
			skillList.append(box);
			return;
		}
		for (const s of items) {
			const row = el("div", "skm-skill");
			const main = el("div", "skm-main");
			const name = el("span", "skm-name", s.name || "未命名");
			name.title = s.name || "";
			const desc = el("div", "skm-desc", s.description || "无描述");
			desc.title = s.description || "";
			main.append(name, desc);
			const ctl = el("div", "skm-ctl");
			const openBtn = actionBtn("打开", async () => {
				try {
					const ok = await ctx.pi.openPath(s.path);
					if (ok === false) throw new Error("无法打开 SKILL.md");
				} catch (e) {
					toast(errText(e));
				}
			});
			if (s.path) openBtn.title = s.path;
			ctl.append(openBtn);
			row.append(main, ctl);
			skillList.append(row);
		}
	}

	async function loadSkills(force) {
		if (skillLoading) return;
		if (skillData && !force) return;
		skillLoading = true;
		skillRefresh.disabled = true;
		skillRefresh.textContent = "读取中";
		try {
			const d = await ctx.pi.listSkills();
			skillData = {
				root: String(d?.root || ""),
				skills: Array.isArray(d?.skills) ? d.skills : [],
			};
			skillErr = "";
			skillNote.hidden = true;
		} catch (e) {
			skillErr = brief(e);
			skillNote.textContent = skillErr;
			skillNote.hidden = false;
		} finally {
			skillLoading = false;
			skillRefresh.disabled = false;
			skillRefresh.textContent = "刷新";
		}
		renderSkills();
	}

	function renderMcp() {
		mcpList.replaceChildren();
		const items = mcpData?.servers || [];
		if (!items.length && mcpOpen !== MCP_ADD) {
			const box = el("div", "skm-empty");
			if (!mcpData) box.append(el("span", null, mcpErr ? "mcp.json 读取失败" : "读取中…"));
			else box.append(el("span", null, "mcp.json 里还没有 MCP 服务"));
			mcpList.append(box);
		}
		for (const s of items) {
			const card = el("div", "skm-card");
			const head = el("div", "skm-head");
			const main = el("div", "skm-main");
			const title = el("div", "skm-title");
			title.append(el("span", "skm-name", s.name), el("span", "skm-tag", s.exposure || "codemode"));
			const parts = [s.command || "", ...(Array.isArray(s.args) ? s.args : [])].filter(Boolean);
			const cmdText = parts.join(" ") || "（未设置 command）";
			const cmd = el("div", "skm-cmd", cmdText);
			cmd.title = cmdText;
			const desc = el("div", "skm-desc", s.description || "无描述");
			desc.title = s.description || "";
			main.append(title, cmd, desc);

			const ctl = el("div", "skm-ctl");
			ctl.append(
				actionBtn("编辑", () => {
					mcpOpen = mcpOpen === s.name ? null : s.name;
					renderMcp();
				}),
			);
			const del = el("button", "settings-btn", "删除");
			del.type = "button";
			let armedDel = false;
			let delTimer = 0;
			const disarmDel = () => {
				if (delTimer) clearTimeout(delTimer);
				delTimer = 0;
				armedDel = false;
				del.textContent = "删除";
				del.classList.remove("is-armed");
			};
			del.onclick = async () => {
				if (!armedDel) {
					armedDel = true;
					del.textContent = "确认删除";
					del.classList.add("is-armed");
					delTimer = setTimeout(disarmDel, 3000);
					return;
				}
				disarmDel();
				del.disabled = true;
				try {
					await ctx.pi.deleteMcp(s.name);
					if (mcpOpen === s.name) mcpOpen = null;
					await loadMcp(true);
					toast("MCP 服务已删除");
				} catch (e) {
					del.disabled = false;
					mcpNote.textContent = errText(e);
					mcpNote.hidden = false;
				}
			};
			ctl.append(del);
			head.append(main, ctl);
			card.append(head);
			if (mcpOpen === s.name) card.append(mcpEditor(s, false));
			mcpList.append(card);
		}
		if (mcpOpen === MCP_ADD) {
			const card = el("div", "skm-card skm-add");
			card.append(mcpEditor({ name: "", command: "", args: [], description: "", exposure: "codemode" }, true));
			mcpList.append(card);
		}
	}

	async function loadMcp(force) {
		if (mcpLoading) return;
		if (mcpData && !force) return;
		mcpLoading = true;
		mcpRefresh.disabled = true;
		mcpRefresh.textContent = "读取中";
		try {
			const d = await ctx.pi.listMcp();
			mcpData = {
				path: String(d?.path || ""),
				servers: Array.isArray(d?.servers) ? d.servers : [],
			};
			mcpOpen = null; // 重读后旧编辑器可能指向已改名/删除的服务，不留下半截草稿
			mcpErr = "";
			mcpNote.hidden = true;
		} catch (e) {
			mcpErr = brief(e);
			mcpNote.textContent = mcpErr;
			mcpNote.hidden = false;
		} finally {
			mcpLoading = false;
			mcpRefresh.disabled = false;
			mcpRefresh.textContent = "刷新";
		}
		renderMcp();
	}

	// ---------- 6. 关于 ----------
	pane("about", "关于");
	const secAbout = section("关于");
	const aboutList = el("div", "settings-about");
	secAbout.append(aboutList);

	const SOURCE_LABEL = { extension: "扩展", skill: "技能", prompt: "提示" };
	let extCommands = null;
	let extLoading = false;
	let appInfo = null;

	function renderExtensions() {
		extList.replaceChildren();
		if (appInfo?.piSource === "bundled") {
			extList.append(
				el(
					"div",
					"settings-hint",
					"当前使用内置 pi：不依赖 SDK 的扩展可用；subagent 等需要 @earendil-works/pi-* 的扩展会加载失败。安装全局 pi 后重启 Myna 会自动切换到系统 pi。",
				),
			);
		}
		// 技能在「技能与 MCP」里已经有一份（含 SKILL.md 路径）；这里只留扩展与提示命令，
		// 免得同一批技能在两个页面各看一遍。
		const list = (extCommands || []).filter((c) => c?.source !== "skill");
		if (!list.length) {
			extList.append(el("div", "settings-exts-empty", "没有可用的扩展或提示"));
			return;
		}
		const groups = new Map();
		for (const c of list) {
			const k = SOURCE_LABEL[c.source] || c.source || "其他";
			if (!groups.has(k)) groups.set(k, []);
			groups.get(k).push(c);
		}
		for (const [label, items] of groups) {
			extList.append(el("div", "settings-exts-head", `${label} · ${items.length}`));
			for (const c of items) {
				const row = el("div", "settings-ext");
				const name = el("span", "settings-ext-name", `/${c.name}`);
				name.title = c.name;
				const desc = el("span", "settings-ext-desc", c.description || "无描述");
				desc.title = c.description || "";
				row.append(name, desc);
				extList.append(row);
			}
		}
	}

	async function loadExtensions(force) {
		if (extLoading) return;
		if (extCommands && !force) return;
		extLoading = true;
		extRefresh.disabled = true;
		extRefresh.textContent = "读取中";
		try {
			const res = await ctx.pi.command({ type: "get_commands" });
			extCommands = (res?.commands || [])
				.slice()
				.sort((a, b) => String(a.source).localeCompare(String(b.source)) || String(a.name).localeCompare(String(b.name)));
			renderExtensions();
			extNote.hidden = true;
		} catch (err) {
			extNote.textContent = brief(err);
			extNote.hidden = false;
		} finally {
			extLoading = false;
			extRefresh.disabled = false;
			extRefresh.textContent = "刷新";
		}
	}

	function renderAbout() {
		aboutList.replaceChildren();
		if (!appInfo) {
			aboutList.append(el("div", "settings-exts-empty", "读取中…"));
			return;
		}
		const rows = [
			["版本", `myna ${appInfo.version || "—"}`],
			["Electron", appInfo.electron || "—"],
			["Chromium", appInfo.chrome || "—"],
			["Node", appInfo.node || "—"],
			["pi", appInfo.piVersion ? `pi ${appInfo.piVersion}` : "未找到"],
			["pi 来源", appInfo.piSource === "system" ? "系统安装（扩展兼容）" : appInfo.piSource === "bundled" ? "内置 bundle（基础功能）" : "—"],
			["pi CLI", appInfo.piCli || "—"],
			["配置目录", appInfo.agentRoot || "—"],
			["日志", appInfo.logFile || "—"],
		];
		for (const [k, v] of rows) {
			const row = el("div", "settings-about-row");
			row.append(el("span", "settings-about-k", k));
			const val = el("span", "settings-about-v", v);
			val.title = v;
			row.append(val);
			aboutList.append(row);
		}
		// 诊断入口：路径可直接打开，环境信息一键复制
		const acts = el("div", "settings-about-actions");
		const aboutBtn = (label, fn) => {
			const b = el("button", "settings-btn", label);
			b.type = "button";
			b.onclick = fn;
			return b;
		};
		const openIt = (p) => async () => {
			try {
				const ok = await ctx.pi.openPath?.(p);
				if (ok === false) toast("打不开这个路径");
			} catch {
				toast("打不开这个路径");
			}
		};
		if (appInfo.agentRoot) acts.append(aboutBtn("打开配置目录", openIt(appInfo.agentRoot)));
		if (appInfo.logFile) acts.append(aboutBtn("打开日志", openIt(appInfo.logFile)));
		acts.append(
			aboutBtn("复制诊断信息", async () => {
				const text = [
					`myna ${appInfo.version || "?"}`,
					`Electron ${appInfo.electron || "?"} / Chromium ${appInfo.chrome || "?"} / Node ${appInfo.node || "?"}`,
					`pi ${appInfo.piVersion || "?"} (${appInfo.piSource || "?"})`,
					`pi root ${appInfo.piRoot || "?"}`,
					`cwd ${ctx.state.cwd || "?"}`,
					`session ${ctx.state.sessionFile || "new"}`,
					`pi exit ${ctx.state.lastPiExit == null ? "none" : ctx.state.lastPiExit}`,
					`pi error ${ctx.state.lastPiError || "none"}`,
					`log ${appInfo.logFile || "?"}`,
				].join("\n");
				await copyText(text);
				toast("诊断信息已复制");
			}),
		);
		aboutList.append(acts);
	}

	async function loadAppInfo() {
		if (appInfo) return;
		renderAbout();
		try {
			appInfo = await ctx.pi.appInfo();
			if (appInfo?.version) navFoot.textContent = `myna v${appInfo.version}`;
		} catch {
			appInfo = null;
		}
		renderAbout();
	}

	// ---------- 渲染 ----------
	function renderModes() {
		const find = (m) => MODES.find((x) => x.key === m)?.label ?? (m || "—");
		followSel.text.textContent = find(st.followUp);
		steerSel.text.textContent = find(st.steering);
	}

	function renderSwitches() {
		autoCompactSwitch.setAttribute("aria-checked", st.autoCompaction ? "true" : "false");
	}

	function render() {
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
		toastTimer = setTimeout(closeToast, opts.open ? TOAST_ACTION_MS : TOAST_MS);
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
		return Promise.allSettled([
			loadState(),
			fetchStats(),
			loadExtensions(false),
			loadSkills(false),
			loadMcp(false),
			loadAppInfo(),
			loadProviders(false),
		]);
	}

	function closeDialog() {
		if (overlay.hidden) return;
		closeMenu();
		disarm();
		// 归还焦点前先看焦点是不是还在弹窗里：clone / 保存这类收尾是 await 之后才关闭，
		// 期间用户可能已经点了终端或 composer，这时再 focus(lastFocus) 就是抢焦点。
		// 只认「焦点在弹窗内（或已掉回 body）」，其他情况一律不动。
		const active = document.activeElement;
		const focusInside = !active || active === document.body || overlay.contains(active);
		const back = lastFocus && lastFocus.isConnected ? lastFocus : gear;
		lastFocus = null;
		overlay.hidden = true;
		gear.setAttribute("aria-expanded", "false");
		if (!focusInside) return;
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

	// 让位规则：上面还压着真正的模态层（aria-modal）时，Esc/Tab 都归它。
	// 扩展弹窗（z-index 100）与图片灯箱（z-index 1200）叠在设置（z-index 60）之上，
	// 两处都用 document capture，不让位就会一次 Esc 关两层、两套焦点陷阱互相抢 Tab。
	// 注意：message-fork 的分支弹窗只有 role="dialog"（z-index 90），不在这里，
	// 它与设置遮罩互斥，不构成叠加。
	const modalAbove = () =>
		[...document.querySelectorAll('[aria-modal="true"]')].some(
			(n) => n !== dialog && n.getClientRects().length > 0,
		);

	function onDocKey(e) {
		if (overlay.hidden) return;
		if (modalAbove()) return;
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation(); // 别让 app.js 的全局 Esc 触发 abort
			if (menu) {
				// 焦点可能在菜单项里，先收回到触发按钮再拆菜单，否则掉回 body
				const anchor = menu.anchor;
				closeMenu();
				anchor?.focus?.();
			} else closeDialog();
			return;
		}
		if (e.key !== "Tab") return;
		// 菜单在 body 上，焦点陷阱管不到它，Tab 前先收起，免得留下够不着的孤儿菜单
		closeMenu();
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

	// ---------- 7. 快捷操作（补齐 clone / cycle_* / abort_retry / last_text） ----------
	pane("quick", "快捷操作");
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
			// clone 已切到克隆体：重新拉历史再刷新状态，别把 undefined 交给 renderHistory
			const history = await ctx.pi.command({ type: "get_messages" });
			ctx.reload?.(history?.messages ?? []);
			await ctx.refreshState?.();
			closeDialog();
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

	// 初始分区：通用（不抢焦点，等用户自己 Tab 进导航）
	selectPane("general", false);

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
		if (e.button !== 0) return; // 右键/中键点在遮罩上不该关窗
		if (e.target === overlay) closeDialog();
	});

	document.addEventListener("keydown", onDocKey, true);

	// 首次引导/其他功能可以深链到设置分区
	window.addEventListener("myna:open-settings", (e) => {
		openDialog().then(() => {
			const pane = e?.detail?.pane;
			if (typeof pane === "string" && pane) selectPane(pane, true);
		});
	});

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
		return Promise.allSettled([
			loadState(),
			fetchStats(),
			loadExtensions(false),
			loadSkills(false),
			loadMcp(false),
			loadAppInfo(),
			loadProviders(false),
		]).then(() => true);
	};

	render();
}
