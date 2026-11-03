// 排队 dock：流式期间输入框上方贴一块与输入卡融合的待发送面板。
// pi 只有 steer / follow_up / clear_queue，没有按条 remove/edit/steer；所以本地维护「我发过的文本」镜像，
// 行内只显示预览与「已排队」，清空只能整队清。
// Enter → follow_up（排队）；Ctrl/Cmd+Enter → steer（插话）；流式中点 #send 且草稿非空 → 排队发送。
// 自注入样式与 DOM（#composer 内、.box 之前），不改 index.html / app.js / base.css。
// RPC：follow_up / steer / get_state / clear_queue

const POLL_MS = 2000;
const TOAST_MS = 2000;
const ARM_MS = 2500;
const SETTLE_GRACE_MS = 1500;
const SVG_NS = "http://www.w3.org/2000/svg";

// ---------- 持久化 ----------
// 队列项按会话落 localStorage：key = pi-mini.queue.<sessionFile>，新会话（还没有 sessionFile）用 _new。
// 只存 { text, mode }，不存 id / 已发送标记——恢复出来的一律是「本地草稿」，不是 pi 的 pending。
const STORE_PREFIX = "pi-mini.queue.";
const STORE_NEW = `${STORE_PREFIX}_new`;
const STORE_MAX = 50;
const SESSION_WATCH_MS = 500;

const storeKeyOf = (sessionFile) => {
	const f = typeof sessionFile === "string" ? sessionFile.trim() : "";
	return f ? `${STORE_PREFIX}${f}` : STORE_NEW;
};

const readQueueStore = (key) => {
	try {
		const raw = localStorage.getItem(key);
		if (!raw) return [];
		const arr = JSON.parse(raw);
		if (!Array.isArray(arr)) return [];
		const out = [];
		for (const it of arr) {
			const text = typeof it?.text === "string" ? it.text : "";
			if (!text.trim()) continue;
			out.push({ text, mode: it?.mode === "steer" ? "steer" : "follow_up" });
			if (out.length >= STORE_MAX) break;
		}
		return out;
	} catch {
		return []; // 坏数据当成空队列，不打断 Dock
	}
};

const CSS = `
.queue-dock {
	box-sizing: border-box;
	width: min(768px, 100% - 48px);
	margin: 0 auto -3px;
	padding: 2px 0;
	overflow: hidden;
	background: var(--bg);
	border: 1px solid var(--line);
	border-bottom: none;
	border-radius: 10px 10px 0 0;
	box-shadow: none;
}
.queue-dock[hidden] { display: none; }

.queue-head {
	display: flex;
	align-items: center;
	gap: 8px; /* STYLE §3⑥ 间距只用 4 的倍数（原 10） */
	height: 36px;
	padding: 0 8px 0 12px;
}

.queue-lead {
	display: grid;
	flex: none;
	place-items: center;
	color: var(--faint);
}
.queue-lead svg { display: block; }

.queue-count {
	flex: 1 1 auto;
	min-width: 0;
	overflow: hidden;
	color: var(--text);
	font: 13px/24px var(--ui);
	white-space: nowrap;
	text-overflow: ellipsis;
}

.queue-clear {
	flex: none;
	height: 24px;
	/*「清空」40px →「确认清空」64px：预留宽度，二次确认时整行不跳动 */
	min-width: 64px;
	padding: 0 8px;
	border: none;
	border-radius: 8px;
	background: none;
	color: var(--faint);
	font: 12px/1 var(--ui);
	white-space: nowrap;
	transition: background-color 120ms ease, color 120ms ease;
}
.queue-clear:hover { background: var(--hover); color: var(--text); }
/* armed 必须和 hover 有区别，否则看不出已进入确认态 */
.queue-clear[data-armed="1"] { background: var(--hover); color: var(--err); }
.queue-clear:focus-visible { outline: 1px solid var(--faint); outline-offset: -1px; }

.queue-chevron {
	display: grid;
	flex: none;
	place-items: center;
	width: 24px;
	height: 24px;
	padding: 0;
	border: none;
	border-radius: 8px;
	background: none;
	color: var(--faint);
	transition: background-color 120ms ease, color 120ms ease;
}
.queue-chevron:hover { background: var(--hover); color: var(--text); }
.queue-chevron:focus-visible { outline: 1px solid var(--faint); outline-offset: -1px; }

.queue-list {
	max-height: 180px;
	margin: 0;
	padding: 0;
	overflow-y: auto;
	list-style: none;
	scrollbar-width: thin;
	/* 与 base.css 全局 thumb（rgba(13,13,13,.2)）对齐；--line 只有 8% 透明，拖动条等于看不见 */
	scrollbar-color: rgba(13, 13, 13, 0.2) transparent;
}
.queue-list[hidden] { display: none; }

.queue-row {
	display: flex;
	align-items: center;
	gap: 8px; /* STYLE §3⑥ 间距只用 4 的倍数（原 10） */
	min-height: 36px;
	padding: 4px 12px;
}
.queue-row + .queue-row { box-shadow: inset 0 1px 0 var(--line); }

.queue-preview {
	flex: 1 1 auto;
	min-width: 0;
	overflow: hidden;
	color: var(--dim);
	font: 12px/1.5 var(--ui);
	white-space: nowrap;
	text-overflow: ellipsis;
}

.queue-status {
	flex: none;
	color: var(--faint);
	font: 11px/1 var(--mono);
	white-space: nowrap;
}

/* 运行中草稿非空：#send 显示箭头（压过 base.css 的 #send.stop .sq / .up） */
#send.queue-send .up { display: block; }
#send.queue-send .sq { display: none; }

.queue-toast {
	position: fixed;
	left: 50%;
	z-index: 45;
	transform: translateX(-50%) translateY(4px);
	padding: 6px 12px;
	border: 1px solid var(--line);
	border-radius: 12px;
	background: var(--bg);
	box-shadow: var(--shadow-menu);
	color: var(--text);
	font: 12px/1.5 var(--ui);
	opacity: 0;
	pointer-events: none;
	transition: opacity 140ms ease, transform 140ms ease;
}
.queue-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

@media (prefers-reduced-motion: reduce) {
	.queue-clear, .queue-chevron, .queue-toast { transition: none; }
}
`;

const svg = (parts) => {
	const el = document.createElementNS(SVG_NS, "svg");
	el.setAttribute("width", "14");
	el.setAttribute("height", "14");
	el.setAttribute("viewBox", "0 0 14 14");
	el.setAttribute("fill", "none");
	el.setAttribute("stroke", "currentColor");
	el.setAttribute("stroke-width", "1.3");
	el.setAttribute("stroke-linecap", "round");
	el.setAttribute("stroke-linejoin", "round");
	el.setAttribute("aria-hidden", "true");
	for (const part of parts) el.append(part);
	return el;
};

const pathEl = (d) => {
	const p = document.createElementNS(SVG_NS, "path");
	p.setAttribute("d", d);
	return p;
};

const dotEl = (cx, cy) => {
	const c = document.createElementNS(SVG_NS, "circle");
	c.setAttribute("cx", cx);
	c.setAttribute("cy", cy);
	c.setAttribute("r", "1.1");
	c.setAttribute("fill", "currentColor");
	c.setAttribute("stroke", "none");
	return c;
};

const queueIcon = () => svg([dotEl("2.8", "4.4"), dotEl("2.8", "9.6"), pathEl("M5.6 4.4h5.6"), pathEl("M5.6 9.6h5.6")]);

const chevronIcon = (open) => svg([pathEl(open ? "M3.6 8.8 7 5.4l3.4 3.4" : "M3.6 5.2 7 8.6l3.4-3.4")]);

export function init(ctx) {
	const input = ctx?.input;
	const composer = document.getElementById("composer");
	const box = composer?.querySelector(".box");
	const sendBtn = document.getElementById("send");
	if (!ctx?.pi || !input || !composer || !box || !sendBtn) return;
	if (composer.querySelector(".queue-dock")) return; // 幂等

	const style = document.createElement("style");
	style.textContent = CSS;
	document.head.append(style);

	const sendTitle = sendBtn.title || "发送";

	// ---------- 本地队列镜像（pi 没有按条操作，只有整队 clear_queue）----------
	// sent=true：已经交给 pi 的（follow_up 排队），pi 计数归零时可以本地移除；
	// sent=false：从 localStorage 恢复的本地草稿，pi 不知道它的存在，任何计数清理都不能碰。
	const queue = []; // { id, text, mode, sent }
	let seq = 0;
	let storeKey = storeKeyOf(ctx.state?.sessionFile); // 当前会话对应的存储 key
	let restoredKey = null; // 已经恢复过的 key：同一个 key 不重复覆盖本地队列
	let settleAt = 0; // 最近一次 agent_settled：只有刚结束这一轮，_new → 真实文件的迁移才可信
	let collapsed = true;
	let lastPushAt = 0;
	let pollTimer = 0;
	let busy = false;
	let armed = false;
	let armTimer = 0;
	let toastTimer = 0;
	let toastSeq = 0;
	let demo = false; // 验收钩子塞的假条目：不发送，也不让轮询把它清掉

	// ---------- Dock DOM ----------
	const dock = document.createElement("div");
	dock.className = "queue-dock";
	dock.hidden = true;
	dock.setAttribute("role", "region");
	dock.setAttribute("aria-label", "待发送队列");

	const head = document.createElement("div");
	head.className = "queue-head";

	const leadEl = document.createElement("span");
	leadEl.className = "queue-lead";
	leadEl.append(queueIcon());

	const countEl = document.createElement("span");
	countEl.className = "queue-count";
	countEl.setAttribute("aria-live", "polite"); // 队列增减时焦点不在 Dock 上，靠 live 区域播报条数

	const clearBtn = document.createElement("button");
	clearBtn.type = "button";
	clearBtn.className = "queue-clear";
	clearBtn.textContent = "清空";
	clearBtn.title = "清空待发送队列";
	clearBtn.setAttribute("aria-label", "清空待发送队列");

	const chevronBtn = document.createElement("button");
	chevronBtn.type = "button";
	chevronBtn.className = "queue-chevron";
	chevronBtn.setAttribute("aria-controls", "queue-list");
	chevronBtn.setAttribute("aria-expanded", "false"); // 初值 collapsed = true，不能先声明成展开
	chevronBtn.setAttribute("aria-label", "展开队列");

	const listEl = document.createElement("ul");
	listEl.className = "queue-list";
	listEl.id = "queue-list";
	listEl.setAttribute("aria-label", "待发送消息");

	head.append(leadEl, countEl, clearBtn, chevronBtn);
	dock.append(head, listEl);
	composer.insertBefore(dock, box);

	function resetArm() {
		clearTimeout(armTimer);
		armTimer = 0;
		armed = false;
		clearBtn.dataset.armed = "0";
		clearBtn.textContent = "清空";
	}

	const rowEl = (item) => {
		const li = document.createElement("li");
		li.className = "queue-row";
		const preview = document.createElement("span");
		preview.className = "queue-preview";
		preview.textContent = item.text;
		preview.title = item.text;
		const status = document.createElement("span");
		status.className = "queue-status";
		// 恢复出来的草稿 pi 那边没有，不能写「已排队」冒充 pendingMessageCount
		status.textContent = item.sent ? "已排队" : "未发送";
		li.append(preview, status);
		return li;
	};

	function render() {
		const n = queue.length;
		dock.hidden = n === 0;
		if (n === 0) {
			listEl.replaceChildren();
			resetArm();
			return;
		}
		const listVisible = !collapsed;
		countEl.textContent = `${n} 条待发送`;
		listEl.hidden = !listVisible;
		chevronBtn.replaceChildren(chevronIcon(listVisible));
		const chevronLabel = listVisible ? "收起队列" : "展开队列";
		chevronBtn.setAttribute("aria-expanded", listVisible ? "true" : "false");
		chevronBtn.title = chevronLabel;
		chevronBtn.setAttribute("aria-label", chevronLabel); // 图标按钮没有可读文本，名字必须显式同步
		listEl.replaceChildren();
		for (const item of queue) listEl.append(rowEl(item));
	}

	// ---------- 写盘 / 恢复 ----------
	function persist() {
		if (demo) return; // 验收钩子的假条目不落盘
		try {
			if (!queue.length) {
				localStorage.removeItem(storeKey);
				return;
			}
			const rows = queue.slice(-STORE_MAX).map((it) => ({ text: it.text, mode: it.mode === "steer" ? "steer" : "follow_up" }));
			localStorage.setItem(storeKey, JSON.stringify(rows));
		} catch (err) {
			console.warn("[queue] 持久化失败", err?.message || err);
		}
	}

	function clearLocal() {
		queue.length = 0;
		render();
		persist();
	}

	// 只清「已经交给 pi 的」条目；恢复出来的本地草稿留着，pi 的 pendingMessageCount 管不到它们
	function clearSent() {
		let hit = false;
		for (let i = queue.length - 1; i >= 0; i--) {
			if (queue[i].sent) {
				queue.splice(i, 1);
				hit = true;
			}
		}
		if (!hit) return;
		render();
		persist();
	}

	// 会话变了就把 Dock 换成那个会话的队列；sessionFile 还没出来时挂在 _new 上
	function restore() {
		const nextKey = storeKeyOf(ctx.state?.sessionFile);
		if (nextKey === restoredKey) return;
		// 新会话第一轮结束才有 sessionFile：刚 settle 完的这一下，把没发出去的草稿带到正式 key 上，别丢。
		// 手动切会话不算（那是别的会话，草稿留在 _new 里等下次新会话）。
		const settled = Date.now() - settleAt < 5000;
		const carry = restoredKey === STORE_NEW && nextKey !== STORE_NEW && settled ? queue.filter((it) => !it.sent) : [];
		restoredKey = nextKey;
		storeKey = nextKey;
		demo = false;
		queue.length = 0;
		for (const it of readQueueStore(nextKey)) queue.push({ id: ++seq, text: it.text, mode: it.mode, sent: false });
		for (const it of carry) queue.push({ id: ++seq, text: it.text, mode: it.mode, sent: false });
		render();
		syncSend();
		if (carry.length) persist();
	}

	// ---------- 发送键在运行中：草稿有内容显示 Send（排队），空则保持 Stop ----------
	const syncSend = () => {
		const streaming = !!ctx.state?.streaming;
		const queuing = streaming && input.value.trim().length > 0;
		sendBtn.classList.toggle("queue-send", queuing);
		// 运行中空草稿时按钮实际是「停止」（#send.stop 方块），title 不能回落成「发送」
		sendBtn.title = queuing ? "排队发送（Ctrl+Enter 插话）" : streaming ? "停止" : sendTitle;
	};

	// ---------- Toast（只用于插话反馈）----------
	const toastEl = document.createElement("div");
	toastEl.className = "queue-toast";
	toastEl.setAttribute("role", "status");
	toastEl.setAttribute("aria-live", "polite");
	document.body.append(toastEl);

	function toast(text) {
		const host = document.getElementById("composer");
		const top = host ? host.getBoundingClientRect().top : window.innerHeight - 96;
		toastEl.style.bottom = `${Math.max(8, Math.round(window.innerHeight - top + 8))}px`;
		toastEl.textContent = text;
		toastEl.classList.add("show");
		const my = ++toastSeq;
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => {
			if (toastSeq === my) toastEl.classList.remove("show");
		}, TOAST_MS);
	}

	// ---------- 发送 ----------
	const takeDraft = () => {
		const text = input.value.trim();
		if (!text) return null;
		const prev = input.value;
		input.value = "";
		input.dispatchEvent(new Event("input", { bubbles: true }));
		return { text, prev };
	};

	const restoreDraft = (prev) => {
		if (input.value) return;
		input.value = prev;
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.focus();
	};

	const enqueue = async () => {
		// follow_up 只带文本：带图排队会把附件静默留在 rail 上，用户以为已经发出去了
		if ((ctx.attachments?.get?.() || []).length) {
			toast("排队不支持图片，请等这轮结束再发");
			return;
		}
		const draft = takeDraft();
		if (!draft) return;
		try {
			await ctx.pi.command({ type: "follow_up", message: draft.text });
			demo = false;
			queue.push({ id: ++seq, text: draft.text, mode: "follow_up", sent: true });
			lastPushAt = Date.now();
			render();
			persist();
			startPoll();
		} catch (err) {
			console.warn("[queue] follow_up 失败", err?.message || err);
			restoreDraft(draft.prev);
		}
	};

	const steerNow = async () => {
		const draft = takeDraft();
		if (!draft) return;
		try {
			await ctx.pi.command({ type: "steer", message: draft.text });
			toast("已插话");
		} catch (err) {
			console.warn("[queue] steer 失败", err?.message || err);
			restoreDraft(draft.prev);
		}
	};

	// ---------- 计数轮询：流式期间每 2s，pi 报 0 时同步清空 ----------
	async function poll() {
		if (document.hidden || busy) return;
		if (!ctx.state?.streaming) {
			stopPoll();
			return;
		}
		busy = true;
		try {
			const s = await ctx.pi.command({ type: "get_state" });
			if (s?.isStreaming === false) {
				stopPoll();
				if (!demo) clearSent();
				return;
			}
			// pi 的计数只描述它自己的队列，只能用来清「已交给 pi」的条目
			const hasSent = queue.some((it) => it.sent);
			if (!demo && hasSent && s?.pendingMessageCount === 0 && Date.now() - lastPushAt > SETTLE_GRACE_MS) {
				clearSent();
			}
		} catch {
			// 查询失败不打扰用户，等下一轮
		} finally {
			busy = false;
		}
	}

	function startPoll() {
		if (!pollTimer) pollTimer = setInterval(poll, POLL_MS);
	}

	function stopPoll() {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = 0;
		}
	}

	// ---------- 交互 ----------
	// 流式中 Enter → 排队；Ctrl/Cmd+Enter → 插话。补全打开时都让给补全。
	const onKeyDown = (e) => {
		if (e.target !== input || e.key !== "Enter" || e.shiftKey || e.isComposing) return;
		if (!ctx.state?.streaming || !input.value.trim()) return;
		if (document.querySelector(".sug:not([hidden])")) return;
		const steer = e.ctrlKey || e.metaKey;
		e.preventDefault();
		e.stopPropagation();
		if (steer) void steerNow();
		else void enqueue();
	};

	// 流式中点 #send 且草稿非空：捕获阶段拦下，避免 app.js 把它当成 abort
	const onSendClick = (e) => {
		if (!sendBtn.contains(e.target)) return;
		if (!ctx.state?.streaming || !input.value.trim()) return;
		e.preventDefault();
		e.stopPropagation();
		void enqueue();
	};

	chevronBtn.onclick = (e) => {
		e.preventDefault();
		e.stopPropagation();
		collapsed = !collapsed;
		render();
	};

	clearBtn.onclick = async (e) => {
		e.preventDefault();
		e.stopPropagation();
		if (!armed) {
			armed = true;
			clearBtn.dataset.armed = "1";
			clearBtn.textContent = "确认清空";
			clearTimeout(armTimer);
			armTimer = setTimeout(resetArm, ARM_MS);
			return;
		}
		resetArm();
		try {
			await ctx.pi.command({ type: "clear_queue" });
			clearLocal();
		} catch (err) {
			console.warn("[queue] clear_queue 失败", err?.message || err);
		}
	};

	// ---------- 验收钩子（截图用：只往本地 mirror 塞假条目，不发 RPC）----------
	const DEMO_TEXTS = [
		"检查构建输出",
		"把失败的单测修掉",
		"补一下 preload 的返回值类型",
		"重跑 lint 并整理告警",
	];
	const demoText = (i) => {
		const base = DEMO_TEXTS[i % DEMO_TEXTS.length];
		return i < DEMO_TEXTS.length ? base : `${base}（${i + 1}）`;
	};

	window.__piQueueDemo = (n = 2) => {
		const count = Math.trunc(Number(n));
		demo = true; // 先立旗：清空 / 塞假条目都不写 localStorage
		queue.length = 0;
		if (!Number.isFinite(count) || count <= 0) {
			demo = false;
			render();
			return 0;
		}
		for (let i = 0; i < count; i++) queue.push({ id: ++seq, text: demoText(i), mode: "follow_up", sent: true });
		lastPushAt = Date.now();
		render();
		return queue.length;
	};

	window.__piQueueDemoClear = () => {
		// demo 期间不落盘：清掉的只是假条目，磁盘上那份真实队列不能被顺手删了
		queue.length = 0;
		render();
		demo = false;
	};

	// ---------- 挂载 ----------
	input.addEventListener("input", syncSend);
	document.addEventListener("keydown", onKeyDown, true);
	document.addEventListener("click", onSendClick, true);

	try {
		ctx.pi.onEvent?.((ev) => {
			if (ev?.type === "agent_start") {
				startPoll();
				poll();
				syncSend();
			} else if (ev?.type === "agent_settled") {
				stopPoll();
				if (!demo) clearSent();
				syncSend();
				settleAt = Date.now();
				restore(); // 新会话第一轮结束才有 sessionFile，这里补一次
			} else if (ev?.type === "session_info_changed") {
				settleAt = 0; // 会话被换掉了，不是「刚结束一轮」的迁移
				restore();
			}
		});
	} catch {}

	document.addEventListener("visibilitychange", () => {
		if (!document.hidden && ctx.state?.streaming) poll();
	});

	// app.js 的 refreshState 不广播事件：轮询 sessionFile 变化兜底（只是读一个字符串）
	setInterval(() => {
		if (storeKeyOf(ctx.state?.sessionFile) !== restoredKey) restore();
	}, SESSION_WATCH_MS);

	restore();
	render();
	syncSend();
	if (ctx.state?.streaming) {
		startPoll();
		poll();
	}
}
