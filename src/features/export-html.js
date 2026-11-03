// 导出会话 HTML：顶栏 28px 图标按钮（#cwd 之后）+ 底部居中 toast。
// 自注入样式与 DOM，不改 index.html / app.js / base.css / 其他 feature。
// RPC：{ type: "export_html" } -> { path }
//
// 默认落点（不传 outputPath）：pi 侧 outputPath 为相对路径
// `${APP_NAME}-session-<会话文件名去扩展名>.html`，writeFileSync 相对 CLI 进程 cwd 落盘
// = 当前工作区根目录；同名文件已存在会被静默覆盖，无提示、无后缀。
// 见 pi-coding-agent dist/core/export-html/index.js:193-199（APP_NAME 默认 "pi"）。

const TOAST_MS = 3500;
// 有按钮可点 / 是错误详情时多留一会儿，3500ms 读不完 180 字的报错
const TOAST_LONG_MS = 5000;
const MAX_ERR = 180;

const IS_ABS = (p) => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("/");

const CSS = `
.export-btn {
	width: 28px;
	height: 28px;
	border-radius: 6px;
	display: grid;
	place-items: center;
	color: var(--faint);
	flex: none;
	transition: background 120ms ease, color 120ms ease, opacity 120ms ease;
}
.export-btn:hover:not(:disabled) { background: var(--hover); color: var(--text); }
.export-btn:focus-visible { outline: 1px solid var(--faint); outline-offset: -1px; }
.export-btn:disabled { opacity: 0.45; cursor: default; }
.export-toast {
	position: fixed;
	left: 50%;
	/* composer 顶边约 96px：24px 会压在输入框上 */
	bottom: 96px;
	transform: translateX(-50%);
	/* 与 settings / extension 的 toast 同一层：高于设置遮罩(60)与扩展弹窗(100) */
	z-index: 110;
	display: flex;
	align-items: center;
	gap: 10px;
	max-width: min(560px, calc(100vw - 32px));
	padding: 8px 10px;
	background: var(--bg);
	border: 1px solid var(--line);
	border-radius: var(--radius-xl);
	box-shadow: var(--shadow-menu);
	font-size: 12.5px;
	line-height: 1.4;
	color: var(--text);
	opacity: 0;
	transition: opacity 140ms ease;
}
.export-toast.is-in { opacity: 1; }
.export-toast.is-err { color: var(--err); }
.export-toast-text {
	/* flex 项默认 min-width:auto = min-content，长路径会撑破 max-width 且省略号失效 */
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.export-toast-act {
	flex: none;
	color: var(--link);
	font-size: 12.5px;
	padding: 0 2px;
	border-radius: 4px;
}
.export-toast-act:hover { text-decoration: underline; }
.export-toast-act:focus-visible { outline: 1px solid var(--link); outline-offset: 1px; }
@media (prefers-reduced-motion: reduce) {
	.export-btn,
	.export-toast { transition: none; }
}
`;

// 文档 + 向下箭头
const ICON =
	'<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M9.2 2.2H4.4c-.6 0-1 .4-1 1v9.6c0 .6.4 1 1 1h7.2c.6 0 1-.4 1-1V5.4L9.2 2.2Z" stroke-linejoin="round"/><path d="M9.2 2.2v3.2h3.4" stroke-linejoin="round"/><path d="M8 8.3v4M6.2 10.5 8 12.3l1.8-1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function init(ctx) {
	const topbar = document.getElementById("topbar");
	if (!topbar || !ctx?.pi) return;
	if (topbar.querySelector(".export-btn")) return; // 幂等

	const style = document.createElement("style");
	style.textContent = CSS;
	document.head.append(style);

	// ---------- DOM ----------
	const btn = document.createElement("button");
	btn.type = "button";
	btn.className = "export-btn";
	btn.title = "导出会话 HTML";
	btn.setAttribute("aria-label", "导出当前会话为 HTML 文件");
	btn.innerHTML = ICON;

	const cwd = document.getElementById("cwd");
	if (cwd && cwd.parentElement === topbar) {
		cwd.insertAdjacentElement("afterend", btn);
	} else {
		const spacer = topbar.querySelector(".spacer");
		if (spacer) topbar.insertBefore(btn, spacer);
		else topbar.append(btn);
	}

	// ---------- 路径 ----------
	// export_html 不传 outputPath 时返回的是相对 CLI cwd 的裸文件名，补成绝对路径，
	// 保证 relPath 能显示 ./xxx、openPath 不依赖主进程 cwd。
	const absolute = (p) => {
		const raw = String(p ?? "");
		if (!raw) return "";
		if (IS_ABS(raw)) return raw;
		const base = String(ctx.state?.cwd || "").replace(/[\\/]+$/, "");
		return base ? `${base}/${raw.replace(/^\.?[\\/]+/, "")}` : raw;
	};

	const brief = (s) => {
		const t = String(s ?? "").replace(/\s+/g, " ").trim() || "导出失败";
		return t.length > MAX_ERR ? `${t.slice(0, MAX_ERR)}…` : t;
	};

	// ---------- toast ----------
	let toast = null;
	let toastTimer = 0;

	const closeToast = () => {
		if (toastTimer) {
			clearTimeout(toastTimer);
			toastTimer = 0;
		}
		const el = toast;
		toast = null;
		if (el) el.remove();
	};

	const showToast = (text, opts = {}) => {
		closeToast();
		const el = document.createElement("div");
		el.className = opts.error ? "export-toast is-err" : "export-toast";
		el.setAttribute("role", opts.error ? "alert" : "status");
		el.setAttribute("aria-live", opts.error ? "assertive" : "polite");

		const msg = document.createElement("span");
		msg.className = "export-toast-text";
		msg.textContent = text;
		msg.title = text;
		el.append(msg);

		if (opts.action) {
			const act = document.createElement("button");
			act.type = "button";
			act.className = "export-toast-act";
			act.textContent = opts.action.label;
			act.onclick = (ev) => {
				ev.preventDefault();
				ev.stopPropagation();
				opts.action.run();
				closeToast();
			};
			el.append(act);
		}

		el.onclick = () => closeToast();

		toast = el;
		document.body.append(el);
		requestAnimationFrame(() => el.classList.add("is-in"));
		toastTimer = setTimeout(closeToast, opts.action || opts.error ? TOAST_LONG_MS : TOAST_MS);
	};

	// ---------- 导出 ----------
	let busy = false;

	btn.onclick = async (e) => {
		e.preventDefault();
		e.stopPropagation();
		if (busy) return;

		busy = true;
		btn.disabled = true;
		btn.setAttribute("aria-busy", "true");
		btn.title = "正在导出…";

		try {
			const r = await ctx.pi.command({ type: "export_html" });
			const path = absolute(r?.path);
			if (!path) throw new Error("pi 未返回导出路径");
			const shown = ctx.relPath?.(path) || path;
			showToast(`已导出 ${shown}`, {
				action: {
					label: "打开",
					run: () => {
						try {
							ctx.pi.openPath?.(path);
						} catch {}
					},
				},
			});
		} catch (err) {
			showToast(brief(err?.message), { error: true });
		} finally {
			busy = false;
			btn.disabled = false;
			btn.removeAttribute("aria-busy");
			btn.title = "导出会话 HTML";
		}
	};
}
