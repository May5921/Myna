// 用户消息操作：悬停出现「回填」「重试」
// 只处理 .row.mine；幂等挂载，MutationObserver 覆盖新消息与历史重绘。
const CSS = `
/* 回填/重试按钮并入行内的 .acts 横条（由 message-actions 建容器） */
.row.mine > .acts .retry-btn {
	width: 28px;
	height: 28px;
	border-radius: 7px;
	display: grid;
	place-items: center;
	background: none;
	color: var(--faint);
	transition: background-color 120ms ease, color 120ms ease;
}
.row.mine > .acts .retry-btn:hover {
	background: var(--hover);
	color: var(--text);
}
.row.mine > .acts .retry-btn:focus-visible {
	outline: none;
	background: var(--hover);
	color: var(--text);
}
.row.mine > .acts .retry-btn[disabled] {
	opacity: 0.35;
	cursor: default;
}
.row.mine > .acts .retry-btn[disabled]:hover {
	background: none;
	color: var(--faint);
}
@media (prefers-reduced-motion: reduce) {
	.row.mine > .acts .retry-btn { transition: none; }
}
`;

const FILL_FALLBACK =
	'<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M11.4 2.6a1.3 1.3 0 0 1 1.8 0l.2.2a1.3 1.3 0 0 1 0 1.8L6 12.1l-2.6.5.5-2.6 7.5-7.4Z" stroke-linejoin="round"/></svg>';
const RETRY_ICON =
	'<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M13 8a5 5 0 1 1-1.6-3.7" stroke-linecap="round"/><path d="M13.2 2.4v3.2H10" stroke-linecap="round" stroke-linejoin="round"/></svg>';

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

	// 回填：写回输入框；input 事件触发 app.js 的 autosize / updateSend
	const fill = (row) => {
		const text = textOf(row);
		if (!text) return false;
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
		if (!fill(row)) return false;
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		return true;
	};

	const sync = (row) => {
		const btn = row.querySelector(':scope > .acts [data-act="retry"]');
		if (!btn) return;
		const blocked = !!ctx.state?.streaming;
		btn.disabled = blocked;
		btn.setAttribute("aria-disabled", blocked ? "true" : "false");
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
			row.append(bar);
		}
		return bar;
	};

	const attach = (row) => {
		if (row.dataset.retryActs === "1") return;
		if (!row.querySelector(":scope > .user")) return;
		row.dataset.retryActs = "1";

		const bar = actsOf(row);
		bar.setAttribute("role", "group");
		bar.setAttribute("aria-label", "消息操作");

		const fillBtn = button("fill", "回填到输入框", "回填到输入框（不发送）", fillIcon);
		fillBtn.classList.add("retry-btn");
		fillBtn.onclick = (e) => {
			e.preventDefault();
			e.stopPropagation();
			fill(row);
		};

		const retryBtn = button("retry", "重试", "重试：回填并发送", RETRY_ICON);
		retryBtn.classList.add("retry-btn");
		retryBtn.onclick = (e) => {
			e.preventDefault();
			e.stopPropagation();
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

	const mo = new MutationObserver(schedule);
	mo.observe(stream, { childList: true, subtree: true });
	scan();
}
