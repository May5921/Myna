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
	archived: new Set(),
	archivedOpen: false,
	searchResults: [],
	searchQuery: "",
	searchBusy: false,
	searchTruncated: false,
	searchSeq: 0,
	searchTimer: 0,
	projects: [],
	projectsSeeded: false,
	live: null, // 正在流式的 assistant 行
	liveText: null, // 流式文本节点（增量追加，不重排）
	liveRaw: "",
	textPending: "", // 待吐出的文本（pi-web 式匀速吐字）
	revealRaf: 0,
	revealTick: 0,
	revealFinal: null, // message_end 到达但文本还没吐完时暂存
	liveTps: null, // 流式速度指示（tokens / tok/s）
	liveThink: null, // 流式思考块（thinking_delta）
	liveThinkRaw: "",
	liveTokens: 0, // 已接收文本的增量 token 估算
	tpsTimer: 0,
	runClock: null, // 运行中状态行（思考中/生成中 + 已用时间，DSH RunningStatus）
	pendingTools: [], // 正文还没落定时先排队的工具卡，finalize 写完 innerHTML 再插入
	aborted: false, // 用户主动中断：settle 时画“已停止”标记（DSH 的 stopped tag）
	runStart: 0,
	runTools: 0,
	tools: new Map(),
};

// 图片附件桥：features/attachments.js 覆盖 get/clear
const attachments = { get: () => [], clear: () => {} };

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

const inlineMd = (s) =>
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
			text = linkifyPaths(text).replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
			return text.replace(/%%SLOT(\d+)%%/g, (_m, i) => slots[Number(i)] ?? "");
		})
		.join("");

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
	if (stickBottom) stream.scrollTop = stream.scrollHeight;
}

function initScroll() {
	const jump = $("jump");
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
	// 回答里的路径变成可点链接
	stream.addEventListener("click", (e) => {
		const link = e.target.closest(".flink");
		if (!link) return;
		e.preventDefault();
		window.pi.openPath(link.dataset.path);
	});
}

function clearStream() {
	stopReveal();
	state.textPending = "";
	state.revealFinal = null;
	state.liveThink = null;
	state.liveThinkRaw = "";
	if (state.tpsTimer) clearInterval(state.tpsTimer);
	state.tpsTimer = 0;
	state.runClock = null;
	state.pendingTools = [];
	state.liveTps = null;
	state.liveTokens = 0;
	stream.innerHTML = "";
	state.live = null;
	state.liveText = null;
	state.liveRaw = "";
	state.tools.clear();
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
function addUser(text) {
	stream.querySelector(".empty")?.remove();
	const row = document.createElement("div");
	row.className = "row mine";
	const bubble = document.createElement("div");
	bubble.className = "user";
	bubble.textContent = text;
	row.append(bubble);
	stream.append(row);
	follow();
	return row;
}

function addAssistantRow() {
	// 上一条消息还没吐完就来了新消息：先收尾，别丢尾巴
	if (state.revealFinal) finalizeAssistant(state.revealFinal);
	stopReveal();
	state.textPending = "";
	state.revealFinal = null;
	// 一轮里只挂一行运行状态：新行接手，旧行先收摊，别两行同时闪
	settleRunStatus();
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
	runClock.textContent = "0.0s";
	runState.append(runText, runClock);
	const tps = document.createElement("span");
	tps.className = "tps wait";
	tps.setAttribute("aria-hidden", "true");
	// 计时已经在状态行里，t/s 徽标等首 token 出来再出现，避免两个时钟
	tps.hidden = true;
	meta.append(runState, tps);
	const body = document.createElement("div");
	body.className = "body";
	row.append(meta, body);
	stream.append(row);
	state.live = { row, body };
	state.liveRaw = "";
	state.liveThinkRaw = "";
	if (state.tpsTimer) clearInterval(state.tpsTimer);
	state.liveTps = { box: meta, el: tps, text: runText, start: 0 };
	// 用时按整轮算（DSH RunningStatus 的 turn startTime），工具阶段换行也不归零
	state.runClock = { text: runText, clock: runClock, start: state.runStart || performance.now() };
	state.liveTokens = 0;
	state.tpsTimer = setInterval(tpsTick, 300);
	const tn = document.createTextNode("");
	body.append(tn);
	const caret = document.createElement("span");
	caret.className = "caret";
	body.append(caret);
	state.liveText = { node: tn, caret };
	follow();
	return row;
}

// 运行中状态行收尾（DSH 的 running 槽只在运行期存在）：清计时器、去掉状态文字，
// 行里只剩 t/s 摘要时保留，什么都没有就整行藏掉
function settleRunStatus() {
	if (state.tpsTimer) clearInterval(state.tpsTimer);
	state.tpsTimer = 0;
	state.runClock = null;
	for (const meta of stream.querySelectorAll(".row.assistant > .meta.running")) {
		meta.querySelector(":scope > .run-state")?.remove();
		meta.classList.remove("running");
		const tps = meta.querySelector(":scope > .tps");
		meta.hidden = !tps || tps.hidden || !tps.textContent;
	}
}

// 工具卡落到最新一条 assistant 的正文里；正文还在吐字/等重写时先排队，
// 等 finalizeAssistant 写完 innerHTML 再插回去，否则会被整块覆盖（卡片凭空消失）
function mountTool(el) {
	if (state.live || state.revealFinal) {
		state.pendingTools.push(el);
		return;
	}
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

function flushPendingTools(body) {
	if (!body || !state.pendingTools.length) return;
	body.append(...state.pendingTools);
	state.pendingTools = [];
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
		state.textPending = "";
		state.revealFinal = null;
		return;
	}
	const dt = Math.min(64, Math.max(8, now - (state.revealTick || now)));
	state.revealTick = now;
	const backlog = state.textPending.length;
	if (backlog) {
		// 整段约 2.6s 吐完；积压多时按比例加速，不会越落越远
		const rate = Math.max(45, state.liveRaw.length / 2.6);
		let n = Math.max(1, Math.round((rate * dt) / 1000));
		if (backlog > 240) n = Math.max(n, Math.ceil(backlog / 6));
		n = Math.min(n, backlog);
		state.liveText.node.appendData(state.textPending.slice(0, n));
		state.textPending = state.textPending.slice(n);
		follow();
	}
	if (state.textPending.length) {
		state.revealRaf = requestAnimationFrame(revealStep);
	} else if (state.revealFinal) {
		const msg = state.revealFinal;
		state.revealFinal = null;
		finalizeAssistant(msg);
	}
}

// 运行中状态行 + 流式速度：每 300ms 刷一次用时，首 token 之后再补 t/s 徽标
function tpsTick() {
	if (state.runClock) {
		const used = (performance.now() - state.runClock.start) / 1000;
		state.runClock.clock.textContent = `${used.toFixed(1)}s`;
	}
	const st = state.liveTps;
	if (!st || !state.liveText || !st.start) return;
	const elapsed = (performance.now() - st.start) / 1000;
	if (elapsed < 0.5) return;
	const speed = state.liveTokens / elapsed;
	st.el.hidden = false;
	st.el.className = "tps";
	st.el.textContent = `↓ ${fmtTokens(state.liveTokens)} · ${speed.toFixed(1)} tok/s`;
	st.el.style.background =
		speed >= 50 ? "#53b3cb" : speed >= 30 ? "#9bc53d" : speed >= 15 ? "#f9c22e" : "#e01a4f";
}

function finalizeAssistant(message) {
	stopReveal();
	state.textPending = "";
	state.revealFinal = null;
	// 计时器不在这里停：正文定型后运行中状态行还要继续走到 agent_settled
	const st = state.liveTps;
	state.liveTps = null;
	const total = Math.max(state.liveTokens, Number(message?.usage?.output) || 0);
	const elapsed = st?.start ? (performance.now() - st.start) / 1000 : 0;
	if (st?.el && total > 0 && elapsed > 0.5) {
		st.el.className = "tps done";
		st.el.style.background = "";
		st.el.hidden = false;
		st.el.textContent = `${fmtTokens(total)} tokens · 平均 ${(total / elapsed).toFixed(1)} tok/s`;
	} else if (st?.el) {
		st.el.hidden = true;
	}
	if (!state.live) return;
	const body = state.live.body;
	const think = thinkText(message);
	const lt = state.liveThink;
	if (lt) {
		// 终稿为准，补全可能被截断的流
		lt.finish(think || state.liveThinkRaw || "");
		state.liveThink = null;
	} else if (think) {
		const th = makeThinkBlock(think, false);
		state.live.row.insertBefore(th.wrap, body);
	}
	state.liveThinkRaw = "";
	const text = blockText(message?.content ?? state.liveRaw);
	body.innerHTML = md(text);
	state.live = null;
	state.liveText = null;
	// 流式期间到的工具卡在 innerHTML 写完后再插回（DSH 里工具排在正文之后）
	flushPendingTools(body);
	applyHighlight(body);
	follow();
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
					.highlight(items)
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
		arg.onclick = (e) => {
			e.preventDefault();
			e.stopPropagation();
			window.pi.openPath(spec.file);
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

	if (diff) setDiff(root, stat, diff);
	else if (output) appendToolOutput(root, output);
	return root;
}

function setDiff(root, stat, diff) {
	if (!root || !stat) return;
	const block = buildDiffBlock(diff);
	stat.textContent = `+${block.dataset.added} −${block.dataset.removed}`;
	root.querySelector(".inner")?.append(block);
	toggleDisclosure(root, true);
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
	toggleDisclosure(root, true);
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

function renderHistory(messages) {
	clearStream();
	const visible = messages.filter((m) => m.role !== "system");
	if (!visible.length) {
		emptyHint();
		return;
	}
	const toolRows = new Map();
	let lastTs = 0;
	for (const m of visible) {
		if (m.role === "user" && m.timestamp) {
			// 超过 10 分钟或跨天就插一条时间分隔
			if (!lastTs || Math.abs(new Date(m.timestamp) - new Date(lastTs)) > 600000) {
				const div = timeDivider(m.timestamp);
				if (div) stream.append(div);
			}
			lastTs = m.timestamp;
		}
		if (m.role === "user") {
			addUser(blockText(m.content));
		} else if (m.role === "assistant") {
			const row = document.createElement("div");
			row.className = "row assistant";
			const body = document.createElement("div");
			body.className = "body";
			const think = thinkText(m);
			if (think) row.append(makeThinkBlock(think, false).wrap);
			body.innerHTML = md(blockText(m.content));
			for (const b of Array.isArray(m.content) ? m.content : []) {
				if (b.type !== "toolCall") continue;
				const el = buildToolRow({ name: b.name, args: b.arguments });
				if (b.id) toolRows.set(b.id, el);
				body.append(el);
			}
			row.append(body);
			stream.append(row);
		} else if (m.role === "toolResult") {
			// 历史里的工具结果补回到对应的调用行
			const id = m.toolCallId ?? m.tool_call_id ?? m.id;
			const el = id ? toolRows.get(id) : null;
			const text = blockText(m.content);
			const diff = m.details?.diff;
			if (el) {
				if (m.isError) {
					el.classList.add("err");
					const badge = el.querySelector(".badge");
					if (badge) badge.hidden = false;
				}
				if (diff) setDiff(el, el.querySelector(".stat"), diff);
				else if (text) appendToolOutput(el, text);
				appendToolImages(el, m.content);
			}
		}
	}
	stickBottom = true;
	follow();
	applyHighlight(stream);
}

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

function toggleArchive(s) {
	if (state.archived.has(s.path)) state.archived.delete(s.path);
	else state.archived.add(s.path);
	saveArchived();
	renderSessions();
}

function relTime(ts) {
	const t = new Date(ts).getTime();
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
	name.textContent = s.name || s.title || "未命名会话";
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
	const arch = document.createElement("button");
	arch.type = "button";
	arch.textContent = state.archived.has(s.path) ? "取消归档" : "归档";
	arch.onclick = (e) => {
		e.stopPropagation();
		toggleArchive(s);
	};
	pop.append(arch);
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

function renderSessions() {
	const list = $("list");
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
	head.append(title, grow, search, bind);
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

	const byCwd = new Map();
	for (const s of state.sessions) {
		const key = s.cwd || "";
		if (q) {
			const text = `${s.name || ""} ${s.title || ""}`.toLowerCase();
			if (!text.includes(q)) continue;
		}
		if (state.archived.has(s.path) && s.path !== state.sessionFile) continue;
		if (!byCwd.has(key)) byCwd.set(key, []);
		byCwd.get(key).push(s);
	}

	const ordered = [];
	if (state.cwd) ordered.push([state.cwd, byCwd.get(state.cwd) || []]);
	for (const cwd of state.projects) {
		if (cwd === state.cwd) continue;
		ordered.push([cwd, byCwd.get(cwd) || []]);
	}

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
		kids.className = "kids";
		kids.hidden = !open;
		proj.onclick = async (e) => {
			// 菜单项自己处理，别连带折叠分组
			if (e.target.closest(".proj-menu")) return;
			if (!current) {
				await bindWorkspace(cwd);
				return;
			}
			const nowOpen = state.collapsed.has(cwd);
			if (nowOpen) state.collapsed.delete(cwd);
			else state.collapsed.add(cwd);
			kids.hidden = !nowOpen;
			proj.classList.toggle("open", nowOpen);
			proj.setAttribute("aria-expanded", nowOpen ? "true" : "false");
			saveCollapsed();
		};
		proj.onkeydown = (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				proj.click();
			}
		};

		for (const s of items.slice(0, state.expandedGroups?.has(cwd) ? items.length : 6)) {
			kids.append(sessionRow(s));
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
			kids.append(more);
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
				kids.append(load);
			}
		}
		list.append(kids);
	}

	const archivedItems = state.sessions
		.filter((s) => state.archived.has(s.path) && s.path !== state.sessionFile)
		.filter((s) => !q || `${s.name || ""} ${s.title || ""}`.toLowerCase().includes(q))
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
	try {
		const s = await window.pi.command({ type: "get_state" });
		state.model = s.model ?? null;
		state.thinkingLevel = s.thinkingLevel ?? state.thinkingLevel ?? null;
		state.sessionFile = s.sessionFile ?? null;
		// 让主进程记住当前会话：pi 崩溃重启时按它续会话
		const active = window.pi.setActiveSession?.(state.sessionFile);
		if (active?.catch) active.catch(() => {});
		state.sessionName = s.sessionName ?? null;
		state.streaming = s.isStreaming ?? false;
		saveLastSession();
		renderModel();
		renderTitle();
		renderSessions();
	} catch {}
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

async function bindWorkspace(cwd) {
	if (!cwd || cwd === state.cwd) return false;
	if (state.streaming) {
		showError("正在生成回答，先停止再切换工作区");
		return false;
	}
	try {
		const r = await window.pi.setCwd(cwd);
		if (!r) return false;
		if (!state.projects.includes(state.cwd)) {
			state.projects.unshift(state.cwd);
		}
		state.cwd = r.cwd;
		state.sessions = r.sessions ?? [];
		state.sessionFile = null;
		state.sessionName = null;
		state.sessionPage = readPageSize();
		state.collapsed.delete(cwd);
		saveProjects();
		saveCollapsed();
		renderTitle();
		clearStream();
		emptyHint();
		await loadModels();
		await refreshState();
		return true;
	} catch (e) {
		showError(e.message);
		return false;
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
	if (state.streaming) return;
	if (cwd && cwd !== state.cwd) {
		const ok = await bindWorkspace(cwd);
		if (!ok) return;
	}
	try {
		const r = await window.pi.switchSession(path);
		if (r.cancelled) return;
		renderHistory(r.messages ?? []);
		await refreshState();
	} catch (e) {
		showError(e.message);
	}
}

async function newSession() {
	if (state.streaming) return;
	await window.pi.newSession();
	clearStream();
	emptyHint();
	await refreshState();
}

async function pifold() {
	const r = await window.pi.pickFolder();
	if (!r) return;
	state.cwd = r.cwd;
	state.projects = [r.cwd, ...state.projects.filter((x) => x !== r.cwd)];
	saveProjects();
	state.sessions = r.sessions;
	state.sessionName = null;
	renderTitle();
	clearStream();
	emptyHint();
	await loadModels();
	await refreshState();
}

function showError(msg) {
	const d = document.createElement("div");
	d.className = "err";
	d.textContent = msg;
	stream.append(d);
	follow();
}

async function submit() {
	const extra = attachments.get() || [];
	const text = input.value.trim();
	if ((!text && !extra.length) || state.streaming) return;
	input.value = "";
	autosize();
	updateSend();
	addUser(text || `[${extra.length} 张图片]`);
	const row = stream.lastElementChild;
	setStreaming(true);
	try {
		const cmd = { type: "prompt", message: text };
		if (extra.length) cmd.images = extra;
		await window.pi.command(cmd);
		attachments.clear();
	} catch (e) {
		// 发送失败：回滚刚插入的“假发送”气泡，并把草稿还给用户
		if (row?.classList.contains("mine")) row.remove();
		if (!input.value) {
			input.value = text;
			autosize();
			updateSend();
		}
		showError(e.message);
		setStreaming(false);
	}
}

function abortRun() {
	if (!state.streaming) return;
	state.aborted = true;
	window.pi.command({ type: "abort" }).catch(() => {});
}

function setStreaming(on) {
	state.streaming = on;
	sendBtn.classList.toggle("stop", on);	updateSend();
}

// 一轮结束的状态条：完成 · 12.4s · 6 工具；3 秒后收成小圆点，点击可展开
function showRunSummary() {
	if (!state.runStart) return;
	const seconds = (performance.now() - state.runStart) / 1000;
	const tools = state.runTools;
	state.runStart = 0;
	state.runTools = 0;
	const row = document.createElement("div");
	row.className = "row run-summary-row";
	const pill = document.createElement("span");
	pill.className = "run-summary";
	pill.textContent = `完成 · ${seconds.toFixed(1)}s${tools ? ` · ${tools} 工具` : ""}`;
	pill.title = pill.textContent;
	// 优先挂在最后一条助手消息里，跟正文同属一个 flow item（DSH 的 tail slot 行为）
	const last = [...stream.querySelectorAll(".row.assistant")].pop();
	if (last) {
		const acts = last.querySelector(":scope > .acts");
		if (acts) last.insertBefore(pill, acts);
		else last.append(pill);
	} else {
		row.append(pill);
		stream.append(row);
	}
	follow();
	// 一轮结束的状态条：完成 · 12.4s · 6 工具；3 秒后淡出，不收成对勾（用户明确不要打勾）
	setTimeout(() => {
		if (!pill.isConnected) return;
		pill.classList.add("leaving");
		setTimeout(() => pill.remove(), 200);
	}, 3000);
}

function autosize() {
	input.style.height = "auto";
	input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
}

function updateSend() {
	const hasImages = (attachments.get() || []).length > 0;
	const on = state.streaming || input.value.trim().length > 0 || hasImages;
	sendBtn.classList.toggle("on", on);
	// 空草稿空闲时真正禁用，避免 Tab 到无反馈的按钮；流式时是停止键，保持可用
	sendBtn.disabled = !on;
}

// ---------- 事件 ----------
window.pi.onEvent((ev) => {
	switch (ev.type) {
		case "message_start": {
			const m = ev.message;
			// agent_start 已经建过运行行时复用，别在首条消息时再多挂一行
			if (m?.role === "assistant" && !state.live) addAssistantRow();
			break;
		}
		case "message_update": {
			const a = ev.assistantMessageEvent;
			if (a?.type === "thinking_start") {
				ensureLiveThink();
				break;
			}
			if (a?.type === "thinking_delta") {
				const th = ensureLiveThink();
				if (th) {
					state.liveThinkRaw = (state.liveThinkRaw || "") + (a.delta || "");
					th.setText(state.liveThinkRaw, true);
					follow();
				}
				break;
			}
			if (a?.type === "thinking_end") {
				const th = state.liveThink;
				if (th) {
					state.liveThinkRaw = typeof a.content === "string" && a.content ? a.content : state.liveThinkRaw;
					th.finish(state.liveThinkRaw || "");
				}
				break;
			}
			if (a?.type === "text_delta" && state.liveText) {
				state.liveRaw += a.delta;
				state.textPending += a.delta;
				state.liveTokens += estimateTokens(a.delta);
				if (state.liveTps) {
					if (!state.liveTps.start) {
						state.liveTps.start = performance.now();
						// 首个 token 到了：状态文字从「思考中」切「生成中」（DSH RunningStatus 的 deepDiving 阶段）
						if (state.liveTps.text) state.liveTps.text.textContent = "生成中…";
					}
				}
				scheduleReveal();
				follow();
			}
			break;
		}
		case "message_end": {
			if (ev.message?.role === "assistant") {
				if (state.textPending) {
					state.revealFinal = ev.message;
					scheduleReveal();
				} else {
					finalizeAssistant(ev.message);
				}
			}
			break;
		}
		case "tool_execution_start": {
			state.runTools += 1;
			const el = buildToolRow({ name: ev.toolName, args: ev.args });
			el.classList.add("running", "fresh");
			// 正文可能还在吐字（message_end 之后才开始的工具）：先排队，别被 finalize 的 innerHTML 冲掉
			mountTool(el);
			state.tools.set(ev.toolCallId, el);
			follow();
			break;
		}
		case "tool_execution_end": {
			const el = state.tools.get(ev.toolCallId);
			if (!el) break;
			el.classList.remove("running");
			el.classList.toggle("err", !!ev.isError);
			const badge = el.querySelector(".badge");
			if (badge) badge.hidden = !ev.isError;
			const dur = el.querySelector(".dur");
			if (dur) dur.textContent = fmtDuration(ev.durationMs);
			const text = blockText(ev.result?.content);
			const diff = ev.result?.details?.diff;
			if (diff) setDiff(el, el.querySelector(".stat"), diff);
			else if (text) appendToolOutput(el, text);
			appendToolImages(el, ev.result?.content);
			break;
		}
		case "agent_start":
			setStreaming(true);
			state.runStart = performance.now();
			state.runTools = 0;
			stream.querySelector(".run-summary-row")?.remove();
			// 不等 message_start：发送后立刻出「思考中… 0.0s」，工具阶段也有反馈
			if (!state.live && !state.revealFinal) addAssistantRow();
			break;
		case "agent_settled":
			setStreaming(false);
			// 中断时 finalize 会重写 body.innerHTML：先把没吐完的尾巴收掉，再画「已停止」，
			// 顺序反了标记会被冲掉（长文本吐字比 message_end 晚，settle 可能先到）
			if (state.live || state.revealFinal) finalizeAssistant(state.revealFinal);
			// 运行中状态行只在运行期存在，一轮结束就收掉
			settleRunStatus();
			if (state.aborted) {
				const body = [...stream.querySelectorAll(".row.assistant")]
					.map((r) => r.querySelector(":scope > .body"))
					.filter(Boolean)
					.pop();
				if (body && !body.querySelector(":scope > .stopped")) {
					const stop = document.createElement("span");
					stop.className = "stopped";
					stop.textContent = "已停止";
					body.append(stop);
				}
				state.aborted = false;
			}
			// 只思考、没正文也没工具/图片的空回合不留下空白行（例如请求被 pi 内部吞掉）
			const lastRow = [...stream.querySelectorAll(".row.assistant")].pop();
			const lastBody = lastRow?.querySelector(":scope > .body");
			if (lastBody && !lastBody.textContent.trim() && !lastBody.querySelector("img, .tool, pre, table, .stopped")) lastRow.remove();
			showRunSummary();
			// 新会话的第一轮结束后 sessionFile 才有值，刷新一次便于下次启动恢复
			refreshState().catch(() => {});
			break;
		case "session_info_changed":
			window.pi.sessions({ perCwd: state.sessionPage || readPageSize() }).then((s) => {
				state.sessions = s;
				renderSessions();
			});
			break;
		case "process_exit":
			console.warn("[pi] process exited", ev.code);
			// pi 子进程退出：下一条消息会自动重启；先把流式态收尾，否则光标会一直转
			if (state.streaming) {
				setStreaming(false);
				if (state.live || state.revealFinal) finalizeAssistant(state.revealFinal);
				settleRunStatus();
			}
			showError("pi 进程意外退出，下一条消息会自动重启");
			follow();
			break;
	}
});

window.pi.onStderr((t) => {
	if (/error|Error/.test(t)) console.warn("[pi]", t);
});

// ---------- 交互 ----------
input.addEventListener("input", () => {
	autosize();
	updateSend();
});
input.addEventListener("keydown", (e) => {
	if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
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

	// ReadBlock / SearchBlock 样例
	const LS = String.fromCharCode(10);
	const extra = document.createElement("div");
	extra.className = "row assistant";
	const extraBody = document.createElement("div");
	extraBody.className = "body";
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
	toggleDisclosure(readEl, true);
	toggleDisclosure(grepEl, true);
	extraBody.append(readEl, grepEl);
	extra.append(extraBody);
	stream.append(extra);

	stickBottom = true;
	stream.scrollTop = stream.scrollHeight;
	return true;
};

// ---------- 启动 ----------
function showBootError(err) {
	stream.querySelectorAll(".empty").forEach((n) => n.remove());
	const wrap = document.createElement("div");
	wrap.className = "empty boot-error";
	const title = document.createElement("p");
	title.className = "empty-title";
	title.textContent = "连不上 pi";
	const sub = document.createElement("p");
	sub.className = "empty-sub";
	sub.textContent = err?.message || String(err || "未知错误");
	const retry = document.createElement("button");
	retry.type = "button";
	retry.className = "boot-retry";
	retry.textContent = "重试";
	retry.onclick = () => {
		retry.disabled = true;
		retry.textContent = "正在重试…";
		bootApp();
	};
	wrap.append(title, sub, retry);
	stream.append(wrap);
}

let booting = false;
async function bootApp() {
	if (booting) return;
	booting = true;
	stream.querySelectorAll(".empty").forEach((n) => n.remove());
	const loading = emptyHint("正在连接 pi…");
	try {
		const boot = await window.pi.boot();
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
				renderHistory(r.messages ?? []);
				await refreshState();
				sessionBootDone = true;
				saveLastSession();
				window.__ready = true;
				return;
			}
		}
		// 重启后回到上次会话；找不到就按新会话处理
		if (restore && last && last.cwd === boot.cwd) {
			const r = await window.pi.switchSession(last.path).catch(() => null);
			if (r && !r.cancelled) {
				loading.remove();
				renderHistory(r.messages ?? []);
				await refreshState();
				sessionBootDone = true;
				saveLastSession();
				window.__ready = true;
				return;
			}
		}
		const history = await window.pi.command({ type: "get_messages" }).catch(() => null);
		loading.remove();
		renderHistory(history?.messages ?? []);
		sessionBootDone = true;
		saveLastSession();
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
initScroll();
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
	reload: renderHistory,
	refreshState,
	ICON: { terminal: ICON_TERMINAL, doc: ICON_DOC, pencil: ICON_PENCIL, search: ICON_SEARCH, grid: ICON_GRID, dot: ICON_DOT },
};
window.__piui = ctx;

// 新增功能模块登记在这里；每个模块导出 init(ctx)
const FEATURES = ["./features/code-toolbar.js", "./features/message-actions.js", "./features/input-trigger.js", "./features/message-retry.js", "./features/message-fork.js", "./features/json-view.js", "./features/empty-chips.js", "./features/context-meter.js", "./features/extension-ui.js", "./features/queue.js", "./features/export-html.js", "./features/attachments.js", "./features/settings.js", "./features/right-panel.js", "./features/image-preview.js", "./features/terminal.js", "./features/shortcuts.js"];

for (const f of FEATURES) {
	try {
		const m = await import(f);
		m.init?.(ctx);
		console.log("[feature] loaded", f);
	} catch (e) {
		console.error("[feature] failed", f, e?.message);
	}
}
