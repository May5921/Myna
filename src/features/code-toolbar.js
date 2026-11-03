// 代码块工具条：语言标签 + 复制（对齐 DSH CodeToolbar）
// 工具条是代码块上方的独立 banner，而不是浮在 pre 里的绝对定位层：
// 原来的右上角浮层会压住首行代码，横向滚动时还会跟着内容跑出视口。

const COPY_ICON =
	'<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="5.5" y="5.5" width="8" height="8" rx="1.6"/><path d="M10.5 5.5V3.6c0-.6-.4-1-1-1H3.6c-.6 0-1 .4-1 1v5.9c0 .6.4 1 1 1h1.9" stroke-linejoin="round"/></svg>';
const CHECK_ICON =
	'<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3.6 8.4 6.5 11.3 12.4 5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

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

const timers = new WeakMap();

function feedback(btn, ok) {
	clearTimeout(timers.get(btn));
	btn.dataset.state = ok ? "ok" : "bad";
	btn.innerHTML = ok ? CHECK_ICON : COPY_ICON;
	btn.title = ok ? "已复制" : "复制失败";
	btn.setAttribute("aria-label", btn.title);
	timers.set(
		btn,
		setTimeout(() => {
			delete btn.dataset.state;
			btn.innerHTML = COPY_ICON;
			btn.title = "复制代码";
			btn.setAttribute("aria-label", "复制代码");
		}, ok ? 1200 : 2000),
	);
}

export function init(ctx) {
	const stream = ctx?.stream;
	if (!stream) return;

	const CSS = `
	/* 外壳管边框/圆角/背景，pre 本身退成无边框内层（Codex _Source>pre 同结构） */
	.codeblock {
		margin: 11px 0;
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		background: var(--code-bg);
		overflow: hidden;
	}
	.codeblock > pre,
	.body .codeblock > pre {
		margin: 0;
		border: 0;
		border-radius: 0;
		background: var(--code-bg);
	}
	.codebar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 4px 4px 4px 13px;
		background: var(--surface-2);
		border-bottom: 1px solid var(--line);
		color: var(--faint);
		font: 11px/1.6 var(--mono);
	}
	.codebar-lang {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.codebar button {
		flex: none;
		width: 22px;
		height: 22px;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: var(--radius-xs);
		background: none;
		color: var(--dim);
		transition: background-color 120ms ease, color 120ms ease;
	}
	.codebar button:hover { background: var(--hover); color: var(--text); }
	.codebar button:focus-visible {
		outline: 1px solid var(--faint);
		outline-offset: 1px;
		background: var(--hover);
		color: var(--text);
	}
	.codebar button[data-state="ok"] { color: var(--text); }
	.codebar button[data-state="bad"] { color: var(--err); }
	@media (prefers-reduced-motion: reduce) { .codebar button { transition: none; } }
	`;
	if (!document.head.querySelector('style[data-feature="code-toolbar"]')) {
		const style = document.createElement("style");
		style.dataset.feature = "code-toolbar";
		style.textContent = CSS;
		document.head.append(style);
	}

	const attach = (pre) => {
		if (pre.dataset.bar === "1") return;
		const host = pre.parentElement;
		if (!host) return;
		pre.dataset.bar = "1";

		const wrap = document.createElement("div");
		wrap.className = "codeblock";
		host.insertBefore(wrap, pre);
		wrap.append(pre);

		const bar = document.createElement("div");
		bar.className = "codebar";

		const lang = (pre.dataset.lang || "").trim();
		const label = document.createElement("span");
		label.className = "codebar-lang";
		label.textContent = lang || "text";
		label.title = lang || "text";

		const btn = document.createElement("button");
		btn.type = "button";
		btn.title = "复制代码";
		btn.setAttribute("aria-label", "复制代码");
		btn.innerHTML = COPY_ICON;
		btn.onclick = async (e) => {
			e.preventDefault();
			e.stopPropagation();
			// 取 code 的 textContent：shiki 高亮后仍是源码文本
			feedback(btn, await writeClipboard(pre.querySelector("code")?.textContent ?? ""));
		};

		bar.append(label, btn);
		wrap.insertBefore(bar, pre);
	};

	let queued = false;
	const scan = () => {
		queued = false;
		for (const pre of stream.querySelectorAll(".body pre[data-lang]")) attach(pre);
	};
	const schedule = () => {
		if (queued) return;
		queued = true;
		requestAnimationFrame(scan);
	};

	// 只要子节点增删：md() 重渲染会整段换掉 body，characterData 监听是浪费
	const mo = new MutationObserver(schedule);
	mo.observe(stream, { childList: true, subtree: true });
	scan();
}
