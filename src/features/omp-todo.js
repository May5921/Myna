// OMP Todo 进度面板：轮询 get_state.todoPhases，在输入框上方渲染任务 dock。
// 只依赖已有的 window.pi.command；pi 后端没有 todoPhases 时自动隐藏。
const STORE_KEY = "myna.todo.collapsed";

const CSS = `
.otodo {
	width: min(var(--thread-max-width), 100% - 48px);
	margin: 0 auto 6px;
	border: 1px solid var(--line);
	border-radius: 12px;
	background: var(--bg);
	box-shadow: var(--shadow-surface);
	font-size: 12px;
	line-height: 1.5;
	overflow: hidden;
}
.otodo[hidden] { display: none; }
.otodo-head {
	display: flex;
	align-items: center;
	gap: 8px;
	width: 100%;
	padding: 7px 12px;
	color: var(--dim);
	text-align: left;
}
.otodo-head:hover { background: var(--hover); color: var(--text); }
.otodo-title { font-weight: 550; color: var(--text); }
.otodo-count { color: var(--faint); font-variant-numeric: tabular-nums; }
.otodo-grow { flex: 1; }
.otodo-chev { transition: transform 140ms ease; color: var(--faint); }
.otodo[data-open="0"] .otodo-chev { transform: rotate(-90deg); }
.otodo-body { padding: 0 12px 8px; }
.otodo[data-open="0"] .otodo-body { display: none; }
.otodo-phase { padding: 3px 0; }
.otodo-phase-title { margin: 3px 0 2px; font-size: 11px; color: var(--faint); }
.otodo-item { display: flex; align-items: flex-start; gap: 7px; padding: 2px 0; color: var(--dim); }
.otodo-mark { flex: none; width: 13px; height: 13px; margin-top: 1px; display: grid; place-items: center; }
.otodo-mark svg { display: block; }
.otodo-item[data-status="in_progress"] { color: var(--text); }
.otodo-item[data-status="completed"] { color: var(--faint); text-decoration: line-through; }
.otodo-item[data-status="cancelled"] { color: var(--faint); text-decoration: line-through; opacity: 0.7; }
.otodo-text { min-width: 0; overflow-wrap: anywhere; }
.otodo-spin { width: 10px; height: 10px; border: 1.5px solid var(--line-strong); border-top-color: var(--text); border-radius: 50%; animation: otodo-spin 900ms linear infinite; }
@keyframes otodo-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .otodo-spin { animation: none; } }
`;

const CHECK =
	'<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="5.2" fill="currentColor" opacity=".16"/><path d="M3.4 6.1 5.2 7.9 8.8 4.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CIRCLE = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="4.6" stroke="currentColor" stroke-width="1.2"/></svg>';
const CROSS =
	'<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="4.8" stroke="currentColor" stroke-width="1.1"/><path d="m4.2 4.2 3.6 3.6M7.8 4.2 4.2 7.8" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>';

const STATUS = new Set(["pending", "in_progress", "completed", "cancelled"]);

function statusOf(raw) {
	const s = String(raw || "").toLowerCase();
	if (s === "completed" || s === "complete" || s === "done") return "completed";
	if (s === "in_progress" || s === "in-progress" || s === "active" || s === "running") return "in_progress";
	if (s === "cancelled" || s === "canceled" || s === "skipped") return "cancelled";
	return STATUS.has(s) ? s : "pending";
}

function itemOf(raw) {
	if (!raw || typeof raw !== "object") return null;
	const text = raw.content ?? raw.text ?? raw.title ?? raw.task ?? raw.label;
	if (typeof text !== "string" || !text.trim()) return null;
	return { text: text.trim(), status: statusOf(raw.status ?? raw.state) };
}

// 兼容三种形态：[[todo]]、[{title,todos}]、[{content,status}]
function normalize(phases) {
	if (!Array.isArray(phases)) return [];
	if (phases.length && phases.every((p) => p && !Array.isArray(p?.todos ?? p?.items ?? p?.tasks) && itemOf(p))) {
		return [{ title: "", items: phases.map(itemOf).filter(Boolean) }];
	}
	const out = [];
	for (const phase of phases) {
		if (!phase || typeof phase !== "object") continue;
		const raw = phase.todos ?? phase.items ?? phase.tasks;
		let items = Array.isArray(raw) ? raw.map(itemOf).filter(Boolean) : [];
		// 阶段本身也可能是一个任务
		if (!items.length) {
			const one = itemOf(phase);
			if (one) items = [one];
		}
		if (!items.length) continue;
		out.push({ title: String(phase.title ?? phase.name ?? phase.phase ?? ""), items });
	}
	return out;
}

export function init(ctx) {
	if (!ctx?.pi) return;
	if (document.getElementById("otodo")) return;
	const style = document.createElement("style");
	style.textContent = CSS;
	document.head.append(style);

	const dock = document.createElement("div");
	dock.id = "otodo";
	dock.className = "otodo";
	dock.hidden = true;
	const head = document.createElement("button");
	head.type = "button";
	head.className = "otodo-head";
	head.innerHTML = '<span class="otodo-title">任务</span><span class="otodo-count"></span><span class="otodo-grow"></span><span class="otodo-chev">▾</span>';
	const body = document.createElement("div");
	body.className = "otodo-body";
	dock.append(head, body);

	let open = true;
	try {
		open = localStorage.getItem(STORE_KEY) !== "0";
	} catch {}
	dock.dataset.open = open ? "1" : "0";
	head.onclick = () => {
		open = !open;
		dock.dataset.open = open ? "1" : "0";
		try {
			localStorage.setItem(STORE_KEY, open ? "1" : "0");
		} catch {}
	};

	const composer = document.getElementById("composer");
	if (composer) composer.before(dock);
	else document.querySelector("main")?.append(dock);

	let lastKey = "";
	let lastFetch = 0;
	let busy = false;
	const countEl = head.querySelector(".otodo-count");

	const render = (phases) => {
		const all = phases.flatMap((p) => p.items);
		const done = all.filter((i) => i.status === "completed" || i.status === "cancelled").length;
		const key = JSON.stringify(phases);
		countEl.textContent = all.length ? `${done}/${all.length}` : "";
		if (key === lastKey) return;
		lastKey = key;
		dock.hidden = !all.length;
		if (!all.length) return;
		body.textContent = "";
		for (const phase of phases) {
			const box = document.createElement("div");
			box.className = "otodo-phase";
			if (phase.title) {
				const title = document.createElement("div");
				title.className = "otodo-phase-title";
				title.textContent = phase.title;
				box.append(title);
			}
			for (const item of phase.items) {
				const row = document.createElement("div");
				row.className = "otodo-item";
				row.dataset.status = item.status;
				const mark = document.createElement("span");
				mark.className = "otodo-mark";
				if (item.status === "in_progress") mark.innerHTML = '<span class="otodo-spin"></span>';
				else if (item.status === "completed") mark.innerHTML = CHECK;
				else if (item.status === "cancelled") mark.innerHTML = CROSS;
				else mark.innerHTML = CIRCLE;
				const text = document.createElement("span");
				text.className = "otodo-text";
				text.textContent = item.text;
				row.append(mark, text);
				box.append(row);
			}
			body.append(box);
		}
	};

	const fetch = async () => {
		if (busy) return;
		busy = true;
		lastFetch = Date.now();
		try {
			const state = await window.pi.command({ type: "get_state" });
			render(normalize(state?.todoPhases));
		} catch {
			// 后端不支持或正在重启：保持原样，不清空
		} finally {
			busy = false;
		}
	};

	// 事件驱动：todo 只在工具执行/回合边界变化；不再每秒轮询 get_state。
	// 流式期间留一个 3s 兜底（防止扩展直接改状态没发事件），空闲完全不请求。
	let timer = 0;
	let fallback = 0;
	const schedule = () => {
		clearTimeout(timer);
		timer = setTimeout(fetch, 350);
	};
	const tick = () => {
		if (!document.hidden && window.__piStreaming) fetch();
	};
	fallback = setInterval(tick, 3_000);

	window.addEventListener("myna:event", (e) => {
		const detail = e.detail;
		const type = detail?.type;
		if (type === "agent_start" || type === "agent_settled" || type === "todo" || type === "todo_update") schedule();
		else if (type === "tool_execution_end" && /^(todo|task)$/.test(String(detail?.toolName || ""))) schedule();
	});
	document.addEventListener("visibilitychange", () => {
		if (!document.hidden) fetch();
	});
	// 非 OMP 后端没有 todoPhases，不轮询也不占位
	window.agentBackend
		?.info?.()
		.then((info) => {
			if (info?.id !== "omp") {
				clearInterval(fallback);
				dock.hidden = true;
				return;
			}
			fetch();
		})
		.catch(() => fetch());
	// 清掉旧会话的 ids 时同步清空
	const clearWhenEmpty = setInterval(() => {
		if (!document.getElementById("otodo")) {
			clearInterval(fallback);
			clearInterval(clearWhenEmpty);
		}
	}, 10_000);
}
