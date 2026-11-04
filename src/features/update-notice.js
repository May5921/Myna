// 新版本提示：启动后查一次 GitHub 最新 release（带 24h 缓存），有新版就在侧栏底部留一行入口。
// 只提示、不自动下载——未签名的静默更新容易被杀毒软件当成可疑行为。
export function init(ctx) {
	const side = document.getElementById("side");
	if (!side || side.querySelector(".upd")) return; // 幂等

	const CSS = `
	.upd {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 6px 10px 12px;
		padding: 7px 9px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--surface-2);
		font-size: 12px;
		color: var(--dim);
		cursor: pointer;
		text-align: left;
	}
	.upd[hidden] { display: none; }
	.upd:hover { background: var(--hover); color: var(--text); }
	.upd-dot {
		flex: none;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--accent, #2f6fed);
	}
	.upd-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.upd-ver { font-family: var(--mono); color: var(--text); }
	.upd-close {
		flex: none;
		width: 18px;
		height: 18px;
		display: grid;
		place-items: center;
		border-radius: 50%;
		color: var(--faint);
		font-size: 13px;
		line-height: 1;
	}
	.upd-close:hover { background: var(--line); color: var(--text); }
	`;

	const style = document.createElement("style");
	style.textContent = CSS;
	document.head.append(style);

	const btn = document.createElement("div");
	btn.className = "upd";
	btn.hidden = true;
	btn.setAttribute("role", "button");
	btn.tabIndex = 0;

	const dot = document.createElement("span");
	dot.className = "upd-dot";
	const text = document.createElement("span");
	text.className = "upd-text";
	const close = document.createElement("button");
	close.type = "button";
	close.className = "upd-close";
	close.textContent = "×";
	close.title = "忽略这个版本";
	btn.append(dot, text, close);
	side.append(btn);

	let info = null;

	const open = () => {
		if (!info?.url) return;
		window.pi.openExternal(info.url);
	};

	btn.addEventListener("click", (e) => {
		if (e.target === close) return;
		open();
	});
	btn.addEventListener("keydown", (e) => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			open();
		}
	});
	close.addEventListener("click", (e) => {
		e.stopPropagation();
		// 记下被忽略的版本，同一个版本不再打扰
		try {
			localStorage.setItem("myna.update.skip", info?.latest || "");
		} catch {}
		btn.hidden = true;
	});

	const render = () => {
		if (!info?.newer) return;
		let skipped = "";
		try {
			skipped = localStorage.getItem("myna.update.skip") || "";
		} catch {}
		if (skipped === info.latest) return;
		text.textContent = "";
		text.append("有新版本 ");
		const v = document.createElement("span");
		v.className = "upd-ver";
		v.textContent = `v${info.latest}`;
		text.append(v);
		btn.title = `当前 v${info.current}，点击打开发布页`;
		btn.hidden = false;
	};

	// 启动不抢带宽：等历史画完、pi 起来之后再查
	setTimeout(async () => {
		try {
			info = await window.pi.checkUpdate(false);
			render();
		} catch {}
	}, 4000);
}
