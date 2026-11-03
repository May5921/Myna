// OMP 子代理任务：聚合 task 工具的 start/end，在输入框上方显示运行中的子任务。
// 只消费 IR 事件（myna:event），不轮询；pi 后端没有 task 工具时自动隐藏。
const OPEN_KEY = "myna.tasks.open";
const MAX = 24;

const CSS = `
.otask {
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
.otask[hidden] { display: none; }
.otask-head {
	display: flex;
	align-items: center;
	gap: 8px;
	width: 100%;
	padding: 7px 12px;
	color: var(--dim);
	text-align: left;
}
.otask-head:hover { background: var(--hover); color: var(--text); }
.otask-title { font-weight: 550; color: var(--text); }
.otask-count { color: var(--faint); font-variant-numeric: tabular-nums; }
.otask-grow { flex: 1; }
.otask-chev { color: var(--faint); transition: transform 140ms ease; }
.otask[data-open="0"] .otask-chev { transform: rotate(-90deg); }
.otask-body { padding: 0 12px 8px; }
.otask[data-open="0"] .otask-body { display: none; }
.otask-row { display: flex; align-items: flex-start; gap: 7px; padding: 4px 0; color: var(--dim); }
.otask-mark { flex: none; width: 13px; height: 13px; margin-top: 1px; display: grid; place-items: center; }
.otask-spin { width: 10px; height: 10px; border: 1.5px solid var(--line-strong); border-top-color: var(--text); border-radius: 50%; animation: otask-spin 900ms linear infinite; }
@keyframes otask-spin { to { transform: rotate(360deg); } }
.otask-main { min-width: 0; flex: 1; }
.otask-name { color: var(--text); overflow-wrap: anywhere; }
.otask-meta { color: var(--faint); font-size: 11px; margin-top: 1px; }
.otask-row[data-status="error"] .otask-name { color: var(--err); }
.otask-row[data-status="done"] .otask-name { color: var(--dim); }
.otask-out { margin-top: 3px; color: var(--faint); font-size: 11px; white-space: pre-wrap; max-height: 54px; overflow: auto; overflow-wrap: anywhere; }
@media (prefers-reduced-motion: reduce) { .otask-spin { animation: none; } }
`;

const DONE =
	'<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="5.2" fill="currentColor" opacity=".16"/><path d="M3.4 6.1 5.2 7.9 8.8 4.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ERR =
	'<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="4.8" stroke="currentColor" stroke-width="1.1"/><path d="m4.2 4.2 3.6 3.6M7.8 4.2 4.2 7.8" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>';

const textOf = (v) => (typeof v === "string" && v.trim() ? v.trim() : "");

function taskName(args) {
	if (!args || typeof args !== "object") return "子任务";
	return (
		textOf(args.description) ||
		textOf(args.title) ||
		textOf(args.prompt) ||
		textOf(args.task) ||
		textOf(args.agent) ||
		"子任务"
	).slice(0, 160);
}

export function init(ctx) {
	if (!ctx?.pi) return;
	if (document.getElementById("otask")) return;
	const style = document.createElement("style");
	style.textContent = CSS;
	document.head.append(style);

	const dock = document.createElement("div");
	dock.id = "otask";
	dock.className = "otask";
	dock.hidden = true;
	const head = document.createElement("button");
	head.type = "button";
	head.className = "otask-head";
	head.innerHTML =
		'<span class="otask-title">子代理</span><span class="otask-count"></span><span class="otask-grow"></span><span class="otask-chev">▾</span>';
	const body = document.createElement("div");
	body.className = "otask-body";
	dock.append(head, body);
	const countEl = head.querySelector(".otask-count");

	let open = true;
	try {
		open = localStorage.getItem(OPEN_KEY) !== "0";
	} catch {}
	dock.dataset.open = open ? "1" : "0";
	head.onclick = () => {
		open = !open;
		dock.dataset.open = open ? "1" : "0";
		try {
			localStorage.setItem(OPEN_KEY, open ? "1" : "0");
		} catch {}
	};

	const anchor = () => {
		const todo = document.getElementById("otodo");
		const composer = document.getElementById("composer");
		if (todo?.parentElement) todo.before(dock);
		else if (composer) composer.before(dock);
		else document.querySelector("main")?.append(dock);
	};
	anchor();

	// id → { id, name, status, startedAt, durationMs, output }
	const items = new Map();
	let backendOmp = true;

	const render = () => {
		const list = [...items.values()];
		if (!backendOmp || !list.length) {
			dock.hidden = true;
			return;
		}
		const running = list.filter((i) => i.status === "running").length;
		countEl.textContent = running ? `${running} 个运行中` : `${list.length} 个`;
		dock.hidden = false;
		body.textContent = "";
		for (const item of list.slice(-MAX)) {
			const row = document.createElement("div");
			row.className = "otask-row";
			row.dataset.status = item.status;
			const mark = document.createElement("span");
			mark.className = "otask-mark";
			if (item.status === "running") mark.innerHTML = '<span class="otask-spin"></span>';
			else if (item.status === "error") mark.innerHTML = ERR;
			else mark.innerHTML = DONE;
			const main = document.createElement("div");
			main.className = "otask-main";
			const name = document.createElement("div");
			name.className = "otask-name";
			name.textContent = item.name;
			const meta = document.createElement("div");
			meta.className = "otask-meta";
			const parts = [item.status === "running" ? "运行中" : item.status === "error" ? "失败" : "完成"];
			if (item.durationMs != null) parts.push(`${(item.durationMs / 1000).toFixed(1)}s`);
			meta.textContent = parts.join(" · ");
			main.append(name, meta);
			if (item.output && item.status !== "running") {
				const out = document.createElement("div");
				out.className = "otask-out";
				out.textContent = item.output;
				main.append(out);
			}
			row.append(mark, main);
			body.append(row);
		}
	};

	window.addEventListener("myna:event", (e) => {
		const ev = e.detail;
		if (!ev) return;
		if (ev.type === "tool.start") {
			const name = String(ev.name || "").toLowerCase();
			if (name !== "task" && name !== "subagent") return;
			const id = String(ev.toolCallId || `task-${Date.now()}`);
			items.set(id, {
				id,
				name: taskName(ev.args),
				status: "running",
				startedAt: Date.now(),
				durationMs: null,
				output: "",
			});
			render();
			return;
		}
		if (ev.type === "tool.end") {
			const item = items.get(String(ev.toolCallId || ""));
			if (!item) return;
			item.status = ev.ok === false ? "error" : "done";
			item.durationMs = Number.isFinite(ev.durationMs) ? ev.durationMs : Date.now() - item.startedAt;
			item.output = textOf(ev.output).slice(0, 600);
			render();
		}
	});

	window.agentBackend
		?.info?.()
		.then((info) => {
			backendOmp = info?.id === "omp";
			if (!backendOmp) items.clear();
			render();
		})
		.catch(() => {});
}
