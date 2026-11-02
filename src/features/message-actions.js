// 消息操作：悬停出现复制按钮（对齐 DSH ui-chat 的 message actions）
export function init(ctx) {
	const CSS = `
	.row { position: relative; }
	.acts {
		position: absolute;
		top: 2px;
		right: -30px;
		display: flex;
		flex-direction: column;
		gap: 2px;
		opacity: 0;
		transition: opacity 120ms ease;
	}
	.row:hover .acts, .acts:focus-within { opacity: 1; }
	.acts button {
		width: 22px;
		height: 22px;
		border-radius: 5px;
		display: grid;
		place-items: center;
		color: var(--faint);
	}
	.acts button:hover { background: var(--hover); color: var(--text); }
	@media (prefers-reduced-motion: reduce) { .acts { transition: none; } }
	`;
	const style = document.createElement("style");
	style.textContent = CSS;
	document.head.append(style);

	const COPY_ICON =
		'<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="5.5" y="5.5" width="8" height="8" rx="1.6"/><path d="M10.5 5.5V3.6c0-.6-.4-1-1-1H3.6c-.6 0-1 .4-1 1v5.9c0 .6.4 1 1 1h1.9" stroke-linejoin="round"/></svg>';

	const attach = (row) => {
		if (row.querySelector(":scope > .acts")) return;
		const acts = document.createElement("div");
		acts.className = "acts";
		const copy = document.createElement("button");
		copy.type = "button";
		copy.title = "复制";
		copy.innerHTML = COPY_ICON;
		copy.onclick = (e) => {
			e.preventDefault();
			e.stopPropagation();
			const text = row.querySelector(".body")?.innerText ?? row.innerText ?? "";
			navigator.clipboard?.writeText(text.trim()).then(
				() => {
					copy.style.color = "#2f7a55";
					setTimeout(() => {
						copy.style.color = "";
					}, 900);
				},
				() => {
					copy.style.color = "var(--err)";
				},
			);
		};
		acts.append(copy);
		row.append(acts);
	};

	const scan = () => {
		for (const row of ctx.stream.querySelectorAll(".row")) attach(row);
	};
	const mo = new MutationObserver(scan);
	mo.observe(ctx.stream, { childList: true, subtree: true });
	scan();
}
