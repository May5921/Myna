// 底部终端抽屉：非 PTY，一次执行一条命令（cwd 由 main.js 固定为 ctx.state.cwd），流式回显。
// 只新增本文件，样式自注入（.term- 前缀），不改 index.html / app.js / main.js / preload.cjs / base.css。
//
// 数据契约（ctx.pi，见 preload.cjs + main.js）：
//   termRun({ command }) → { runId }
//   onTermData(cb) → 退订；{ runId, stream: "stdout" | "stderr", chunk }
//   onTermExit(cb) → 退订；{ runId, code }
//
// 窗口钩子：__piTermToggle() 开关抽屉；__piTermDemo() 打开并跑 `echo pi-mini terminal`。
// 键盘：Ctrl+` 全局开关（普通反引号输入不受影响）；输入框内 Enter 执行 / ↑↓ 历史 / Ctrl+L 清屏；Esc 关闭抽屉。
//
// 层级：z-index 8 —— 压过 #jump(5)，让位给 #menu(10) / queue(45) / 右栏(40) / 设置(60)。
// 配色：终端是浅色界面里的深色孤岛，内部前景色相对深色底定义，集中在 .term 的 4 个局部变量上
// （--term-bg / --term-fg / --term-dim / --term-err），宿主换深色主题只改这 4 行。

const MAX_LINES = 2000;
const HISTORY_MAX = 200;
const CLOSE_ICON =
	'<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M2.7 2.7 9.3 9.3M9.3 2.7 2.7 9.3"/></svg>';

const CSS = `
.term {
	/* 终端底色：跟随宿主的代码底色；本主题 --code-bg 是浅色 #f6f6f6，
	   白字会糊，init() 量一次实际亮度，浅色就落到 #1a1c1f 兜底（深色主题仍跟随 --code-bg）。 */
	--term-bg: var(--code-bg, #1a1c1f);
	--term-fg: rgba(255, 255, 255, 0.92);
	--term-dim: rgba(255, 255, 255, 0.5);
	--term-err: #ff9d94;
	position: fixed;
	left: 0;
	right: 0;
	bottom: 0;
	z-index: 8;
	display: flex;
	flex-direction: column;
	height: min(300px, 45vh);
	background: var(--bg);
	border-top: 1px solid var(--line);
	color: var(--text);
	font-family: var(--ui);
}
.term[hidden] { display: none; }

.term-head {
	display: flex;
	align-items: center;
	gap: 8px;
	flex: 0 0 32px;
	height: 32px;
	padding: 0 8px 0 12px;
	border-bottom: 1px solid var(--line);
	background: var(--bg);
}
.term-title {
	flex: 0 0 auto;
	font-size: 12px;
	font-weight: var(--weight-shell);
	color: var(--text);
}
.term-cwd {
	flex: 1 1 auto;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font: 11px/1 var(--mono);
	color: var(--faint);
}
.term-btn {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	flex: 0 0 auto;
	height: 22px;
	min-width: 22px;
	padding: 0 6px;
	border: 0;
	border-radius: 6px;
	background: none;
	color: var(--faint);
	font: 12px/1 var(--ui);
}
.term-btn:hover { background: var(--hover); color: var(--text); }
.term-btn:focus-visible { outline: 1px solid var(--faint); outline-offset: -1px; }
.term-btn svg { display: block; }

.term-out {
	flex: 1 1 auto;
	min-height: 0;
	overflow-x: hidden;
	overflow-y: auto;
	padding: 6px 12px 8px;
	background: var(--term-bg);
	color: var(--term-fg);
	font: 12px/1.55 var(--mono);
	white-space: pre-wrap;
	word-break: break-word;
	overscroll-behavior: contain;
	scrollbar-width: thin;
	scrollbar-color: var(--term-dim) transparent;
}
.term-out::-webkit-scrollbar { width: 8px; }
.term-out::-webkit-scrollbar-thumb { background: var(--term-dim); border-radius: 4px; }
/* 空行也要占一行高，否则 printf 的空行会被压扁 */
.term-line { min-height: 1.55em; }
.term-line.cmd { color: var(--term-dim); }
.term-line.err { color: var(--term-err); }
.term-line.exit { color: var(--term-dim); }

.term-foot {
	display: flex;
	align-items: center;
	gap: 8px;
	flex: 0 0 34px;
	height: 34px;
	padding: 0 12px;
	border-top: 1px solid var(--line);
	background: var(--bg);
}
.term-prompt {
	flex: 0 0 auto;
	font: 12px/1 var(--mono);
	color: var(--faint);
}
.term-input {
	flex: 1 1 auto;
	min-width: 0;
	height: 24px;
	padding: 0;
	border: 0;
	outline: 0;
	background: none;
	color: var(--text);
	font: 12px/1.5 var(--mono);
}
.term-input::placeholder { color: var(--faint); }
.term-input:disabled { color: var(--faint); }
.term-state {
	flex: 0 0 auto;
	font-size: 11px;
	color: var(--faint);
}
`;

export function init(ctx) {
	if (typeof document === "undefined") return null;
	if (document.querySelector(".term")) return window.__piTermAPI || null; // 幂等：重复 init 不叠 DOM

	const pi = ctx?.pi || {};
	const state = ctx?.state || {};

	const style = document.createElement("style");
	style.textContent = CSS;
	document.head.append(style);

	// ---------- DOM ----------
	const mkBtn = (label, title, html) => {
		const b = document.createElement("button");
		b.type = "button";
		b.className = "term-btn";
		b.title = title;
		b.setAttribute("aria-label", title);
		if (html) b.innerHTML = html;
		else b.textContent = label;
		return b;
	};

	const root = document.createElement("div");
	root.className = "term";
	root.hidden = true;
	root.setAttribute("role", "region");
	root.setAttribute("aria-label", "终端");

	const head = document.createElement("div");
	head.className = "term-head";

	const title = document.createElement("span");
	title.className = "term-title";
	title.textContent = "终端";

	const cwdEl = document.createElement("span");
	cwdEl.className = "term-cwd";

	const clearBtn = mkBtn("清空", "清空输出（Ctrl+L）", "");
	const closeBtn = mkBtn("", "关闭终端（Esc）", CLOSE_ICON);

	head.append(title, cwdEl, clearBtn, closeBtn);

	const out = document.createElement("div");
	out.className = "term-out";

	const foot = document.createElement("div");
	foot.className = "term-foot";

	const prompt = document.createElement("span");
	prompt.className = "term-prompt";
	prompt.textContent = "$";

	const input = document.createElement("input");
	input.className = "term-input";
	input.type = "text";
	input.autocomplete = "off";
	input.spellcheck = false;
	input.setAttribute("aria-label", "终端命令");
	input.placeholder = "输入命令，Enter 执行";

	const stateEl = document.createElement("span");
	stateEl.className = "term-state";

	foot.append(prompt, input, stateEl);
	root.append(head, out, foot);
	document.body.append(root);

	// 输出区底色：本主题 --code-bg 是浅色，白字会糊；量一次实际底色，浅色就落到深色兜底。
	const bg = getComputedStyle(out).backgroundColor || "";
	const m = /^rgba?\(([^)]+)\)$/i.exec(bg);
	if (m) {
		const [r, g, b, a = 1] = m[1].split(",").map((v) => parseFloat(v));
		const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
		if (a < 0.5 || lum > 0.5) out.style.background = "#1a1c1f";
	}

	// ---------- 状态 ----------
	let open = false;
	let running = false;
	let current = ""; // 当前 runId
	let runSeq = 0; // 防「启动请求还没返回，命令已经退出/又起一条」的竞态
	const dead = new Set(); // 已退出 / 被新命令顶掉的 runId：迟到的 data/exit 一律丢弃
	const history = []; // 只在本功能内，不落盘
	let hIdx = -1;
	let draft = "";
	const tail = { stdout: null, stderr: null }; // 未换行的尾巴节点，避免把一行拆成多行
	const unsubs = [];

	const msg = (e) => String(e?.message || e || "未知错误");
	// runId 作废：主进程 kill 掉旧命令后，管道里可能还有迟到的 data/exit。
	const markDead = (id) => {
		if (!id) return;
		dead.add(id);
		if (dead.size > 256) dead.delete(dead.values().next().value); // 只留最近 256 条，防无界增长
	};
	const caret = () => {
		const n = input.value.length;
		try {
			input.setSelectionRange(n, n);
		} catch {}
	};
	const pin = () => {
		out.scrollTop = out.scrollHeight;
	};
	const atBottom = () => out.scrollHeight - out.scrollTop - out.clientHeight < 24;

	const makeLine = (text, kind) => {
		const el = document.createElement("div");
		el.className = kind ? `term-line ${kind}` : "term-line";
		el.textContent = text;
		return el;
	};

	// 只留最近 MAX_LINES 行；一次删一批，避免逐条 remove 触发多次布局。
	const trim = () => {
		const excess = out.childElementCount - MAX_LINES;
		if (excess <= 0) return;
		const range = document.createRange();
		range.setStartBefore(out.firstElementChild);
		range.setEndAfter(out.children[excess - 1]);
		range.deleteContents();
		if (tail.stdout && !tail.stdout.isConnected) tail.stdout = null;
		if (tail.stderr && !tail.stderr.isConnected) tail.stderr = null;
	};

	const emit = (text, kind) => {
		out.append(makeLine(text, kind));
		trim();
	};

	const refreshCwd = () => {
		const cwd = typeof state.cwd === "string" ? state.cwd : "";
		cwdEl.textContent = cwd || "—";
		cwdEl.title = cwd;
	};

	const clear = () => {
		out.textContent = "";
		tail.stdout = tail.stderr = null;
	};

	const setRunning = (on) => {
		running = on;
		input.disabled = on;
		stateEl.textContent = on ? "运行中…" : "";
		// 结束后把焦点还给输入框，但不从别处（比如主输入框）抢焦点
		if (!on && open) {
			const a = document.activeElement;
			if (!a || a === document.body || a === input) input.focus({ preventScroll: true });
		}
	};

	// ---------- 流式输出 ----------
	// 按 \n 切行，未换行的尾巴留在同一个节点里（下次 chunk 继续追加），
	// 这样 64KB 边界把一行切开时不会变成两行；\r / \r\n 统一成 \n。
	const feed = (stream, chunk) => {
		if (!chunk) return;
		const kind = stream === "stderr" ? "err" : "";
		const parts = String(chunk).replace(/\r\n?/g, "\n").split("\n");
		if (parts.length > MAX_LINES) parts.splice(0, parts.length - MAX_LINES); // 一次刷屏只留尾部
		const bottom = atBottom();
		let node = tail[stream];
		const frag = document.createDocumentFragment();
		for (let i = 0; i < parts.length; i++) {
			const seg = parts[i];
			const last = i === parts.length - 1;
			if (last && seg === "") {
				tail[stream] = null; // 以换行结尾：尾巴收口
				break;
			}
			if (!node) {
				node = makeLine("", kind);
				frag.append(node);
				tail[stream] = node;
			}
			if (seg) node.textContent += seg;
			if (!last) {
				node = null;
				tail[stream] = null;
			}
		}
		if (frag.childElementCount) {
			out.append(frag);
			trim();
		}
		if (bottom) pin();
	};

	// ---------- 历史 ----------
	const pushHistory = (cmd) => {
		if (history[history.length - 1] !== cmd) history.push(cmd);
		if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX);
	};

	const nav = (dir) => {
		if (!history.length) return;
		if (hIdx === -1) {
			if (dir > 0) return; // 已在草稿位
			draft = input.value;
			hIdx = history.length - 1;
		} else {
			hIdx += dir;
			if (hIdx >= history.length) {
				hIdx = -1;
				input.value = draft;
				caret();
				return;
			}
			if (hIdx < 0) hIdx = 0;
		}
		input.value = history[hIdx] ?? "";
		caret();
	};

	// ---------- 执行 ----------
	const run = async (command) => {
		const cmd = String(command ?? "").trim();
		if (!cmd || running) return;
		if (typeof pi.termRun !== "function") {
			emit("终端接口未就绪：ctx.pi.termRun 不存在", "err");
			return;
		}
		const seq = ++runSeq;
		if (current) markDead(current);
		current = "";
		tail.stdout = tail.stderr = null;
		refreshCwd();
		emit(`$ ${cmd}`, "cmd");
		pin();
		input.value = "";
		hIdx = -1;
		draft = "";
		pushHistory(cmd);
		setRunning(true);
		try {
			const res = await pi.termRun({ command: cmd });
			const id = String(res?.runId ?? "");
			if (!id) throw new Error("termRun 未返回 runId");
			if (seq === runSeq) current = id;
		} catch (e) {
			if (seq === runSeq) {
				current = "";
				emit(`启动失败：${msg(e)}`, "err");
				setRunning(false);
			}
		}
	};

	const finish = (id, code) => {
		if (id) markDead(id);
		current = "";
		tail.stdout = tail.stderr = null;
		emit(`退出 ${Number.isFinite(code) ? code : -1}`, "exit");
		pin();
		setRunning(false);
	};

	// ---------- 事件 ----------
	const onData = (ev) => {
		if (!running) return;
		const id = String(ev?.runId ?? "");
		if (id && dead.has(id)) return;
		if (current && id !== current) {
			if (id) markDead(id);
			return;
		}
		feed(ev?.stream === "stderr" ? "stderr" : "stdout", ev?.chunk);
	};

	const onExit = (ev) => {
		const id = String(ev?.runId ?? "");
		if (id && dead.has(id)) return;
		if (!running) return;
		if (current && id !== current) {
			if (id) markDead(id);
			return;
		}
		finish(id, ev?.code);
	};

	// ---------- 开关 ----------
	const setOpen = (next) => {
		const want = !!next;
		if (want === open) return;
		open = want;
		if (open) {
			refreshCwd();
			root.hidden = false;
			pin();
			requestAnimationFrame(() => {
				if (open) input.focus({ preventScroll: true });
			});
		} else {
			root.hidden = true;
			if (document.activeElement === input) input.blur();
		}
	};

	const toggle = () => setOpen(!open);

	// ---------- 键盘 ----------
	const onInputKey = (e) => {
		if (e.isComposing) return;
		if (e.key === "Enter") {
			e.preventDefault();
			if (!running) {
				const cmd = input.value.trim();
				if (cmd) run(cmd);
			}
			return;
		}
		if (e.key === "ArrowUp") {
			e.preventDefault();
			nav(-1);
			return;
		}
		if (e.key === "ArrowDown") {
			e.preventDefault();
			nav(1);
			return;
		}
		if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "l" || e.key === "L")) {
			e.preventDefault();
			clear();
		}
	};

	const onDocKey = (e) => {
		if (e.isComposing) return;
		// Ctrl+` 全局开关：必须按住 Ctrl/Cmd，输入框里的普通反引号不受影响。
		if (
			(e.ctrlKey || e.metaKey) &&
			!e.altKey &&
			!e.shiftKey &&
			(e.code === "Backquote" || e.key === "`")
		) {
			e.preventDefault();
			e.stopPropagation();
			toggle();
			return;
		}
		// Esc 只在抽屉打开时关抽屉；别的浮层已经处理过（defaultPrevented）就不抢。
		if (e.key === "Escape" && open && !e.defaultPrevented) {
			e.preventDefault();
			setOpen(false);
		}
	};

	// ---------- 接线 ----------
	input.addEventListener("keydown", onInputKey);
	clearBtn.addEventListener("click", () => {
		clear();
		input.focus({ preventScroll: true });
	});
	closeBtn.addEventListener("click", () => setOpen(false));
	document.addEventListener("keydown", onDocKey, true);

	for (const [name, cb] of [
		["onTermData", onData],
		["onTermExit", onExit],
	]) {
		if (typeof pi[name] !== "function") continue;
		try {
			const off = pi[name](cb);
			if (typeof off === "function") unsubs.push(off);
		} catch {}
	}

	refreshCwd();

	const demo = () => {
		setOpen(true);
		return run("echo pi-mini terminal");
	};

	const api = {
		open: () => setOpen(true),
		close: () => setOpen(false),
		toggle,
		run,
		clear,
		get isOpen() {
			return open;
		},
		get isRunning() {
			return running;
		},
		destroy() {
			for (const off of unsubs.splice(0)) {
				try {
					off();
				} catch {}
			}
			document.removeEventListener("keydown", onDocKey, true);
			input.removeEventListener("keydown", onInputKey);
			root.remove();
			style.remove();
			if (window.__piTermToggle === toggle) delete window.__piTermToggle;
			if (window.__piTermDemo === demo) delete window.__piTermDemo;
			if (window.__piTermAPI === api) delete window.__piTermAPI;
		},
	};

	window.__piTermToggle = toggle;
	window.__piTermDemo = demo;
	window.__piTermAPI = api;
	return api;
}
