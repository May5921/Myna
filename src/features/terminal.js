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
// 本地持久化（localStorage，读写全部 try/catch，隐私模式下静默降级）：
//   pi-mini.termHistory —— 最近 200 条命令（相邻去重），刷新后 ↑↓ 仍可用；
//   pi-mini.termHeight  —— 抽屉高度 px（160 ~ min(560, 70vh)），双击拖拽条删键回默认。
// 输出：写入前清 ANSI（CSI/OSC/DCS 等），\r\n、\r 规整成 \n；跨 chunk 的半截转义序列挂起等待下一段。
// 运行中：输入行右侧出现「停止」（ctx.pi.termKill），停止后追一行 dim「已停止」；Esc 照旧只关抽屉。
//
// 层级：z-index 8 —— 压过 #jump(5)，让位给 #menu(10) / queue(45) / 右栏(40) / 设置(60)。
// 配色：终端是浅色界面里的深色孤岛，内部前景色相对深色底定义，集中在 .term 的 4 个局部变量上
// （--term-bg / --term-fg / --term-dim / --term-err），宿主换深色主题只改这 4 行。

const MAX_LINES = 2000;
const HISTORY_MAX = 200;
const HKEY = "pi-mini.termHistory";
const HKEY_H = "pi-mini.termHeight";
const H_MIN = 160; // 拖拽下限
const H_DEFAULT = () => Math.min(300, Math.round(window.innerHeight * 0.45)); // 与 CSS 默认 min(300px,45vh) 一致
const H_MAX = () => Math.max(H_MIN, Math.min(560, Math.round(window.innerHeight * 0.7)));

// 半截转义序列的缓冲上限：真遇到永不完结的 OSC（比如坏掉的标题设置），直接丢，别把内存吃满。
const ANSI_CARRY_MAX = 4096;

const CLOSE_ICON =
	'<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M2.7 2.7 9.3 9.3M9.3 2.7 2.7 9.3"/></svg>';

// ---------- ANSI ----------
// 逐段清理即可（性能不敏感）：OSC/DCS 先走（内容里可能带 '['），再 CSI，再两字符转义，
// 最后抹掉残余控制字符（保留 \t \n，\r 交给下面的规整；BEL 等一并清掉）。
const stripAnsi = (s) =>
	String(s)
		.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "") // OSC：窗口标题、超链接（BEL 或 ST 收尾）
		.replace(/\x1b[P^_][\s\S]*?\x1b\\/g, "") // DCS / PM / APC（ST 收尾）
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "") // CSI：颜色 \x1b[32m、擦除行 \x1b[K、光标等
		.replace(/\x1b[@-Z\\-_]/g, "") // 两字符转义：ESC ( B、ESC 7、ESC = …
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ""); // 残余控制符（\t=09、\n=0a 保留）

// \r\n / 裸 \r（进度条覆盖写）统一成 \n；中文和普通换行原样保留。
const normalizeOut = (s) => stripAnsi(s).replace(/\r\n?/g, "\n");

// 末尾挂着未完成的转义序列时返回它的起点，留给下一个 chunk 续上；否则 -1。
const ansiTailFrom = (s) => {
	const i = s.lastIndexOf("\x1b");
	if (i < 0) return -1;
	const rest = s.slice(i + 1);
	if (!rest) return i; // 只有 ESC
	const lead = rest[0];
	if (lead === "[") return /[@-~]/.test(rest.slice(1)) ? -1 : i; // CSI 最终字节 0x40-0x7E
	if (lead === "]" || lead === "P" || lead === "^" || lead === "_") {
		return /(?:\x07|\x1b\\)/.test(rest.slice(1)) ? -1 : i; // OSC/DCS：BEL 或 ST 收尾
	}
	return -1; // 两字符转义：ESC 后已跟一个字符即完整
};

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
/* 拖拽调高：只有 8px，鼠标悬停才亮一下；触摸/拖动期间禁掉选中，免得把文字刷蓝。 */
.term-grip {
	position: relative;
	flex: 0 0 8px;
	height: 8px;
	cursor: ns-resize;
	background: var(--bg);
	touch-action: none;
	user-select: none;
}
.term-grip::after {
	content: "";
	position: absolute;
	left: 50%;
	top: 3px;
	width: 36px;
	height: 2px;
	margin-left: -18px;
	border-radius: 1px;
	background: var(--line);
	transition: background 0.12s ease;
}
.term-grip:hover::after, .term-grip:active::after { background: var(--dim); }
.term.dragging, .term.dragging * { user-select: none !important; }

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
/* 停止：运行中出现在输入行右侧；暖红提示，但底是浅色，用宿主 --err。 */
.term-btn.stop { color: var(--err, var(--term-err)); }
.term-btn.stop:hover { background: var(--hover); color: var(--err, var(--term-err)); }
.term-btn.ok { color: var(--text); }
.term-btn[hidden] { display: none; }

.term-out {
	flex: 1 1 auto;
	min-height: 0;
	overflow-x: hidden;
	overflow-y: auto;
	padding: 6px 12px 8px;
	background: var(--term-bg);
	color: var(--term-fg);
	font: var(--term-size, 12px)/1.55 var(--mono);
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
.term-line.dim { color: var(--term-dim); }
/* 非 0 退出：按要求用宿主 --err；深色底上它偏暗，兜底落在 --term-err。 */
.term-line.exit-fail { color: var(--err, var(--term-err)); }

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

	const grip = document.createElement("div");
	grip.className = "term-grip";
	grip.title = "拖动调整高度（双击恢复默认）";
	grip.setAttribute("role", "separator");
	grip.setAttribute("aria-orientation", "horizontal");

	const head = document.createElement("div");
	head.className = "term-head";

	const title = document.createElement("span");
	title.className = "term-title";
	title.textContent = "终端";

	const cwdEl = document.createElement("span");
	cwdEl.className = "term-cwd";

	const copyBtn = mkBtn("复制", "复制全部输出", "");
	const clearBtn = mkBtn("清空", "清空输出（Ctrl+L）", "");
	const closeBtn = mkBtn("", "关闭终端（Esc）", CLOSE_ICON);

	head.append(title, cwdEl, copyBtn, clearBtn, closeBtn);

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

	const stopBtn = mkBtn("停止", "停止当前命令", "");
	stopBtn.classList.add("stop");
	stopBtn.hidden = true;

	foot.append(prompt, input, stateEl, stopBtn);
	root.append(grip, head, out, foot);
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
	let stopPending = false; // 「runId 还没回来就点了停止」：等 id 到手立刻 kill
	let runSeq = 0; // 防「启动请求还没返回，命令已经退出/又起一条」的竞态
	const dead = new Set(); // 已退出 / 被新命令顶掉的 runId：迟到的 data/exit 一律丢弃
	const history = loadHistory();
	let hIdx = -1;
	let draft = "";
	const tail = { stdout: null, stderr: null }; // 未换行的尾巴节点，避免把一行拆成多行
	const carry = { stdout: "", stderr: "" }; // 跨 chunk 的半截转义序列
	const unsubs = [];

	// ---------- localStorage（隐私模式 / 配额满都静默降级）----------
	function readStore(key) {
		try {
			return localStorage.getItem(key);
		} catch {
			return null;
		}
	}
	function writeStore(key, val) {
		try {
			localStorage.setItem(key, val);
		} catch {}
	}
	function dropStore(key) {
		try {
			localStorage.removeItem(key);
		} catch {}
	}
	function loadHistory() {
		let raw = null;
		try {
			raw = JSON.parse(readStore(HKEY) || "[]");
		} catch {
			return [];
		}
		if (!Array.isArray(raw)) return [];
		const list = [];
		for (const v of raw) {
			if (typeof v !== "string") continue;
			const s = v.trim();
			if (!s || list[list.length - 1] === s) continue; // 去空 + 相邻去重
			list.push(s);
		}
		return list.slice(-HISTORY_MAX);
	}

	// ---------- 高度 ----------
	const clampH = (h) => Math.max(H_MIN, Math.min(H_MAX(), Math.round(Number(h) || 0)));
	const applyHeight = (h) => {
		root.style.height = `${clampH(h)}px`;
	};
	// 启动恢复：没有记录就用 CSS 默认 min(300px,45vh)。
	const savedH = parseFloat(readStore(HKEY_H) || "");
	if (Number.isFinite(savedH)) applyHeight(savedH);

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
		out.append(makeLine(stripAnsi(text), kind));
		trim();
	};

	const refreshCwd = () => {
		const cwd = typeof state.cwd === "string" ? state.cwd : "";
		cwdEl.textContent = cwd || "—";
		cwdEl.title = cwd;
	};

	// 只清输出：历史与高度都不动（清空按钮的语义）。
	const clear = () => {
		out.textContent = "";
		tail.stdout = tail.stderr = null;
		carry.stdout = carry.stderr = "";
	};

	const setRunning = (on) => {
		running = on;
		input.disabled = on;
		stateEl.textContent = on ? "运行中…" : "";
		stopBtn.hidden = !on; // 运行中才给停止入口
		// 结束后把焦点还给输入框，但不从别处（比如主输入框）抢焦点
		if (!on && open) {
			const a = document.activeElement;
			if (!a || a === document.body || a === input) input.focus({ preventScroll: true });
		}
	};

	// ---------- 流式输出 ----------
	// 按 \n 切行，未换行的尾巴留在同一个节点里（下次 chunk 继续追加），
	// 这样 64KB 边界把一行切开时不会变成两行。
	// 每个 chunk 先拼 carry（上个 chunk 末尾没写完的转义序列），清完 ANSI 再规整 \r，
	// 所以 \x1b[3 与 2m 被拆到两个 chunk 也不会漏成乱码。
	const feed = (stream, chunk) => {
		if (!chunk) return;
		const kind = stream === "stderr" ? "err" : "";
		let raw = carry[stream] + String(chunk);
		const cut = ansiTailFrom(raw);
		if (cut >= 0) {
			carry[stream] = raw.slice(cut);
			raw = raw.slice(0, cut);
			// 永不完结的 OSC（坏掉的控制序列）别无限攒：超限直接丢，输出照常继续。
			if (carry[stream].length > ANSI_CARRY_MAX) carry[stream] = "";
		} else {
			carry[stream] = "";
		}
		const text = normalizeOut(raw);
		if (!text) return;
		const parts = text.split("\n");
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
	// 落盘在 pushHistory 里做（每条命令一次写入），启动时 loadHistory 读回。
	const pushHistory = (cmd) => {
		if (history[history.length - 1] !== cmd) history.push(cmd);
		if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX);
		writeStore(HKEY, JSON.stringify(history));
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
		stopPending = false;
		tail.stdout = tail.stderr = null;
		carry.stdout = carry.stderr = "";
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
			if (seq !== runSeq) {
				markDead(id); // 这条已经被后一条顶掉：让它安静地跑完
				return;
			}
			current = id;
			if (stopPending) {
				// 用户在 termRun 返回前就点了「停止」：id 一到手立刻 kill。
				stopPending = false;
				killNow(id);
			}
		} catch (e) {
			if (seq === runSeq) {
				current = "";
				stopPending = false;
				emit(`启动失败：${msg(e)}`, "err");
				setRunning(false);
			}
		}
	};

	// 主动停止：先把这个 runId 作废（主进程 kill 后迟到的 data/exit 会被丢掉），
	// 所以不会再追加一行「退出 -1」，只留一行 dim「已停止」。
	const killNow = (id) => {
		markDead(id);
		current = "";
		stopPending = false;
		tail.stdout = tail.stderr = null;
		carry.stdout = carry.stderr = "";
		emit("已停止", "dim");
		pin();
		setRunning(false);
		if (typeof pi.termKill === "function") {
			try {
				Promise.resolve(pi.termKill(id)).catch(() => {});
			} catch {}
		} else {
			emit("ctx.pi.termKill 不存在，无法停止", "err");
		}
	};

	const stop = () => {
		if (!running) return;
		if (!current) {
			stopPending = true; // runId 还没回来，等 run() 拿到再 kill
			return;
		}
		killNow(current);
	};

	const finish = (id, code) => {
		if (id) markDead(id);
		current = "";
		tail.stdout = tail.stderr = null;
		carry.stdout = carry.stderr = "";
		const n = Number.isFinite(code) ? code : -1;
		emit(`退出 ${n}`, n === 0 ? "exit" : "exit-fail");
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

	// ---------- 复制 ----------
	let copyTimer = 0;
	const copyText = async (text) => {
		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(text);
				return true;
			}
		} catch {} // 无权限 / 非安全上下文：落到 execCommand
		try {
			const ta = document.createElement("textarea");
			ta.value = text;
			ta.setAttribute("readonly", "");
			ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none";
			document.body.append(ta);
			ta.select();
			const ok = document.execCommand("copy");
			ta.remove();
			return ok;
		} catch {
			return false;
		}
	};
	const copyAll = async () => {
		// 逐行取 textContent：div 是块级，直接 textContent 会把所有行粘成一行。
		const text = Array.from(out.children)
			.map((el) => el.textContent)
			.join("\n");
		const ok = await copyText(text);
		clearTimeout(copyTimer);
		copyBtn.textContent = ok ? "已复制" : "复制失败";
		copyBtn.classList.toggle("ok", ok);
		copyTimer = setTimeout(() => {
			copyBtn.textContent = "复制";
			copyBtn.classList.remove("ok");
		}, 1200);
	};

	// ---------- 拖拽调高 ----------
	// 抽屉贴底，所以往上拖 = 变高：h = 起始高度 + (起始 Y - 当前 Y)。
	let drag = null;
	const onGripDown = (e) => {
		if (e.pointerType === "mouse" && e.button !== 0) return;
		e.preventDefault();
		drag = { y: e.clientY, h: root.getBoundingClientRect().height };
		root.classList.add("dragging");
		try {
			grip.setPointerCapture(e.pointerId);
		} catch {}
	};
	const onGripMove = (e) => {
		if (!drag) return;
		applyHeight(drag.h + (drag.y - e.clientY));
	};
	const onGripUp = (e) => {
		if (!drag) return;
		drag = null;
		root.classList.remove("dragging");
		try {
			grip.releasePointerCapture(e.pointerId);
		} catch {}
		const h = clampH(root.getBoundingClientRect().height);
		applyHeight(h); // 拖拽中被窗口夹住的值也回写
		writeStore(HKEY_H, String(h));
	};
	const onGripReset = () => {
		// 双击回默认：删键而不是存默认值，这样窗口尺寸变了仍跟 CSS 的 min(300px,45vh) 一致。
		applyHeight(H_DEFAULT());
		dropStore(HKEY_H);
	};
	// 窗口缩小后旧的 px 高度可能超过 70vh，随手夹一下（不写盘，保留用户原值）。
	const onWinResize = () => {
		const cur = parseFloat(root.style.height);
		if (Number.isFinite(cur) && cur > H_MAX()) applyHeight(H_MAX());
	};

	// ---------- 接线 ----------
	input.addEventListener("keydown", onInputKey);
	clearBtn.addEventListener("click", () => {
		clear();
		input.focus({ preventScroll: true });
	});
	copyBtn.addEventListener("click", copyAll);
	closeBtn.addEventListener("click", () => setOpen(false));
	stopBtn.addEventListener("click", stop);
	grip.addEventListener("pointerdown", onGripDown);
	grip.addEventListener("pointermove", onGripMove);
	grip.addEventListener("pointerup", onGripUp);
	grip.addEventListener("pointercancel", onGripUp);
	grip.addEventListener("dblclick", onGripReset);
	window.addEventListener("resize", onWinResize);
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
		stop,
		copy: copyAll,
		get isOpen() {
			return open;
		},
		get isRunning() {
			return running;
		},
		destroy() {
			clearTimeout(copyTimer);
			for (const off of unsubs.splice(0)) {
				try {
					off();
				} catch {}
			}
			document.removeEventListener("keydown", onDocKey, true);
			window.removeEventListener("resize", onWinResize);
			input.removeEventListener("keydown", onInputKey);
			grip.removeEventListener("pointerdown", onGripDown);
			grip.removeEventListener("pointermove", onGripMove);
			grip.removeEventListener("pointerup", onGripUp);
			grip.removeEventListener("pointercancel", onGripUp);
			grip.removeEventListener("dblclick", onGripReset);
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
