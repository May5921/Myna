// 新版本提示：启动后查一次 GitHub 最新 release（24h 缓存），有新版就在侧栏底部留一行入口。
// 下载由用户点按触发；下载完成必须通过 SHA256 校验才会执行安装包。
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
	.upd-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--accent, #2f6fed); }
	.upd-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.upd-ver { font-family: var(--mono); color: var(--text); }
	.upd-close {
		flex: none; width: 18px; height: 18px; display: grid; place-items: center;
		border-radius: 50%; color: var(--faint); font-size: 13px; line-height: 1;
	}
	.upd-close:hover { background: var(--line); color: var(--text); }

	.upd-back {
		position: fixed; inset: 0; z-index: 1300;
		display: flex; align-items: flex-start; justify-content: center;
		padding: min(12vh, 100px) 16px 24px;
		background: rgba(0, 0, 0, 0.28);
	}
	.upd-back[hidden] { display: none; }
	.upd-dialog {
		width: min(520px, 100%);
		max-height: min(70vh, 640px);
		display: flex; flex-direction: column;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-menu);
		overflow: hidden;
	}
	.upd-head { display: flex; align-items: baseline; gap: 8px; padding: 16px 18px 8px; }
	.upd-title { font-size: 16px; font-weight: 600; color: var(--text); }
	.upd-sub { font-size: 12px; color: var(--faint); }
	.upd-body { padding: 0 18px 12px; overflow: auto; font-size: 12.5px; line-height: 1.6; color: var(--dim); white-space: pre-wrap; }
	.upd-status { padding: 0 18px 10px; font-size: 12px; color: var(--faint); min-height: 18px; }
	.upd-status.err { color: var(--err); }
	.upd-bar { height: 4px; margin: 0 18px 12px; border-radius: 999px; background: var(--line); overflow: hidden; }
	.upd-bar[hidden] { display: none; }
	.upd-bar > i { display: block; height: 100%; width: 0; background: var(--accent, #2f6fed); transition: width 120ms ease; }
	.upd-actions { display: flex; gap: 8px; justify-content: flex-end; padding: 12px 18px 16px; border-top: 1px solid var(--line); }
	.upd-btn {
		height: 30px; padding: 0 12px; border: 1px solid var(--line-strong);
		border-radius: 7px; background: var(--bg); color: var(--text); font-size: 12.5px; cursor: pointer;
	}
	.upd-btn:hover:not(:disabled) { background: var(--hover); }
	.upd-btn.primary { background: var(--text); color: var(--bg); border-color: var(--text); }
	.upd-btn.primary:hover:not(:disabled) { opacity: 0.88; }
	.upd-btn:disabled { opacity: 0.5; cursor: default; }
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
	let overlay = null;
	let statusEl = null;
	let barEl = null;
	let primary = null;
	let secondary = null;
	let downloaded = null;
	let busy = false;

	const setStatus = (msg, isErr = false) => {
		if (!statusEl) return;
		statusEl.textContent = msg || "";
		statusEl.classList.toggle("err", Boolean(isErr));
	};

	const render = () => {
		if (!info?.newer) return;
		let skipped = "";
		try {
			skipped = localStorage.getItem("myna.update.skip") || "";
		} catch {}
		if (skipped === info.latest) return;
		text.replaceChildren();
		text.append("有新版本 ");
		const v = document.createElement("span");
		v.className = "upd-ver";
		v.textContent = `v${info.latest}`;
		text.append(v);
		btn.title = `当前 v${info.current}，点击查看更新`;
		btn.hidden = false;
	};

	const closeDialog = () => {
		if (!overlay) return;
		overlay.hidden = true;
	};

	const buildDialog = () => {
		if (overlay) return;
		overlay = document.createElement("div");
		overlay.className = "upd-back";
		overlay.hidden = true;
		overlay.setAttribute("role", "dialog");
		overlay.setAttribute("aria-modal", "true");
		overlay.setAttribute("aria-label", "Myna 更新");

		const dialog = document.createElement("div");
		dialog.className = "upd-dialog";
		const head = document.createElement("div");
		head.className = "upd-head";
		const title = document.createElement("span");
		title.className = "upd-title";
		title.textContent = `Myna v${info?.latest || ""}`;
		const sub = document.createElement("span");
		sub.className = "upd-sub";
		sub.textContent = "更新会关闭当前窗口并启动安装程序";
		head.append(title, sub);

		const body = document.createElement("div");
		body.className = "upd-body";
		body.textContent = info?.notes || "这个版本没有附发布说明。";
		statusEl = document.createElement("div");
		statusEl.className = "upd-status";
		barEl = document.createElement("div");
		barEl.className = "upd-bar";
		barEl.hidden = true;
		barEl.append(document.createElement("i"));
		const actions = document.createElement("div");
		actions.className = "upd-actions";

		secondary = document.createElement("button");
		secondary.type = "button";
		secondary.className = "upd-btn";
		secondary.textContent = "打开发布页";
		secondary.onclick = () => info?.url && ctx.pi.openExternal(info.url);
		const later = document.createElement("button");
		later.type = "button";
		later.className = "upd-btn";
		later.textContent = "稍后";
		later.onclick = closeDialog;
		primary = document.createElement("button");
		primary.type = "button";
		primary.className = "upd-btn primary";
		primary.onclick = () => void runPrimary();
		actions.append(secondary, later, primary);

		dialog.append(head, body, statusEl, barEl, actions);
		overlay.append(dialog);
		overlay.addEventListener("click", (e) => {
			if (e.target === overlay) closeDialog();
		});
		document.body.append(overlay);
	};

	const runPrimary = async () => {
		if (busy) return;
		if (downloaded) {
			busy = true;
			primary.disabled = true;
			setStatus("正在启动安装程序…");
			try {
				await window.pi.installUpdate(downloaded);
			} catch (e) {
				setStatus(e?.message || "安装程序启动失败", true);
				busy = false;
				primary.disabled = false;
			}
			return;
		}
		if (!info?.installer?.url || !info?.checksum?.url) {
			setStatus("这个发布缺少安装包或 SHA256 校验文件，请手动从发布页下载。", true);
			return;
		}
		busy = true;
		primary.disabled = true;
		secondary.disabled = true;
		setStatus("准备下载…");
		barEl.hidden = false;
		try {
			const r = await window.pi.downloadUpdate(info);
			downloaded = r.path;
			setStatus(`下载完成，SHA256 校验通过。`);
			barEl.querySelector("i").style.width = "100%";
			primary.textContent = "重启并安装";
		} catch (e) {
			setStatus(e?.message || "更新下载失败", true);
			barEl.hidden = true;
			primary.disabled = false;
			secondary.disabled = false;
		} finally {
			busy = false;
		}
	};

	const openDialog = async () => {
		if (!info?.newer) return;
		// 旧缓存可能只有版本号，没有 installer/checksum；打开时强制刷新一次
		if (!info.installer?.url || !info.checksum?.url) {
			try {
				const fresh = await window.pi.checkUpdate(true);
				if (fresh?.newer) {
					info = fresh;
					if (overlay) {
						overlay.remove();
						overlay = null;
					}
				}
			} catch {}
		}
		buildDialog();
		// 每次打开按当前状态重置按钮，但保留已下载结果
		primary.textContent = downloaded ? "重启并安装" : "下载并安装";
		primary.disabled = false;
		secondary.disabled = false;
		primary.hidden = false;
		barEl.hidden = !downloaded;
		setStatus(downloaded ? "下载完成，SHA256 校验通过。" : "下载后会自动校验 SHA256。");
		overlay.hidden = false;
		primary.focus?.();
	};

	btn.addEventListener("click", (e) => {
		if (e.target === close) return;
		openDialog();
	});
	btn.addEventListener("keydown", (e) => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			openDialog();
		}
	});
	close.addEventListener("click", (e) => {
		e.stopPropagation();
		try {
			localStorage.setItem("myna.update.skip", info?.latest || "");
		} catch {}
		btn.hidden = true;
	});

	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && overlay && !overlay.hidden) closeDialog();
	});

	try {
		window.pi.onUpdateProgress?.((p) => {
			if (!statusEl || !barEl) return;
			if (p.phase === "download") {
				barEl.hidden = false;
				barEl.querySelector("i").style.width = `${p.percent || 0}%`;
				setStatus(`下载中… ${p.percent || 0}%（${Math.round((p.received || 0) / 1048576)} MB）`);
			} else if (p.phase === "verify") {
				setStatus("下载完成，正在校验 SHA256…");
			} else if (p.phase === "ready") {
				setStatus("SHA256 校验通过。");
			} else if (p.phase === "error") {
				setStatus(p.message || "更新失败", true);
			}
		});
	} catch {}

	// 启动不抢带宽：等历史画完、pi 起来之后再查
	setTimeout(async () => {
		try {
			info = await window.pi.checkUpdate(false);
			render();
		} catch {}
	}, 4000);
}
