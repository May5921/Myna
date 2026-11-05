// 排队 dock：结构照 DSH 的 QueueDock（packages/client/ui-conversation/src/client/queue/QueueDock.tsx）。
// 本地队列：pi 没有按条编辑/删除/插话的 RPC，只能由前端维护。
// 行为：
//   - 空队列不渲染；1 条直接显示一行；多条折叠成「N 条排队」，默认收起
//   - 行内图标操作：编辑（勾/叉确认）、删除、插话（仅运行中可用）
//   - 发送中：条目保留并显示「发送中…」，成功后移除，失败恢复可操作
//   - 空闲且队列非空时自动发下一条（等价于 DSH 的 host 队列自动投递）
// Enter → 排队；Ctrl/Cmd+Enter → 插话（设置 → 行为可互换）。
// 持久化：pi-mini.queue.<sessionFile>（历史键名保留），只存文本；带图条目只活在本次运行。
import { QUEUE_STORE_MAX, QUEUE_STORE_NEW, parseQueueStore, queueStoreKey } from "../core/queue-store.js";
import { composeMessage, splitAttachments, toRpcImages } from "../core/rpc-attachments.js";

const TOAST_MS = 2000;
const SVG_NS = "http://www.w3.org/2000/svg";

const contentText = (content) =>
	Array.isArray(content)
		? content.filter((b) => b?.type === "text").map((b) => b.text || "").join("")
		: typeof content === "string"
			? content
			: "";

// steer 插话是 pi 的延迟投递：消息到达后先留在 dock 里，等 user 回显再移除。
const sameEcho = (sent, got) => {
	const a = String(sent || "").trim();
	const b = String(got || "").trim();
	return Boolean(a && b && (a === b || b.includes(a) || a.includes(b)));
};

const SESSION_WATCH_MS = 500;
const BUSY_ENTER_KEY = "pi-mini.busyEnter";
const busyEnter = () => {
	try {
		return localStorage.getItem(BUSY_ENTER_KEY) === "steer" ? "steer" : "queue";
	} catch {
		return "queue";
	}
};

const storeKeyOf = queueStoreKey;

const readQueueStore = (key) => {
	try {
		return parseQueueStore(localStorage.getItem(key), QUEUE_STORE_MAX);
	} catch {
		return [];
	}
};

const CSS = `
.queue-dock {
	box-sizing: border-box;
	width: min(768px, 100% - 48px);
	margin: 0 auto -3px;
	overflow: hidden;
	background: var(--bg);
	border: 1px solid var(--line);
	border-bottom: none;
	border-radius: 10px 10px 0 0;
}
.queue-dock[hidden] { display: none; }

.queue-head {
	display: flex;
	align-items: center;
	gap: 10px;
	width: 100%;
	height: 36px;
	padding: 4px 12px;
	border: none;
	background: none;
	color: var(--text);
	font: 13px/24px var(--ui);
	text-align: left;
	cursor: pointer;
}
.queue-head[hidden] { display: none; }
.queue-head:disabled { cursor: default; }
.queue-head:focus-visible { outline: 1px solid var(--faint); outline-offset: -2px; }
.queue-count { flex: 1 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.queue-chevron { display: grid; place-items: center; flex: none; width: 14px; height: 14px; color: var(--faint); }
.queue-lead { display: grid; place-items: center; flex: none; color: var(--faint); }
.queue-lead svg, .queue-chevron svg, .queue-act svg { display: block; }

.queue-list {
	max-height: 180px;
	margin: 0;
	padding: 0;
	overflow-y: auto;
	list-style: none;
	scrollbar-width: thin;
	scrollbar-color: var(--line-strong) transparent;
}
.queue-list[hidden] { display: none; }

.queue-row {
	box-sizing: border-box;
	display: flex;
	align-items: center;
	gap: 10px;
	width: 100%;
	min-height: 36px;
	padding: 4px 6px 4px 12px;
}
.queue-row + .queue-row { box-shadow: inset 0 1px 0 var(--line); }
.queue-row.pending .queue-preview { color: var(--faint); }

.queue-thumbs { display: flex; flex: none; gap: 4px; min-width: 0; max-width: 45%; overflow: hidden; }
.queue-thumb {
	width: 24px;
	height: 24px;
	object-fit: cover;
	border: 1px solid var(--line);
	border-radius: 4px;
	background: var(--hover);
}
.queue-more { flex: none; align-self: center; color: var(--faint); font: 11px/1 var(--mono); }
.queue-preview {
	flex: 1 1 auto;
	min-width: 0;
	overflow: hidden;
	color: var(--dim);
	font: 13px/1.5 var(--ui);
	white-space: nowrap;
	text-overflow: ellipsis;
}
.queue-status { flex: none; color: var(--faint); font: 12px/1.5 var(--ui); white-space: nowrap; }

.queue-actions { display: flex; flex: none; align-items: center; gap: 2px; }
.queue-act {
	display: grid;
	place-items: center;
	flex: none;
	width: 28px;
	height: 28px;
	padding: 0;
	border: none;
	border-radius: 999px;
	background: none;
	color: var(--faint);
	transition: background-color 120ms ease, color 120ms ease;
}
.queue-act:hover:not(:disabled) { background: var(--hover); color: var(--text); }
.queue-act:disabled { opacity: 0.45; cursor: default; }
.queue-act:focus-visible { outline: 1px solid var(--faint); outline-offset: -1px; }

.queue-edit {
	flex: 1 1 auto;
	min-width: 0;
	height: 28px;
	padding: 0 8px;
	border: 1px solid var(--line-strong);
	border-radius: 6px;
	background: var(--bg);
	color: var(--text);
	font: 13px/1.4 var(--ui);
}
.queue-edit:focus { outline: none; border-color: var(--faint); }

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
	.queue-act, .queue-toast, .queue-chevron { transition: none; }
}
`;

// ---------- 图标（14px，DSH QueueDock 的图标尺寸）----------
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

const ICON = {
	queue: () => svg([dotEl("2.8", "4.4"), dotEl("2.8", "9.6"), pathEl("M5.6 4.4h5.6"), pathEl("M5.6 9.6h5.6")]),
	chevronDown: () => svg([pathEl("M3.6 5.2 7 8.6l3.4-3.4")]),
	chevronUp: () => svg([pathEl("M3.6 8.8 7 5.4l3.4 3.4")]),
	edit: () => svg([pathEl("M9.6 2.6a1.2 1.2 0 0 1 1.7 0l.1.1a1.2 1.2 0 0 1 0 1.7L5.2 10.6l-2.2.5.5-2.2 6.1-6.3Z")]),
	trash: () => svg([pathEl("M2.6 3.6h8.8"), pathEl("M5.4 3.6V2.5h3.2v1.1"), pathEl("M3.8 3.6l.5 7.6h5.4l.5-7.6")]),
	steer: () => svg([pathEl("M12.4 1.9 1.9 6.1l4 1.6 1.6 4 4.9-9.8Z"), pathEl("M5.9 7.7 9 5.4")]),
	check: () => svg([pathEl("M3 7.4 5.7 10.1 11 4.8")]),
	close: () => svg([pathEl("M3.6 3.6l6.8 6.8"), pathEl("M10.4 3.6l-6.8 6.8")]),
};

const mk = (tag, cls, text) => {
	const el = document.createElement(tag);
	if (cls) el.className = cls;
	if (text != null) el.textContent = text;
	return el;
};

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
	const basePlaceholder = input.placeholder;

	const queue = []; // { id, text, images, pending }
	let seq = 0;
	let storeKey = storeKeyOf(ctx.state?.sessionFile);
	let restoredKey = null;
	let settleAt = 0;
	let collapsed = true;
	let editingId = null;
	let dispatching = false;
	let failAt = 0; // 投递失败后的退避，避免 500ms 看门狗变成重试风暴
	let failCount = 0;
	let demo = false;
	let toastTimer = 0;
	let toastSeq = 0;

	// ---------- Dock DOM ----------
	const dock = mk("div", "queue-dock");
	dock.hidden = true;
	dock.setAttribute("role", "region");
	dock.setAttribute("aria-label", "待发送队列");

	const head = mk("button", "queue-head");
	head.type = "button";
	head.hidden = true;
	head.setAttribute("aria-controls", "queue-list");
	head.setAttribute("aria-expanded", "false");

	const leadEl = mk("span", "queue-lead");
	leadEl.append(ICON.queue());
	const countEl = mk("span", "queue-count");
	countEl.setAttribute("aria-live", "polite");
	const chevronEl = mk("span", "queue-chevron");
	head.append(leadEl, countEl, chevronEl);

	const listEl = mk("ul", "queue-list");
	listEl.id = "queue-list";
	listEl.setAttribute("aria-label", "待发送消息");

	dock.append(head, listEl);
	composer.insertBefore(dock, box);

	// ---------- Toast ----------
	const toastEl = mk("div", "queue-toast");
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

	// ---------- 行 ----------
	const iconBtn = (icon, label, { disabled = false, title = label, onClick } = {}) => {
		const b = mk("button", "queue-act");
		b.type = "button";
		b.append(icon());
		b.title = title;
		b.setAttribute("aria-label", label);
		b.disabled = disabled;
		if (onClick) b.onclick = onClick;
		return b;
	};

	const editorFor = (item) => {
		const inp = mk("input", "queue-edit");
		inp.type = "text";
		inp.value = item.text;
		inp.setAttribute("aria-label", "编辑排队消息");
		inp.onkeydown = (e) => {
			if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) {
				e.preventDefault();
				saveEdit(item, inp.value);
			} else if (e.key === "Escape") {
				e.preventDefault();
				editingId = null;
				render();
			}
		};
		return inp;
	};

	const saveEdit = (item, value) => {
		const text = String(value || "").trim();
		if (!text) return;
		item.text = text;
		editingId = null;
		persist();
		render();
	};

	const removeItem = (item) => {
		const i = queue.indexOf(item);
		if (i < 0) return;
		queue.splice(i, 1);
		if (editingId === item.id) editingId = null;
		persist();
		render();
	};

	const steerItem = async (item) => {
		if (item.pending || item.steerPending) return;
		if (!ctx.state?.streaming) return;
		try {
			const { docs, images } = splitAttachments(item.images);
			const cmd = { type: "steer", message: composeMessage(item.text, docs) || `[${images.length} 张图片]` };
			if (images.length) cmd.images = toRpcImages(images);
			await ctx.pi.command(cmd);
			item.steerPending = true;
			item.steerSent = cmd.message;
			render();
			toast("已插话，等当前回合结束");
		} catch (err) {
			console.warn("[queue] steer 失败", err?.message || err);
			toast("插话失败");
		}
	};

	const rowEl = (item) => {
		const li = mk("li", "queue-row" + (item.pending ? " pending" : ""));
		li.dataset.id = String(item.id);
		const single = queue.length === 1;
		if (single) {
			const lead = mk("span", "queue-lead");
			lead.append(ICON.queue());
			li.append(lead);
		}
		if (item.images?.length) {
			const thumbs = mk("span", "queue-thumbs");
			for (const img of item.images.slice(0, 3)) {
				const im = document.createElement("img");
				im.className = "queue-thumb";
				im.src = img.url || (img.data ? `data:${img.mimeType};base64,${img.data}` : "");
				im.alt = img.name || "图片";
				im.draggable = false;
				thumbs.append(im);
			}
			if (item.images.length > 3) thumbs.append(mk("span", "queue-more", `+${item.images.length - 3}`));
			li.append(thumbs);
		}

		const editing = editingId === item.id;
		if (editing) {
			li.append(editorFor(item));
		} else {
			const preview = mk("span", "queue-preview", item.text || "[仅图片]");
			preview.title = item.text || "";
			li.append(preview);
		}

		if (item.pending) {
			li.append(mk("span", "queue-status", "发送中…"));
			const actions = mk("span", "queue-actions");
			actions.append(
				iconBtn(ICON.edit, "编辑", { disabled: true, title: "发送中" }),
				iconBtn(ICON.trash, "删除", { disabled: true, title: "发送中" }),
				iconBtn(ICON.steer, "插话", { disabled: true, title: "发送中" }),
			);
			li.append(actions);
			return li;
		}

		if (item.steerPending) {
			// 已经发给 pi，但 pi 只会在当前回合的工具调用结束后才投递；这里保留一行等待态。
			li.append(mk("span", "queue-status", "等待当前回合结束…"));
			return li;
		}

		const actions = mk("span", "queue-actions");
		if (editing) {
			actions.append(
				iconBtn(ICON.check, "保存", { title: "保存编辑", onClick: () => saveEdit(item, li.querySelector(".queue-edit")?.value) }),
				iconBtn(ICON.close, "取消", {
					title: "取消编辑",
					onClick: () => {
						editingId = null;
						render();
					},
				}),
			);
		} else {
			const running = !!ctx.state?.streaming;
			actions.append(
				iconBtn(ICON.edit, "编辑", {
					title: "编辑排队消息",
					onClick: () => {
						editingId = item.id;
						render();
					},
				}),
				iconBtn(ICON.trash, "删除", { title: "删除排队消息", onClick: () => removeItem(item) }),
				iconBtn(ICON.steer, "插话", {
					disabled: !running,
					title: running ? "插入当前回合（下一个步骤生效）" : "当前没有正在生成的回复",
					onClick: () => void steerItem(item),
				}),
			);
		}
		li.append(actions);
		return li;
	};

	const jumpEl = document.getElementById("jump");
	let jumpBase = null;
	const syncJumpOffset = () => {
		if (!jumpEl) return;
		if (jumpBase == null) {
			const raw = parseFloat(getComputedStyle(jumpEl).bottom);
			jumpBase = Number.isFinite(raw) ? raw : 150;
		}
		if (dock.hidden) {
			jumpEl.style.removeProperty("bottom");
		} else {
			// #jump 的默认 bottom 按空 composer 算的；dock 出现后要把这段高度让出来
			jumpEl.style.bottom = `${jumpBase + dock.offsetHeight + 8}px`;
		}
	};

	// ---------- 渲染 ----------
	function render() {
		const n = queue.length;
		dock.hidden = n === 0;
		head.hidden = n <= 1;
		if (n === 0) {
			collapsed = true;
			editingId = null;
			listEl.replaceChildren();
			head.setAttribute("aria-expanded", "false");
			syncSend();
			syncJumpOffset();
			return;
		}
		const interactionActive = editingId !== null || queue.some((it) => it.pending);
		if (interactionActive) collapsed = false;
		const listVisible = n === 1 || !collapsed;
		head.disabled = interactionActive;
		countEl.textContent = `${n} 条排队`;
		head.setAttribute("aria-expanded", listVisible ? "true" : "false");
		head.setAttribute("aria-label", listVisible ? "收起排队消息" : "展开排队消息");
		chevronEl.replaceChildren(listVisible ? ICON.chevronDown() : ICON.chevronUp());
		listEl.hidden = !listVisible;
		listEl.replaceChildren(...queue.map(rowEl));
		if (editingId !== null) listEl.querySelector(".queue-edit")?.focus();
		syncSend();
		syncJumpOffset();
	}

	head.onclick = (e) => {
		e.preventDefault();
		if (head.disabled) return;
		collapsed = !collapsed;
		render();
	};

	// ---------- 写盘 / 恢复 ----------
	function persist() {
		if (demo) return;
		try {
			if (!queue.length) {
				localStorage.removeItem(storeKey);
				return;
			}
			// base64 图不落盘（localStorage 存不下），带图条目只活在本次运行里
			const rows = queue
				.filter((it) => !it.steerPending && !it.images?.length && it.text.trim())
				.slice(-QUEUE_STORE_MAX)
				.map((it) => ({ text: it.text }));
			if (!rows.length) {
				localStorage.removeItem(storeKey);
				return;
			}
			localStorage.setItem(storeKey, JSON.stringify(rows));
		} catch (err) {
			console.warn("[queue] 持久化失败", err?.message || err);
		}
	}

	function restore() {
		const nextKey = storeKeyOf(ctx.state?.sessionFile);
		if (nextKey === restoredKey) return;
		// 新会话第一轮结束才有 sessionFile：刚 settle 完的 5 秒内，把没发出去的草稿带到正式 key 上。
		const settled = Date.now() - settleAt < 5000;
		const carry = restoredKey === QUEUE_STORE_NEW && nextKey !== QUEUE_STORE_NEW && settled ? queue.filter((it) => !it.pending && !it.steerPending) : [];
		restoredKey = nextKey;
		storeKey = nextKey;
		demo = false;
		editingId = null;
		collapsed = true;
		queue.length = 0;
		for (const it of readQueueStore(nextKey)) queue.push({ id: ++seq, text: it.text, images: [], pending: false });
		for (const it of carry) queue.push({ id: ++seq, text: it.text, images: it.images || [], pending: false });
		render();
		if (carry.length) {
			persist();
			try {
				localStorage.removeItem(QUEUE_STORE_NEW);
			} catch {}
		}
	}

	// ---------- 发送键 / 草稿 ----------
	const hasDraft = () => !!input.value.trim() || (ctx.attachments?.get?.() || []).length > 0;
	const syncSend = () => {
		const streaming = !!ctx.state?.streaming;
		const queuing = streaming && hasDraft();
		sendBtn.classList.toggle("queue-send", queuing);
		const primary = busyEnter();
		sendBtn.title = queuing
			? primary === "steer"
				? "插话发送（Ctrl+Enter 排队）"
				: "排队发送（Ctrl+Enter 插话）"
			: streaming
				? "停止"
				: sendTitle;
	};

	const takeDraft = () => {
		const text = input.value.trim();
		const images = ctx.attachments?.take?.() || [];
		if (!text && !images.length) return null;
		const prev = input.value;
		input.value = "";
		input.dispatchEvent(new Event("input", { bubbles: true }));
		return { text, prev, images };
	};

	const restoreDraft = (draft) => {
		if (draft.images?.length) ctx.attachments.set?.(draft.images);
		if (!input.value) {
			input.value = draft.prev || "";
			input.dispatchEvent(new Event("input", { bubbles: true }));
		}
		input.focus();
	};

	const enqueue = () => {
		const draft = takeDraft();
		if (!draft) return;
		demo = false;
		failAt = 0;
		failCount = 0;
		queue.push({ id: ++seq, text: draft.text, images: draft.images, pending: false });
		persist();
		render();
		toast(draft.images.length ? `已排队（含 ${draft.images.length} 个附件）` : "已排队");
	};

	const steerNow = async () => {
		const draft = takeDraft();
		if (!draft) return;
		try {
			const { docs, images } = splitAttachments(draft.images);
			const cmd = { type: "steer", message: composeMessage(draft.text, docs) || `[${images.length} 张图片]` };
			if (images.length) cmd.images = toRpcImages(images);
			await ctx.pi.command(cmd);
			// 保留一行等待态：pi 要到当前回合结束才把消息交给模型
			queue.push({ id: ++seq, text: draft.text, images: draft.images, pending: false, steerPending: true, steerSent: cmd.message });
			render();
			toast("已插话，等当前回合结束");
		} catch (err) {
			console.warn("[queue] steer 失败", err?.message || err);
			restoreDraft(draft);
		}
	};

	const keepBackoff = () => {
		if (!failAt) return false;
		const wait = Math.min(30000, 5000 * 2 ** Math.min(failCount, 3));
		return Date.now() - failAt < wait;
	};

	// ---------- 投递 ----------
	// 每条排队消息占一个完整回合：先标记 pending（发送中），submit 成功后才出队；
	// 失败/早退则恢复可操作，输入和附件都回滚。
	async function dispatchNext() {
		if (dispatching || !queue.length) return;
		if (demo) return;
		const item = queue.find((it) => !it.steerPending);
		if (!item || item.pending) return;
		if (editingId !== null) return;
		if (ctx.state?.streaming || ctx.state?.switching) return;
		if (keepBackoff()) return;
		if (input.value.trim()) return;
		if ((ctx.attachments?.get?.() || []).length) return;
		dispatching = true;
		item.pending = true;
		render();
		try {
			input.value = item.text;
			if (item.images?.length) ctx.attachments.set?.(item.images);
			input.dispatchEvent(new Event("input", { bubbles: true }));
			const sent = await ctx.submit?.();
			if (sent === false) {
				item.pending = false;
				ctx.attachments.clear?.();
				input.value = "";
				input.dispatchEvent(new Event("input", { bubbles: true }));
				persist();
				render();
			} else {
				removeItem(item);
			}
		} catch (err) {
			console.warn("[queue] 排队消息发送失败", err?.message || err);
			item.pending = false;
			failAt = Date.now();
			failCount += 1;
			ctx.attachments.clear?.();
			persist();
			render();
			toast("排队消息发送失败");
		} finally {
			dispatching = false;
		}
	}

	// 空闲且队列非空：自动投递下一条（DSH host 队列的等价行为）
	function kick() {
		if (!window.__ready || demo || dispatching) return;
		if (!queue.some((it) => !it.steerPending && !it.pending)) return;
		if (editingId !== null) return;
		if (ctx.state?.streaming || ctx.state?.switching) return;
		if (keepBackoff()) return;
		if (input.value.trim()) return;
		if ((ctx.attachments?.get?.() || []).length) return;
		void dispatchNext();
	}

	// ---------- 交互 ----------
	const onKeyDown = (e) => {
		if (e.target !== input || e.key !== "Enter" || e.shiftKey || e.isComposing || e.keyCode === 229) return;
		if (e.defaultPrevented) return;
		if (!ctx.state?.streaming || !hasDraft()) return;
		if (document.querySelector(".sug:not([hidden])")) return;
		const primary = busyEnter();
		const steer = e.ctrlKey || e.metaKey ? primary !== "steer" : primary === "steer";
		e.preventDefault();
		e.stopPropagation();
		if (steer) void steerNow();
		else enqueue();
	};

	const onSendClick = (e) => {
		if (!sendBtn.contains(e.target)) return;
		if (!ctx.state?.streaming || !hasDraft()) return;
		e.preventDefault();
		e.stopPropagation();
		if (busyEnter() === "steer") void steerNow();
		else enqueue();
	};

	// ---------- 验收钩子 ----------
	const DEMO_TEXTS = ["检查构建输出", "把失败的单测修掉", "补一下 preload 的返回值类型", "重跑 lint 并整理告警"];
	window.__piQueueDemo = (n = 2) => {
		const count = Math.trunc(Number(n));
		demo = true;
		queue.length = 0;
		editingId = null;
		if (!Number.isFinite(count) || count <= 0) {
			demo = false;
			render();
			return 0;
		}
		for (let i = 0; i < count; i++) {
			queue.push({ id: ++seq, text: i < DEMO_TEXTS.length ? DEMO_TEXTS[i] : `${DEMO_TEXTS[i % DEMO_TEXTS.length]}（${i + 1}）`, images: [], pending: false });
		}
		collapsed = false; // 截图验收：直接展开，方便看行结构
		render();
		return queue.length;
	};
	window.__piQueueDemoClear = () => {
		queue.length = 0;
		editingId = null;
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
				failAt = 0;
				failCount = 0;
				input.placeholder = busyEnter() === "steer" ? "插话发送…（Ctrl+Enter 排队）" : "排队发送…（Ctrl+Enter 插话）";
				syncSend();
			} else if (ev?.type === "message_start" && ev.message?.role === "user") {
				// pi 把 steer 消息回显到会话里：从等待区移除对应行
				const text = contentText(ev.message.content).trim();
				const i = queue.findIndex((it) => it.steerPending && sameEcho(it.steerSent, text));
				if (i >= 0) {
					queue.splice(i, 1);
					render();
				}
			} else if (ev?.type === "agent_settled") {
				input.placeholder = basePlaceholder;
				syncSend();
				settleAt = Date.now();
				// 回合结束仍未回显的插话等待行没有意义了，清掉避免一直挂着
				for (let i = queue.length - 1; i >= 0; i--) if (queue[i].steerPending) queue.splice(i, 1);
				render();
				restore();
				void dispatchNext();
			} else if (ev?.type === "session_info_changed") {
				settleAt = 0;
				restore();
			}
		});
	} catch {}

	setInterval(() => {
		if (storeKeyOf(ctx.state?.sessionFile) !== restoredKey) restore();
		kick();
	}, SESSION_WATCH_MS);

	render();
}
