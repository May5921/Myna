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
	projects: [],
	projectsSeeded: false,
	live: null, // 正在流式的 assistant 行
	liveText: null, // 流式文本节点（增量追加，不重排）
	liveRaw: "",
	tools: new Map(),
};

// 图片附件桥：features/attachments.js 覆盖 get/clear
const attachments = { get: () => [], clear: () => {} };

// ---------- 文本工具 ----------
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

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
	let html = `<div class="table-wrap"><table><thead><tr>`;
	html += header.map((h, i) => cell("th", h, tableAlign(specs[i] || ""))).join("");
	html += `</tr></thead>`;
	if (rows.length) {
		html += `<tbody>`;
		for (const row of rows) {
			html += `<tr>${header.map((_, i) => cell("td", row[i] ?? "", tableAlign(specs[i] || ""))).join("")}</tr>`;
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
		const h = line.match(/^#{1,6}\s+(.*)$/);
		const ul = line.match(/^\s*[-*]\s+(.*)$/);
		const ol = line.match(/^\s*\d+\.\s+(.*)$/);
		if (h) {
			flushPara();
			flushList();
			html += `<p class="h">${inlineMd(h[1])}</p>`;
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
		if (i % 2 === 1) {
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
	const row = document.createElement("div");
	row.className = "row assistant fresh";
	const body = document.createElement("div");
	body.className = "body";
	row.append(body);
	stream.append(row);
	state.live = { row, body };
	state.liveRaw = "";
	const tn = document.createTextNode("");
	body.append(tn);
	const caret = document.createElement("span");
	caret.className = "caret";
	body.append(caret);
	state.liveText = { node: tn, caret };
	follow();
	return row;
}

function finalizeAssistant(message) {
	if (!state.live) return;
	const body = state.live.body;
	const text = blockText(message?.content ?? state.liveRaw);
	body.innerHTML = md(text);
	state.live = null;
	state.liveText = null;
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
	pre.textContent = output.length > 4000 ? `${output.slice(0, 4000)}\n…` : output;
	inner.append(pre);
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
		if (!state.sideSearch) state.sideQuery = "";
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
			renderSessions();
			const el = list.querySelector(".side-search input");
			if (el) {
				el.focus();
				el.setSelectionRange(el.value.length, el.value.length);
			}
		};
		inp.onkeydown = (e) => {
			if (e.key === "Escape") {
				state.sideSearch = false;
				state.sideQuery = "";
				renderSessions();
			}
		};
		box.append(inp);
		list.append(box);
		queueMicrotask(() => {
			const el = list.querySelector(".side-search input");
			el?.focus();
			el?.setSelectionRange(el.value.length, el.value.length);
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
			menu.hidden = !menu.hidden;
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
		proj.onclick = async () => {
			if (!current) {
				await bindWorkspace(cwd);
				return;
			}
			const nowOpen = state.collapsed.has(cwd);
			if (nowOpen) state.collapsed.delete(cwd);
			else state.collapsed.add(cwd);
			kids.hidden = !nowOpen;
			proj.classList.toggle("open", nowOpen);
			saveCollapsed();
		};

		for (const s of items.slice(0, state.expandedGroups?.has(cwd) ? items.length : 6)) {
			const b = document.createElement("button");
			b.type = "button";
			b.className = "item" + (s.path === state.sessionFile ? " active" : "");
			const dot = document.createElement("span");
			dot.className = "item-status";
			const name = document.createElement("span");
			name.className = "item-title";
			name.textContent = s.name || s.title || "未命名会话";
			const time = document.createElement("span");
			time.className = "item-time";
			time.textContent = relTime(s.timestamp);
			b.append(dot, name, time);
			b.title = `${s.cwd}\n${s.path}`;
			b.onclick = () => pickSession(s.path, s.cwd);
			kids.append(b);
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
		}
		list.append(kids);
	}
}

document.addEventListener("click", () => {
	for (const m of document.querySelectorAll(".proj-menu")) m.hidden = true;
});

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
		state.sessionName = s.sessionName ?? null;
		state.streaming = s.isStreaming ?? false;
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
	if (!cwd || cwd === state.cwd || state.streaming) return false;
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

function setStreaming(on) {
	state.streaming = on;
	sendBtn.classList.toggle("stop", on);
	updateSend();
}

function autosize() {
	input.style.height = "auto";
	input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
}

function updateSend() {
	const hasImages = (attachments.get() || []).length > 0;
	sendBtn.classList.toggle("on", state.streaming || input.value.trim().length > 0 || hasImages);
}

// ---------- 事件 ----------
window.pi.onEvent((ev) => {
	switch (ev.type) {
		case "message_start": {
			const m = ev.message;
			if (m?.role === "assistant") addAssistantRow();
			break;
		}
		case "message_update": {
			const a = ev.assistantMessageEvent;
			if (a?.type === "text_delta" && state.liveText) {
				state.liveRaw += a.delta;
				state.liveText.node.appendData(a.delta);
				follow();
			}
			break;
		}
		case "message_end": {
			if (ev.message?.role === "assistant") finalizeAssistant(ev.message);
			break;
		}
		case "tool_execution_start": {
			const el = buildToolRow({ name: ev.toolName, args: ev.args });
			el.classList.add("running", "fresh");
			let host = state.live?.body;
			if (!host) {
				// message_end 之后才开始的工具：补一个与历史一致的 row/body 容器
				const row = document.createElement("div");
				row.className = "row assistant";
				host = document.createElement("div");
				host.className = "body";
				row.append(host);
				stream.append(row);
			}
			host.append(el);
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
			break;
		}
		case "agent_start":
			setStreaming(true);
			break;
		case "agent_settled":
			setStreaming(false);
			break;
		case "session_info_changed":
			window.pi.sessions().then((s) => {
				state.sessions = s;
				renderSessions();
			});
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
	if (state.streaming) window.pi.command({ type: "abort" }).catch(() => {});
});
sendBtn.onclick = () => {
	if (state.streaming) window.pi.command({ type: "abort" }).catch(() => {});
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
(async () => {
	initScroll();
	const loading = emptyHint("正在连接 pi…");
	const boot = await window.pi.boot();
	state.cwd = boot.cwd;
	state.sessions = boot.sessions;
	renderTitle();
	autosize();
	updateSend();
	await loadModels();
	await refreshState();
	if (boot.restore) {
		const r = await window.pi.switchSession(boot.restore).catch(() => null);
		if (r && !r.cancelled) {
			renderHistory(r.messages ?? []);
			await refreshState();
			window.__ready = true;
			return;
		}
	}
	const history = await window.pi.command({ type: "get_messages" }).catch(() => null);
	loading.remove();
	renderHistory(history?.messages ?? []);
	window.__ready = true;
})();

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
const FEATURES = ["./features/code-toolbar.js", "./features/message-actions.js", "./features/input-trigger.js", "./features/message-retry.js", "./features/message-fork.js", "./features/json-view.js", "./features/empty-chips.js", "./features/context-meter.js", "./features/extension-ui.js", "./features/queue.js", "./features/export-html.js", "./features/attachments.js", "./features/settings.js", "./features/right-panel.js"];

for (const f of FEATURES) {
	try {
		const m = await import(f);
		m.init?.(ctx);
		console.log("[feature] loaded", f);
	} catch (e) {
		console.error("[feature] failed", f, e?.message);
	}
}
