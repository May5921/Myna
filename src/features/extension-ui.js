// 扩展 UI（extension_ui_request）：把 pi 扩展的弹窗 / 提示渲染成 Codex 风格，并回传响应。
// 协议见 pi dist/modes/rpc/rpc-types.d.ts：
//   select / confirm / input / editor —— 扩展会一直等，必须回 extension_ui_response；
//   notify / setStatus / setWidget / setTitle / set_editor_text —— 单向通知，pi 不等回应。
// 响应只能走 ctx.pi.sendRaw：它直接写 pi 的 stdin，没有 request id，也不经过 command()。

export const STATUS_MAX_LINES = 5;
export const TOAST_MS = 3500;

const LEAVE_MS = 130;
const MODAL_METHODS = new Set(["select", "confirm", "input", "editor"]);

let installed = false;

// ---------- 纯函数（不依赖 DOM，可用 node 直接测） ----------

export function isModalMethod(method) {
	return MODAL_METHODS.has(String(method ?? ""));
}

// select / input / editor → { value }；confirm → { confirmed }；cancelled 优先。
// 非弹窗方法（notify、setStatus…）返回 null：它们不需要响应。
export function buildResponse(ev, result = {}) {
	const id = ev?.id;
	if (!id || !isModalMethod(ev?.method)) return null;
	if (result.cancelled) return { type: "extension_ui_response", id, cancelled: true };
	if (ev.method === "confirm") return { type: "extension_ui_response", id, confirmed: result.confirmed === true };
	return { type: "extension_ui_response", id, value: result.value == null ? "" : String(result.value) };
}

// 倒计时剩余毫秒，永不为负。
export function remainingMs(deadline, now) {
	const left = Number(deadline) - Number(now);
	return Number.isFinite(left) && left > 0 ? left : 0;
}

// 扩展把终端配色一起塞进了文本（例如 \u001b[38;2;51;126;88m● …\u001b[39m），渲染前必须剥掉。
// 覆盖 CSI（含 38:2:… 冒号参数与 ? 私有前缀）、OSC（ESC ] … BEL / ST）和落单的 ESC。
const ANSI_RE = /\u001b\[[0-9;:?!]*[A-Za-z]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]|\u001b/g;

export function stripAnsi(text) {
	if (typeof text !== "string") return text == null ? "" : String(text);
	if (!text.includes("\u001b")) return text;
	return text.replace(ANSI_RE, "");
}

// 状态区最多渲染 maxLines 行；单条被截断时给最后一行加省略号。
export function visibleStatusRows(entries, maxLines = STATUS_MAX_LINES) {
	const out = [];
	let left = Number.isFinite(maxLines) && maxLines > 0 ? Math.floor(maxLines) : STATUS_MAX_LINES;
	for (const entry of entries ?? []) {
		if (left <= 0) break;
		const raw = Array.isArray(entry?.lines) ? entry.lines : [];
		const keep = [];
		for (const line of raw) {
			if (left <= 0) break;
			keep.push(String(line ?? ""));
			left -= 1;
		}
		if (!keep.length) continue;
		if (keep.length < raw.length) keep[keep.length - 1] = `${keep[keep.length - 1]}…`;
		out.push({ key: String(entry?.key ?? ""), lines: keep });
	}
	return out;
}

function reducedMotion() {
	return !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
}

// ---------- 模块 ----------

export function init(ctx) {
	if (installed) return;
	const pi = ctx?.pi;
	if (typeof pi?.onEvent !== "function" || typeof pi?.sendRaw !== "function") return;
	installed = true;

	const CSS = `
	.ext-modal {
		position: fixed;
		inset: 0;
		z-index: 100;
		display: grid;
		place-items: center;
		padding: 24px;
		background: rgba(26, 28, 31, .18);
		animation: ext-fade-in 120ms ease-out;
	}
	.ext-modal.ext-wide { --ext-w: 660px; }
	.ext-modal.ext-leave { animation: ext-fade-out 130ms ease-in forwards; pointer-events: none; }
	.ext-card {
		width: min(var(--ext-w, 520px), 100%);
		max-height: min(76vh, 620px);
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 16px;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: 16px;
		box-shadow: var(--shadow-menu);
		color: var(--text);
		font: 12.5px/1.6 var(--ui);
		outline: none;
		animation: ext-rise 140ms ease-out;
	}
	.ext-head {
		display: flex;
		align-items: baseline;
		gap: 10px;
	}
	.ext-title {
		flex: 1 1 auto;
		min-width: 0;
		font-size: 14px;
		font-weight: 500;
		color: var(--text);
		overflow-wrap: anywhere;
	}
	.ext-timer {
		flex: 0 0 auto;
		font: 11px/1 var(--mono);
		color: var(--faint);
		font-variant-numeric: tabular-nums;
	}
	.ext-msg {
		margin: 0;
		max-height: 40vh;
		overflow-y: auto;
		color: var(--dim);
		font-size: 12.5px;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.ext-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-height: 0;
		margin: 0 -4px;
		padding: 2px 4px;
		overflow-y: auto;
	}
	.ext-opt {
		display: block;
		width: 100%;
		height: 34px;
		/* 定高不被压：.ext-opt 有 overflow:hidden（自动最小尺寸=0），
		   在定高的滚动列里会被 flex 压缩成一条条碎行，而不是滚动 */
		flex: none;
		padding: 0 10px;
		border-radius: 8px;
		background: none;
		color: var(--text);
		font: 12.5px/34px var(--ui);
		text-align: left;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.ext-opt:hover { background: var(--hover); }
	.ext-opt.on { background: var(--hover); box-shadow: inset 0 0 0 1px var(--line-strong); }
	.ext-opt:focus-visible { outline: 1px solid var(--line-strong); outline-offset: -1px; }
	.ext-empty {
		padding: 6px 2px;
		color: var(--faint);
		font-size: 12.5px;
	}
	.ext-input {
		width: 100%;
		height: 30px;
		padding: 0 9px;
		border: 1px solid var(--line);
		border-radius: var(--radius-xl);
		background: var(--bg);
		color: var(--text);
		font: 12.5px/1.5 var(--ui);
		outline: 0;
	}
	.ext-input::placeholder { color: var(--faint); }
	.ext-input:focus { border-color: var(--line-strong); }
	.ext-area {
		width: 100%;
		min-height: calc(5 * 1.55em + 18px);
		max-height: 50vh;
		padding: 8px 9px;
		resize: vertical;
		border: 1px solid var(--line);
		border-radius: var(--radius-xl);
		background: var(--bg);
		color: var(--text);
		font: 12.5px/1.55 var(--mono);
		outline: 0;
	}
	.ext-area:focus { border-color: var(--line-strong); }
	.ext-foot {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 8px;
	}
	.ext-hint {
		margin-right: auto;
		color: var(--faint);
		font-size: 12px;
		user-select: none;
	}
	.ext-btn {
		height: 30px;
		padding: 0 12px;
		border: 1px solid var(--line);
		border-radius: var(--radius-xl);
		background: var(--bg);
		color: var(--dim);
		font: 12.5px/1.5 var(--ui);
	}
	.ext-btn:hover { background: var(--hover); color: var(--text); }
	.ext-btn:focus-visible { outline: 1px solid var(--line-strong); outline-offset: 1px; }
	.ext-btn.primary {
		background: var(--send-bg);
		border-color: transparent;
		/* 原来是裸 #fff；洋白底色的 token 就是 --bg，别再硬编码一次 */
		color: var(--bg);
	}
	.ext-btn.primary:hover { background: var(--send-bg); color: var(--bg); opacity: .9; }
	.ext-toasts {
		/* STYLE.md 的语义色只有 --err，没有警告色；notify(warning) 又不能和普通提示
		   长得一样。按 right-panel 的做法把这一处颜色收口成局部 token，改一处即可换掉 */
		--ext-warn: #c08b1e;
		position: fixed;
		left: 50%;
		bottom: 96px;
		transform: translateX(-50%);
		/* 浮在弹窗(100)与会话上方；别压过图片灯箱(1200) */
		z-index: 110;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		pointer-events: none;
	}
	.ext-toast {
		max-width: min(560px, 100vw - 48px);
		padding: 8px 12px;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: var(--radius-xl);
		box-shadow: var(--shadow-menu);
		color: var(--text);
		font: 12.5px/1.6 var(--ui);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		animation: ext-rise 120ms ease-out;
	}
	.ext-toast.warning { color: var(--ext-warn); }
	.ext-toast.error { color: var(--err); }
	.ext-toast.ext-leave { animation: ext-fade-out 160ms ease-in forwards; }
	.ext-status {
		flex: 0 0 auto;
		width: min(var(--thread-max-width), 100% - 48px);
		margin: 0 auto;
		/* 左右 14px 对齐 #input 的内容缩进，底 4px 与 #composer 的 6px 上边距留出间隙 */
		padding: 0 14px 4px;
		color: var(--dim);
		font: 12px/1.5 var(--mono);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		overflow: hidden;
	}
	.ext-status-row + .ext-status-row { margin-top: 2px; }
	.ext-status-line { min-height: 1.5em; }
	@keyframes ext-fade-in { from { opacity: 0; } }
	@keyframes ext-fade-out { to { opacity: 0; } }
	@keyframes ext-rise { from { opacity: 0; transform: translateY(6px); } }
	@media (prefers-reduced-motion: reduce) {
		.ext-modal,
		.ext-card,
		.ext-toast { animation: none !important; transition: none !important; }
	}
	`;
	const style = document.createElement("style");
	style.dataset.extUi = "1";
	style.textContent = CSS;
	document.head.append(style);

	let current = null; // 正在显示的 modal 记录
	const queue = []; // 排队的 modal 请求
	const statusEntries = new Map(); // `${kind}:${key}` -> { key, lines }
	let statusHost = null;
	let toastHost = null;

	// ---------- 状态区（#composer 上方） ----------

	function ensureStatus() {
		if (statusHost?.isConnected) return statusHost;
		const composer = document.getElementById("composer");
		if (!composer?.parentElement) return null;
		statusHost = document.createElement("div");
		statusHost.className = "ext-status";
		statusHost.setAttribute("role", "status");
		statusHost.setAttribute("aria-live", "polite");
		composer.parentElement.insertBefore(statusHost, composer);
		return statusHost;
	}

	function renderStatus() {
		const rows = visibleStatusRows(statusEntries.values());
		if (!rows.length) {
			if (statusHost) statusHost.remove();
			statusHost = null;
			return;
		}
		const host = ensureStatus();
		if (!host) return;
		host.textContent = "";
		for (const row of rows) {
			const group = document.createElement("div");
			group.className = "ext-status-row";
			group.dataset.key = row.key;
			// 每个 key 可能带多行（setStatus 的换行、setWidget 的 widgetLines），逐行渲染
			for (const text of row.lines) {
				const line = document.createElement("div");
				line.className = "ext-status-line";
				line.textContent = text;
				group.append(line);
			}
			host.append(group);
		}
	}

	// 空的 text / lines 等于移除该条（pi 的 setStatus(key, undefined) 就是清除）。
	function setEntry(kind, key, lines) {
		const id = `${kind}:${key ?? ""}`;
		// 这里是 status / widget 的共同入口：ANSI 在这一层统一剥掉
		const clean = Array.isArray(lines) ? lines.map((l) => stripAnsi(l)) : [];
		while (clean.length && !clean[clean.length - 1].trim()) clean.pop();
		if (!clean.length) statusEntries.delete(id);
		else statusEntries.set(id, { key: stripAnsi(key), lines: clean });
		renderStatus();
	}

	// ---------- toast ----------

	function toast(message, notifyType) {
		const text = stripAnsi(message);
		if (!text.trim()) return;
		if (!toastHost || !toastHost.isConnected) {
			toastHost = document.createElement("div");
			toastHost.className = "ext-toasts";
			document.body.append(toastHost);
		}
		while (toastHost.childElementCount >= 4) toastHost.firstElementChild?.remove();

		const el = document.createElement("div");
		el.className = "ext-toast";
		if (notifyType === "warning") el.classList.add("warning");
		else if (notifyType === "error") el.classList.add("error");
		el.setAttribute("role", notifyType === "error" ? "alert" : "status");
		el.textContent = text;
		toastHost.append(el);

		setTimeout(() => {
			if (!el.isConnected) return;
			if (reducedMotion()) {
				el.remove();
				return;
			}
			el.classList.add("ext-leave");
			setTimeout(() => el.remove(), 180);
		}, TOAST_MS);
	}

	// ---------- modal ----------

	function pump() {
		if (current || !queue.length) return;
		openModal(queue.shift());
	}

	function sendResponse(rec, result) {
		const payload = buildResponse(rec.ev, result);
		if (!payload) return;
		try {
			Promise.resolve(pi.sendRaw(payload)).catch(() => {});
		} catch (err) {
			console.warn("[extension-ui] sendRaw failed", err?.message);
		}
	}

	function closeModal(rec) {
		if (reducedMotion()) rec.overlay.remove();
		else {
			rec.overlay.classList.add("ext-leave");
			setTimeout(() => rec.overlay.remove(), LEAVE_MS + 20);
		}
		if (current === rec) current = null;
		pump();
	}

	// 每个请求只响应一次：answered 之后所有出口都失效。
	function finish(rec, result) {
		if (!rec || rec.answered) return;
		rec.answered = true;
		clearTimeout(rec.timer);
		clearInterval(rec.tick);
		rec.timer = 0;
		rec.tick = 0;
		sendResponse(rec, result);
		closeModal(rec);
	}

	function buttonEl(label, primary, ariaLabel, onclick) {
		const b = document.createElement("button");
		b.type = "button";
		b.className = "ext-btn" + (primary ? " primary" : "");
		b.textContent = label;
		b.setAttribute("aria-label", ariaLabel || label);
		b.onclick = (e) => {
			e.preventDefault();
			onclick();
		};
		return b;
	}

	function startTimeout(rec) {
		const total = Number(rec.ev.timeout);
		if (!Number.isFinite(total) || total <= 0) return;
		rec.deadline = Date.now() + total;
		const label = rec.timerEl;
		if (label) label.textContent = `${Math.ceil(total / 1000)}s`;
		rec.tick = setInterval(() => {
			if (label) label.textContent = `${Math.ceil(remainingMs(rec.deadline, Date.now()) / 1000)}s`;
		}, 250);
		rec.timer = setTimeout(() => finish(rec, { cancelled: true }), total);
	}

	function openModal(ev) {
		const overlay = document.createElement("div");
		overlay.className = "ext-modal" + (ev.method === "editor" ? " ext-wide" : "");
		overlay.setAttribute("role", "dialog");
		overlay.setAttribute("aria-modal", "true");
		const titleRaw = stripAnsi(ev.title);
		if (titleRaw) overlay.setAttribute("aria-label", titleRaw);

		const card = document.createElement("div");
		card.className = "ext-card";
		card.tabIndex = -1;
		overlay.append(card);

		const rec = { ev, overlay, card, answered: false, timer: 0, tick: 0, deadline: 0, timerEl: null };
		current = rec;

		// 点遮罩 = 取消（mousedown 才判定，避免从卡片拖到遮罩误触；右键不算）
		overlay.addEventListener("mousedown", (e) => {
			if (e.button !== 0) return;
			if (e.target === overlay) finish(rec, { cancelled: true });
		});

		const title = document.createElement("div");
		title.className = "ext-head";
		const titleText = document.createElement("span");
		titleText.className = "ext-title";
		titleText.textContent = titleRaw;
		title.append(titleText);
		if (Number.isFinite(Number(ev.timeout)) && Number(ev.timeout) > 0) {
			const timerEl = document.createElement("span");
			timerEl.className = "ext-timer";
			rec.timerEl = timerEl;
			title.append(timerEl);
		}
		card.append(title);

		const foot = document.createElement("div");
		foot.className = "ext-foot";

		if (ev.method === "select") {
			// raw 保留原串用于回传（扩展按原样比对），显示时剥掉 ANSI
			const raw = Array.isArray(ev.options) ? ev.options.map((o) => String(o ?? "")) : [];
			const options = raw.map((o) => stripAnsi(o));
			const list = document.createElement("div");
			list.className = "ext-list";
			list.setAttribute("role", "listbox");
			if (titleRaw) list.setAttribute("aria-label", titleRaw);

			const btns = [];
			let active = 0;
			const setActive = (i) => {
				if (!btns.length) return;
				active = (i + btns.length) % btns.length;
				btns.forEach((b, k) => {
					b.classList.toggle("on", k === active);
					b.setAttribute("aria-selected", k === active ? "true" : "false");
				});
				btns[active]?.focus();
			};
			for (let i = 0; i < options.length; i += 1) {
				const label = options[i];
				const b = document.createElement("button");
				b.type = "button";
				b.className = "ext-opt";
				b.setAttribute("role", "option");
				b.setAttribute("aria-label", label);
				// 长选项被 nowrap+ellipsis 截断后，鼠标悬停还能看到全文
				b.title = label;
				b.textContent = label;
				b.onclick = () => finish(rec, { value: raw[i] });
				list.append(b);
				btns.push(b);
			}
			if (!btns.length) {
				const empty = document.createElement("div");
				empty.className = "ext-empty";
				empty.textContent = "没有可选项";
				list.append(empty);
			}
			card.append(list);

			rec.move = (delta) => setActive(active + delta);
			rec.pick = () => {
				if (btns.length) finish(rec, { value: raw[active] });
			};

			foot.append(buttonEl("取消", false, "取消选择", () => finish(rec, { cancelled: true })));
			card.append(foot);
			document.body.append(overlay);
			if (btns.length) setActive(0);
			else foot.firstElementChild?.focus();
		} else if (ev.method === "confirm") {
			const msg = document.createElement("p");
			msg.className = "ext-msg";
			msg.textContent = stripAnsi(ev.message);
			card.append(msg);

			const cancel = buttonEl("取消", false, "取消", () => finish(rec, { cancelled: true }));
			const ok = buttonEl("确认", true, "确认", () => finish(rec, { confirmed: true }));
			foot.append(cancel, ok);
			card.append(foot);
			document.body.append(overlay);
			ok.focus();
		} else if (ev.method === "input") {
			const field = document.createElement("input");
			field.type = "text";
			field.className = "ext-input";
			field.placeholder = stripAnsi(ev.placeholder);
			field.setAttribute("aria-label", titleRaw || "输入");
			card.append(field);

			rec.submit = () => finish(rec, { value: field.value });
			foot.append(
				buttonEl("取消", false, "取消输入", () => finish(rec, { cancelled: true })),
				buttonEl("提交", true, "提交输入", () => finish(rec, { value: field.value })),
			);
			card.append(foot);
			document.body.append(overlay);
			field.focus();
		} else {
			// editor
			const area = document.createElement("textarea");
			area.className = "ext-area";
			area.rows = 5;
			area.spellcheck = false;
			area.value = stripAnsi(ev.prefill);
			area.setAttribute("aria-label", titleRaw || "编辑");
			card.append(area);

			const hint = document.createElement("span");
			hint.className = "ext-hint";
			hint.textContent = "Ctrl/⌘ + Enter 提交";
			rec.submit = () => finish(rec, { value: area.value });
			foot.append(
				hint,
				buttonEl("取消", false, "取消编辑", () => finish(rec, { cancelled: true })),
				buttonEl("提交", true, "提交编辑", () => finish(rec, { value: area.value })),
			);
			card.append(foot);
			document.body.append(overlay);
			area.focus();
			const end = area.value.length;
			area.setSelectionRange(end, end);
			area.scrollTop = area.scrollHeight;
		}

		startTimeout(rec);
	}

	// 捕获阶段拦 Esc：不能让 app.js 的全局 abort 吃到。
	function onKeyDown(e) {
		const rec = current;
		if (!rec) return;

		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			finish(rec, { cancelled: true });
			return;
		}

		if (e.key === "Tab") {
			trapTab(e, rec);
			return;
		}

		const onCardButton = document.activeElement?.tagName === "BUTTON" && rec.card.contains(document.activeElement);

		switch (rec.ev.method) {
			case "select": {
				if (e.key === "ArrowDown" || e.key === "ArrowUp") {
					e.preventDefault();
					e.stopPropagation();
					rec.move(e.key === "ArrowDown" ? 1 : -1);
					return;
				}
				// 焦点在选项按钮上时交给原生 click，避免重复响应
				if (e.key === "Enter" && !onCardButton) {
					e.preventDefault();
					e.stopPropagation();
					rec.pick();
				}
				return;
			}
			case "confirm": {
				if (e.key === "Enter" && !onCardButton) {
					e.preventDefault();
					e.stopPropagation();
					finish(rec, { confirmed: true });
				}
				return;
			}
			case "input": {
				if (e.key === "Enter" && !e.isComposing) {
					e.preventDefault();
					e.stopPropagation();
					rec.submit();
				}
				return;
			}
			default: {
				if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
					e.preventDefault();
					e.stopPropagation();
					rec.submit?.();
				}
			}
		}
	}

	function trapTab(e, rec) {
		const focusables = [...rec.card.querySelectorAll("button, input, textarea")].filter((el) => !el.disabled);
		if (!focusables.length) return;
		const first = focusables[0];
		const last = focusables[focusables.length - 1];
		const activeEl = document.activeElement;
		const inside = rec.card.contains(activeEl);
		if (!inside) {
			e.preventDefault();
			first.focus();
		} else if (e.shiftKey && activeEl === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && activeEl === last) {
			e.preventDefault();
			first.focus();
		}
	}

	document.addEventListener("keydown", onKeyDown, true);

	// ---------- 单向通知 ----------

	function setEditorText(text) {
		const input = ctx.input || document.getElementById("input");
		if (!input) return;
		input.value = String(text ?? "");
		input.dispatchEvent(new Event("input", { bubbles: true }));
		const end = input.value.length;
		try {
			// 弹窗开着时别抢焦点，否则键盘会被 composer 抢回去
			if (!current) input.focus();
			input.setSelectionRange(end, end);
		} catch {}
		input.scrollTop = input.scrollHeight;
	}

	// ---------- 事件入口 ----------

	pi.onEvent((ev) => {
		if (!ev || ev.type !== "extension_ui_request") return;
		const method = ev.method;
		try {
			if (isModalMethod(method)) {
				queue.push(ev);
				pump();
				return;
			}
			switch (method) {
				case "notify":
					toast(ev.message, ev.notifyType);
					break;
				case "setStatus": {
					const text = typeof ev.statusText === "string" ? ev.statusText : "";
					setEntry("status", ev.statusKey ?? "", text.split("\n"));
					break;
				}
				case "setWidget": {
					const lines = Array.isArray(ev.widgetLines) ? ev.widgetLines : [];
					setEntry("widget", ev.widgetKey ?? "", lines);
					break;
				}
				case "setTitle":
					document.title = stripAnsi(ev.title);
					break;
				case "set_editor_text":
					setEditorText(ev.text);
					break;
				default:
					console.warn("[extension-ui] unknown method", method);
			}
		} catch (err) {
			console.warn("[extension-ui] handle failed", method, err?.message);
		}
	});
}
