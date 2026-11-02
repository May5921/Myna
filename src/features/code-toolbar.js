// 代码块工具条：语言标签 + 复制（对齐 DSH CodeToolbar）
export function init(ctx) {
	const CSS = `
	.body pre { position: relative; }
	.codebar {
		position: absolute;
		top: 6px;
		right: 8px;
		display: flex;
		align-items: center;
		gap: 8px;
		opacity: 0;
		transition: opacity 120ms ease;
		font: 11px/1.4 var(--mono);
		color: var(--faint);
	}
	.body pre:hover .codebar { opacity: 1; }
	.codebar button {
		color: var(--dim);
		background: #fff;
		border: 1px solid var(--line);
		border-radius: 5px;
		padding: 1px 6px;
		font-size: 11px;
	}
	.codebar button:hover { color: var(--text); border-color: #d0d0d0; }
	@media (prefers-reduced-motion: reduce) { .codebar { transition: none; } }
	`;
	const style = document.createElement("style");
	style.textContent = CSS;
	document.head.append(style);

	const attach = (pre) => {
		if (pre.dataset.bar === "1") return;
		pre.dataset.bar = "1";
		const bar = document.createElement("div");
		bar.className = "codebar";

		const lang = (pre.dataset.lang || "").toLowerCase();
		const label = document.createElement("span");
		label.textContent = lang || "text";

		const btn = document.createElement("button");
		btn.type = "button";
		btn.textContent = "复制";
		btn.onclick = (e) => {
			e.preventDefault();
			e.stopPropagation();
			const text = pre.querySelector("code")?.textContent ?? "";
			navigator.clipboard?.writeText(text).then(
				() => {
					btn.textContent = "已复制";
					setTimeout(() => {
						btn.textContent = "复制";
					}, 1200);
				},
				() => {
					btn.textContent = "失败";
				},
			);
		};

		bar.append(label, btn);
		pre.append(bar);
	};

	const scan = () => {
		for (const pre of ctx.stream.querySelectorAll("pre[data-lang]")) attach(pre);
	};
	const mo = new MutationObserver(scan);
	mo.observe(ctx.stream, { childList: true, subtree: true, characterData: true });
	scan();
}
