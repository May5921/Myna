// 分支：从某条用户消息 fork 出新会话（pi 的 fork），成功后重放当前会话历史。
// 只处理 .row.mine；幂等挂载，MutationObserver 覆盖新消息与历史重绘。
// RPC：get_fork_messages → { messages:[{ entryId, text }] }
//      fork({ entryId }) → { text, cancelled }
//      get_messages     → { messages }
const CSS = `
/* 分支按钮并入行内的 .acts 横条；按钮外观统一由 message-actions 的
   .row > .acts button 负责，这里只留浮层与 toast。 */
/* 读取历史期间的等待态（拿 fock 列表要等 IPC，不能毫无反馈） */
.row.mine > .acts [data-act="fork"][data-busy] {
	opacity: 0.4;
	cursor: default;
}
/* 确认浮层：Codex 菜单皮，锚在按钮旁，不铺遮罩 */
.fork-pop {
	position: fixed;
	z-index: 60;
	width: max-content;
	min-width: 188px;
	max-width: 260px;
	display: flex;
	flex-direction: column;
	gap: 8px;
	padding: 8px;
	background: var(--bg);
	border: 1px solid var(--line);
	border-radius: var(--radius-xl);
	box-shadow: var(--shadow-menu);
	color: var(--text);
	font-size: 12.5px;
	line-height: 1.6;
	animation: fork-rise 120ms ease-out;
}
.fork-pop[hidden] {
	display: none;
}
.fork-pop-text {
	padding: 2px 4px 0;
	color: var(--text);
}
.fork-pop-btns {
	display: flex;
	justify-content: flex-end;
	gap: 4px;
}
.fork-pop-btn {
	height: 26px;
	padding: 0 10px;
	border-radius: var(--radius-md);
	font-size: 12.5px;
	white-space: nowrap;
	color: var(--dim);
	transition: background-color 120ms ease, color 120ms ease;
}
.fork-pop-btn:hover,
.fork-pop-btn:focus-visible {
	outline: none;
	background: var(--hover);
	color: var(--text);
}
.fork-pop-ok,
.fork-pop-ok:hover,
.fork-pop-ok:focus-visible {
	background: var(--text);
	color: var(--bg);
}
.fork-pop-ok:hover,
.fork-pop-ok:focus-visible {
	opacity: 0.88;
}
.fork-pop-ok[disabled] {
	opacity: 0.45;
	cursor: default;
}
.fork-toasts {
	position: fixed;
	left: 50%;
	/* 让开 #jump（bottom: 96px）——两者原来完全重叠 */
	bottom: 132px;
	transform: translateX(-50%);
	z-index: 90;
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 8px;
	pointer-events: none;
}
.fork-toast {
	max-width: min(520px, 100vw - 48px);
	padding: 8px 12px;
	background: var(--bg);
	border: 1px solid var(--line);
	border-radius: var(--radius-xl);
	box-shadow: var(--shadow-menu);
	color: var(--text);
	font-size: 12.5px;
	line-height: 1.6;
	overflow-wrap: anywhere;
	animation: fork-rise 120ms ease-out;
}
.fork-toast.err {
	color: var(--err);
}
@keyframes fork-rise {
	from { opacity: 0; transform: translateY(4px); }
}
@media (prefers-reduced-motion: reduce) {
	.fork-pop,
	.fork-pop-btn,
	.fork-toast {
		transition: none;
		animation: none;
	}
}
`;

// 分支图标（git branch：主干 + 一条岔出去的分支）
const BRANCH_ICON =
	'<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="3.4" r="1.5"/><circle cx="5" cy="12.6" r="1.5"/><circle cx="11.4" cy="3.4" r="1.5"/><path d="M5 4.9v6.2"/><path d="M11.4 4.9v.7c0 1.4-1.1 2.5-2.5 2.5H5.7"/></svg>';

const TOAST_MS = 3200;
let inited = false;

export function init(ctx) {
	const stream = ctx?.stream;
	const pi = ctx?.pi;
	if (!stream || typeof pi?.command !== "function") return;
	if (inited) return;
	inited = true;

	// 只对样式做存在性判断：原来「样式在就整体 return」会让行为静默缺失
	if (!document.head.querySelector('style[data-feature="message-fork"]')) {
		const style = document.createElement("style");
		style.dataset.feature = "message-fork";
		style.textContent = CSS;
		document.head.append(style);
	}

	// ---------- toast ----------
	let toastHost = null;

	function toast(message, isError) {
		const text = String(message ?? "").trim();
		if (!text) return;
		if (!toastHost || !toastHost.isConnected) {
			toastHost = document.createElement("div");
			toastHost.className = "fork-toasts";
			toastHost.setAttribute("aria-live", "polite");
			document.body.append(toastHost);
		}
		while (toastHost.childElementCount >= 3) toastHost.firstElementChild?.remove();
		const el = document.createElement("div");
		el.className = "fork-toast" + (isError ? " err" : "");
		el.setAttribute("role", isError ? "alert" : "status");
		el.textContent = text;
		toastHost.append(el);
		setTimeout(() => el.remove(), TOAST_MS);
	}

	// ---------- 确认浮层 ----------
	const pop = document.createElement("div");
	pop.className = "fork-pop";
	pop.hidden = true;
	pop.setAttribute("role", "dialog");
	pop.setAttribute("aria-label", "创建分支");

	const popText = document.createElement("div");
	popText.className = "fork-pop-text";
	popText.textContent = "从这条消息创建分支？";

	const popBtns = document.createElement("div");
	popBtns.className = "fork-pop-btns";

	const cancelBtn = document.createElement("button");
	cancelBtn.type = "button";
	cancelBtn.className = "fork-pop-btn";
	cancelBtn.textContent = "取消";

	const okBtn = document.createElement("button");
	okBtn.type = "button";
	okBtn.className = "fork-pop-btn fork-pop-ok";
	okBtn.textContent = "创建分支";

	popBtns.append(cancelBtn, okBtn);
	pop.append(popText, popBtns);
	document.body.append(pop);

	let anchorBtn = null; // 浮层的锚点按钮
	let entryId = null; // 待 fork 的 entryId
	let busy = false;

	function closePop() {
		if (pop.hidden) return;
		// 焦点在浮层里就还给锚点按钮，别让键盘用户掉到 body 上
		const hadFocus = pop.contains(document.activeElement);
		const back = anchorBtn;
		pop.hidden = true;
		entryId = null;
		anchorBtn = null;
		if (hadFocus && back?.isConnected) back.focus?.();
	}

	// 用户主动收起；fork 请求在飞时不响应，免得看不到结果
	function dismiss() {
		if (busy) return;
		closePop();
	}

	// 定位：按钮下方，放不下就翻到上方；永不越过输入框顶边
	function place(btn) {
		// 先以不可见状态参与布局再量尺寸：直接 hidden=false 会先闪一帧在旧位置
		pop.style.visibility = "hidden";
		pop.hidden = false;
		const r = btn.getBoundingClientRect();
		const w = pop.offsetWidth;
		const h = pop.offsetHeight;
		const composer = document.getElementById("composer");
		const floor = composer ? composer.getBoundingClientRect().top - 8 : window.innerHeight - 8;
		let top = r.bottom + 6;
		if (top + h > floor) top = r.top - h - 6;
		top = Math.min(Math.max(8, top), Math.max(8, floor - h));
		let left = r.right - w;
		left = Math.min(Math.max(8, left), Math.max(8, window.innerWidth - w - 8));
		pop.style.left = `${Math.round(left)}px`;
		pop.style.top = `${Math.round(top)}px`;
		pop.style.visibility = "";
	}

	async function createFork() {
		if (busy || !entryId) return;
		busy = true;
		const id = entryId;
		const label = okBtn.textContent;
		okBtn.disabled = true;
		cancelBtn.disabled = true;
		okBtn.textContent = "创建中…";
		try {
			const res = await pi.command({ type: "fork", entryId: id });
			if (res?.cancelled === true) {
				closePop();
				return;
			}
			const hist = await pi.command({ type: "get_messages" });
			ctx.reload?.(hist?.messages ?? []);
			await ctx.refreshState?.();
			closePop();
		} catch (e) {
			console.warn("[message-fork] fork 失败", e?.message || e);
			closePop();
			toast(`创建分支失败${e?.message ? `：${e.message}` : ""}`, true);
		} finally {
			busy = false;
			okBtn.disabled = false;
			cancelBtn.disabled = false;
			okBtn.textContent = label;
		}
	}

	// ---------- 匹配 + 打开 ----------
	async function openFor(btn, row) {
		if (ctx.state?.streaming) return;
		const text = (row.querySelector(":scope > .user")?.textContent ?? "").trim();
		if (!text) return;
		closePop();
		anchorBtn = btn;

		let list;
		btn.dataset.busy = "1";
		try {
			list = await pi.command({ type: "get_fork_messages" });
		} catch (e) {
			console.warn("[message-fork] get_fork_messages 失败", e?.message || e);
			anchorBtn = null;
			toast("读取历史消息失败", true);
			return;
		} finally {
			delete btn.dataset.busy;
		}
		// 等待期间换了目标、行被重绘或开始流式：放弃
		if (anchorBtn !== btn || !row.isConnected || ctx.state?.streaming) {
			if (anchorBtn === btn) anchorBtn = null;
			return;
		}

		const messages = Array.isArray(list?.messages) ? list.messages : [];
		const hit = messages.find((m) => typeof m?.text === "string" && m.text.trim() === text);
		if (!hit?.entryId) {
			console.warn("[message-fork] 找不到对应的历史消息", text.slice(0, 40));
			anchorBtn = null;
			toast("找不到对应的历史消息", true);
			return;
		}

		entryId = hit.entryId;
		place(btn);
		okBtn.focus?.();
	}

	// ---------- 行挂载 ----------
	const sync = (row) => {
		const btn = row.querySelector(':scope > .acts [data-act="fork"]');
		if (!btn) return;
		const blocked = !!ctx.state?.streaming;
		// 原生 disabled 不派发 hover/focus，没法解释为什么按不动（DSH MessageIconActions）
		if (blocked) btn.setAttribute("data-unavailable", "");
		else btn.removeAttribute("data-unavailable");
		btn.setAttribute("aria-disabled", blocked ? "true" : "false");
		btn.title = blocked ? "生成中，结束后才能分支" : "从这条消息创建分支";
	};

	const syncAll = () => {
		for (const row of stream.querySelectorAll(".row.mine")) sync(row);
	};

	const attach = (row) => {
		if (row.dataset.forkActs === "1") return;
		if (!row.querySelector(":scope > .user")) return;
		row.dataset.forkActs = "1";

		let bar = row.querySelector(":scope > .acts");
		if (!bar) {
			bar = document.createElement("div");
			bar.className = "acts";
			row.append(bar);
		}

		const btn = document.createElement("button");
		btn.type = "button";
		btn.dataset.act = "fork";
		btn.title = "从这条消息创建分支";
		btn.setAttribute("aria-label", "从这条消息创建分支");
		btn.innerHTML = BRANCH_ICON;
		btn.onclick = (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (ctx.state?.streaming) return;
			if (!pop.hidden && anchorBtn === btn) {
				dismiss();
				return;
			}
			openFor(btn, row);
		};

		bar.append(btn);
		bar.addEventListener("focusin", () => sync(row));
		row.addEventListener("pointerenter", () => sync(row));
		sync(row);
	};

	let queued = false;
	const scan = () => {
		queued = false;
		for (const row of stream.querySelectorAll(".row.mine")) attach(row);
	};
	const schedule = () => {
		if (queued) return;
		queued = true;
		requestAnimationFrame(scan);
	};

	const mo = new MutationObserver(schedule);
	mo.observe(stream, { childList: true, subtree: true });
	scan();

	// ---------- 浮层交互 ----------
	cancelBtn.onclick = (e) => {
		e.preventDefault();
		dismiss();
	};
	okBtn.onclick = (e) => {
		e.preventDefault();
		createFork();
	};

	// Enter 确认、Esc 取消；捕获阶段拦下，别让 app.js 的全局 Esc 触发 abort
	document.addEventListener(
		"keydown",
		(e) => {
			if (pop.hidden) return;
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				dismiss();
				return;
			}
			if (e.key === "Enter" && !e.isComposing) {
				// 焦点不在浮层里就别劫持：否则在输入框里敲 Enter 会去创建分支
				if (!pop.contains(document.activeElement)) return;
				e.preventDefault();
				e.stopPropagation();
				if (document.activeElement === cancelBtn) dismiss();
				else createFork();
			}
		},
		true,
	);

	// 点外部取消（取历史还没回来时点到别处，也作废这次打开）
	document.addEventListener("click", (e) => {
		if (pop.hidden) {
			if (anchorBtn && !anchorBtn.contains(e.target)) anchorBtn = null;
			return;
		}
		if (pop.contains(e.target)) return;
		if (anchorBtn?.contains(e.target)) return;
		dismiss();
	});

	window.addEventListener("scroll", dismiss, true);
	window.addEventListener("resize", dismiss);

	// 流式开始/结束：重排禁用态，顺带收起浮层
	pi.onEvent?.((ev) => {
		if (ev?.type === "agent_start") {
			closePop();
			syncAll();
		} else if (ev?.type === "agent_settled") {
			syncAll();
		}
	});
}
