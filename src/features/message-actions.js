// 消息操作：悬停出现复制按钮（对齐 DSH ui-chat 的 MessageIconActions）
const COPY_ICON =
	'<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="5.5" y="5.5" width="8" height="8" rx="1.6"/><path d="M10.5 5.5V3.6c0-.6-.4-1-1-1H3.6c-.6 0-1 .4-1 1v5.9c0 .6.4 1 1 1h1.9" stroke-linejoin="round"/></svg>';
const CHECK_ICON =
	'<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3.6 8.4 6.5 11.3 12.4 5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// 写剪贴板：优先异步 API，缺失/被拒时退到 execCommand（对齐 DSH ui-primitives/clipboard.ts）
async function writeClipboard(text) {
	if (navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			return false;
		}
	}
	const exec = typeof document.execCommand === "function" ? document.execCommand.bind(document) : null;
	if (!exec) return false;
	const ta = document.createElement("textarea");
	ta.value = text;
	ta.setAttribute("readonly", "");
	ta.style.cssText = "position:fixed;left:-9999px;top:0";
	document.body.append(ta);
	ta.select();
	try {
		return exec("copy");
	} catch {
		return false;
	} finally {
		ta.remove();
	}
}

// 复制用的正文：用户消息取气泡原文；助手消息剔除工具卡与代码块工具条，
// 否则 bash 输出、文件名、「复制」按钮文字都会混进剪贴板。
function rowText(row) {
	if (row.classList.contains("mine")) {
		return (row.querySelector(":scope > .user")?.textContent ?? "").trim();
	}
	const body = row.querySelector(":scope > .body");
	if (!body) return "";
	const clone = body.cloneNode(true);
	clone.querySelectorAll(".tool, .codebar, .acts").forEach((n) => n.remove());
	const host = document.createElement("div");
	host.style.cssText = "position:fixed;top:0;left:-9999px;max-width:640px";
	host.append(clone);
	document.body.append(host);
	const text = (clone.innerText || clone.textContent || "").trim();
	host.remove();
	return text;
}

const timers = new WeakMap();

function feedback(btn, ok, note) {
	clearTimeout(timers.get(btn));
	btn.dataset.state = ok ? "ok" : "bad";
	btn.innerHTML = ok ? CHECK_ICON : COPY_ICON;
	btn.title = ok ? "已复制" : note || "复制失败";
	btn.setAttribute("aria-label", btn.title);
	timers.set(
		btn,
		setTimeout(() => {
			delete btn.dataset.state;
			btn.innerHTML = COPY_ICON;
			btn.title = "复制";
			btn.setAttribute("aria-label", "复制");
		}, ok ? 1200 : 2000),
	);
}

export function init(ctx) {
	const stream = ctx?.stream;
	if (!stream) return;

	const CSS = `
	.row { position: relative; }
	/* 操作条在消息正文下方，横向一排（对齐 DSH MessageIconActions） */
	.row > .acts {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 4px;
		opacity: 0;
		pointer-events: none;
		transition: opacity 120ms ease;
	}
	/* 透明度切换保住布局，不写 height/display（DSH 同理由） */
	.row:hover > .acts, .row > .acts:focus-within, .row.acts-on > .acts { opacity: 1; pointer-events: auto; }
	/* 分支浮层打开时钉住当前行的操作条，鼠标移去浮层也不消失 */
	.row.acts-pin > .acts { opacity: 1; pointer-events: auto; }
	@media (hover: none) { .row > .acts { opacity: 1; pointer-events: auto; } }
	.row.mine { flex-wrap: wrap; }
	/* 用户消息的操作条浮在气泡下方，不参与布局（否则每条用户消息后多出 34px 空白） */
	.row.mine > .acts { position: absolute; top: 100%; right: 0; margin-top: 2px; width: auto; justify-content: flex-end; }
	.row.assistant > .acts { margin-top: 16px; margin-left: -6px; }
	.row > .acts button {
		width: 28px;
		height: 28px;
		border-radius: var(--radius-sm);
		display: grid;
		place-items: center;
		background: none;
		color: var(--faint);
		transition: background-color 120ms ease, color 120ms ease;
	}
	.row > .acts button:hover { background: var(--hover); color: var(--text); }
	.row > .acts button:focus-visible {
		outline: 1px solid var(--faint);
		outline-offset: 1px;
		background: var(--hover);
		color: var(--text);
	}
	/* 不可用状态不用原生 disabled：禁用按钮不派发 hover/focus，没法解释原因（DSH 原话） */
	.row > .acts button[data-unavailable] { opacity: 0.4; cursor: default; }
	.row > .acts button[data-unavailable]:hover { background: none; color: var(--faint); }
	.row > .acts button[data-state="ok"] { color: var(--text); }
	.row > .acts button[data-state="bad"] { color: var(--err); }
	@media (prefers-reduced-motion: reduce) {
		.row > .acts, .row > .acts button { transition: none; }
	}
	`;
	if (!document.head.querySelector('style[data-feature="message-actions"]')) {
		const style = document.createElement("style");
		style.dataset.feature = "message-actions";
		style.textContent = CSS;
		document.head.append(style);
	}

	const attach = (row) => {
		if (row.querySelector(":scope > .acts")) return;
		const acts = document.createElement("div");
		acts.className = "acts";
		acts.setAttribute("role", "group");
		acts.setAttribute("aria-label", "消息操作");
		const copy = document.createElement("button");
		copy.type = "button";
		copy.dataset.act = "copy";
		copy.title = "复制";
		copy.setAttribute("aria-label", "复制");
		copy.innerHTML = COPY_ICON;
		copy.onclick = async (e) => {
			e.preventDefault();
			e.stopPropagation();
			const text = rowText(row);
			if (!text) {
				feedback(copy, false, "没有可复制的内容");
				return;
			}
			feedback(copy, await writeClipboard(text));
		};
		acts.append(copy);
		row.append(acts);

		// 鼠标离开后留 380ms 宽限：跨过行与操作条之间的小缝隙、或移向分支浮层时
		// 不会立即淡出而点不到按钮（DSH 只做 hover 显隐，这里补一个容错窗口）。
		row.addEventListener("pointerenter", () => {
			clearTimeout(row.__actsTimer);
			row.classList.add("acts-on");
		});
		row.addEventListener("pointerleave", () => {
			clearTimeout(row.__actsTimer);
			row.__actsTimer = setTimeout(() => {
				if (row.matches(":hover") || row.classList.contains("acts-pin")) return;
				if (row.contains(document.activeElement)) return;
				row.classList.remove("acts-on");
			}, 380);
		});
	};

	let queued = false;
	const scan = () => {
		queued = false;
		for (const row of stream.querySelectorAll(".row")) attach(row);
	};
	const schedule = () => {
		if (queued) return;
		queued = true;
		requestAnimationFrame(scan);
	};

	// 只关心子节点增删：characterData 每次 delta 都会触发，没必要
	const mo = new MutationObserver(schedule);
	mo.observe(stream, { childList: true, subtree: true });
	scan();
}
