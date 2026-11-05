import {
	addStep,
	emptyMetrics,
	formatClockMs as fmtClock,
	formatTokSpeed as fmtTokSpeed,
	mergeMetrics,
	parseMetrics,
	summarizeMetrics,
} from "./core/metrics.js";
import { imagesFromContent } from "./core/content-images.js";
import { composeMessage, splitAttachments, toRpcImages } from "./core/rpc-attachments.js";
import {
	applyHistoryToolResult,
	assistantTextFromContent,
	assistantFromHistory,
	createAssistantMessage,
} from "./core/assistant-message.js";
import {
	applyAssistantEventToTurn,
	beginTurn,
	createTurnState,
	currentAssistantMessage,
	finishAssistantMessageInTurn,
	noteAssistantMessage,
	noteToolStart,
	requestAbort,
	revealAllAssistantTextInTurn,
	revealAssistantTextInTurn,
	resetTurn,
	settleTurn,
} from "./core/turn-model.js";
import { initTheme, isDark } from "./theme.js";

initTheme();

import { buildSessionGroups } from "./core/session-groups.js";

const $ = (id) => document.getElementById(id);
const stream = $("stream");
const input = $("input");
const sendBtn = $("send");
const menu = $("menu");
let menuBack = null;

const state = {
	cwd: "",
	sessions: [],
	models: [],
	model: null,
	thinkingLevel: null,
	thinkingLevels: [],
	sessionFile: null,
	sessionName: null,
	streaming: false,
	collapsed: new Set(),
	lastRenderedCwd: "", // 切工作区后给新打开的分组放一次展开动画
	archived: new Set(),
	archiveFilter: "hide",
	archivedOpen: false,
	names: {},
	pinned: new Set(),
	searchResults: [],
	searchQuery: "",
	searchBusy: false,
	searchTruncated: false,
	searchSeq: 0,
	searchTimer: 0,
	projects: [],
	projectsSeeded: false,
	live: null, // 正在流式的 assistant 行
	liveText: null, // 流式 markdown 增量渲染器（append/flush + caret）
	revealRaf: 0,
	revealTick: 0,
	liveTps: null, // 实时吐字仪表：滑动窗口 + EMA + 迷你曲线
	runTps: 0, // 本轮平均 tok/s，结算条用
	runSpeed: { tokens: 0, ms: 0 }, // 多段 assistant 回合的累计解码时间/ token
	liveThink: null, // 流式思考块（thinking_delta）
	liveTokens: 0, // 已接收文本的增量 token 估算
	tpsTimer: 0,
	runClock: null, // 运行中状态行（思考中/生成中 + 已用时间，DSH RunningStatus）
	aborted: false, // 用户主动中断：settle 时画“已停止”标记（DSH 的 stopped tag）
	abortRow: null, // 被中断的那一行；只标自己，别标到上一条历史回答
	pendingUserEcho: "", // submit 已乐观插入的用户消息，等 pi 回显时跳过
	lastTurnAborted: false, // 上一轮是用户中断：队列不要自动接力
	lastPiExit: null, // 最近一次 pi 子进程退出码，供诊断复制
	lastPiError: "", // 最近一条已脱敏的 pi stderr 摘要
	switching: false, // 正在切换会话/工作区：期间禁止发送，避免发错会话
	paintingHistory: false, // 历史批量渲染：抑制每条消息各自 follow 造成的反复滚动
	sessionScroll: new Map(), // 每个会话的阅读位置：切回来别总是跳到底部
	metrics: emptyMetrics(), // 会话级吐字统计（localStorage，按 sessionFile 分桶）
	metricsKey: "",
	newBucketEpoch: -1, // _new 桶属于哪一次会话切换（防串桶）
	sessionEpoch: 0,
	streamSeq: 0, // 流式状态版本号：过期的 get_state 回包不许覆盖它
	turn: createTurnState(),
	turnRows: [], // 本轮实时渲染出的 assistant 行，供整轮过程折叠使用
	tools: new Map(),
};

// 图片附件桥：features/attachments.js 覆盖 get/clear
const attachments = { get: () => [], clear: () => {} };

const emptyAssistant = createAssistantMessage();
function currentAssistant() {
	return currentAssistantMessage(state.turn) || emptyAssistant;
}

// ---------- 文本工具 ----------
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// 吐字速度估算（对齐 pi-web MessageView）：CJK 约 1 token/字，其余约 4 字符/token
const CJK_RE = /[\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff\u{20000}-\u{2fa1f}\uac00-\ud7af]/u;
function estimateTokens(text) {
	let cjk = 0;
	let rest = 0;
	for (const ch of text) {
		if (CJK_RE.test(ch)) cjk++;
		else rest++;
	}
	return cjk + rest / 4;
}

// 统一记录输出 token：思考与正文都算 output（pi 的 usage.output 也包含 reasoning）。
// firstToken 必须从第一段思考/正文开始，否则“想了很久、正文很快”会被算成 781 tok/s。
function markOutputTokens(delta) {
	const n = estimateTokens(delta || "");
	if (!n) return;
	state.liveTokens += n;
	const st = state.liveTps;
	if (!st) return;
	const now = performance.now();
	if (!st.start) st.start = st.createdAt || now;
	if (!st.firstToken) {
		st.firstToken = now;
		if (st.text) st.text.textContent = "生成中…";
	}
	st.marks.push({ t: now, n });
}

const fmtTokens = (n) => Math.round(n).toLocaleString("en-US");

// 极简 markdown：段落、列表、标题、代码块、行内代码/加粗。不做完整解析，够用即可。
// 相对/绝对/Windows 盘符路径（对齐 DSH isExplicitFilePath）
function isExplicitFilePath(value) {
	return /^(?:[\/]|\.{1,2}[\/]|[a-z]:[\/])/i.test(value);
}

// markdown 链接目标解析（对齐 DSH parseFileLink，简化：不处理行号定位）
function parseFileLink(value) {
	const hash = value.indexOf("#");
	const destination = hash < 0 ? value : value.slice(0, hash);
	if (destination.includes("?")) return undefined;
	let path;
	try {
		path = decodeURIComponent(destination);
	} catch {
		return undefined;
	}
	if (!path || /[\u0000-\u001f\u007f]/.test(path)) return undefined;
	if (!isExplicitFilePath(path) && URL.canParse(path)) return undefined;
	const suffix = hash < 0 ? /:(\d+)(?::\d+|-\d+)?$/.exec(destination) : null;
	if (suffix) path = path.slice(0, -suffix[0].length);
	return path ? { path } : undefined;
}

const TRAILING = /[.,;:!?，。；：！？）】》”"'`>]+$/;

// 单趟合并，避免盘符路径被规则二次包裹
const BARE_PATH =
	/(?<![\w:/\@-])(?:[A-Za-z]:[\/][^\s<>"'`，。；：！？）】》]*|(?:\.{1,2}[\/])?(?:[\w.@-]+[\/])+[\w.@-]+\.[A-Za-z0-9]{1,10}(?![\/\w]))/g;

function wrapPath(raw) {
	const path = raw.replace(TRAILING, "");
	if (path.length < 3 || /^https?:/i.test(path)) return raw;
	const tail = raw.slice(path.length);
	return `<span class="flink" data-path="${path}">${path}</span>${tail}`;
}

function linkifyPaths(html) {
	return html.replace(BARE_PATH, wrapPath);
}

// 行内渲染：代码、链接、裸路径。粗体在外面先抽成占位符再还原，
// 否则 `**a `code` b**` 会被行内代码切断，双星号原样漏出来。
const inlineCore = (s) =>
	esc(s)
		.split(/(`[^`\n]+`)/)
		.map((part) => {
			if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
				return `<code>${part.slice(1, -1)}</code>`;
			}
			// 先把 markdown 链接抽成占位符，避免链接内的路径被二次识别
			const slots = [];
			let text = part.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, dest) => {
				const file = parseFileLink(dest);
				let html;
				if (file) html = `<span class="flink" data-path="${file.path}">${label}</span>`;
				else if (/^https?:\/\//i.test(dest)) html = `<span class="xlink" data-url="${dest}">${label}</span>`;
				else return m;
				slots.push(html);
				return `%%SLOT${slots.length - 1}%%`;
			});
			text = linkifyPaths(text);
			return text.replace(/%%SLOT(\d+)%%/g, (_m, i) => slots[Number(i)] ?? "");
		})
		.join("");

const BOLD_SLOT = /\u0000B(\d+)\u0000/g;

const inlineMd = (s) => {
	const bolds = [];
	const withSlots = String(s).replace(/\*\*([\s\S]+?)\*\*/g, (_m, inner) => {
		bolds.push(inner);
		return `\u0000B${bolds.length - 1}\u0000`;
	});
	if (!bolds.length) return inlineCore(withSlots);
	return inlineCore(withSlots).replace(BOLD_SLOT, (_m, i) => `<strong>${inlineCore(bolds[Number(i)])}</strong>`);
};

function splitTableRow(line) {
	let s = line.trim();
	if (s.startsWith("|")) s = s.slice(1);
	if (s.endsWith("|")) s = s.slice(0, -1);
	return s
		.replace(/\\\|/g, "\u0001")
		.split("|")
		.map((c) => c.replace(/\u0001/g, "|").trim());
}

function isTableSeparator(line) {
	const s = line.trim();
	if (!s.includes("-") || !s.includes("|")) return false;
	const cells = splitTableRow(s);
	return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));
}

function tableAlign(spec) {
	if (spec.startsWith(":") && spec.endsWith(":")) return "center";
	if (spec.endsWith(":")) return "right";
	if (spec.startsWith(":")) return "left";
	return "";
}

function renderTable(header, specs, rows) {
	const cell = (tag, text, align) => `<${tag}${align ? ` style="text-align:${align}"` : ""}>${inlineMd(text ?? "")}</${tag}>`;
	// 列数以表头与各行最大值为准，避免数据行比表头长时丢列
	const cols = Math.max(header.length, ...rows.map((r) => r.length), 0);
	let html = `<div class="table-wrap"><table><thead><tr>`;
	html += Array.from({ length: cols }, (_, i) => cell("th", header[i] ?? "", tableAlign(specs[i] || ""))).join("");
	html += `</tr></thead>`;
	if (rows.length) {
		html += `<tbody>`;
		for (const row of rows) {
			html += `<tr>${Array.from({ length: cols }, (_, i) => cell("td", row[i] ?? "", tableAlign(specs[i] || ""))).join("")}</tr>`;
		}
		html += `</tbody>`;
	}
	return `${html}</table></div>`;
}

function renderFragment(part) {
	const lines = part.split("\n");
	let html = "";
	let para = [];
	let list = null;
	const flushPara = () => {
		if (para.length) {
			html += `<p>${para.map(inlineMd).join("<br>")}</p>`;
			para = [];
		}
	};
	const flushList = () => {
		if (list) {
			html += `<${list.tag}>${list.items.map((t) => `<li>${inlineMd(t)}</li>`).join("")}</${list.tag}>`;
			list = null;
		}
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].replace(/\s+$/, "");
		if (!line.trim()) {
			flushPara();
			flushList();
			continue;
		}
		// 分隔线 --- / *** / ___（DSH MarkdownText 的 hr）
		if (/^ {0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line)) {
			flushPara();
			flushList();
			html += "<hr>";
			continue;
		}
		// 引用 "> ..."（DSH MarkdownText 的 blockquote）：连续引用行合成一段
		const quote = line.match(/^ {0,3}>\s?(.*)$/);
		if (quote) {
			flushPara();
			flushList();
			const quoted = [quote[1]];
			while (i + 1 < lines.length) {
				const next = lines[i + 1].match(/^ {0,3}>\s?(.*)$/);
				if (!next) break;
				quoted.push(next[1]);
				i++;
			}
			html += `<blockquote>${quoted.map(inlineMd).join("<br>")}</blockquote>`;
			continue;
		}
		// GFM 表格：表头行 + 分隔行（| --- | :---: |）
		if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
			flushPara();
			flushList();
			const header = splitTableRow(line);
			const specs = splitTableRow(lines[i + 1]);
			const rows = [];
			let j = i + 2;
			while (j < lines.length && lines[j].trim() && lines[j].includes("|")) {
				rows.push(splitTableRow(lines[j]));
				j++;
			}
			html += renderTable(header, specs, rows);
			i = j - 1;
			continue;
		}
		const h = line.match(/^(#{1,6})\s+(.*)$/);
		const ul = line.match(/^\s*[-*]\s+(.*)$/);
		const ol = line.match(/^\s*\d+\.\s+(.*)$/);
		if (h) {
			flushPara();
			flushList();
			const lv = h[1].length;
			html += `<h${lv} class="h">${inlineMd(h[2])}</h${lv}>`;
			continue;
		}
		if (ul || ol) {
			flushPara();
			const tag = ul ? "ul" : "ol";
			if (!list || list.tag !== tag) {
				flushList();
				list = { tag, items: [] };
			}
			list.items.push((ul || ol)[1]);
			continue;
		}
		flushList();
		para.push(line);
	}
	flushPara();
	flushList();
	return html;
}

function md(src) {
	const parts = String(src).split(/```/);
	let out = "";
	for (let i = 0; i < parts.length; i++) {
		// 围栏未闭合时（parts 数为偶），最后一段是正文而不是代码
		if (i % 2 === 1 && !(i === parts.length - 1 && parts.length % 2 === 0)) {
			const nl = parts[i].indexOf("\n");
			const langRaw = nl > -1 ? parts[i].slice(0, nl).trim() : "";
			const body = nl > -1 ? parts[i].slice(nl + 1) : parts[i];
			const lang = esc((langRaw.split(/\s+/)[0] || "").toLowerCase());
			out += `<pre data-lang="${lang}"><code>${esc(body.replace(/\n+$/, ""))}</code></pre>`;
		} else {
			out += renderFragment(parts[i]);
		}
	}
	return out;
}

function blockText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("");
}

// ---------- 思考（reasoning）块：照 DSH ReasoningRow/DisclosureRow ----------
// 折叠时一行 24px：图标 + 「思考」+ 2px 点 + 首行摘要；点整行展开完整 markdown。
const THINK_ICON =
	'<svg class="think-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M10.2854 5.71481C12.9673 8.39663 14.1182 11.5938 12.8562 12.8559C11.5942 14.1179 8.39706 12.9669 5.71518 10.2851C3.03333 7.60323 1.88236 4.40608 3.14441 3.14403C4.40644 1.882 7.6036 3.03297 10.2854 5.71481Z"/><path d="M10.2854 10.2851C7.6036 12.9669 4.40644 14.1179 3.14441 12.8559C1.88236 11.5938 3.03333 8.39663 5.71518 5.71481C8.39706 3.03297 11.5942 1.882 12.8562 3.14403C14.1182 4.40608 12.9673 7.60323 10.2854 10.2851Z"/><path d="M8.86291 8.0002C8.86291 8.47549 8.47762 8.86087 8.00224 8.86087C7.52694 8.86087 7.1416 8.47549 7.1416 8.0002C7.1416 7.52485 7.52694 7.13953 8.00224 7.13953C8.47762 7.13953 8.86291 7.52485 8.86291 8.0002Z" fill="currentColor" stroke="none"/></svg>';
const THINK_CHEV =
	'<svg class="think-chev" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 6.2 8 10.2 12 6.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function thinkText(message) {
	const blocks = Array.isArray(message?.content) ? message.content : [];
	return blocks
		.filter((b) => b.type === "thinking" && b.thinking)
		.map((b) => b.thinking)
		.join("\n\n");
}

function firstLineOf(text) {
	const i = text.indexOf("\n");
	return i === -1 ? text : text.slice(0, i);
}

// 流式中取「最后一个已完成段落的首行」，避免半句话疯狂抖动（DSH latestCompletedParagraphFirstLine）
function latestParagraphLine(text) {
	let out = "";
	let start = 0;
	const sep = /\r?\n(?:[\t ]*\r?\n)+/g;
	while (true) {
		const next = sep.exec(text);
		const paraEnd = next === null ? text.length : next.index + next[0].indexOf("\n");
		const nl = text.indexOf("\n", start);
		if (nl !== -1 && nl <= paraEnd) {
			const cand = text.slice(start, nl).trim();
			if (cand) out = cand;
		}
		if (next === null) return out;
		start = next.index + next[0].length;
	}
}

function thinkSummary(text, running) {
	return (running ? latestParagraphLine(text) : firstLineOf(text)).replaceAll("**", "");
}

function makeThinkBlock(text, running = false) {
	const wrap = document.createElement("div");
	wrap.className = "think";
	wrap.dataset.open = "0";
	wrap.dataset.state = running ? "running" : "ok";
	const row = document.createElement("div");
	row.className = "think-row";
	row.setAttribute("role", "button");
	row.tabIndex = 0;
	row.setAttribute("aria-expanded", "false");
	const lead = document.createElement("span");
	lead.className = "think-lead";
	lead.innerHTML = THINK_ICON + THINK_CHEV;
	const title = document.createElement("span");
	title.className = "think-title";
	title.textContent = "思考";
	const dot = document.createElement("span");
	dot.className = "think-dot";
	dot.setAttribute("aria-hidden", "true");
	const summary = document.createElement("span");
	summary.className = "think-summary";
	const body = document.createElement("div");
	body.className = "think-body";
	body.hidden = true;
	row.append(lead, title, dot, summary);
	wrap.append(row, body);

	let raw = text || "";
	let raf = 0;
	const paintBody = () => {
		raf = 0;
		body.innerHTML = md(raw);
	};
	const render = () => {
		summary.textContent = thinkSummary(raw, wrap.dataset.state === "running");
		if (!body.hidden && !raf) raf = requestAnimationFrame(paintBody);
	};
	const setOpen = (open) => {
		wrap.dataset.open = open ? "1" : "0";
		row.setAttribute("aria-expanded", String(open));
		body.hidden = !open;
		if (open) paintBody();
	};
	const toggle = () => setOpen(wrap.dataset.open !== "1");
	row.addEventListener("click", toggle);
	row.addEventListener("keydown", (e) => {
		if (e.key !== "Enter" && e.key !== " ") return;
		e.preventDefault();
		toggle();
	});
	render();
	return {
		wrap,
		row,
		summary,
		body,
		setOpen,
		setText(next, isRunning = wrap.dataset.state === "running") {
			raw = next || "";
			wrap.dataset.state = isRunning ? "running" : "ok";
			render();
		},
		finish(next) {
			raw = next ?? raw;
			wrap.dataset.state = "ok";
			render();
			if (raf) cancelAnimationFrame(raf);
			paintBody();
		},
	};
}

function ensureLiveThink() {
	if (!state.live) return null;
	if (state.liveThink) return state.liveThink;
	const th = makeThinkBlock("", true);
	state.live.row.insertBefore(th.wrap, state.live.body);
	state.liveThink = th;
	return th;
}

// ---------- 滚动：粘底策略 + 手动回底 ----------
let stickBottom = true;

function follow() {
	if (state.paintingHistory) return;
	if (stickBottom) stream.scrollTop = stream.scrollHeight;
}

// 切换会话前记住阅读位置；切回来时恢复，而不是永远跳到底部
function rememberScroll(key) {
	if (!key) return;
	const max = stream.scrollHeight - stream.clientHeight;
	const atBottom = stickBottom || max - stream.scrollTop < 24;
	state.sessionScroll.set(key, atBottom ? { bottom: true } : { top: stream.scrollTop });
}

function restoreScroll(key) {
	const mem = key ? state.sessionScroll.get(key) : null;
	if (!mem || mem.bottom) {
		stickBottom = true;
		follow();
		return;
	}
	stickBottom = false;
	stream.scrollTop = Math.min(mem.top, Math.max(0, stream.scrollHeight - stream.clientHeight));
	stream.dispatchEvent(new Event("scroll"));
}

function initScroll() {
	const jump = $("jump");
	const composer = $("composer");
	const syncJumpPosition = () => {
		if (!composer || !jump) return;
		jump.style.bottom = `${Math.max(12, composer.offsetHeight + 10)}px`;
	};
	syncJumpPosition();
	window.addEventListener("resize", syncJumpPosition);
	if (typeof ResizeObserver === "function") new ResizeObserver(syncJumpPosition).observe(composer);
	stream.addEventListener("scroll", () => {
		const gap = stream.scrollHeight - stream.scrollTop - stream.clientHeight;
		stickBottom = gap < 48;
		jump.hidden = stickBottom;
	});
	jump.onclick = () => {
		stickBottom = true;
		jump.hidden = true;
		stream.scrollTop = stream.scrollHeight;
	};
	// 回答里的路径变成可点链接：优先在右栏预览，工作区外再交给系统程序
	stream.addEventListener("click", async (e) => {
		const ext = e.target.closest(".xlink");
		if (ext && ext.dataset.url) {
			e.preventDefault();
			if (/^https?:\/\//i.test(ext.dataset.url)) window.pi.openExternal(ext.dataset.url);
			return;
		}
		const link = e.target.closest(".flink");
		if (!link) return;
		e.preventDefault();
		const path = link.dataset.path;
		let opened = false;
		try {
			opened = !!(await ctx.rightPanel?.preview?.(path));
		} catch {}
		if (!opened) window.pi.openPath(path);
	});
}

function clearStream() {
	stopReveal();
	state.liveThink = null;
	state.aborted = false;
	state.abortRow = null;
	state.pendingUserEcho = "";
	if (state.tpsTimer) clearInterval(state.tpsTimer);
	state.tpsTimer = 0;
	state.runClock = null;
	state.liveTps = null;
	state.runTps = 0;
	state.runSpeed = { tokens: 0, ms: 0 };
	state.liveTokens = 0;
	stream.innerHTML = "";
	state.live = null;
	state.liveText = null;
	state.tools.clear();
	state.turn = resetTurn();
	state.turnRows = [];
}

function emptyHint(text = "选个目录，说句话。") {
	const wrap = document.createElement("div");
	wrap.className = "empty";
	if (text === "选个目录，说句话。") {
		const title = document.createElement("p");
		title.className = "empty-title";
		title.textContent = "我们要做什么？";
		wrap.append(title);
	}
	const sub = document.createElement("p");
	sub.className = "empty-sub";
	sub.textContent = text;
	wrap.append(sub);
	stream.append(wrap);
	return wrap;
}

// ---------- 渲染 ----------
// 图片 src 统一出口：历史块可能是 {url} / {data,mimeType} / 已是 data URL
function normalizeSrc(item) {
	const url = String(item?.url || "");
	if (url) return url;
	const data = String(item?.data || "");
	if (!data) return "";
	if (data.startsWith("data:")) return data;
	return `data:${item?.mimeType || item?.mime_type || "image/png"};base64,${data}`;
}

function addUser(text, images = []) {
	stream.querySelector(".empty")?.remove();
	const row = document.createElement("div");
	row.className = "row mine";
	const bubble = document.createElement("div");
	bubble.className = "user";
	bubble.textContent = text;
	if (images.length) {
		const box = document.createElement("div");
		box.className = "user-imgs";
		for (const item of images) {
			if (item.kind === "doc") {
				// 文档以文件名胶囊呈现，正文已经拼进 message
				const chip = document.createElement("span");
				chip.className = "user-doc";
				chip.textContent = item.name || "文档";
				chip.title = `${item.name || "文档"}${item.truncated ? "（内容已截断）" : ""}`;
				box.append(chip);
				continue;
			}
			const img = document.createElement("img");
			img.className = "tool-img";
			img.src = normalizeSrc(item);
			img.alt = item.name || "图片";
			// 加载失败留痕：不静默破图，便于定位是哪一类来源
			img.addEventListener("error", () => {
				img.dataset.broken = "1";
				console.warn("[image] 加载失败", item.name || "", String(img.getAttribute("src") || "").slice(0, 40));
			});
			box.append(img);
		}
		bubble.append(box);
	}
	row.append(bubble);
	stream.append(row);
	follow();
	return row;
}


function addAssistantRow() {
	// 上一条消息还没吐完就来了新消息：先收尾，别丢尾巴
	if (state.live && currentAssistant().finalMessage) finalizeAssistant(currentAssistant().finalMessage);
	stopReveal();
	// 一轮里只挂一行运行状态：新行接手，旧行先收摊，别两行同时闪
	settleRunStatus();
	// 上一段的最终读数也让位给新行，避免一轮里并排两个仪表（结算时会被清掉）
	for (const old of stream.querySelectorAll(".row.assistant > .meta.settled")) old.hidden = true;
	const row = document.createElement("div");
	row.className = "row assistant fresh";
	// 运行中状态行（DSH ChatView .running / RunningStatus.tsx）：先「思考中」，首 token 后「生成中」+ 已用时间
	const meta = document.createElement("div");
	meta.className = "meta running";
	const runState = document.createElement("span");
	runState.className = "run-state";
	runState.setAttribute("role", "status");
	runState.setAttribute("aria-live", "polite");
	const runText = document.createElement("span");
	runText.className = "run-text";
	runText.textContent = "思考中…";
	const runClock = document.createElement("span");
	runClock.className = "run-clock";
	runClock.setAttribute("aria-hidden", "true");
	runClock.textContent = "00:00:00";
	runState.append(runText, runClock);
	const gauge = createTpsGauge();
	meta.append(runState, gauge.gauge, gauge.card);
	const body = document.createElement("div");
	body.className = "body";
	row.append(meta, body);
	stream.append(row);
	state.turnRows.push(row);
	state.live = { row, body };
	if (state.tpsTimer) clearInterval(state.tpsTimer);
	state.liveTps = {
		...gauge,
		text: runText,
		start: 0,
		createdAt: performance.now(),
		marks: [],
		samples: [],
		ema: 0,
		peak: 0,
	};
	// 用时按整轮算（DSH RunningStatus 的 turn startTime），工具阶段换行也不归零
	state.runClock = { text: runText, clock: runClock, start: state.turn.startedAt || performance.now() };
	state.liveTokens = 0;
	state.tpsTimer = setInterval(tpsTick, 100);
	state.liveText = createLiveMarkdown(body);
	follow();
	return row;
}

// 运行中状态行收尾（DSH 的 running 槽只在运行期存在）：清计时器、去掉状态文字。
// 最后一行的仪表保留最终读数，回答结束后仍能点开看本轮/会话统计；
// 更早回合的仪表在下一轮结算时清掉，避免一屏徽标。
function settleRunStatus() {
	if (state.tpsTimer) clearInterval(state.tpsTimer);
	state.tpsTimer = 0;
	state.runClock = null;
	const st = state.liveTps;
	state.liveTps = null;
	for (const old of stream.querySelectorAll(".row.assistant > .meta.settled")) {
		old.querySelector(":scope > .tps-gauge")?.remove();
		old.querySelector(":scope > .tps-card")?.remove();
		old.classList.remove("settled");
		old.hidden = true;
	}
	const metas = [...stream.querySelectorAll(".row.assistant > .meta.running")];
	metas.forEach((meta, i) => {
		meta.querySelector(":scope > .run-state")?.remove();
		const gauge = meta.querySelector(":scope > .tps-gauge");
		const hasReading = st && (st.firstToken || st.done);
		if (i === metas.length - 1 && gauge && hasReading) {
			if (state.runTps > 0) {
				const nowEl = gauge.querySelector(".tps-now");
				if (nowEl) nowEl.textContent = fmtTokSpeed(state.runTps);
			}
			gauge.classList.remove("idle");
			meta.classList.remove("running");
			meta.classList.add("settled");
			meta.hidden = false;
			return;
		}
		meta.querySelector(":scope > .tps-card")?.remove();
		gauge?.remove();
		meta.classList.remove("running");
		meta.hidden = true;
	});
}

// 工具卡落到最新一条 assistant 的正文里；正文还在吐字/等重写时先留在
// state.tools，定稿后把尚未挂载的卡片补回去，避免 innerHTML 覆盖工具卡。
function mountTool(el) {
	if (state.live && (!currentAssistant().finalMessage || currentAssistant().pendingText.length)) return;
	let body = [...stream.querySelectorAll(".row.assistant")].pop()?.querySelector(":scope > .body");
	if (!body) {
		const row = document.createElement("div");
		row.className = "row assistant";
		body = document.createElement("div");
		body.className = "body";
		row.append(body);
		stream.append(row);
	}
	body.append(el);
}

function flushUnattachedTools(body) {
	if (!body) return;
	for (const [id, el] of state.tools) {
		if (el.isConnected) continue;
		body.append(el);
		if (!el.classList.contains("running")) state.tools.delete(id);
	}
}

// ---- 流式 markdown：冻结已完成前缀，只重渲染尾部 ----
// 早期实现按空行切块，但模型吐一整个长段落/长代码块时，尾部会无限增长，
// 每 80ms 重解析全文就是 O(n²)。这里给尾部设上限：超过就按换行冻结。
const LIVE_TAIL_MAX = 3000;

function createLiveMarkdown(body) {
	const frozen = document.createElement("div");
	frozen.className = "live-frozen";
	const tail = document.createElement("div");
	tail.className = "live-tail";
	body.append(frozen, tail);
	const caret = document.createElement("span");
	caret.className = "caret";
	let text = "";
	let frozenChars = 0;
	let lastPaint = 0;
	let timer = 0;
	const paint = () => {
		if (text.length - frozenChars > LIVE_TAIL_MAX) {
			const target = text.length - LIVE_TAIL_MAX;
			// 退到最近换行，保证尾部不会超过上限；段落被临时切开没关系，结算时会按终稿重排
			let cut = text.lastIndexOf("\n", target);
			if (cut <= frozenChars) cut = target;
			const chunk = text.slice(frozenChars, cut);
			if (chunk) {
				const block = document.createElement("div");
				block.className = "live-block";
				block.innerHTML = md(chunk);
				frozen.append(block);
			}
			frozenChars = cut;
		}
		const tailText = text.slice(frozenChars);
		tail.innerHTML = tailText ? md(tailText) : "";
		// 光标跟在最后一个字符后面，而不是另起一行
		const last = tail.lastElementChild;
		if (last && last.tagName !== "PRE") last.append(caret);
		else tail.append(caret);
	};
	// 尾部每个字符都变，但 md() 不必每帧跑；80ms 一次肉眼仍是连续吐字
	const schedule = () => {
		const now = performance.now();
		if (now - lastPaint >= 80) {
			lastPaint = now;
			paint();
			return;
		}
		if (timer) return;
		timer = setTimeout(() => {
			timer = 0;
			lastPaint = performance.now();
			paint();
		}, 80);
	};
	return {
		append(chunk) {
			text += chunk;
			schedule();
		},
		flush() {
			if (timer) clearTimeout(timer);
			timer = 0;
			lastPaint = performance.now();
			paint();
		},
		caret,
	};
}

// ---- pi-web 式吐字：delta 先进缓冲，再按稳定速率逐帧吐出 ----
function stopReveal() {
	if (state.revealRaf) cancelAnimationFrame(state.revealRaf);
	state.revealRaf = 0;
	state.revealTick = 0;
}

function scheduleReveal() {
	if (state.revealRaf || !state.liveText) return;
	state.revealTick = performance.now();
	state.revealRaf = requestAnimationFrame(revealStep);
}

function revealStep(now) {
	state.revealRaf = 0;
	if (!state.liveText) {
		return;
	}
	const dt = Math.min(64, Math.max(8, now - (state.revealTick || now)));
	state.revealTick = now;
	const backlog = currentAssistant().pendingText.length;
	if (backlog) {
		// 整段约 2.6s 吐完；积压多时按比例加速，不会越落越远
		const rate = Math.max(45, currentAssistant().text.length / 2.6);
		let n = Math.max(1, Math.round((rate * dt) / 1000));
		if (backlog > 240) n = Math.max(n, Math.ceil(backlog / 6));
		n = Math.min(n, backlog);
		const chunk = currentAssistant().pendingText.slice(0, n);
		state.liveText.append(chunk);
		state.turn = revealAssistantTextInTurn(state.turn, chunk);
		follow();
	}
	if (currentAssistant().pendingText.length) {
		state.revealRaf = requestAnimationFrame(revealStep);
	} else if (currentAssistant().finalMessage) {
		finalizeAssistant(currentAssistant().finalMessage);
	}
}

// 吐字仪表：数字 + 迷你曲线 + 点击展开的读数卡
// 会话级统计：按 sessionFile 分桶存 localStorage，重启后仍在
const METRICS_PREFIX = "pi-mini.metrics.";
const metricsKeyOf = (file) => `${METRICS_PREFIX}${file || "_new"}`;

function readMetricsStore(key) {
	try {
		return parseMetrics(localStorage.getItem(key) || "");
	} catch {
		return emptyMetrics();
	}
}

function writeMetricsStore(key, metrics) {
	try {
		localStorage.setItem(key, JSON.stringify(metrics));
		return true;
	} catch {
		// 配额满：返回失败，调用方不能删源桶，否则数据直接丢
		return false;
	}
}

function refreshSessionMetrics() {
	const key = metricsKeyOf(state.sessionFile);
	if (state.metricsKey === key) return;
	const oldKey = state.metricsKey;
	state.metricsKey = key;
	// 新会话第一轮结束前 sessionFile 还是 null：把 _new 的统计并进正式文件。
	// 只有 _new 仍属于「当前这次会话」时才迁移；切走后才回包的 get_state 属于别的会话，
	// 迁过去就会污染别人的均速/首字。
	if (oldKey && oldKey === metricsKeyOf(null) && key !== oldKey) {
		const carried = readMetricsStore(oldKey);
		const owned = state.newBucketEpoch === state.sessionEpoch;
		if (carried.steps > 0 && owned) {
			state.metrics = mergeMetrics(readMetricsStore(key), carried);
			if (writeMetricsStore(key, state.metrics)) {
				try {
					localStorage.removeItem(oldKey);
				} catch {}
			}
			return;
		}
		try {
			localStorage.removeItem(oldKey);
		} catch {}
		state.newBucketEpoch = -1;
	}
	state.metrics = readMetricsStore(key);
}

function recordStepMetrics(step) {
	const key = metricsKeyOf(state.sessionFile);
	if (!state.sessionFile) {
		// _new 是全局单桶：换了会话就先把旧内容丢掉，别并进新会话
		if (state.newBucketEpoch !== state.sessionEpoch) {
			try {
				localStorage.removeItem(key);
			} catch {}
			state.newBucketEpoch = state.sessionEpoch;
		}
	}
	const base = state.metricsKey === key ? state.metrics : readMetricsStore(key);
	const next = addStep(base, step);
	if (next.steps === base.steps) return;
	state.metrics = next;
	state.metricsKey = key;
	writeMetricsStore(key, next);
}

function sparkPoints(samples, peak) {
	const n = samples.length;
	if (!n) return "";
	// 量程留一个下限，低速时曲线不会顶满整格
	const max = Math.max(20, peak);
	return samples
		.map((value, i) => {
			const x = n <= 1 ? 0 : (i / (n - 1)) * 56;
			const y = 15 - Math.max(0, Math.min(1, value / max)) * 13;
			return `${x.toFixed(1)},${y.toFixed(1)}`;
		})
		.join(" ");
}

function createTpsGauge() {
	const NS = "http://www.w3.org/2000/svg";
	const gauge = document.createElement("button");
	gauge.type = "button";
	gauge.className = "tps-gauge";
	gauge.hidden = true;
	gauge.title = "实时吐字速度（点击查看详情）";
	gauge.setAttribute("aria-label", "实时吐字速度");
	gauge.setAttribute("aria-expanded", "false");
	const svg = document.createElementNS(NS, "svg");
	svg.setAttribute("viewBox", "0 0 56 16");
	svg.setAttribute("class", "tps-spark");
	svg.setAttribute("aria-hidden", "true");
	const line = document.createElementNS(NS, "polyline");
	line.setAttribute("fill", "none");
	line.setAttribute("stroke", "currentColor");
	line.setAttribute("stroke-width", "1.2");
	line.setAttribute("stroke-linecap", "round");
	line.setAttribute("stroke-linejoin", "round");
	svg.append(line);
	const nowEl = document.createElement("span");
	nowEl.className = "tps-now";
	nowEl.textContent = "0";
	const unit = document.createElement("span");
	unit.className = "tps-unit";
	unit.textContent = "tok/s";
	gauge.append(svg, nowEl, unit);

	const card = document.createElement("div");
	card.className = "tps-card";
	card.hidden = true;
	const refs = {};
	const addRow = (key, label) => {
		const row = document.createElement("div");
		row.className = "tps-line";
		const k = document.createElement("span");
		k.className = "tps-k";
		k.textContent = label;
		const v = document.createElement("span");
		v.className = "tps-v";
		v.textContent = "—";
		row.append(k, v);
		card.append(row);
		refs[key] = v;
	};
	for (const [key, label] of [
		["current", "当前"],
		["avg", "平均"],
		["peak", "峰值"],
		["ttft", "首字"],
		["tokens", "输出"],
		["decode", "解码"],
		["time", "用时"],
	]) addRow(key, label);

	const addSection = (title, pairs) => {
		const sep = document.createElement("div");
		sep.className = "tps-sep";
		const sub = document.createElement("div");
		sub.className = "tps-sub";
		sub.textContent = title;
		card.append(sep, sub);
		for (const [key, label] of pairs) addRow(key, label);
	};
	addSection("本会话 · 本地", [
		["sessTps", "均速"],
		["sessTtft", "首字"],
		["sessSteps", "步数"],
	]);
	addSection("本会话 · pi", [
		["sessOut", "输出"],
		["sessCache", "缓存"],
		["sessCost", "费用"],
	]);

	const loadStats = async () => {
		// 本地累计先填，pi 的总量异步补
		const sum = summarizeMetrics(state.metrics);
		refs.sessTps.textContent = sum.avgTps > 0 ? `${fmtTokSpeed(sum.avgTps)} tok/s` : "—";
		refs.sessTtft.textContent = sum.avgTtftMs > 0 ? `${(sum.avgTtftMs / 1000).toFixed(2)}s` : "—";
		refs.sessSteps.textContent = sum.steps > 0 ? String(sum.steps) : "—";
		if (refs.statsAt && Date.now() - refs.statsAt < 5000) return;
		try {
			const s = await window.pi.command({ type: "get_session_stats" });
			const tk = s?.tokens && typeof s.tokens === "object" ? s.tokens : {};
			const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
			const billed = num(tk.input) + num(tk.cacheRead) + num(tk.cacheWrite);
			refs.sessOut.textContent = fmtTokens(num(tk.output));
			refs.sessCache.textContent = billed > 0 ? `${Math.round((num(tk.cacheRead) / billed) * 100)}%` : "—";
			refs.sessCost.textContent = Number.isFinite(s?.cost) ? `$${s.cost.toFixed(s.cost > 0 && s.cost < 1 ? 4 : 2)}` : "—";
			refs.statsAt = Date.now();
		} catch {
			refs.sessOut.textContent = "—";
			refs.sessCache.textContent = "—";
			refs.sessCost.textContent = "—";
		}
	};

	gauge.onclick = (e) => {
		e.preventDefault();
		e.stopPropagation();
		card.hidden = !card.hidden;
		gauge.setAttribute("aria-expanded", String(!card.hidden));
		if (!card.hidden) void loadStats();
	};
	return { gauge, card, line, nowEl, refs };
}

// 运行中状态行 + 流式速度：每 100ms 刷新；速度取最近 1.2s 的滑动窗口再平滑
function tpsTick() {
	if (state.runClock) {
		state.runClock.clock.textContent = fmtClock(performance.now() - state.runClock.start);
	}
	const st = state.liveTps;
	if (!st || !st.start) return;
	const now = performance.now();
	const elapsed = (now - st.start) / 1000;
	if (elapsed < 0.5) return;
	// 最近 1.2s 的 token 增量 / 窗口秒数 = 瞬时速度；再和上一帧做 EMA
	const cutoff = now - 1200;
	while (st.marks.length && st.marks[0].t < cutoff) st.marks.shift();
	let sum = 0;
	for (const mark of st.marks) sum += mark.n;
	// 至少按 0.5s 计：首包/短回答整段到达时，除以几十毫秒会算出几百 tok/s 的假速度
	const windowSec = Math.max(0.5, Math.min(1.2, elapsed));
	const inst = sum / windowSec;
	st.ema = st.ema ? st.ema * 0.72 + inst * 0.28 : inst;
	const speed = st.ema;
	st.peak = Math.max(st.peak, inst); // 峰值用瞬时值，不用 EMA（EMA 会系统性压低峰值）
	st.samples.push(speed);
	if (st.samples.length > 56) st.samples.shift();
	// 纯工具消息没有正文：别亮一个 0 tok/s 的仪表，看起来像卡死。
	// 首个 token 后先攒 0.8s / 12 token，避免短回答闪出一个失真的高速度。
	if (!st.firstToken && !st.done) return;
	if (!st.done && elapsed < 0.8 && state.liveTokens < 12) return;
	st.gauge.hidden = false;
	st.gauge.classList.toggle("idle", speed < 1);
	st.nowEl.textContent = fmtTokSpeed(speed);
	st.line.setAttribute("points", sparkPoints(st.samples, st.peak));
	st.refs.current.textContent = `${fmtTokSpeed(speed)} tok/s`;
	const decodeSec = st.firstToken ? (now - st.firstToken) / 1000 : 0;
	const avg = st.done && st.avg ? st.avg : decodeSec > 0 ? state.liveTokens / decodeSec : 0;
	const tokens = st.done && Number.isFinite(st.total) ? st.total : state.liveTokens;
	st.refs.avg.textContent = `${fmtTokSpeed(avg)} tok/s`;
	st.refs.peak.textContent = `${fmtTokSpeed(st.peak)} tok/s`;
	st.refs.ttft.textContent = st.firstToken && st.start ? `${((st.firstToken - st.start) / 1000).toFixed(2)}s` : "—";
	st.refs.tokens.textContent = fmtTokens(tokens);
	const decodeNow = st.done && st.decodeMs ? st.decodeMs / 1000 : decodeSec;
	st.refs.decode.textContent = decodeNow > 0 ? `${decodeNow.toFixed(1)}s` : "—";
	st.refs.time.textContent = `${elapsed.toFixed(1)}s`;
}

function finalizeAssistant(message) {
	// 幂等：多条 assistant 消息/中断/进程退出可能重复调用，统计副作用只能算一次
	if (!state.live) return;
	stopReveal();
	// 计时器不在这里停：正文定型后运行中状态行还要继续走到 agent_settled
	const st = state.liveTps;
	// 优先用 pi 上报的 output tokens；流式期只有估算
	const reported = Number(message?.usage?.output);
	const total = Number.isFinite(reported) && reported > 0 ? reported : state.liveTokens;
	const endAt = st?.endAt || performance.now();
	const decodeMs = st?.firstToken ? Math.max(1, endAt - st.firstToken) : 0;
	const ttftMs = st?.start && st.firstToken ? Math.max(0, st.firstToken - st.start) : 0;
	if (st) {
		// 正文结束：仪表继续跑，速度自然衰减到 0（工具阶段不该停在最后一个读数）
		st.done = true;
		st.total = total;
		st.decodeMs = decodeMs;
		st.ttftMs = ttftMs;
		st.avg = decodeMs > 0 ? total / (decodeMs / 1000) : 0;
	}
	// 平均速度只算解码时间（首 token → 完成），与 DSH 的口径一致；阈值与 addStep 一致
	if (total > 0 && decodeMs > 0) {
		state.runSpeed.tokens += total;
		state.runSpeed.ms += decodeMs;
	}
	state.runTps = state.runSpeed.ms > 0 ? state.runSpeed.tokens / (state.runSpeed.ms / 1000) : 0;
	recordStepMetrics({ tokens: total, decodeMs, ttftMs });
	if (st?.card) st.card.hidden = true;
	const body = state.live.body;
	const think = thinkText(message) || currentAssistant().thinking;
	const lt = state.liveThink;
	if (lt) {
		// 终稿为准，补全可能被截断的流
		lt.finish(think || currentAssistant().thinking || "");
		state.liveThink = null;
	} else if (think) {
		const th = makeThinkBlock(think, false);
		state.live.row.insertBefore(th.wrap, body);
	}
	state.turn = finishAssistantMessageInTurn(state.turn, message ?? currentAssistant().finalMessage);
	state.turn = revealAllAssistantTextInTurn(state.turn);
	const text = currentAssistant().text || assistantTextFromContent(message?.content);
	body.innerHTML = md(text);
	state.live = null;
	state.liveText = null;
	// 流式期间到的工具卡在 innerHTML 写完后再插回（工具排在正文之后）
	flushUnattachedTools(body);
	applyHighlight(body);
	follow();
	// 窗口在后台时给系统通知（Electron 渲染层 HTML5 Notification）
	if (document.hidden && !state.aborted && text.trim() && Date.now() - lastDoneNotice > 6000) {
		lastDoneNotice = Date.now();
		try {
			const n = new Notification("Myna", {
				body: text.replace(/\s+/g, " ").slice(0, 140),
				icon: new URL("./assets/icon.png", location.href).href,
			});
			n.onclick = () => {
				window.focus();
				n.close();
			};
		} catch {}
	}
}

// ---------- 视口内懒高亮（对齐 useViewportHighlighting）----------
let hlObserver = null;

function applyHighlight(root) {
	if (!root) return;
	if (!hlObserver) {
		hlObserver = new IntersectionObserver(
			(entries) => {
				const targets = entries.filter((e) => e.isIntersecting).map((e) => e.target);
				if (!targets.length) return;
				for (const t of targets) hlObserver.unobserve(t);
				const items = targets.map((pre) => ({
					code: pre.querySelector("code")?.textContent ?? "",
					lang: pre.dataset.lang || "",
				}));
				window.pi
					.highlight(items, { dark: isDark() })
					.then((htmls) => {
						htmls.forEach((html, i) => {
							if (!html) return;
							const pre = targets[i];
							const code = pre?.querySelector("code");
							if (!code) return;
							try {
								const doc = new DOMParser().parseFromString(html, "text/html");
								const src = doc.querySelector("code");
								if (src) code.innerHTML = src.innerHTML;
								pre.classList.add("shiki");
							} catch {}
						});
					})
					.catch(() => {});
			},
			{ root: stream, rootMargin: "300px 0px" },
		);
	}
	for (const pre of root.querySelectorAll("pre[data-lang]")) {
		if (pre.dataset.hl) continue;
		pre.dataset.hl = "1";
		hlObserver.observe(pre);
	}
}

// 主题切换后重高亮已渲染代码块（shiki 主题色是内联的，CSS 覆盖不了）
window.addEventListener("myna:theme", () => {
	if (!hlObserver) return;
	for (const pre of stream.querySelectorAll("pre.shiki")) {
		const code = pre.querySelector("code");
		if (!code) continue;
		code.textContent = code.textContent;
		pre.classList.remove("shiki");
		pre.dataset.hl = "1";
		hlObserver.observe(pre);
	}
});

// ---------- 工具调用卡片 ----------
const ICON_TERMINAL =
	'<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2.4" y="3.2" width="11.2" height="9.6" rx="2"/><path d="M5.4 6.6 6.9 8l-1.5 1.4M8.6 9.6h2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_DOC =
	'<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 2.6h5l3 3v7.8H4V2.6Z" stroke-linejoin="round"/><path d="M9 2.6v3h3" stroke-linejoin="round"/></svg>';
const ICON_PENCIL =
	'<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M11.4 2.6a1.3 1.3 0 0 1 1.8 0l.2.2a1.3 1.3 0 0 1 0 1.8L6 12.1l-2.6.5.5-2.6 7.5-7.4Z" stroke-linejoin="round"/></svg>';
const ICON_SEARCH =
	'<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="7" cy="7" r="3.6"/><path d="M9.8 9.8 13 13" stroke-linecap="round"/></svg>';
const ICON_GRID =
	'<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 4h10M3 8h10M3 12h10" stroke-linecap="round"/></svg>';
const ICON_DOT =
	'<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="4.2"/></svg>';

function relPath(p) {
	if (!p) return "";
	const cwd = state.cwd || "";
	if (cwd && p.startsWith(cwd)) return `.${p.slice(cwd.length)}`;
	return p;
}

const clean = (v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

function toolSpec(name, args) {
	const a = args && typeof args === "object" ? args : {};
	switch (name) {
		case "bash":
		case "powershell":
			return { icon: ICON_TERMINAL, title: name, text: clean(a.command), file: null };
		case "read":
			return { icon: ICON_DOC, title: "read", text: relPath(a.path), file: a.path };
		case "write":
			return { icon: ICON_PENCIL, title: "write", text: relPath(a.path), file: a.path };
		case "edit":
			return { icon: ICON_PENCIL, title: "edit", text: relPath(a.path), file: a.path };
		case "ls":
			return { icon: ICON_GRID, title: "ls", text: relPath(a.path || "."), file: a.path };
		case "grep":
			return {
				icon: ICON_SEARCH,
				title: "grep",
				text: [clean(a.pattern), relPath(a.path)].filter(Boolean).join("  "),
				file: null,
			};
		case "find":
			return { icon: ICON_SEARCH, title: "find", text: clean(a.pattern || a.glob || a.path), file: null };
		default: {
			const first = Object.values(a).find((v) => typeof v === "string") || "";
			return { icon: ICON_DOT, title: name || "tool", text: clean(first).slice(0, 88), file: null };
		}
	}
}

function fmtDuration(ms) {
	if (ms == null) return "";
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// 受控折叠行（对齐 DSH DisclosureRow）：hover 才露 chevron、键盘可切换
function toggleDisclosure(root, force) {
	const open = force ?? root.dataset.open !== "1";
	root.dataset.open = open ? "1" : "0";
	const hdr = root.querySelector(".hdr");
	if (hdr) hdr.setAttribute("aria-expanded", open ? "true" : "false");
	const inner = root.querySelector(".inner");
	if (inner) inner.inert = !open;
}

function bindDisclosure(root) {
	const hdr = root.querySelector(".hdr");
	if (!hdr) return;
	hdr.addEventListener("click", () => toggleDisclosure(root));
	hdr.addEventListener("keydown", (e) => {
		if (e.key !== "Enter" && e.key !== " ") return;
		e.preventDefault();
		toggleDisclosure(root);
	});
}

// 一轮结束后，把这一轮的过程（思考 + 工具调用）收成一个可展开块，只留最终回答。
// 阅读顺序按 Codex：先看结论，需要追溯时再展开过程。
function foldTurnProcess(rows, stats = null) {
	const list = (rows || []).filter((r) => r?.isConnected && !r.classList.contains("proc-row"));
	if (!list.length) return null;
	const proc = [];
	let thinkCount = 0;
	let toolCount = 0;
	for (const row of list) {
		// 思考块挂在 row 上（实时与历史都是插入到 row，而不是 body）
		for (const el of [...row.children]) {
			if (!el.classList?.contains("think")) continue;
			proc.push(el);
			thinkCount += 1;
		}
		// 工具卡在 body 里，和正文混排
		const body = row.querySelector(":scope > .body");
		if (!body) continue;
		for (const el of [...body.children]) {
			if (!el.classList?.contains("tool")) continue;
			proc.push(el);
			toolCount += 1;
		}
	}
	if (!proc.length) return null;

	const parts = [];
	if (thinkCount) parts.push(`${thinkCount} 次思考`);
	if (toolCount) parts.push(`${toolCount} 个工具`);
	const seconds = Number(stats?.seconds) || 0;
	const tps = Number(stats?.tps) || 0;

	const wrap = document.createElement("div");
	wrap.className = "row assistant proc-row";
	const details = document.createElement("details");
	details.className = "proc";
	const summary = document.createElement("summary");
	summary.className = "proc-sum";
	const label = document.createElement("span");
	label.className = "proc-text";
	label.textContent = `过程 · ${parts.join(" · ")}`;
	summary.append(label);
	const tail = [seconds ? `${seconds.toFixed(1)}s` : "", tps > 0 ? `${fmtTokSpeed(tps)} tok/s` : ""].filter(Boolean).join(" · ");
	if (tail) {
		const time = document.createElement("span");
		time.className = "proc-time";
		time.textContent = tail;
		summary.append(time);
	}
	const procBody = document.createElement("div");
	procBody.className = "proc-body";
	procBody.append(...proc);
	details.append(summary, procBody);
	wrap.append(details);

	list[0].before(wrap);

	// 摘完只剩空壳的行（本轮只有工具、没有正文）整行收掉，避免留下空白
	for (const row of list) {
		row.querySelector(":scope > .meta")?.remove();
		const body = row.querySelector(":scope > .body");
		if (!body) continue;
		const visible = body.textContent.trim() || body.querySelector("img, pre, table, .stopped");
		if (!visible) row.remove();
	}
	return wrap;
}

// 一轮结束：工具卡、命令输出、思考块统一折回去（用户展开过的也收）
function collapseTurnBlocks() {
	for (const el of stream.querySelectorAll('.tool[data-open="1"]')) toggleDisclosure(el, false);
	for (const el of stream.querySelectorAll('.think[data-open="1"]')) {
		el.querySelector(".think-row")?.click();
	}
}

function buildToolRow({ name, args, output, diff, isError, durationMs }) {
	const root = document.createElement("div");
	root.className = "tool" + (isError ? " err" : "");
	root.dataset.open = "0";
	root.dataset.tool = name || "";
	if (args && typeof args === "object" && args.offset != null) root.dataset.offset = String(args.offset);

	const hdr = document.createElement("div");
	hdr.className = "hdr";
	hdr.setAttribute("role", "button");
	hdr.setAttribute("tabindex", "0");
	hdr.setAttribute("aria-expanded", "false");

	const spec = toolSpec(name, args);
	if (spec.file) root.dataset.file = spec.file;

	const lead = document.createElement("span");
	lead.className = "lead";
	const ic = document.createElement("span");
	ic.className = "ic";
	ic.innerHTML = spec.icon;
	const chev = document.createElement("span");
	chev.className = "chev";
	chev.textContent = "›";
	lead.append(ic, chev);

	const title = document.createElement("span");
	title.className = "name";
	title.textContent = spec.title;

	const arg = document.createElement("span");
	arg.className = "arg" + (spec.file ? " path" : "");
	arg.textContent = spec.text;
	arg.title = spec.file || spec.text;
	if (spec.file) {
		arg.onclick = async (e) => {
			e.preventDefault();
			e.stopPropagation();
			let opened = false;
			try {
				opened = !!(await ctx.rightPanel?.preview?.(spec.file));
			} catch {}
			if (!opened) window.pi.openPath(spec.file);
		};
	}

	const stat = document.createElement("span");
	stat.className = "stat";

	const badge = document.createElement("span");
	badge.className = "badge";
	badge.textContent = "失败";
	badge.hidden = !isError;

	const dur = document.createElement("span");
	dur.className = "dur";
	dur.textContent = fmtDuration(durationMs);

	hdr.append(lead, title, arg, stat, badge, dur);

	const body = document.createElement("div");
	body.className = "body";
	const inner = document.createElement("div");
	inner.className = "inner";
	body.append(inner);

	root.append(hdr, body);
	bindDisclosure(root);
	toggleDisclosure(root, false);

	if (diff) setDiff(root, stat, diff);
	else if (output) appendToolOutput(root, output);
	return root;
}

function setDiff(root, stat, diff) {
	if (!root || !stat) return;
	const block = buildDiffBlock(diff);
	stat.textContent = `+${block.dataset.added} −${block.dataset.removed}`;
	root.querySelector(".inner")?.append(block);
	// diff 也保持折叠，避免一条编辑结果撑开整轮内容。
}

function appendToolImages(root, content) {
	const imgs = (Array.isArray(content) ? content : []).filter((b) => b?.type === "image" && b.data);
	if (!imgs.length) return;
	const inner = root?.querySelector(".inner");
	if (!inner) return;
	const wrap = document.createElement("div");
	wrap.className = "tool-imgs";
	for (const b of imgs) {
		const img = document.createElement("img");
		img.className = "tool-img";
		img.loading = "lazy";
		img.alt = root.dataset.file ? root.dataset.file.split(/[\\/]/).pop() : "工具结果图片";
		img.src = `data:${b.mimeType || "image/png"};base64,${b.data}`;
		wrap.append(img);
	}
	inner.append(wrap);
	// 工具结果默认保持折叠；标题行承担摘要、状态和耗时，用户主动点击再看详情。
}

function appendToolOutput(root, output) {
	const inner = root?.querySelector(".inner");
	if (!inner) return;
	const tool = root.dataset.tool || "";
	if (tool === "read" && !/^Read image file/.test(output)) {
		appendReadOutput(inner, output, root);
		return;
	}
	if ((tool === "grep" || tool === "find") && appendSearchOutput(inner, output)) return;
	const pre = document.createElement("pre");
	const truncated = output.length > 4000;
	pre.textContent = truncated ? `${output.slice(0, 4000)}\n…` : output;
	inner.append(pre);
	if (truncated) {
		const more = document.createElement("button");
		more.type = "button";
		more.className = "more";
		more.textContent = "显示全部";
		more.onclick = () => {
			pre.textContent = output;
			more.remove();
		};
		inner.append(more);
	}
}

// partialResult 更新按 80ms 合并：只画最新一帧，避免高频刷新把主线程占满。
const toolPaintPending = new WeakMap();
function scheduleToolPaint(root, result, isError = false, durationMs) {
	if (!root) return;
	const prev = toolPaintPending.get(root);
	if (prev) {
		Object.assign(prev, { result, isError, durationMs });
		return;
	}
	const entry = { result, isError, durationMs, timer: 0 };
	entry.timer = setTimeout(() => {
		toolPaintPending.delete(root);
		if (root.isConnected) paintToolResult(root, entry.result, entry.isError, entry.durationMs);
	}, 80);
	toolPaintPending.set(root, entry);
}

function flushToolPaint(root, result, isError = false, durationMs) {
	const pending = toolPaintPending.get(root);
	if (pending) {
		clearTimeout(pending.timer);
		toolPaintPending.delete(root);
	}
	paintToolResult(root, result, isError, durationMs);
}

// pi 的 partialResult 是“当前最新预览”，不能把每次更新简单追加成重复输出。
function paintToolResult(root, result, isError = false, durationMs) {
	if (!root) return;
	root.classList.toggle("err", Boolean(isError));
	const badge = root.querySelector(".badge");
	if (badge) {
		badge.hidden = !isError;
	}
	if (durationMs !== undefined) {
		const dur = root.querySelector(".dur");
		if (dur) dur.textContent = fmtDuration(durationMs);
	}
	const inner = root.querySelector(".inner");
	if (inner) inner.replaceChildren();
	const stat = root.querySelector(".stat");
	const diff = result?.details?.diff;
	const text = blockText(result?.content);
	if (diff) setDiff(root, stat, diff);
	else if (text) appendToolOutput(root, text);
	appendToolImages(root, result?.content);
}

// ---------- ReadBlock：补行号 + 截断提示 ----------
function appendReadOutput(inner, text, root) {
	const lines = text.split("\n");
	const start = Number(root.dataset.offset || 1) || 1;
	// pi 若已在内容里带行号，别重复加
	const numbered = lines.filter((l) => /^\s*\d+[|:]\s/.test(l)).length > lines.length * 0.5;
	const box = document.createElement("div");
	box.className = "readblock";
	const cap = Math.min(lines.length, 600);
	for (let i = 0; i < cap; i++) {
		const row = document.createElement("div");
		row.className = "rline";
		if (!numbered) {
			const no = document.createElement("span");
			no.className = "no";
			no.textContent = String(start + i);
			row.append(no);
		}
		const tx = document.createElement("span");
		tx.className = "tx";
		tx.textContent = lines[i];
		row.append(tx);
		box.append(row);
	}
	inner.append(box);
	if (lines.length > cap) {
		const more = document.createElement("div");
		more.className = "more";
		more.textContent = `还有 ${lines.length - cap} 行未显示`;
		inner.append(more);
	}
}

// ---------- SearchBlock：按文件分组 ----------
function appendSearchOutput(inner, text) {
	const lines = text.split("\n").filter((l) => l.trim());
	const parsed = [];
	for (const l of lines) {
		const m = /^(.+?):(\d+):(.*)$/.exec(l);
		if (m) parsed.push({ file: m[1], line: m[2], text: m[3] });
	}
	if (parsed.length < 2 || parsed.length < lines.length * 0.6) return false;

	const groups = new Map();
	for (const p of parsed) {
		if (!groups.has(p.file)) groups.set(p.file, []);
		groups.get(p.file).push(p);
	}

	const box = document.createElement("div");
	box.className = "searchblock";
	for (const [file, items] of groups) {
		const head = document.createElement("div");
		head.className = "sfile";
		const name = document.createElement("span");
		name.className = "flink";
		name.dataset.path = file;
		name.textContent = relPath(file);
		const count = document.createElement("span");
		count.className = "scount";
		count.textContent = String(items.length);
		head.append(name, count);
		box.append(head);
		for (const it of items) {
			const row = document.createElement("div");
			row.className = "smatch";
			const no = document.createElement("span");
			no.className = "no";
			no.textContent = it.line;
			const tx = document.createElement("span");
			tx.className = "tx";
			tx.textContent = it.text.trim();
			row.append(no, tx);
			box.append(row);
		}
	}
	inner.append(box);
	return true;
}

// ---------- diff 渲染（格式：<标记><行号> <内容>）----------
function parseDiff(diff) {
	return diff.split("\n").map((line) => {
		const m = /^([ +-])(\d+) (.*)$/.exec(line);
		if (!m) return { mark: " ", no: "", text: line };
		return { mark: m[1], no: m[2], text: m[3] };
	});
}

function buildDiffBlock(diff) {
	const rows = parseDiff(diff);
	const added = rows.filter((r) => r.mark === "+").length;
	const removed = rows.filter((r) => r.mark === "-").length;

	const wrap = document.createElement("div");
	wrap.className = "diff";
	const body = document.createElement("div");
	body.className = "diff-body";
	for (const r of rows) {
		const line = document.createElement("div");
		line.className = `dl ${r.mark === "+" ? "add" : r.mark === "-" ? "del" : "ctx"}`;
		const no = document.createElement("span");
		no.className = "no";
		no.textContent = r.no;
		const tx = document.createElement("span");
		tx.className = "tx";
		tx.textContent = r.text;
		line.append(no, tx);
		body.append(line);
	}
	wrap.append(body);
	wrap.dataset.added = String(added);
	wrap.dataset.removed = String(removed);
	return wrap;
}

function fmtStamp(ts) {
	if (!ts) return "";
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return "";
	const now = new Date();
	const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
	const diff = (day(now) - day(d)) / 86400000;
	const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
	if (diff === 0) return `今天 ${hm}`;
	if (diff === 1) return `昨天 ${hm}`;
	if (diff < 7) return `${["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()]} ${hm}`;
	return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

function timeDivider(ts) {
	const label = fmtStamp(ts);
	if (!label) return null;
	const el = document.createElement("div");
	el.className = "time";
	el.textContent = label;
	return el;
}

const HISTORY_PAGE = 80;

function renderHistory(messages) {
	clearStream();
	const visible = messages.filter((m) => m.role !== "system");
	state.historyAll = visible;
	state.historyShown = Math.min(visible.length, HISTORY_PAGE);
	paintHistory(false);
}

// 右栏会话树点击：把主对话滚到对应消息并闪一下。
// index 是「user/assistant 消息」里的序号，和树的活动分支过滤后一一对应。
function focusMessage(index) {
	// 流式中重绘历史会把 live 行摘掉，等这轮结束再定位
	if (state.streaming) return false;
	const all = state.historyAll || [];
	const chatIdx = [];
	for (let i = 0; i < all.length; i++) {
		if (all[i].role === "user" || all[i].role === "assistant") chatIdx.push(i);
	}
	const target = chatIdx[index];
	if (target == null) return false;
	// 分页状态下也必须把目标行渲染出来，否则序号对不上
	if (!state.historyShown || state.historyShown < all.length) {
		state.historyShown = all.length;
		paintHistory(false);
	}
	const rows = [...stream.querySelectorAll(".row.mine, .row.assistant")];
	const row = rows[index];
	if (!row) return false;
	row.scrollIntoView({ block: "center", behavior: "smooth" });
	row.classList.remove("flash");
	void row.offsetWidth;
	row.classList.add("flash");
	setTimeout(() => row.classList.remove("flash"), 1500);
	row.focus?.({ preventScroll: true });
	return true;
}

function paintHistory(keepAnchor) {
	const all = state.historyAll || [];
	if (!all.length) {
		state.historyAll = null;
		emptyHint();
		return;
	}
	const shown = Math.min(all.length, state.historyShown || HISTORY_PAGE);
	// 从整轮起点开始渲染，避免把一条 user 消息和它的工具结果截断
	let from = Math.max(0, all.length - Math.max(shown, 1));
	while (from > 0 && all[from].role !== "user") from--;
	const prevH = stream.scrollHeight;
	const prevTop = stream.scrollTop;
	stream.replaceChildren();
	if (from > 0) {
		const more = document.createElement("button");
		more.type = "button";
		more.className = "history-more";
		more.textContent = `加载更早的消息（还有 ${from} 条）`;
		more.addEventListener("click", async () => {
			if (state.streaming || state.switching) return;
			// historyAll 可能是本轮之前的快照：分页前重拉一次，否则会把刚结束的一轮抹掉
			let list = state.historyAll || [];
			try {
				const h = await window.pi.command({ type: "get_messages" });
				if (Array.isArray(h?.messages)) list = h.messages.filter((m) => m.role !== "system");
				state.historyAll = list;
			} catch {}
			state.historyShown = Math.min(list.length, (state.historyShown || HISTORY_PAGE) + HISTORY_PAGE);
			paintHistory(true);
		});
		stream.append(more);
	}
	const toolRows = new Map();
	let lastTs = 0;
	// 历史也按「一轮」折过程：遇到下一条用户消息前，把这一轮的思考与工具收成一个块
	let groupRows = [];
	state.paintingHistory = true;
	try {
		for (const m of all.slice(from)) {
		if (m.role === "user" && m.timestamp) {
			// 超过 10 分钟或跨天就插一条时间分隔
			if (!lastTs || Math.abs(new Date(m.timestamp) - new Date(lastTs)) > 600000) {
				const div = timeDivider(m.timestamp);
				if (div) stream.append(div);
			}
			lastTs = m.timestamp;
		}
		if (m.role === "user") {
			if (groupRows.length) {
				foldTurnProcess(groupRows);
				groupRows = [];
			}
			addUser(blockText(m.content), imagesFromContent(m.content));
		} else if (m.role === "assistant") {
			const model = assistantFromHistory(m);
			const row = document.createElement("div");
			row.className = "row assistant";
			const body = document.createElement("div");
			body.className = "body";
			if (model.thinking) row.append(makeThinkBlock(model.thinking, false).wrap);
			body.innerHTML = md(model.text);
			const record = { model, row };
			for (const tool of model.tools) {
				const el = buildToolRow({ name: tool.name, args: tool.args });
				if (tool.id) toolRows.set(tool.id, { el, record });
				body.append(el);
			}
			row.append(body);
			stream.append(row);
			groupRows.push(row);
		} else if (m.role === "toolResult") {
			// 历史里的工具结果补回到对应的调用行
			const id = m.toolCallId ?? m.tool_call_id ?? m.id;
			const entry = id ? toolRows.get(id) : null;
			const el = entry?.el;
			if (el) {
				entry.record.model = applyHistoryToolResult(entry.record.model, m);
				const tool = entry.record.model.tools.find((item) => item.id === String(id));
				const result = tool?.result || m;
				const text = blockText(result.content);
				const diff = result.details?.diff;
				if (tool?.isError) {
					el.classList.add("err");
					const badge = el.querySelector(".badge");
					if (badge) badge.hidden = false;
				}
				if (diff) setDiff(el, el.querySelector(".stat"), diff);
				else if (text) appendToolOutput(el, text);
				appendToolImages(el, result.content);
			}
		}
		}
		if (groupRows.length) foldTurnProcess(groupRows);
	} finally {
		state.paintingHistory = false;
	}
	if (keepAnchor) {
		stickBottom = false;
		stream.scrollTop = prevTop + (stream.scrollHeight - prevH);
	} else {
		stickBottom = true;
		follow();
	}
	applyHighlight(stream);
}

// 开发/截图钩子：用合成消息压测历史渲染与分页
const FOLDER_ICON =
	'<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 4.6c0-.6.5-1 1-1h3l1.4 1.6H13c.6 0 1 .5 1 1v5.8c0 .6-.4 1-1 1H3c-.5 0-1-.4-1-1V4.6Z" stroke-linejoin="round"/></svg>';
const PLUS_ICON =
	'<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M8 3.2v9.6M3.2 8h9.6" stroke-linecap="round"/></svg>';
const SEARCH_ICON =
	'<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="7" cy="7" r="3.8"/><path d="M9.9 9.9 13 13" stroke-linecap="round"/></svg>';
const FOLDER_PLUS_ICON =
	'<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 4.6c0-.6.5-1 1-1h3l1.4 1.6H13c.6 0 1 .5 1 1v5.8c0 .6-.4 1-1 1H3c-.5 0-1-.4-1-1V4.6Z" stroke-linejoin="round"/><path d="M11.2 9.4v3M9.7 10.9h3" stroke-linecap="round"/></svg>';
const MORE_ICON =
	'<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.1"/><circle cx="8" cy="8" r="1.1"/><circle cx="12.5" cy="8" r="1.1"/></svg>';
const PLUS_CIRCLE_ICON =
	'<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="5.4"/><path d="M8 5.6v4.8M5.6 8h4.8" stroke-linecap="round"/></svg>';
const PEN_ICON =
	'<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M11.4 2.6a1.3 1.3 0 0 1 1.8 0l.2.2a1.3 1.3 0 0 1 0 1.8L6 12.1l-2.6.5.5-2.6 7.5-7.4Z" stroke-linejoin="round"/></svg>';

const COLLAPSE_KEY = "pi-mini.collapsed";
const PROJECTS_KEY = "pi-mini.projects";
const LAST_SESSION_KEY = "pi-mini.lastSession";
const RESTORE_KEY = "pi-mini.restore-session";
const PAGE_KEY = "pi-mini.page-size";
let sessionBootDone = false;

function readPref(key, fallback) {
	try {
		const v = localStorage.getItem(key);
		return v == null ? fallback : v;
	} catch {
		return fallback;
	}
}

function restoreAllowed() {
	return readPref(RESTORE_KEY, "1") !== "0";
}

function readPageSize() {
	const n = Number(readPref(PAGE_KEY, 20));
	return [20, 40, 60, 100].includes(n) ? n : 20;
}

function loadLastSession() {
	try {
		const raw = JSON.parse(localStorage.getItem(LAST_SESSION_KEY) || "null");
		return raw && typeof raw.path === "string" && raw.path ? raw : null;
	} catch {
		return null;
	}
}

function saveLastSession() {
	if (!sessionBootDone || !state.cwd || !state.sessionFile) return;
	try {
		localStorage.setItem(LAST_SESSION_KEY, JSON.stringify({ cwd: state.cwd, path: state.sessionFile }));
	} catch {}
}

function loadProjects() {
	try {
		const raw = JSON.parse(localStorage.getItem(PROJECTS_KEY) || "null");
		return Array.isArray(raw) ? raw.filter((x) => typeof x === "string" && x) : [];
	} catch {
		return [];
	}
}

function saveProjects() {
	try {
		localStorage.setItem(PROJECTS_KEY, JSON.stringify(state.projects));
	} catch {}
}

function loadCollapsed() {
	try {
		const raw = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "[]");
		return new Set(Array.isArray(raw) ? raw : []);
	} catch {
		return new Set();
	}
}

function saveCollapsed() {
	try {
		localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...state.collapsed]));
	} catch {}
}

const ARCHIVE_KEY = "pi-mini.archived";
const ARCHIVE_FILTER_KEY = "pi-mini.archive-filter";
const NAMES_KEY = "pi-mini.names";
const PIN_KEY = "pi-mini.pinned";

function loadArchived() {
	try {
		const raw = JSON.parse(localStorage.getItem(ARCHIVE_KEY) || "[]");
		return new Set(Array.isArray(raw) ? raw.filter((x) => typeof x === "string" && x) : []);
	} catch {
		return new Set();
	}
}

function saveArchived() {
	try {
		localStorage.setItem(ARCHIVE_KEY, JSON.stringify([...state.archived]));
	} catch {}
}

function loadNames() {
	try {
		const raw = JSON.parse(localStorage.getItem(NAMES_KEY) || "{}");
		return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	} catch {
		return {};
	}
}

function saveNames() {
	try {
		localStorage.setItem(NAMES_KEY, JSON.stringify(state.names));
	} catch {}
}

function loadPinned() {
	try {
		const raw = JSON.parse(localStorage.getItem(PIN_KEY) || "[]");
		return new Set(Array.isArray(raw) ? raw.filter((x) => typeof x === "string" && x) : []);
	} catch {
		return new Set();
	}
}

function savePinned() {
	try {
		localStorage.setItem(PIN_KEY, JSON.stringify([...state.pinned]));
	} catch {}
}

function sessionLabel(s) {
	return state.names[s.path] || s.name || s.title || "未命名会话";
}

function toggleArchive(s) {
	const wasArchived = state.archived.has(s.path);
	if (wasArchived) state.archived.delete(s.path);
	else state.archived.add(s.path);
	saveArchived();
	renderSessions();
	notice(wasArchived ? "已取消归档" : "已归档", {
		label: "撤销",
		onClick: () => {
			if (wasArchived) state.archived.add(s.path);
			else state.archived.delete(s.path);
			saveArchived();
			renderSessions();
		},
	});
}

// 导出当前会话为 Markdown（使用已加载的 get_messages，工具结果折叠进 details）
async function exportMarkdown() {
	let messages = [];
	try {
		const h = await window.pi.command({ type: "get_messages" });
		messages = Array.isArray(h?.messages) ? h.messages.filter((m) => m.role !== "system") : [];
	} catch (e) {
		notice(`导出失败：${e.message}`);
		return;
	}
	const title = sessionLabel({ path: state.sessionFile, name: state.sessionName }) || "Myna 会话";
	const lines = [`# ${title}`, ""];
	for (const m of messages) {
		const text = blockText(m.content).trim();
		if (m.role === "user") {
			if (text) lines.push("## 你", "", text, "");
			for (const img of imagesFromContent(m.content)) lines.push("_[图片]_", "");
		} else if (m.role === "assistant") {
			const think = thinkText(m).trim();
			if (think) lines.push("<details><summary>思考</summary>", "", think, "", "</details>", "");
			if (text) lines.push("## myna", "", text, "");
			for (const b of Array.isArray(m.content) ? m.content : []) {
				if (b?.type === "toolCall") lines.push(`- 调用工具 \`${b.name}\``);
			}
			if (text || think) lines.push("");
		}
	}
	const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
	const a = document.createElement("a");
	a.href = URL.createObjectURL(blob);
	a.download = `${String(title).replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80) || "Myna"}.md`;
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(a.href), 4000);
	notice("已导出 Markdown");
}

function relTime(ts) {	const t = new Date(ts).getTime();
	if (!Number.isFinite(t)) return "";
	const d = Date.now() - t;
	if (d < 60_000) return "刚刚";
	if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
	if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
	if (d < 172_800_000) return "昨天";
	return new Date(ts).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

const SESS_MORE_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="3.6" cy="8" r="1.1"/><circle cx="8" cy="8" r="1.1"/><circle cx="12.4" cy="8" r="1.1"/></svg>';

// 一行会话：可点击打开 + 悬停出「…」菜单（目前只有归档/取消归档）
function sessionRow(s) {
	const row = document.createElement("div");
	row.className = "srow";
	const b = document.createElement("button");
	b.type = "button";
	b.className = "item" + (s.path === state.sessionFile ? " active" : "");
	if (s.path === state.sessionFile) b.setAttribute("aria-current", "true");
	const name = document.createElement("span");
	name.className = "item-title";
	name.textContent = sessionLabel(s);
	const time = document.createElement("span");
	time.className = "item-time";
	time.textContent = relTime(s.timestamp);
	b.append(name, time);
	b.title = `${s.cwd}\n${s.path}`;
	b.onclick = () => pickSession(s.path, s.cwd);

	const actions = document.createElement("button");
	actions.type = "button";
	actions.className = "sess-more";
	actions.title = "会话操作";
	actions.setAttribute("aria-label", "会话操作");
	actions.innerHTML = SESS_MORE_ICON;
	const pop = document.createElement("div");
	pop.className = "sess-menu";
	pop.hidden = true;
	const pin = document.createElement("button");
	pin.type = "button";
	pin.textContent = state.pinned.has(s.path) ? "取消置顶" : "置顶";
	pin.onclick = (e) => {
		e.stopPropagation();
		if (state.pinned.has(s.path)) state.pinned.delete(s.path);
		else state.pinned.add(s.path);
		savePinned();
		renderSessions();
	};
	const rename = document.createElement("button");
	rename.type = "button";
	rename.textContent = "重命名";
	rename.onclick = (e) => {
		e.stopPropagation();
		pop.hidden = true;
		startRename(row, s, name);
	};
	const copyId = document.createElement("button");
	copyId.type = "button";
	copyId.textContent = "复制会话 ID";
	copyId.onclick = async (e) => {
		e.stopPropagation();
		pop.hidden = true;
		const id = String(s.id || s.path || "")
			.split(/[\\/]/)
			.pop()
			.replace(/\.jsonl$/i, "");
		try {
			await navigator.clipboard.writeText(id);
		} catch {
			const ta = document.createElement("textarea");
			ta.value = id;
			ta.style.position = "fixed";
			ta.style.opacity = "0";
			document.body.append(ta);
			ta.select();
			try {
				document.execCommand("copy");
			} catch {}
			ta.remove();
		}
		notice("会话 ID 已复制");
	};
	const arch = document.createElement("button");
	arch.type = "button";
	arch.textContent = state.archived.has(s.path) ? "取消归档" : "归档";
	arch.onclick = (e) => {
		e.stopPropagation();
		toggleArchive(s);
	};
	const md = document.createElement("button");
	md.type = "button";
	md.textContent = "导出 Markdown";
	md.onclick = (e) => {
		e.stopPropagation();
		pop.hidden = true;
		if (s.path !== state.sessionFile) {
			notice("先打开该会话再导出 Markdown");
			return;
		}
		exportMarkdown();
	};
	pop.append(pin, rename, copyId, md, arch);
	actions.onclick = (e) => {
		e.stopPropagation();
		const wasHidden = pop.hidden;
		for (const m of document.querySelectorAll(".proj-menu, .sess-menu")) m.hidden = true;
		for (const p of document.querySelectorAll(".proj.menu-open")) p.classList.remove("menu-open");
		pop.hidden = !wasHidden;
	};
	row.append(b, actions, pop);
	return row;
}

// 行内重命名：覆盖在会话行上的小输入框，Enter 保存、Esc 取消
function startRename(row, s, nameEl) {
	const box = document.createElement("div");
	box.className = "sess-rename";
	const inp = document.createElement("input");
	inp.type = "text";
	inp.maxLength = 80;
	inp.value = state.names[s.path] || s.name || s.title || "";
	inp.setAttribute("aria-label", "会话名称");
	box.append(inp);
	row.append(box);
	inp.focus();
	inp.select();
	let done = false;
	const finish = (save) => {
		if (done) return;
		done = true;
		if (save) {
			const v = inp.value.trim();
			const base = s.name || s.title || "";
			if (v && v !== base) state.names[s.path] = v;
			else delete state.names[s.path];
			saveNames();
		}
		renderSessions();
	};
	inp.onkeydown = (e) => {
		e.stopPropagation();
		if (e.key === "Enter") {
			e.preventDefault();
			finish(true);
		} else if (e.key === "Escape") {
			e.preventDefault();
			finish(false);
		}
	};
	inp.onblur = () => finish(true);
	inp.onclick = (e) => e.stopPropagation();
}

// ---------- 会话内容搜索 ----------
function scheduleContentSearch(value) {
	clearTimeout(state.searchTimer);
	const text = String(value || "").trim();
	if (text.length < 2) {
		state.searchQuery = "";
		state.searchResults = [];
		state.searchBusy = false;
		state.searchTruncated = false;
		paintSearchResults();
		return;
	}
	state.searchQuery = text;
	state.searchBusy = true;
	paintSearchResults();
	const seq = ++state.searchSeq;
	state.searchTimer = setTimeout(async () => {
		try {
			const r = await window.pi.searchSessions({ cwd: state.cwd, query: text });
			if (seq !== state.searchSeq) return;
			state.searchResults = Array.isArray(r?.results) ? r.results : [];
			state.searchTruncated = !!r?.truncated;
		} catch {
			if (seq !== state.searchSeq) return;
			state.searchResults = [];
		}
		state.searchBusy = false;
		paintSearchResults();
	}, 240);
}

function paintSearchResults() {
	const host = $("list");
	if (!host) return;
	let box = host.querySelector(".side-hits");
	if (!state.searchQuery) {
		if (box) box.remove();
		return;
	}
	if (!box) {
		box = document.createElement("div");
		box.className = "side-hits";
		const search = host.querySelector(".side-search");
		if (search && search.nextSibling) host.insertBefore(box, search.nextSibling);
		else host.append(box);
	}
	box.innerHTML = "";
	const head = document.createElement("div");
	head.className = "hits-head";
	head.textContent = state.searchBusy
		? "搜索中…"
		: `内容匹配 ${state.searchResults.length}${state.searchTruncated ? "+" : ""}`;
	box.append(head);
	for (const hit of state.searchResults) {
		const row = document.createElement("button");
		row.type = "button";
		row.className = "hit";
		row.title = hit.snippet || "";
		const t = document.createElement("span");
		t.className = "hit-title";
		t.textContent = hit.name || hit.title || String(hit.path).split(/[\\/]/).pop();
		const s = document.createElement("span");
		s.className = "hit-snippet";
		s.textContent = hit.snippet || "";
		row.append(t, s);
		row.onclick = async () => {
			state.sideSearch = false;
			state.sideQuery = "";
			state.sideCaret = 0;
			state.searchQuery = "";
			state.searchResults = [];
			await pickSession(hit.path, hit.cwd);
			renderSessions();
		};
		box.append(row);
	}
}

let lastSessionsKey = "";
let sessionListTimer = 0;
let sessionListDirty = false;

// 外部进程新建/删除会话时，主进程会推 pi:sessions-changed。
// 窗口藏在托盘时不重建 DOM，回到可见时补一次。
function refreshSessionList(delay = 300) {
	if (document.hidden) {
		sessionListDirty = true;
		return;
	}
	clearTimeout(sessionListTimer);
	sessionListTimer = setTimeout(async () => {
		sessionListDirty = false;
		try {
			const next = await window.pi.sessions({ perCwd: state.sessionPage || readPageSize() });
			if (!Array.isArray(next)) return;
			state.sessions = next;
			renderSessions();
		} catch {}
	}, delay);
}

function renderSessions() {
	const list = $("list");
	// 每轮 refreshState 都会调用这里，但模型/流式状态变化不影响侧栏。
	// 用一份轻量签名跳过无变化的整树重建（600 个会话时省掉大量 DOM 操作）。
	const sessionSig = state.sessions
		.map((s) => `${s.path}\u0001${s.timestamp || ""}\u0001${s.name || ""}\u0001${s.title || ""}`)
		.join("\u0002");
	const key = [
		state.cwd,
		state.sideSearch ? 1 : 0,
		state.sideQuery,
		state.archiveFilter,
		state.archivedOpen ? 1 : 0,
		state.sessionFile,
		state.sessionPage,
		state.projects.join("\u0001"),
		[...state.archived].sort().join("\u0001"),
		[...state.pinned].sort().join("\u0001"),
		JSON.stringify(state.names),
		[...state.collapsed].sort().join("\u0001"),
		[...(state.expandedGroups || [])].sort().join("\u0001"),
		state.searchQuery,
		state.searchResults.length,
		state.searchResults.map((h) => h.path).join("\u0001"),
		state.searchBusy ? 1 : 0,
		state.searchTruncated ? 1 : 0,
		sessionSig,
	].join("\u0003");
	if (key === lastSessionsKey && list.childElementCount) return;
	lastSessionsKey = key;
	// 每轮结束都会 refreshState → 重建侧栏；不记住 scrollTop 会跳回顶部
	const prevTop = list.scrollTop;
	list.innerHTML = "";

	const newBtn = document.createElement("button");
	newBtn.className = "newchat";
	newBtn.innerHTML = `${PEN_ICON}<span>新聊天</span>`;
	newBtn.onclick = newSession;
	list.append(newBtn);

	if (!state.collapsedSeeded) {
		state.collapsed = loadCollapsed();
		state.collapsedSeeded = true;
	}
	if (!state.archivedSeeded) {
		state.archived = loadArchived();
		state.archivedSeeded = true;
	}
	if (!state.archiveFilterSeeded) {
		try {
			const v = localStorage.getItem(ARCHIVE_FILTER_KEY);
			if (v === "hide" || v === "all" || v === "only") state.archiveFilter = v;
		} catch {}
		state.archiveFilterSeeded = true;
	}
	if (!state.namesSeeded) {
		state.names = loadNames();
		state.namesSeeded = true;
	}
	if (!state.pinnedSeeded) {
		state.pinned = loadPinned();
		state.pinnedSeeded = true;
	}

	// 工作区标题行：标题 + 搜索 + 绑定新项目（DSH sidebar 结构）
	const head = document.createElement("div");
	head.className = "sec-head";
	const title = document.createElement("span");
	title.className = "sec-title";
	title.textContent = "工作区";
	const grow = document.createElement("span");
	grow.className = "grow";
	const search = document.createElement("button");
	search.type = "button";
	search.className = "side-icon";
	search.title = "搜索会话";
	search.setAttribute("aria-label", "搜索会话");
	search.innerHTML = SEARCH_ICON;
	search.onclick = () => {
		state.sideSearch = !state.sideSearch;
		if (!state.sideSearch) {
			state.sideQuery = "";
			state.sideCaret = 0;
			state.searchQuery = "";
			state.searchResults = [];
			state.searchBusy = false;
			clearTimeout(state.searchTimer);
		}
		renderSessions();
	};
	const bind = document.createElement("button");
	bind.type = "button";
	bind.className = "side-icon";
	bind.title = "绑定工作项目";
	bind.setAttribute("aria-label", "绑定工作项目");
	bind.innerHTML = FOLDER_PLUS_ICON;
	bind.onclick = pifold;
	const arcFilter = document.createElement("button");
	arcFilter.type = "button";
	arcFilter.className = "side-icon";
	const ARC_MODES = {
		hide: ["隐藏归档", "归档会话已隐藏，点击显示"],
		all: ["显示全部", "含归档会话，点击只看归档"],
		only: ["仅归档", "只显示归档会话，点击恢复隐藏"],
	};
	const arcNow = ARC_MODES[state.archiveFilter] || ARC_MODES.hide;
	arcFilter.title = `归档筛选：${arcNow[1]}`;
	arcFilter.setAttribute("aria-label", `归档筛选：${arcNow[0]}`);
	arcFilter.innerHTML =
		'<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.2 5.2h11.6M4.3 5.2v6.2c0 .7.6 1.3 1.3 1.3h4.8c.7 0 1.3-.6 1.3-1.3V5.2M6.3 8h3.4"/><path d="M4.6 2.8h6.8l1 2.4H3.6l1-2.4Z"/></svg>';
	arcFilter.onclick = () => {
		const next = state.archiveFilter === "hide" ? "all" : state.archiveFilter === "all" ? "only" : "hide";
		state.archiveFilter = next;
		try {
			localStorage.setItem(ARCHIVE_FILTER_KEY, next);
		} catch {}
		renderSessions();
		notice(`归档筛选：${ARC_MODES[next][0]}`);
	};
	head.append(title, grow, search, arcFilter, bind);
	list.append(head);

	const q = String(state.sideQuery || "").trim().toLowerCase();
	if (state.sideSearch) {
		const box = document.createElement("div");
		box.className = "side-search";
		const inp = document.createElement("input");
		inp.type = "text";
		inp.placeholder = "搜索会话";
		inp.value = state.sideQuery || "";
		inp.oninput = () => {
			state.sideQuery = inp.value;
			state.sideCaret = inp.selectionStart ?? inp.value.length;
			scheduleContentSearch(inp.value);
			// 中文输入法组合期间不重建列表，否则 IME 会被打断
			if (inp.dataset.composing === "1") return;
			renderSessions();
		};
		inp.oncompositionstart = () => {
			inp.dataset.composing = "1";
		};
		inp.oncompositionend = () => {
			delete inp.dataset.composing;
			state.sideQuery = inp.value;
			state.sideCaret = inp.selectionStart ?? inp.value.length;
			renderSessions();
		};
		inp.onkeydown = (e) => {
			if (e.key === "Escape") {
				state.sideSearch = false;
				state.sideQuery = "";
				state.sideCaret = 0;
				state.searchQuery = "";
				state.searchResults = [];
				state.searchBusy = false;
				clearTimeout(state.searchTimer);
				renderSessions();
			}
		};
		box.append(inp);
		list.append(box);
		queueMicrotask(() => {
			const el = list.querySelector(".side-search input");
			if (!el) return;
			el.focus();
			const pos = Math.min(state.sideCaret ?? el.value.length, el.value.length);
			el.setSelectionRange(pos, pos);
		});
	}

	// 只显示手动绑定过的项目；当前项目一定在列表里
	if (!state.projectsSeeded) {
		state.projects = loadProjects();
		state.projectsSeeded = true;
		if (!state.projects.length && state.cwd) state.projects = [state.cwd];
		saveProjects();
	}
	if (state.cwd && !state.projects.includes(state.cwd)) {
		state.projects.unshift(state.cwd);
		saveProjects();
	}

	const ordered = buildSessionGroups({
		sessions: state.sessions,
		cwd: state.cwd,
		projects: state.projects,
		query: q,
		archiveFilter: state.archiveFilter,
		archived: state.archived,
		pinned: state.pinned,
		currentSession: state.sessionFile,
		getText: (session) => `${sessionLabel(session)} ${session.name || ""} ${session.title || ""}`,
	}).map((group) => [group.workspace, group.sessions]);

	// 首次加载且没有持久化折叠状态时，除当前项目外默认折叠
	if (!state.groupsSeeded) {
		state.groupsSeeded = true;
		let stored = null;
		try {
			stored = localStorage.getItem(COLLAPSE_KEY);
		} catch {}
		if (stored === null) {
			for (const [key] of ordered) if (key !== state.cwd) state.collapsed.add(key);
			saveCollapsed();
		}
	}

	for (const [cwd, items] of ordered) {
		const leaf = cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;
		const open = !state.collapsed.has(cwd);
		const current = cwd === state.cwd;

		const proj = document.createElement("div");
		proj.className = "proj" + (open ? " open" : "") + (current ? " current" : "");
		proj.innerHTML = `<span class="chev">›</span>${FOLDER_ICON}<span class="lbl">${esc(leaf)}</span>`;
		proj.title = cwd;
		proj.setAttribute("role", "button");
		proj.tabIndex = 0;
		proj.setAttribute("aria-expanded", open ? "true" : "false");

		const actions = document.createElement("span");
		actions.className = "proj-actions";
		const more = document.createElement("button");
		more.type = "button";
		more.className = "side-icon";
		more.title = "更多";
		more.setAttribute("aria-label", "更多");
		more.innerHTML = MORE_ICON;
		const menu = document.createElement("div");
		menu.className = "proj-menu";
		menu.hidden = true;
		const openDir = document.createElement("button");
		openDir.type = "button";
		openDir.textContent = "打开目录";
		openDir.onclick = () => window.pi.openPath(cwd);
		menu.append(openDir);
		if (!current) {
			const switchProj = document.createElement("button");
			switchProj.type = "button";
			switchProj.textContent = "切换到此项目";
			switchProj.onclick = () => bindWorkspace(cwd);
			menu.append(switchProj);
		}
		const bindNew = document.createElement("button");
		bindNew.type = "button";
		bindNew.textContent = "绑定新项目";
		bindNew.onclick = pifold;
		menu.append(bindNew);
		if (!current || state.projects.length > 1) {
			const unbind = document.createElement("button");
			unbind.type = "button";
			unbind.textContent = "从列表移除";
			unbind.onclick = () => removeProject(cwd);
			menu.append(unbind);
		}
		more.onclick = (e) => {
			e.stopPropagation();
			const wasHidden = menu.hidden;
			for (const m of document.querySelectorAll(".proj-menu, .sess-menu")) m.hidden = true;
			for (const p of document.querySelectorAll(".proj.menu-open")) p.classList.remove("menu-open");
			menu.hidden = !wasHidden;
			proj.classList.toggle("menu-open", !menu.hidden);
		};
		const newChat = document.createElement("button");
		newChat.type = "button";
		newChat.className = "side-icon";
		newChat.title = "在此工作区新建会话";
		newChat.setAttribute("aria-label", "在此工作区新建会话");
		newChat.innerHTML = PLUS_CIRCLE_ICON;
		newChat.onclick = async (e) => {
			e.stopPropagation();
			if (!current) {
				const ok = await bindWorkspace(cwd);
				if (!ok) return;
			}
			await newSession();
		};
		actions.append(more, newChat);
		proj.append(actions, menu);
		list.append(proj);

		const kids = document.createElement("div");
		const inner = document.createElement("div");
		inner.className = "kids-inner";
		kids.append(inner);
		// 切工作区后的第一次渲染：新分组用展开动画，而不是瞬间出现
		const reveal = current && !!state.lastRenderedCwd && state.lastRenderedCwd !== cwd;
		const cls = "kids" + (open ? " open" : "") + (reveal ? " reveal" : "");
		kids.className = cls;
		kids.setAttribute("aria-hidden", open ? "false" : "true");
		inner.style.overflow = open ? "" : "hidden";
		if (current) state.lastRenderedCwd = cwd;

		const setKidsOpen = (on) => {
			proj.classList.toggle("open", on);
			proj.setAttribute("aria-expanded", on ? "true" : "false");
			kids.setAttribute("aria-hidden", on ? "false" : "true");
			clearTimeout(kids._openTimer);
			if (on) {
				// 展开期间必须裁剪，动画结束后恢复，否则会话菜单会被裁掉
				inner.style.overflow = "hidden";
				kids.classList.add("open");
				kids._openTimer = setTimeout(() => {
					inner.style.overflow = "";
				}, 220);
			} else {
				inner.style.overflow = "hidden";
				kids.classList.remove("open");
			}
		};

		proj.onclick = async (e) => {
			// 菜单项自己处理，别连带折叠分组
			if (e.target.closest(".proj-menu")) return;
			if (!current) {
				// 切工作区：先展开它，让点击的反馈就是“文件夹打开”
				state.collapsed.delete(cwd);
				saveCollapsed();
				setKidsOpen(true);
				await bindWorkspace(cwd);
				return;
			}
			const nowOpen = state.collapsed.has(cwd);
			if (nowOpen) state.collapsed.delete(cwd);
			else state.collapsed.add(cwd);
			setKidsOpen(nowOpen);
			saveCollapsed();
		};
		proj.onkeydown = (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				proj.click();
			}
		};

		for (const s of items.slice(0, state.expandedGroups?.has(cwd) ? items.length : 6)) {
			inner.append(sessionRow(s));
		}
		if (items.length > 6) {
			const expanded = state.expandedGroups?.has(cwd);
			const more = document.createElement("button");
			more.type = "button";
			more.className = "item-more";
			more.textContent = expanded ? "收起" : `显示更多（${items.length - 6}）`;
			more.onclick = (e) => {
				e.stopPropagation();
				if (!state.expandedGroups) state.expandedGroups = new Set();
				if (expanded) state.expandedGroups.delete(cwd);
				else state.expandedGroups.add(cwd);
				renderSessions();
			};
			inner.append(more);
			const page = state.sessionPage || 20;
			if (expanded && items.length >= page && page < 200) {
				const load = document.createElement("button");
				load.type = "button";
				load.className = "item-more";
				load.textContent = "加载更多会话";
				load.onclick = async (e) => {
					e.stopPropagation();
					if (load.disabled) return;
					load.disabled = true;
					load.textContent = "加载中…";
					state.sessionPage = Math.min(200, page + 20);
					try {
						state.sessions = await window.pi.sessions({ perCwd: state.sessionPage });
					} catch {}
					renderSessions();
				};
				inner.append(load);
			}
		}
		list.append(kids);
	}

	const archivedItems =
		state.archiveFilter !== "hide"
			? []
			: state.sessions
					.filter((s) => state.archived.has(s.path) && s.path !== state.sessionFile)
					.filter((s) => !q || `${sessionLabel(s)} ${s.name || ""} ${s.title || ""}`.toLowerCase().includes(q))
					.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

	// 无可见会话时的空态（含搜索无匹配）
	if (!ordered.some(([, listItems]) => listItems.length) && !archivedItems.length) {
		const empty = document.createElement("div");
		empty.className = "side-empty";
		empty.textContent = q ? "没有匹配的会话" : "暂无会话";
		list.append(empty);
	}

	if (archivedItems.length) {
		const head = document.createElement("button");
		head.type = "button";
		head.className = "archived-head" + (state.archivedOpen ? " open" : "");
		head.innerHTML = `<span class="chev">›</span><span>已归档</span><span class="arch-count">${archivedItems.length}</span>`;
		head.onclick = () => {
			state.archivedOpen = !state.archivedOpen;
			renderSessions();
		};
		list.append(head);
		if (state.archivedOpen) {
			const box = document.createElement("div");
			box.className = "kids archived-kids";
			for (const s of archivedItems) box.append(sessionRow(s));
			list.append(box);
		}
	}

	paintSearchResults();
	// 搜索时列表整体换了内容，回到顶部；平时保持用户原来的滚动位置
	list.scrollTop = q ? 0 : prevTop;
}

document.addEventListener("click", () => {
	for (const m of document.querySelectorAll(".proj-menu, .sess-menu")) m.hidden = true;
	for (const p of document.querySelectorAll(".proj.menu-open")) p.classList.remove("menu-open");
});

// 开发/截图用：清空归档列表（location.reload 会被 will-navigate 拦截）
window.__piClearArchive = () => {
	state.archived.clear();
	saveArchived();
	renderSessions();
};

const capLevel = (l) => (l ? l.charAt(0).toUpperCase() + l.slice(1) : "");

const CHECK_SVG = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M2.8 7.2 5.6 10 11.2 4.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const MODEL_CHEV = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2.75 4.5 6 7.75l3.25-3.25" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const MENU_CHEV = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M4.5 2.75 7.75 6 4.5 9.25" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function renderModel() {
	const btn = $("model");
	const m = state.model;
	const name = m ? m.name || m.id : "选择模型";
	const level = capLevel(state.thinkingLevel);
	btn.textContent = "";
	const nameEl = document.createElement("span");
	nameEl.className = "model-name";
	nameEl.textContent = name;
	btn.append(nameEl);
	if (level) {
		const lv = document.createElement("span");
		lv.className = "model-level";
		lv.textContent = "· " + level;
		btn.append(lv);
	}
	const chev = document.createElement("span");
	chev.className = "model-chev";
	chev.innerHTML = MODEL_CHEV;
	btn.append(chev);
	btn.title = level ? `${name} · ${level}` : name;
}

function menuRow(label, sub, on) {
	const b = document.createElement("button");
	const opt = document.createElement("span");
	opt.className = "opt";
	opt.textContent = label;
	b.append(opt);
	if (sub) {
		const s = document.createElement("span");
		s.className = "sub";
		s.textContent = sub;
		b.append(s);
	}
	const chk = document.createElement("span");
	chk.className = "chk";
	chk.innerHTML = CHECK_SVG;
	b.append(chk);
	if (on) b.classList.add("on");
	return b;
}

const leafOf = (p) => (p || "").split(/[\\/]/).filter(Boolean).pop() || p || "";

function renderTitle() {
	const el = $("cwd-name");
	el.textContent = state.sessionName || leafOf(state.cwd) || "pi";
	$("cwd").title = state.cwd;
}

// ---------- 动作 ----------
async function refreshState() {
	const streamSeq = state.streamSeq;
	const sessionEpoch = state.sessionEpoch;
	try {
		const s = await window.pi.command({ type: "get_state" });
		// 会话切换期间可能有旧 get_state 回包晚到；它不能把新会话指针覆盖回去。
		if (sessionEpoch !== state.sessionEpoch) return false;
		state.model = s.model ?? null;
		state.thinkingLevel = s.thinkingLevel ?? state.thinkingLevel ?? null;
		state.sessionFile = s.sessionFile ?? null;
		refreshSessionMetrics();
		// 让主进程记住当前会话：pi 崩溃重启时按它续会话
		const active = window.pi.setActiveSession?.(state.sessionFile);
		if (active?.catch) active.catch(() => {});
		state.sessionName = s.sessionName ?? null;
		// 回包期间流式态已经变过（例如 settle 后队列立刻接力），别用过期值覆盖
		if (streamSeq === state.streamSeq) setStreaming(s.isStreaming ?? false);
		saveLastSession();
		renderModel();
		renderTitle();
		renderSessions();
		return true;
	} catch {}
	return false;
}

async function loadModels() {
	try {
		const d = await window.pi.command({ type: "get_available_models" });
		state.models = d.models ?? [];
	} catch {
		state.models = [];
	}
	try {
		const d = await window.pi.command({ type: "get_available_thinking_levels" });
		state.thinkingLevels = Array.isArray(d?.levels) ? d.levels : [];
	} catch {
		state.thinkingLevels = [];
	}
}

function captureWorkspaceView() {
	return {
		cwd: state.cwd,
		sessions: state.sessions,
		sessionFile: state.sessionFile,
		sessionName: state.sessionName,
		sessionPage: state.sessionPage,
		projects: [...state.projects],
	};
}

async function restoreWorkspaceView(previous) {
	state.cwd = previous.cwd;
	state.sessions = previous.sessions;
	state.sessionFile = previous.sessionFile;
	state.sessionName = previous.sessionName;
	state.sessionPage = previous.sessionPage;
	state.projects = previous.projects;
	renderTitle();
	renderSessions();
	clearStream();
	let history = null;
	if (previous.sessionFile) history = await window.pi.sessionMessages(previous.sessionFile).catch(() => null);
	if (Array.isArray(history) && history.length) renderHistory(history);
	else emptyHint();
	window.dispatchEvent(new Event("pi:cwd-changed"));
	await refreshState().catch(() => {});
	swapDraft();
}

async function bindWorkspace(cwd) {
	if (!cwd || cwd === state.cwd) return false;
	if (state.streaming) {
		notice("正在生成回答，先停止再切换工作区");
		return false;
	}
	const previous = captureWorkspaceView();
	state.switching = true;
	state.sessionEpoch += 1;
	updateSend();
	saveDraftNow();
	try {
		// 第一步：只读文件拿这个工作区的会话列表，侧栏立刻换过去（不碰 pi 进程）
		const quick = await window.pi.sessions({ cwd, perCwd: readPageSize() }).catch(() => null);
		if (quick) {
			state.cwd = cwd;
			state.sessions = quick;
			state.sessionFile = null;
			state.sessionName = null;
			state.sessionPage = readPageSize();
			state.collapsed.delete(cwd);
			// 追加而不是插队：绑定顺序保持稳定，列表不会因为切换而重排
			if (!state.projects.includes(cwd)) state.projects.push(cwd);
			saveProjects();
			saveCollapsed();
			renderTitle();
			renderSessions();
			clearStream();
			emptyHint();
		}
		// 第二步：重启 pi（切换工作区必须换进程，这一步省不掉）
		const r = await window.pi.setCwd(cwd);
		if (!r) return false;
		if (!state.projects.includes(state.cwd)) {
			state.projects.push(state.cwd);
		}
		state.cwd = r.cwd;
		// 第一步已经画过同一份列表就不再重建 DOM（工作区大时重建要几十毫秒）
		const same =
			quick &&
			Array.isArray(r.sessions) &&
			r.sessions.length === quick.length &&
			(r.sessions[0]?.path || "") === (quick[0]?.path || "");
		state.sessions = r.sessions ?? [];
		state.sessionFile = null;
		state.sessionName = null;
		state.sessionPage = readPageSize();
		state.collapsed.delete(cwd);
		saveProjects();
		saveCollapsed();
		renderTitle();
		if (!same) renderSessions();
		// 右栏的文件/变更缓存按工作区失效
		window.dispatchEvent(new Event("pi:cwd-changed"));
		rememberScroll(state.sessionFile);
		clearStream();
		emptyHint();
		await loadModels();
		await refreshState();
		swapDraft();
		return true;
	} catch (e) {
		await restoreWorkspaceView(previous);
		showError(e.message);
		return false;
	} finally {
		state.switching = false;
		updateSend();
	}
}

async function removeProject(cwd) {
	state.projects = state.projects.filter((x) => x !== cwd);
	saveProjects();
	if (cwd === state.cwd) {
		const next = state.projects[0];
		if (next) {
			await bindWorkspace(next);
			return;
		}
	}
	renderSessions();
}

async function pickSession(path, cwd) {
	if (state.streaming) {
		notice("正在生成回答，先停止再切换会话");
		return;
	}
	if (cwd && cwd !== state.cwd) {
		const ok = await bindWorkspace(cwd);
		if (!ok) return;
	}
	if (state.streaming || state.switching) {
		if (state.streaming) notice("正在生成回答，先停止再切换会话");
		return;
	}
	state.switching = true;
	state.sessionEpoch += 1;
	updateSend();
	try {
		saveDraftNow();
		rememberScroll(state.sessionFile);
		// 先用本地文件把历史画出来：pi 若还在重启，这一步就能让内容立即出现
		let painted = false;
		try {
			const local = await window.pi.sessionMessages(path);
			if (local?.length) {
				state.sessionFile = path;
				renderHistory(local);
				painted = true;
			}
		} catch {}
		const r = await window.pi.switchSession(path);
		if (r.cancelled) return;
		// 本地已经画过同一份数据就不再重绘，避免闪一下
		if (!painted) renderHistory(r.messages ?? []);
		restoreScroll(path);
		await refreshState();
		swapDraft();
	} catch (e) {
		showError(e.message);
		// 主进程可能已经提交了新的会话指针：把界面拉回来，别让下一条消息发错会话
		await refreshState().catch(() => {});
	} finally {
		state.switching = false;
		updateSend();
	}
}

async function newSession() {
	if (state.streaming) {
		notice("正在生成回答，先停止再新建会话");
		return;
	}
	state.switching = true;
	state.sessionEpoch += 1;
	updateSend();
	try {
		saveDraftNow();
		await window.pi.newSession();
		rememberScroll(state.sessionFile);
		clearStream();
		emptyHint();
		await refreshState();
		swapDraft();
	} catch (e) {
		showError(e.message);
	} finally {
		state.switching = false;
		updateSend();
	}
}

async function pifold() {
	if (state.streaming) {
		notice("正在生成回答，先停止再切换工作区");
		return;
	}
	const previous = captureWorkspaceView();
	state.switching = true;
	state.sessionEpoch += 1;
	updateSend();
	try {
		const r = await window.pi.pickFolder();
		if (!r) return;
		state.cwd = r.cwd;
		state.projects = [r.cwd, ...state.projects.filter((x) => x !== r.cwd)];
		saveProjects();
		state.sessions = r.sessions;
		state.sessionFile = null;
		state.sessionName = null;
		renderTitle();
		window.dispatchEvent(new Event("pi:cwd-changed"));
		rememberScroll(state.sessionFile);
		clearStream();
		emptyHint();
		await loadModels();
		await refreshState();
		swapDraft();
	} catch (e) {
		await restoreWorkspaceView(previous);
		showError(e.message);
	} finally {
		state.switching = false;
		updateSend();
	}
}

function showError(msg) {
	const d = document.createElement("div");
	d.className = "err";
	d.textContent = msg;
	stream.append(d);
	follow();
}

// 轻量提示：正在生成时点了不能做的操作，用浮层说明，别往聊天记录里塞错误块
let noticeTimer = 0;
let lastDoneNotice = 0;
function notice(text, action) {
	let el = document.getElementById("pi-notice");
	if (!el) {
		el = document.createElement("div");
		el.id = "pi-notice";
		el.className = "pi-notice";
		el.setAttribute("role", "status");
		el.setAttribute("aria-live", "polite");
		document.body.append(el);
	}
	el.textContent = "";
	el.append(document.createTextNode(text));
	if (action?.label && typeof action.onClick === "function") {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.textContent = action.label;
		btn.onclick = () => {
			el.classList.remove("show");
			action.onClick();
		};
		el.append(btn);
	}
	el.classList.add("show");
	clearTimeout(noticeTimer);
	noticeTimer = setTimeout(() => el.classList.remove("show"), action?.label ? 5000 : 2200);
}

// ---------- 输入草稿：按会话落盘，切会话/重启都不丢 ----------
const DRAFT_KEY = "pi-mini.draft";
let draftTimer = 0;
function currentDraftKey() {
	return state.sessionFile ? `s:${state.sessionFile}` : `c:${state.cwd || ""}`;
}
function readDrafts() {
	try {
		const o = JSON.parse(localStorage.getItem(DRAFT_KEY) || "{}");
		return o && typeof o === "object" ? o : {};
	} catch {
		return {};
	}
}
function saveDraftNow() {
	clearTimeout(draftTimer);
	const all = readDrafts();
	const key = currentDraftKey();
	if (input.value.trim()) all[key] = input.value;
	else delete all[key];
	try {
		localStorage.setItem(DRAFT_KEY, JSON.stringify(all));
	} catch {}
}
function saveDraftSoon() {
	clearTimeout(draftTimer);
	draftTimer = setTimeout(saveDraftNow, 200);
}
function loadDraft() {
	if (input.value.trim()) return;
	const v = readDrafts()[currentDraftKey()];
	if (!v) return;
	input.value = v;
	autosize();
	updateSend();
	const end = v.length;
	input.setSelectionRange(end, end);
}
// 切会话后：先清空上一个会话的草稿，再装新会话的草稿并同步输入框尺寸/发送键
function swapDraft() {
	input.value = "";
	loadDraft();
	autosize();
	updateSend();
}

async function submit() {
	const extra = attachments.get() || [];
	const text = input.value.trim();
	if ((!text && !extra.length) || state.streaming || state.switching) return false;
	input.value = "";
	autosize();
	updateSend();
	// 文档：抽出的纯文本拼在正文后面，跟图片一起作为一次 prompt
	const { docs, images } = splitAttachments(extra);
	const body = composeMessage(text, docs);
	addUser(text || `[${extra.length} 个附件]`, extra);
	state.pendingUserEcho = text;
	state.aborted = false;
	state.abortRow = null;
	state.lastTurnAborted = false;
	const row = stream.lastElementChild;
	// 图片消息的重试不能把 “[N 张图片]” 当正文发出去
	if (extra.length && row?.classList.contains("mine")) row.dataset.images = String(extra.length);
	setStreaming(true);
	try {
		const cmd = { type: "prompt", message: body };
		// pi 只认 {type,data,mimeType}；url/name/w/h 是本地渲染用的，别塞进 RPC
		if (images.length) cmd.images = toRpcImages(images);
		const res = await window.pi.command(cmd);
		saveDraftNow();
		attachments.clear();
		// 扩展/输入处理器可能直接吞掉 prompt：只回 response，不发 agent 事件
		if (res?.disposition === "handled") {
			setStreaming(false);
			state.pendingUserEcho = "";
		} else {
			watchPromptStart();
		}
	} catch (e) {
		// 发送失败：回滚刚插入的“假发送”气泡，并把草稿还给用户
		if (row?.classList.contains("mine")) row.remove();
		if (!input.value) {
			input.value = text;
			autosize();
			updateSend();
		}
		saveDraftSoon();
		showError(e.message);
		setStreaming(false);
		state.pendingUserEcho = "";
	}
	return true;
}

// prompt 已 resolve 却一直没有 agent_start：10s 后核对 pi 状态，空闲就收掉流式态
function watchPromptStart() {
	setTimeout(() => {
		if (!state.streaming || state.live) return;
		window.pi.command({ type: "get_state" })
			.then((s) => {
				if (state.streaming && !state.live && s && s.isStreaming === false) {
					setStreaming(false);
					state.pendingUserEcho = "";
				}
			})
			.catch(() => {});
	}, 10000);
}

function abortRun() {
	if (!state.streaming) return;
	state.aborted = true;
	state.turn = requestAbort(state.turn);
	// 只标本轮自己创建的行；没有 live 行就不标，别把上一条历史回答写成“已停止”
	state.abortRow = state.live?.row || null;
	window.pi.command({ type: "abort" })
		.then(() => {
			setTimeout(() => {
				if (!state.streaming) return;
				window.pi.command({ type: "get_state" })
					.then((s) => {
						// pi 已空闲但没发 agent_settled（例如 abort 时它本来就没在跑）
						if (s && s.isStreaming === false) finishAbortedTurn();
					})
					.catch(() => {});
			}, 3000);
		})
		.catch(() => {
			state.aborted = false;
			state.abortRow = null;
		});
}

function finishAbortedTurn() {
	if (!state.streaming) return;
	setStreaming(false);
	if (state.live) finalizeAssistant(currentAssistant().finalMessage);
	state.turn = settleTurn(state.turn, "aborted");
	settleRunStatus();
	collapseTurnBlocks();
	markStopped();
	state.aborted = false;
	state.lastTurnAborted = true; // 队列不要在被中断后自动接力
	state.abortRow = null;
	state.runTps = 0;
	state.runSpeed = { tokens: 0, ms: 0 };
	refreshState().catch(() => {});
}

function markStopped() {
	const row = state.abortRow;
	const body = row?.isConnected ? row.querySelector(":scope > .body") : null;
	if (body && !body.querySelector(":scope > .stopped")) {
		const stop = document.createElement("span");
		stop.className = "stopped";
		stop.textContent = "已停止";
		body.append(stop);
	}
}

function setStreaming(on) {
	state.streaming = on;
	window.__piStreaming = on;
	// 端到端专用：不经侧栏直接打开某个会话（侧栏加载依赖展开时序，测试里不稳定）
	window.__mynaPickSession = (path, cwd) => pickSession(path, cwd);
	state.streamSeq += 1; // 让在途的 get_state 回包知道状态已经变了
	sendBtn.classList.toggle("stop", on);
	updateSend();
}

// 新会话的 sessionFile 可能只在第一轮开始后才出现；提前同步指针，
// 这样 pi 在首轮中途崩溃时，重启仍能恢复原会话，而不是另开空会话。
async function syncSessionPointer() {
	const epoch = state.sessionEpoch;
	try {
		const s = await window.pi.command({ type: "get_state" });
		if (epoch !== state.sessionEpoch || !s?.sessionFile) return false;
		state.sessionFile = s.sessionFile;
		if (s.sessionName != null) state.sessionName = s.sessionName;
		window.pi.setActiveSession?.(state.sessionFile)?.catch?.(() => {});
		saveLastSession();
		renderTitle();
		renderSessions();
		return true;
	} catch {
		return false;
	}
}

// 取本轮统计并重置运行态。展示交给 foldTurnProcess 的「过程」块，不再另插一条完成提示。
function takeRunStats() {
	const turn = state.turn;
	const startedAt = turn.startedAt;
	const seconds = startedAt ? (performance.now() - startedAt) / 1000 : 0;
	const tools = turn.toolCount;
	const tps = state.runTps;
	state.runTps = 0;
	state.runSpeed = { tokens: 0, ms: 0 };
	state.turn = resetTurn();
	return { seconds, tools, tps };
}

function autosize() {
	input.style.height = "auto";
	input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
}

function updateSend() {
	const hasImages = (attachments.get() || []).length > 0;
	const on = !state.switching && (state.streaming || input.value.trim().length > 0 || hasImages);
	sendBtn.classList.toggle("on", on);
	// 空草稿空闲时真正禁用，避免 Tab 到无反馈的按钮；流式时是停止键，保持可用
	sendBtn.disabled = !on;
}

// ---------- 事件 ----------
window.pi.onEvent((ev) => {
	// 广播原始 pi 事件，供只读扩展 UI 观察；产品状态仍由下方 pi 事件模型驱动
	try {
		window.dispatchEvent(new CustomEvent("myna:event", { detail: ev }));
	} catch {}
	switch (ev.type) {
		case "message_start": {
			const m = ev.message;
			if (m?.role === "assistant") {
				// 一轮里可能有多条 assistant 消息（文本→工具→文本）：每条各自成行。
				// 旧行还有没吐完/没定稿的内容就先收尾，否则 msg2 的 message_end 会把 msg1 冲掉。
				if (state.live && (currentAssistant().text || currentAssistant().thinking || state.liveThink || currentAssistant().pendingText)) {
					finalizeAssistant(currentAssistant().finalMessage);
				}
				if (!state.live) addAssistantRow();
				state.turn = noteAssistantMessage(state.turn, m);
				// 请求已发出：作为 TTFT 的起点（DSH 的 stepStartTime）
				if (state.liveTps && !state.liveTps.start) state.liveTps.start = performance.now();
			} else if (m?.role === "user") {
				// 排队/插话发出的消息由 pi 回显；submit 自己插过的那条要跳过，别重复。
				const text = blockText(m.content).trim();
				const echo = state.pendingUserEcho.trim();
				if (text && echo && (text === echo || text.includes(echo) || echo.includes(text))) {
					state.pendingUserEcho = "";
				} else if (text) {
					addUser(text);
				}
			}
			break;
		}
		case "message_update": {
			// agent_settled 后的迟到事件不能重新创建空 assistant 行。
			if (state.turn.phase === "settled" && !state.live) break;
			const a = ev.assistantMessageEvent;
			if (!state.live && ["thinking_start", "thinking_delta", "thinking_end", "text_delta"].includes(a?.type)) {
				addAssistantRow();
			}
			state.turn = applyAssistantEventToTurn(state.turn, a);
			if (a?.type === "thinking_start") {
				ensureLiveThink();
				break;
			}
			if (a?.type === "thinking_delta") {
				markOutputTokens(a.delta);
				const th = ensureLiveThink();
				if (th) {
					th.setText(currentAssistant().thinking, true);
					follow();
				}
				break;
			}
			if (a?.type === "thinking_end") {
				const th = state.liveThink;
				if (th) {
					th.finish(currentAssistant().thinking || "");
				}
				break;
			}
			if (a?.type === "text_delta") {
				markOutputTokens(a.delta);
				scheduleReveal();
				follow();
			}
			break;
		}
		case "message_end": {
			if (ev.message?.role === "assistant") {
				state.turn = finishAssistantMessageInTurn(state.turn, ev.message);
				// 解码结束时间要在事件到达时记，不能等吐字动画放完
				if (state.liveTps) state.liveTps.endAt = performance.now();
				if (currentAssistant().pendingText) {
					scheduleReveal();
				} else {
					finalizeAssistant(ev.message);
				}
			}
			break;
		}
		case "tool_execution_start": {
			// pi TUI 将嵌套 ctx.executeTool() 调用收在父卡里，不单独显示顶层卡。
			if (ev.parentToolCallId) break;
			if (state.tools.has(ev.toolCallId)) break;
			state.turn = noteToolStart(state.turn, ev.toolCallId);
			state.turn = applyAssistantEventToTurn(state.turn, {
				type: "tool_execution_start",
				toolCallId: ev.toolCallId,
				toolName: ev.toolName,
				args: ev.args,
			});
			const el = buildToolRow({ name: ev.toolName, args: ev.args });
			el.classList.add("running", "fresh");
			state.tools.set(ev.toolCallId, el);
			// 正文可能还在吐字（message_end 之后才开始的工具）：先留在映射里，
			// 别被 finalize 的 innerHTML 冲掉
			mountTool(el);
			follow();
			break;
		}
		case "tool_execution_update": {
			if (ev.parentToolCallId) break;
			state.turn = applyAssistantEventToTurn(state.turn, {
				type: "tool_execution_update",
				toolCallId: ev.toolCallId,
				partialResult: ev.partialResult,
			});
			const el = state.tools.get(ev.toolCallId);
			if (!el) break;
			// partialResult 可能每秒来很多次；每次都清空重建 inner 会直接拖死渲染层
			scheduleToolPaint(el, ev.partialResult, false);
			break;
		}
		case "tool_execution_end": {
			if (ev.parentToolCallId) break;
			state.turn = applyAssistantEventToTurn(state.turn, {
				type: "tool_execution_end",
				toolCallId: ev.toolCallId,
				result: ev.result,
				isError: ev.isError,
				durationMs: ev.durationMs,
			});
			const el = state.tools.get(ev.toolCallId);
			if (!el) break;
			el.classList.remove("running");
			flushToolPaint(el, ev.result, ev.isError, ev.durationMs);
			// 已挂载的结果不再需要主进程事件映射；尚未挂载的卡片留到 finalize。
			if (el.isConnected) state.tools.delete(ev.toolCallId);
			break;
		}
		case "agent_start": {
			syncSessionPointer().catch(() => {});
			const wasRunning = state.turn.phase === "running";
			state.turn = beginTurn(state.turn, performance.now());
			setStreaming(true);
			// pi 的 continue 会再次发 agent_start：整轮只在第一次开始计时/计数
			if (!wasRunning) {
				state.runSpeed = { tokens: 0, ms: 0 };
				state.turnRows = [];
			}
			// 上一轮的过程块保持折叠态，不因新一轮开始而展开
			// 不等 message_start：发送后立刻出「思考中… 00:00:00」，工具阶段也有反馈
			if (!state.live && !currentAssistant().finalMessage) addAssistantRow();
			break;
		}
		case "agent_settled": {
			// 以 pi 的事件字段为权威，同时保留本地 abort 的即时闩锁。
			const aborted = Boolean(ev.aborted || state.aborted);
			if (!state.streaming && state.turn.phase === "settled") break;
			if (aborted) {
				state.aborted = true;
				if (!state.abortRow) state.abortRow = state.live?.row || null;
			}
			const outcome = aborted ? "aborted" : "ok";
			setStreaming(false);
			// 中断时 finalize 会重写 body.innerHTML：先把没吐完的尾巴收掉，再画「已停止」，
			// 顺序反了标记会被冲掉（长文本吐字比 message_end 晚，settle 可能先到）
			if (state.live) finalizeAssistant(currentAssistant().finalMessage);
			state.turn = settleTurn(state.turn, outcome);
			// 运行中状态行只在运行期存在，一轮结束就收掉
			settleRunStatus();
			// 队列接力要用：settle 后 state.aborted 就被清掉了。
			// 只置真不置假——abortRun 的 3s 兜底可能已经清掉 aborted，
			// 晚到的 settle 不能把「用户中断」的闩锁覆盖掉。
			if (state.aborted) state.lastTurnAborted = true;
			// 回话结束：工具卡、命令输出、思考块统一折回去
			collapseTurnBlocks();
			for (const tool of state.tools.values()) tool.classList.remove("running");
			state.tools.clear();
			if (state.aborted) {
				markStopped();
				state.aborted = false;
				state.abortRow = null;
			}
			state.pendingUserEcho = "";
			// 只思考、没正文也没工具/图片的空回合不留下空白行（例如请求被 pi 内部吞掉）
			const lastRow = [...stream.querySelectorAll(".row.assistant")].pop();
			const lastBody = lastRow?.querySelector(":scope > .body");
			if (lastBody && !lastBody.textContent.trim() && !lastBody.querySelector("img, .tool, pre, table, .stopped")) lastRow.remove();
			// 整轮过程收成一个可展开块，正文留在外面
			const runStats = takeRunStats();
			foldTurnProcess(state.turnRows, runStats);
			state.turnRows = [];
			follow();
			// 新会话的第一轮结束后 sessionFile 才有值，刷新一次便于下次启动恢复
			refreshState().catch(() => {});
			break;
		}
		case "session_info_changed":
			refreshSessionList(0);
			break;
		case "error":
			// pi 桥的可见错误。
			showError(ev.message || "发生错误");
			break;
		case "process_exit": {
			window.__piExitSeen = true;
			window.__piLastExit = Number.isFinite(ev.code) ? ev.code : null;
			state.lastPiExit = window.__piLastExit;
			console.warn("[pi] process exited", ev.code);
			// pi 子进程退出：下一条消息会自动重启；先把流式态收尾，否则光标会一直转
			if (state.streaming) {
				setStreaming(false);
				if (state.live) finalizeAssistant(currentAssistant().finalMessage);
				settleRunStatus();
				collapseTurnBlocks();
			}
			// 半轮也要收起来，否则思考与工具会散在界面上
			foldTurnProcess(state.turnRows, null);
			state.turnRows = [];
			state.turn = settleTurn(state.turn, "failed");
			state.aborted = false;
			state.abortRow = null;
			state.pendingUserEcho = "";
			state.lastTurnAborted = true; // 进程死了，队列先停，别自动乱发
			state.runTps = 0;
			state.runSpeed = { tokens: 0, ms: 0 };
			showError(ev.message || "pi 进程意外退出，下一条消息会自动重启");
			notice("pi 已停止运行", {
				label: "重启 pi",
				onClick: () => {
					window.pi
						.command({ type: "get_state" })
						.then(() => notice("pi 已恢复"))
						.catch((err) => showError(err?.message || "pi 重启失败"));
				},
			});
			follow();
			break;
		}
	}
});

window.pi.onStderr((t) => {
	if (t) state.lastPiError = String(t).slice(-1200);
	if (/error|Error/.test(t)) console.warn("[pi]", t);
});

// 外部 pi 进程新建/删除会话：主进程轮询目录指纹后推送
window.pi.onSessionsChanged?.(() => refreshSessionList(300));
document.addEventListener("visibilitychange", () => {
	if (!document.hidden && sessionListDirty) refreshSessionList(0);
});

// ---------- 交互 ----------
input.addEventListener("input", () => {
	autosize();
	updateSend();
	saveDraftSoon();
});
input.addEventListener("keydown", (e) => {
	if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
		e.preventDefault();
		submit();
	}
});
document.addEventListener("keydown", (e) => {
	if (e.key !== "Escape") return;
	// 模型菜单在二级面板时，Esc 先返回根面板；关菜单这一下不能顺带 abort
	if (!menu.hidden) {
		e.preventDefault();
		if (menuBack) menuBack();
		else {
			menu.hidden = true;
			menuBack = null;
		}
		return;
	}
	menuBack = null;
	if (state.streaming) abortRun();
});
sendBtn.onclick = () => {
	if (state.streaming) abortRun();
	else submit();
};
$("cwd").onclick = pifold;
$("toggle").onclick = () => {
	const app = $("app");
	const collapsed = app.classList.toggle("rail-hidden");
	$("toggle").classList.toggle("on", !collapsed);
};

$("model").onclick = async (e) => {
	e.stopPropagation();
	if (!menu.hidden) {
		menu.hidden = true;
		menuBack = null;
		return;
	}
	const anchor = e.currentTarget;
	const place = () => {
		const r = anchor.getBoundingClientRect();
		menu.style.right = Math.max(12, window.innerWidth - r.right) + "px";
		menu.style.bottom = window.innerHeight - r.top + 6 + "px";
		menu.style.maxHeight = Math.max(160, Math.min(440, r.top - 24)) + "px";
	};
	const close = () => {
		menu.hidden = true;
		menuBack = null;
	};
	const cell = (label, value, on) => {
		const b = document.createElement("button");
		b.className = "menu-cell";
		const l = document.createElement("span");
		l.className = "cell-label";
		l.textContent = label;
		const v = document.createElement("span");
		v.className = "cell-value";
		v.textContent = value;
		const c = document.createElement("span");
		c.className = "cell-chev";
		c.innerHTML = MENU_CHEV;
		b.append(l, v, c);
		b.onclick = (ev) => {
			ev.stopPropagation();
			on();
		};
		return b;
	};
	const backRow = (fn) => {
		const b = document.createElement("button");
		b.className = "menu-back";
		b.innerHTML = '<span class="back-chev">‹</span><span>返回</span>';
		b.onclick = (ev) => {
			ev.stopPropagation();
			fn();
		};
		return b;
	};
	const rootPane = () => {
		menuBack = null;
		menu.innerHTML = "";
		const cur = state.model?.name || state.model?.id || "未选择";
		menu.append(cell("模型", cur, modelPane));
		if (state.thinkingLevels.length) menu.append(cell("思考档位", capLevel(state.thinkingLevel) || "默认", effortPane));
		place();
	};
	const modelPane = () => {
		menuBack = rootPane;
		menu.innerHTML = "";
		menu.append(backRow(rootPane));
		const byProvider = new Map();
		for (const m of state.models) {
			const p = m.provider || "默认";
			if (!byProvider.has(p)) byProvider.set(p, []);
			byProvider.get(p).push(m);
		}
		const list = document.createElement("div");
		list.className = "menu-list";
		menu.append(list);
		const paint = (q) => {
			list.innerHTML = "";
			const needle = q.trim().toLowerCase();
			let hit = 0;
			for (const [prov, arr] of byProvider) {
				const rows = arr.filter((m) => !needle || `${m.name || ""} ${m.id || ""}`.toLowerCase().includes(needle));
				if (!rows.length) continue;
				hit += rows.length;
				const sec = document.createElement("div");
				sec.className = "menu-sec";
				sec.textContent = prov;
				list.append(sec);
				for (const m of rows) {
					const on = !!state.model && m.id === state.model.id && m.provider === state.model.provider;
					const b = menuRow(m.name || m.id, "", on);
					b.onclick = async (ev) => {
						ev.stopPropagation();
						close();
						try {
							const d = await window.pi.command({ type: "set_model", provider: m.provider, modelId: m.id });
							if (d && (d.id || d.modelId)) state.model = d;
							await loadModels();
							await refreshState();
							renderModel();
						} catch (err) {
							showError(err.message);
						}
					};
					list.append(b);
				}
			}
			if (!hit) {
				const empty = document.createElement("div");
				empty.className = "menu-empty";
				empty.textContent = "没有匹配的模型";
				list.append(empty);
			}
			place();
		};
		if (state.models.length > 4) {
			const box = document.createElement("input");
			box.className = "menu-search";
			box.type = "text";
			box.placeholder = "搜索模型";
			box.setAttribute("aria-label", "搜索模型");
			box.addEventListener("input", () => paint(box.value));
			box.addEventListener("click", (ev) => ev.stopPropagation());
			box.addEventListener("keydown", (ev) => {
				ev.stopPropagation();
				if (ev.key !== "Escape") return;
				ev.preventDefault();
				rootPane();
			});
			menu.insertBefore(box, list);
			paint("");
			setTimeout(() => box.focus(), 0);
		} else {
			paint("");
		}
	};
	const effortPane = () => {
		menuBack = rootPane;
		menu.innerHTML = "";
		menu.append(backRow(rootPane));
		const sec = document.createElement("div");
		sec.className = "menu-sec";
		sec.textContent = "思考档位";
		menu.append(sec);
		for (const level of state.thinkingLevels) {
			const b = menuRow(capLevel(level), "", level === state.thinkingLevel);
			b.onclick = async (ev) => {
				ev.stopPropagation();
				close();
				try {
					await window.pi.command({ type: "set_thinking_level", level });
					state.thinkingLevel = level;
					renderModel();
				} catch (err) {
					showError(err.message);
				}
			};
			menu.append(b);
		}
		place();
	};
	rootPane();
	menu.hidden = false;
	place();
};
menu.addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", () => {
	menu.hidden = true;
	menuBack = null;
});
new MutationObserver(() => {
	$("model").classList.toggle("open", !menu.hidden);
}).observe(menu, { attributes: true, attributeFilter: ["hidden"] });

// ---------- 开发自检 ----------
// 吐字仪表验收：不调用模型，按 text_delta 的真实路径喂合成增量
window.__piTpsDemo = (durationMs = 4000) => {
	if (state.streaming || state.live) return false;
	state.turn = beginTurn(state.turn, performance.now());
	state.turn = noteAssistantMessage(state.turn, { id: "tps-demo" });
	addAssistantRow();
	stream.scrollTop = stream.scrollHeight;
	// 模拟 0.8s 的首字延迟，让 TTFT 读数可见
	if (state.liveTps) state.liveTps.start = performance.now() - 800;
	const end = performance.now() + Math.max(800, durationMs);
	let i = 0;
	const timer = setInterval(() => {
		if (performance.now() > end) {
			clearInterval(timer);
			return;
		}
		const delta = "这是一段用于验证实时吐字仪表的示例文本，速度会自然起伏。".slice(0, 10 + (i % 20));
		i++;
		state.turn = applyAssistantEventToTurn(state.turn, { type: "text_delta", delta });
		const n = estimateTokens(delta);
		state.liveTokens += n;
		const st = state.liveTps;
		if (st) {
			const now = performance.now();
			if (!st.start) st.start = now;
			if (!st.firstToken) {
				st.firstToken = now;
				if (st.text) st.text.textContent = "生成中…";
			}
			st.marks.push({ t: now, n });
		}
		scheduleReveal();
	}, 60);
	return true;
};
window.__piTpsDemoClear = () => {
	clearInterval(state.tpsTimer);
	state.tpsTimer = 0;
	state.live?.row?.remove();
	state.live = null;
	state.liveText = null;
	state.liveTokens = 0;
	state.liveTps = null;
	state.runSpeed = { tokens: 0, ms: 0 };
	state.turn = resetTurn();
	state.runTps = 0;
	settleRunStatus();
};

window.__selftest = () => {
	const BS = String.fromCharCode(92);
	const sample = [" 1 line1", "-2 line2", "+2 line2 changed", " 3 line3", " 4 line4", "+6 line6"].join(String.fromCharCode(10));
	const el = buildToolRow({ name: "edit", args: { path: "C:/Users/Luke/projects/pi-mini/app.js" }, diff: sample, durationMs: 12 });
	const row = document.createElement("div");
	row.className = "row assistant";
	row.style.order = "1";
	const body = document.createElement("div");
	body.className = "body";
	body.append(el);
	row.append(body);
	stream.append(row);
	toggleDisclosure(el, true);

	// markdown + 代码块样例，验证 shiki 懒高亮
	const mdRow = document.createElement("div");
	mdRow.className = "row assistant";
	const mdBody = document.createElement("div");
	mdBody.className = "body";
	const f = String.fromCharCode(96, 96, 96);
	mdBody.innerHTML = md(
		[
			"这是 **加粗** 和 `行内代码`，路径 C:/Users/Luke/projects/pi-mini/app.js",
			"",
			"跨行内代码的粗体：**这套从来没装过快捷方式，一直是终端 `npm start` 启动的。**",
			"",
			f + "typescript",
			"const answer: number = 42;",
			"export function add(a: number, b: number) {",
			"  return a + b;",
			"}",
			f,
			"",
			"- 列表项一",
			"- 列表项二",
			"",
			"链接测试：[app.js](C:/Users/Luke/projects/pi-mini/app.js) 和 [GitHub](https://github.com)",
			`裸路径：见 C:/Users/Luke/projects/pi-mini/main.js。还有 C:${BS}Program Files${BS}Common Files${BS}x.dll 结尾`,
		].join(String.fromCharCode(10)),
	);
	mdRow.append(mdBody);
	stream.append(mdRow);
	applyHighlight(mdBody);

	// 过程折叠样例：一轮 = 思考 + 工具 + 最终回答。
	// 第一轮保持默认收起，第二轮预先展开，一张图同时看两种状态。
	const LS = String.fromCharCode(10);
	const makeTurn = (text, tools, think) => {
		const row = document.createElement("div");
		row.className = "row assistant";
		if (think) row.append(makeThinkBlock(think, false).wrap);
		const body = document.createElement("div");
		body.className = "body";
		body.innerHTML = md(text);
		for (const t of tools) body.append(t);
		row.append(body);
		stream.append(row);
		return row;
	};
	const readEl = buildToolRow({
		name: "read",
		args: { path: "C:/Users/Luke/projects/pi-mini/app.js", offset: 120 },
		output: ["const a = 1;", "const b = 2;", "export { a, b };"].join(LS),
		durationMs: 4,
	});
	const grepEl = buildToolRow({
		name: "grep",
		args: { pattern: "export" },
		output: [
			"C:/Users/Luke/projects/pi-mini/app.js:12:export const x = 1",
			"C:/Users/Luke/projects/pi-mini/app.js:40:export const y = 2",
			"C:/Users/Luke/projects/pi-mini/main.js:7:export default 0",
		].join(LS),
		durationMs: 9,
	});
	const turnA = [
		makeTurn("先看一下导出位置。", [readEl], "需要找 export 的位置。"),
		makeTurn("确认完毕，**结论**在下面。", [], null),
	];
	const foldedA = foldTurnProcess(turnA, { seconds: 12.4, tps: 48 });

	const readEl2 = buildToolRow({
		name: "read",
		args: { path: "C:/Users/Luke/projects/pi-mini/main.js" },
		output: ["const T0 = Date.now();", "// 窗口与 IPC"].join(LS),
		durationMs: 3,
	});
	const turnB = [
		makeTurn("接着看主进程入口。", [readEl2, grepEl], "主进程才是真正要改的。"),
		makeTurn("到这里就够了。", [], null),
	];
	const foldedB = foldTurnProcess(turnB, { seconds: 6.8, tps: 61 });
	foldedB?.querySelector(".proc")?.setAttribute("open", "");
	foldedA?.querySelector(".proc")?.setAttribute("aria-label", "上一轮的过程");

	stickBottom = true;
	stream.scrollTop = stream.scrollHeight;
	return true;
};

// ---------- 启动 ----------
function showBootError(err) {
	stream.querySelectorAll(".empty").forEach((n) => n.remove());
	const wrap = document.createElement("div");
	wrap.className = "empty boot-error";
	const msg = err?.message || String(err || "未知错误");
	// 找不到 pi 是最常见的启动失败：直接把要执行的命令摆出来，别让人去猜
	const needsPi = /没有找到 pi|找不到 pi/.test(msg);
	const title = document.createElement("p");
	title.className = "empty-title";
	title.textContent = needsPi ? "需要先安装 pi" : "连不上 pi";
	const sub = document.createElement("p");
	sub.className = "empty-sub";
	sub.textContent = msg;
	const retry = document.createElement("button");
	retry.type = "button";
	retry.className = "boot-retry";
	retry.textContent = "重试";
	retry.onclick = () => {
		retry.disabled = true;
		retry.textContent = "正在重试…";
		bootApp();
	};
	wrap.append(title, sub);
	if (needsPi) {
		const box = document.createElement("div");
		box.className = "boot-cmd";
		const code = document.createElement("code");
		code.textContent = "npm install -g @earendil-works/pi-coding-agent";
		const copy = document.createElement("button");
		copy.type = "button";
		copy.className = "boot-copy";
		copy.textContent = "复制";
		copy.onclick = async () => {
			try {
				await navigator.clipboard.writeText(code.textContent);
				copy.textContent = "已复制";
				setTimeout(() => (copy.textContent = "复制"), 1500);
			} catch {
				copy.textContent = "复制失败";
			}
		};
		box.append(code, copy);
		wrap.append(box);
	}
	wrap.append(retry);
	stream.append(wrap);
}

let booting = false;
async function bootApp() {
	if (booting) return;
	booting = true;
	stream.querySelectorAll(".empty").forEach((n) => n.remove());
	const loading = emptyHint("正在连接…");
	input.placeholder = "使用 pi";
	// pi 冷启动要 4~5 秒（加载扩展与模型目录）。这段时间先用本地会话文件把历史画出来，
	// 否则窗口从出现到有内容之间是一整块白屏。
	let prefilledPath = null;
	try {
		const local = await window.pi.localHistory().catch(() => null);
		if (local?.messages?.length) {
			state.cwd = local.cwd || state.cwd;
			state.sessionFile = local.path;
			state.sessionName = local.name;
			loading.remove();
			renderHistory(local.messages);
			renderTitle();
			prefilledPath = local.path;
			// 打点：这行日志就是「白屏结束」的时刻
			console.warn("[perf] local history painted", local.messages.length, "msgs at", Math.round(performance.now()), "ms");
		}
	} catch {}
	try {
		const boot = await window.pi.boot();
		window.__piE2E = Boolean(boot.e2e);
		window.__piE2EOnboarding = Boolean(boot.onboardingE2e);
		state.cwd = boot.cwd;
		state.sessions = boot.sessions;
		renderTitle();
		autosize();
		updateSend();
		await loadModels();
		const last = loadLastSession();
		const restore = restoreAllowed();
		await refreshState();
		if (restore && boot.restore) {
			const r = await window.pi.switchSession(boot.restore).catch(() => null);
			if (r && !r.cancelled) {
				if (prefilledPath !== boot.restore) renderHistory(r.messages ?? []);
				await refreshState();
				sessionBootDone = true;
				saveLastSession();
				loadDraft();
				window.__ready = true;
				return;
			}
		}
		// 重启后回到上次会话；找不到就按新会话处理
		if (restore && last && last.cwd === boot.cwd) {
			const r = await window.pi.switchSession(last.path).catch(() => null);
			if (r && !r.cancelled) {
				loading.remove();
				if (prefilledPath !== last.path) renderHistory(r.messages ?? []);
				await refreshState();
				sessionBootDone = true;
				saveLastSession();
				loadDraft();
				window.__ready = true;
				return;
			}
		}
		const history = await window.pi.command({ type: "get_messages" }).catch(() => null);
		loading.remove();
		renderHistory(history?.messages ?? []);
		sessionBootDone = true;
		saveLastSession();
		loadDraft();
		window.__ready = true;
	} catch (e) {
		console.warn("[boot] failed", e);
		loading.remove();
		showBootError(e);
	} finally {
		booting = false;
	}
}
// 开发/截图用：手动重跑启动流程 / 渲染启动失败态
window.__piBoot = bootApp;
window.__piBootError = (msg) => showBootError(new Error(msg || "未知错误"));
// 渲染层最后的兜底：错误进主进程日志（console-message 会转发），不让故障静默
window.addEventListener("error", (e) => {
	console.error("[renderer:error]", e.message, e.filename, e.lineno);
});
window.addEventListener("unhandledrejection", (e) => {
	const reason = e.reason;
	console.error("[renderer:rejection]", reason?.stack || reason?.message || String(reason));
});

initScroll();
window.addEventListener("beforeunload", saveDraftNow);
bootApp();

// ---------- 模块扩展点（子代理按模块接入）----------
export const ctx = {
	state,
	stream,
	input: $("input"),
	pi: window.pi,
	md,
	esc,
	buildToolRow,
	toggleDisclosure,
	relPath,
	follow,
	addUser,
	submit,
	attachments,
	pickFolder: pifold,
	reload: renderHistory,
	refreshState,
	focusMessage,
	ICON: { terminal: ICON_TERMINAL, doc: ICON_DOC, pencil: ICON_PENCIL, search: ICON_SEARCH, grid: ICON_GRID, dot: ICON_DOT },
};
window.__piui = ctx;

// 新增功能模块登记在这里；每个模块导出 init(ctx)
const FEATURES = ["./features/onboarding.js", "./features/code-toolbar.js", "./features/message-actions.js", "./features/input-trigger.js", "./features/message-retry.js", "./features/message-fork.js", "./features/json-view.js", "./features/empty-chips.js", "./features/context-meter.js", "./features/extension-ui.js", "./features/queue.js", "./features/export-html.js", "./features/attachments.js", "./features/settings.js", "./features/right-panel.js", "./features/image-preview.js", "./features/terminal.js", "./features/shortcuts.js", "./features/sidebar-resize.js", "./features/turn-rail.js", "./features/update-notice.js"];

for (const f of FEATURES) {
	try {
		const m = await import(f);
		m.init?.(ctx);
		console.log("[feature] loaded", f);
	} catch (e) {
		console.error("[feature] failed", f, e?.message);
	}
}
