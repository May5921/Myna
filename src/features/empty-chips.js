// 空状态提示：输入框下方的「选择项目 / 模型」chip（对齐 Codex 新对话）
export function init(ctx) {
	const input = ctx?.input;
	const stream = ctx?.stream;
	const composer = input?.closest("#composer");
	if (!input || !stream || !composer) return;

	const CSS = `
	.empty-chips {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		margin-top: 10px;
	}
	.empty-chips[hidden] { display: none; }
	.empty-chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 28px;
		padding: 0 10px;
		border-radius: 8px;
		font-size: 12.5px;
		color: var(--dim);
		transition: background-color 120ms ease, color 120ms ease;
	}
	.empty-chip:hover {
		background: var(--hover);
		color: var(--text);
	}
	.empty-chip svg { color: var(--faint); }
	@media (prefers-reduced-motion: reduce) {
		.empty-chip { transition: none; }
	}
	`;
	const style = document.createElement("style");
	style.dataset.feature = "empty-chips";
	style.textContent = CSS;
	document.head.append(style);

	const FOLDER_ICON =
		'<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1.8 4.2c0-.5.4-.9.9-.9h3l1.3 1.5h6.3c.5 0 .9.4.9.9v5.9c0 .5-.4.9-.9.9H2.7c-.5 0-.9-.4-.9-.9V4.2Z" stroke-linejoin="round"/></svg>';

	const chip = (label, icon, onClick) => {
		const b = document.createElement("button");
		b.type = "button";
		b.className = "empty-chip";
		b.innerHTML = icon;
		const text = document.createElement("span");
		text.textContent = label;
		b.append(text);
		b.onclick = onClick;
		return b;
	};

	const wrap = document.createElement("div");
	wrap.className = "empty-chips";
	wrap.hidden = true;
	wrap.append(chip("选择项目", FOLDER_ICON, () => document.getElementById("cwd")?.click()));
	composer.append(wrap);

	const sync = () => {
		wrap.hidden = !!stream.querySelector(".row");
	};
	new MutationObserver(sync).observe(stream, { childList: true, subtree: true });
	sync();
}
