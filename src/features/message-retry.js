// 用户消息操作：悬停出现「回填」「重试」
// 只处理 .row.mine；幂等挂载，MutationObserver 覆盖新消息与历史重绘。
const CSS = `
/* 按钮外观由 message-actions 的 .row > .acts button 统一，这里只加不可用态的说明文字 */
.acts > .act-hint {
	font: 11px/1.6 var(--ui);
	color: var(--faint);
	white-space: nowrap;
	animation: act-hint-in 120ms ease;
}
@keyframes act-hint-in {
	from { opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
	.acts > .act-hint { animation: none; }
}
`;

const FILL_FALLBACK =
	'<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M11.4 2.6a1.3 1.3 0 0 1 1.8 0l.2.2a1.3 1.3 0 0 1 0 1.8L6 12.1l-2.6.5.5-2.6 7.5-7.4Z" stroke-linejoin="round"/></svg>';
const RETRY_ICON =
	'<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M13 8a5 5 0 1 1-1.6-3.7" stroke-linecap="round"/><path d="M13.2 2.4v3.2H10" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const BUSY_REASON = "生成中，结束后才能重试";
const HINT_MS = 2000;

export function init(ctx) {
	const stream = ctx?.stream;
	const input = ctx?.input;
	if (!stream || !input) return;

	// 样式由模块自己注入；重复 init 不重复插入
	if (!document.head.querySelector('style[data-feature="message-retry"]')) {
		const style = document.createElement("style");
		style.dataset.feature = "message-retry";
		style.textContent = CSS;
		document.head.append(style);
	}

	const fillIcon = ctx.ICON?.pencil ?? FILL_FALLBACK;

	// 用户原文（.user 气泡 textContent 即原文，保留换行）
	const textOf = (row) => row.querySelector(":scope > .user")?.textContent ?? "";

	// 行内一次性提示：不可用时说明原因，别让按钮静默没反应
	const hintTimers = new WeakMap();
	const hint = (row, text) => {
		const bar = row.querySelector(":scope > .acts");
		if (!bar) return;
		let el = bar.querySelector(".act-hint");
		if (!el) {
			el = document.createElement("span");
			el.className = "act-hint";
			el.setAttribute("role", "status");
			bar.prepend(el);
		}
		el.textContent = text;
		clearTimeout(hintTimers.get(bar));
		hintTimers.set(
			bar,
			setTimeout(() => el.remove(), HINT_MS),
		);
	};

	// 回填：写回输入框；input 事件触发 app.js 的 autosize / updateSend
	const fill = (row) => {
		const text = textOf(row);
		if (!text.trim()) return false;
		input.value = text;
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.focus();
		const end = text.length;
		try {
			input.setSelectionRange(end, end);
		} catch {}
		input.scrollTop = input.scrollHeight;
		return true;
	};

	// 重试：回填后走 app.js 现有的 Enter 发送路径；流式中不发送
	const retry = (row) => {
		if (ctx.state?.streaming) return false;
		if (row.dataset.images) {
			hint(row, "图片消息不能重试");
			return false;
		}
		if (!fill(row)) return false;
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		return true;
	};

	const sync = (row) => {
		const btn = row.querySelector(':scope > .acts [data-act="retry"]');
		if (!btn) return;
		const blocked = !!ctx.state?.streaming;
		// 不用原生 disabled：禁用按钮不派发 hover/focus，鼠标上没有任何解释（DSH MessageIconActions）
		if (blocked) btn.setAttribute("data-unavailable", "");
		else btn.removeAttribute("data-unavailable");
		btn.setAttribute("aria-disabled", blocked ? "true" : "false");
		btn.title = blocked ? BUSY_REASON : "重试：回填并发送";
	};

	const button = (act, label, title, icon) => {
		const b = document.createElement("button");
		b.type = "button";
		b.dataset.act = act;
		b.title = title;
		b.setAttribute("aria-label", label);
		b.innerHTML = icon;
		return b;
	};

	const actsOf = (row) => {
		let bar = row.querySelector(":scope > .acts");
		if (!bar) {
			bar = document.createElement("div");
			bar.className = "acts";
			bar.setAttribute("role", "group");
			bar.setAttribute("aria-label", "消息操作");
			row.append(bar);
		}
		return bar;
	};

	const attach = (row) => {
		if (row.dataset.retryActs === "1") return;
		if (!row.querySelector(":scope > .user")) return;
		row.dataset.retryActs = "1";

		const bar = actsOf(row);

		const fillBtn = button("fill", "回填到输入框", "回填到输入框（不发送）", fillIcon);
		fillBtn.onclick = (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (!fill(row)) hint(row, "这条消息没有可回填的文字");
		};

		const retryBtn = button("retry", "重试", "重试：回填并发送", RETRY_ICON);
		retryBtn.onclick = (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (ctx.state?.streaming) {
				hint(row, BUSY_REASON);
				return;
			}
			if (!textOf(row).trim()) {
				hint(row, "这条消息没有可重试的文字");
				return;
			}
			retry(row);
		};

		bar.append(fillBtn, retryBtn);
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

	const syncAll = () => {
		for (const row of stream.querySelectorAll(".row.mine")) sync(row);
	};

	const mo = new MutationObserver(schedule);
	mo.observe(stream, { childList: true, subtree: true });
	scan();

	// 流式开始/结束各同步一次：否则按钮要等下次 pointerenter 才恢复可用
	ctx.pi?.onEvent?.((ev) => {
		if (ev?.type === "agent_start" || ev?.type === "agent_settled") syncAll();
	});
}
