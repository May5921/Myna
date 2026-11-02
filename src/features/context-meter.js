// 上下文占用：输入框底栏 #model 左侧的圆环 + 百分比，点开为明细浮层。
// 自注入样式与 DOM（#composer .cbar 内、#model 之前），不改 index.html / app.js / base.css。
// RPC：{ type: "get_session_stats" }

const POLL_MS = 10000;
const DEBOUNCE_MS = 500;
const RING_R = 8;
const RING_C = 2 * Math.PI * RING_R;
const NS = "http://www.w3.org/2000/svg";

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

// 千分位（浮层数值）
const fmtNum = (n) => Math.round(n).toLocaleString("en-US");

// 紧凑 token（圆环 title）：1.2k / 12k / 1.0M
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

const CSS = `
.ctx-btn {
	display: inline-flex;
	align-items: center;
	gap: 5px;
	height: 24px;
	padding: 0 4px;
	border-radius: 6px;
	background: none;
	color: var(--faint);
	transition: background-color 120ms ease;
}
.ctx-btn:hover,
.ctx-btn[aria-expanded="true"] { background: var(--hover); }
.ctx-btn:focus-visible { outline: 1px solid var(--faint); outline-offset: -1px; }
.ctx-btn[hidden] { display: none; }
.ctx-ring { display: block; }
.ctx-track { stroke: var(--line); }
.ctx-arc { stroke: var(--text); transition: stroke-dasharray 220ms ease; }
.ctx-pct {
	font: 11px/1 var(--mono);
	color: var(--faint);
	font-variant-numeric: tabular-nums;
}
.ctx-pop {
	position: fixed;
	z-index: 12;
	width: max-content;
	min-width: 176px;
	max-width: min(280px, calc(100vw - 16px));
	background: var(--bg);
	border: 1px solid var(--line);
	border-radius: 12px;
	padding: 5px;
	box-shadow: var(--shadow-menu);
	font-size: 12px;
	line-height: 1.55;
	opacity: 0;
	transition: opacity 90ms ease;
}
.ctx-pop.show { opacity: 1; }
.ctx-row {
	display: flex;
	align-items: baseline;
	justify-content: space-between;
	gap: 16px;
	padding: 2px 7px;
}
.ctx-k { color: var(--dim); white-space: nowrap; }
.ctx-v {
	color: var(--text);
	font: 12px/1.55 var(--mono);
	font-variant-numeric: tabular-nums;
	text-align: right;
	white-space: nowrap;
}
.ctx-note { padding: 2px 7px; color: var(--dim); }
.ctx-note.err { color: var(--err); }
@media (prefers-reduced-motion: reduce) {
	.ctx-btn { transition: none; }
	.ctx-arc { transition: none; }
	.ctx-pop { transition: none; }
}
`;

export function init(ctx) {
	const modelBtn = document.getElementById("model");
	if (!modelBtn || !ctx?.pi) return;
	const cbar = modelBtn.parentElement;
	if (!cbar) return;
	if (cbar.querySelector(".ctx-btn")) return; // 幂等

	const style = document.createElement("style");
	style.textContent = CSS;
	document.head.append(style);

	// ---------- 圆环按钮 ----------
	const btn = document.createElement("button");
	btn.type = "button";
	btn.className = "ctx-btn";
	btn.hidden = true;
	btn.setAttribute("aria-haspopup", "dialog");
	btn.setAttribute("aria-expanded", "false");
	btn.setAttribute("aria-label", "查看上下文占用");

	const svg = document.createElementNS(NS, "svg");
	svg.setAttribute("class", "ctx-ring");
	svg.setAttribute("width", "20");
	svg.setAttribute("height", "20");
	svg.setAttribute("viewBox", "0 0 20 20");
	svg.setAttribute("aria-hidden", "true");

	const track = document.createElementNS(NS, "circle");
	track.setAttribute("class", "ctx-track");
	track.setAttribute("cx", "10");
	track.setAttribute("cy", "10");
	track.setAttribute("r", String(RING_R));
	track.setAttribute("fill", "none");
	track.setAttribute("stroke-width", "2");

	const arc = document.createElementNS(NS, "circle");
	arc.setAttribute("class", "ctx-arc");
	arc.setAttribute("cx", "10");
	arc.setAttribute("cy", "10");
	arc.setAttribute("r", String(RING_R));
	arc.setAttribute("fill", "none");
	arc.setAttribute("stroke-width", "2");
	arc.setAttribute("transform", "rotate(-90 10 10)");
	arc.style.strokeDasharray = `0 ${RING_C.toFixed(2)}`;

	svg.append(track, arc);

	const pctEl = document.createElement("span");
	pctEl.className = "ctx-pct";
	pctEl.textContent = "—";

	btn.append(svg, pctEl);
	cbar.insertBefore(btn, modelBtn);

	// ---------- 状态 ----------
	let stats = null;
	let err = "";
	let busy = false;

	let pop = null;
	let popSeq = 0;
	let timer = 0;
	let debounceTimer = 0;

	const ctxUsage = () => {
		const cu = stats?.contextUsage;
		return cu && typeof cu === "object" && isNum(cu.contextWindow) && cu.contextWindow > 0 ? cu : null;
	};

	const ratio = () => {
		const cu = ctxUsage();
		if (!cu || !isNum(cu.percent)) return 0;
		return Math.min(1, Math.max(0, cu.percent / 100));
	};

	// ---------- 浮层 ----------
	const rowEl = (label, value) => {
		const row = document.createElement("div");
		row.className = "ctx-row";
		const k = document.createElement("span");
		k.className = "ctx-k";
		k.textContent = label;
		const v = document.createElement("span");
		v.className = "ctx-v";
		v.textContent = value;
		row.append(k, v);
		return row;
	};

	const noteEl = (text, isErr) => {
		const note = document.createElement("div");
		note.className = isErr ? "ctx-note err" : "ctx-note";
		note.textContent = text;
		return note;
	};

	function place() {
		if (!pop) return;
		const r = btn.getBoundingClientRect();
		const w = pop.offsetWidth;
		const h = pop.offsetHeight;
		const vw = window.innerWidth;
		let right = Math.round(vw - r.right);
		if (right + w > vw - 8) right = Math.max(8, vw - w - 8);
		if (right < 8) right = 8;
		const top = Math.max(8, Math.round(r.top - h - 6));
		pop.style.top = `${top}px`;
		pop.style.right = `${right}px`;
	}

	function renderPop() {
		if (!pop) return;
		pop.textContent = "";
		if (!stats) {
			pop.append(err ? noteEl(err, true) : noteEl("读取中…", false));
			place();
			return;
		}

		const cu = ctxUsage();
		const tk = stats.tokens && typeof stats.tokens === "object" ? stats.tokens : null;
		const rows = [];

		if (cu) {
			let value = "—";
			if (isNum(cu.tokens)) {
				value = `${fmtNum(cu.tokens)} / ${fmtNum(cu.contextWindow)}`;
				if (isNum(cu.percent)) value += ` · ${fmtPct(cu.percent)}`;
			}
			rows.push(["上下文", value]);
		}
		if (tk) {
			const fields = [
				["input", "输入"],
				["output", "输出"],
				["cacheRead", "缓存读"],
				["cacheWrite", "缓存写"],
				["total", "合计"],
			];
			for (const [key, label] of fields) {
				if (isNum(tk[key])) rows.push([label, fmtNum(tk[key])]);
			}
		}
		if (isNum(stats.cost)) {
			const digits = stats.cost > 0 && stats.cost < 1 ? 4 : 2;
			const cost = stats.cost.toLocaleString("en-US", {
				minimumFractionDigits: digits,
				maximumFractionDigits: digits,
			});
			rows.push(["费用", `$${cost}`]);
		}
		if (isNum(stats.totalMessages)) rows.push(["消息数", fmtNum(stats.totalMessages)]);

		for (const [label, value] of rows) pop.append(rowEl(label, value));
		if (!rows.length) pop.append(noteEl("暂无数据", false));
		if (err) pop.append(noteEl(err, true));
		place();
	}

	function closePop() {
		if (!pop) return;
		popSeq++;
		pop.remove();
		pop = null;
		btn.setAttribute("aria-expanded", "false");
		document.removeEventListener("pointerdown", onDocDown, true);
		document.removeEventListener("keydown", onDocKey, true);
		window.removeEventListener("resize", place);
	}

	const onDocDown = (e) => {
		if (!pop) return;
		const t = e.target;
		if (pop.contains(t) || btn.contains(t)) return;
		closePop();
	};

	const onDocKey = (e) => {
		if (!pop || e.key !== "Escape") return;
		e.preventDefault();
		e.stopPropagation();
		closePop();
		btn.focus();
	};

	const openPop = () => {
		closePop();
		const seq = ++popSeq;
		pop = document.createElement("div");
		pop.className = "ctx-pop";
		pop.setAttribute("role", "dialog");
		pop.setAttribute("aria-label", "上下文与用量");
		document.body.append(pop);
		btn.setAttribute("aria-expanded", "true");
		renderPop();
		requestAnimationFrame(() => {
			if (pop && popSeq === seq) pop.classList.add("show");
		});
		document.addEventListener("pointerdown", onDocDown, true);
		document.addEventListener("keydown", onDocKey, true);
		window.addEventListener("resize", place);
		fetchStats();
	};

	// ---------- 数据 ----------
	const apply = () => {
		const cu = ctxUsage();
		if (!cu) {
			btn.hidden = true;
			closePop();
			return;
		}
		btn.hidden = false;
		const pct = isNum(cu.percent) ? fmtPct(cu.percent) : "—";
		pctEl.textContent = pct;
		arc.style.strokeDasharray = `${(RING_C * ratio()).toFixed(2)} ${RING_C.toFixed(2)}`;
		btn.title = isNum(cu.tokens)
			? `上下文 ${fmtCompact(cu.tokens)} / ${fmtCompact(cu.contextWindow)} · ${pct}`
			: `上下文 — / ${fmtCompact(cu.contextWindow)}`;
		if (pop) renderPop();
	};

	async function fetchStats() {
		if (document.hidden || busy) return;
		busy = true;
		try {
			const s = await ctx.pi.command({ type: "get_session_stats" });
			if (!s || typeof s !== "object") throw new Error("统计不可用");
			stats = s;
			err = "";
		} catch (e) {
			err = String(e?.message || "读取失败");
		} finally {
			busy = false;
		}
		apply();
	}

	// ---------- 交互 ----------
	btn.onclick = (e) => {
		e.preventDefault();
		e.stopPropagation();
		if (pop) closePop();
		else openPop();
	};

	// ---------- 轮询 + 事件 ----------
	const startPoll = () => {
		if (timer) return;
		timer = setInterval(fetchStats, POLL_MS);
	};

	const stopPoll = () => {
		if (!timer) return;
		clearInterval(timer);
		timer = 0;
	};

	const scheduleRefresh = () => {
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(fetchStats, DEBOUNCE_MS);
	};

	try {
		ctx.pi.onEvent?.((ev) => {
			const t = ev?.type;
			if (t === "agent_settled" || t === "session_info_changed") scheduleRefresh();
		});
	} catch {}

	document.addEventListener("visibilitychange", () => {
		if (document.hidden) {
			stopPoll();
			closePop();
			return;
		}
		startPoll();
		fetchStats();
	});

	fetchStats();
	startPoll();
}
