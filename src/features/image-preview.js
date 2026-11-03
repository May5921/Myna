// 工具结果图片：缩略图 + 点击放大（灯箱）
// 只负责交互与样式；缩略图节点由 app.js 的 appendToolImages 生成。
// 约束：CSS 只能内联、只用第 1 节 token，不引依赖。
const LABEL = "工具结果图片";

export function init(ctx) {
	const stream = ctx?.stream;
	if (!stream) return;

	const CSS = `
.tool-imgs { display: flex; flex-wrap: wrap; gap: 8px; padding: 8px 0 2px; }
.tool-img {
	display: block; max-width: 280px; max-height: 200px;
	border: 1px solid var(--line); border-radius: var(--radius-md);
	background: var(--bg); cursor: zoom-in;
	transition: box-shadow 120ms ease;
}
.tool-img:hover { box-shadow: var(--shadow-surface); }
.tool-img:focus-visible { outline: 1px solid var(--faint); outline-offset: 1px; }

.imgbox {
	position: fixed; inset: 0; z-index: 1200;
	display: flex; align-items: center; justify-content: center;
	background: color-mix(in srgb, var(--text) 82%, transparent);
	padding: 32px; cursor: zoom-out; outline: none;
	animation: imgbox-in 120ms ease;
}
.imgbox[hidden] { display: none; }
.imgbox img {
	max-width: 100%; max-height: 100%;
	border-radius: var(--radius-md); background: var(--bg);
	box-shadow: var(--shadow-menu); cursor: default;
}
.imgbox img[hidden] { display: none; }
.imgbox-cap {
	position: absolute; left: 50%; bottom: 16px;
	transform: translateX(-50%); max-width: calc(100% - 64px);
	overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	color: color-mix(in srgb, var(--bg) 78%, transparent);
	font: 12px/1.4 var(--ui); letter-spacing: .01em;
}
@keyframes imgbox-in { from { opacity: 0 } to { opacity: 1 } }
@media (prefers-reduced-motion: reduce) {
	.imgbox { animation: none; }
	.tool-img { transition: none; }
}
`;

	if (!document.head.querySelector('style[data-feature="image-preview"]')) {
		const style = document.createElement("style");
		style.dataset.feature = "image-preview";
		style.textContent = CSS;
		document.head.append(style);
	}

	let box = null;
	let pic = null;
	let cap = null;
	let opener = null;
	let curLabel = LABEL;
	let capFixed = false;

	function ensure() {
		if (box) return;
		box = document.createElement("div");
		box.className = "imgbox";
		box.hidden = true;
		box.tabIndex = -1;
		box.setAttribute("role", "dialog");
		box.setAttribute("aria-modal", "true");
		box.setAttribute("aria-label", "图片预览");

		pic = document.createElement("img");
		pic.alt = "图片预览";
		// 尺寸必须等 load 之后才知道：lazy 缩略图上的 naturalWidth 在点击时可能还是 0
		pic.addEventListener("load", () => {
			if (capFixed || !pic.naturalWidth) return;
			cap.textContent = `${curLabel} · ${pic.naturalWidth}×${pic.naturalHeight}`;
		});
		pic.addEventListener("error", () => {
			pic.hidden = true;
			cap.textContent = "图片加载失败";
		});

		cap = document.createElement("div");
		cap.className = "imgbox-cap";
		box.append(pic, cap);
		// 只有点背景才关；点图片本身不关
		box.addEventListener("click", (e) => {
			if (e.target === box) close();
		});
		document.body.append(box);
	}

	function open(src, labelText, opts) {
		ensure();
		capFixed = !!opts?.fixed;
		opener = opts?.from || document.activeElement;
		curLabel = labelText || LABEL;
		pic.hidden = false;
		pic.alt = curLabel;
		pic.src = src;
		cap.textContent = curLabel;
		box.hidden = false;
		box.focus?.();
	}

	function close() {
		if (!box || box.hidden) return;
		box.hidden = true;
		pic.src = "";
		// 关闭后把焦点还给缩略图，键盘用户不至于掉回 body
		if (opener?.isConnected) opener.focus?.();
		opener = null;
	}

	const captionOf = (img) => (img?.dataset?.name || img?.alt || "").trim() || LABEL;

	// app.js 生成的缩略图没有可聚焦语义，这里补上键盘入口
	const stamp = (img) => {
		if (img.dataset.ip) return;
		img.dataset.ip = "1";
		img.tabIndex = 0;
		img.setAttribute("role", "button");
		img.setAttribute("aria-label", `放大图片：${captionOf(img)}`);
	};

	const scan = () => {
		for (const img of stream.querySelectorAll(".tool-img")) stamp(img);
	};

	document.addEventListener("click", (e) => {
		const img = e.target?.closest?.(".tool-img");
		if (!img) return;
		e.preventDefault();
		e.stopPropagation();
		open(img.src, captionOf(img), { from: img });
	});

	document.addEventListener(
		"keydown",
		(e) => {
			const img = e.target?.closest?.(".tool-img");
			if (img && (e.key === "Enter" || e.key === " ")) {
				e.preventDefault();
				open(img.src, captionOf(img), { from: img });
				return;
			}
			if (e.key !== "Escape" || !box || box.hidden) return;
			// 吞掉这一下，避免 app.js 的全局 Esc 顺带 abort
			e.preventDefault();
			e.stopPropagation();
			close();
		},
		true,
	);

	// 缩略图是流式追加的
	let queued = 0;
	const schedule = () => {
		if (queued) return;
		queued = requestAnimationFrame(() => {
			queued = 0;
			scan();
		});
	};
	new MutationObserver(schedule).observe(stream, { childList: true, subtree: true });
	scan();

	window.__piImageOpen = (src, label) => open(src, label, { fixed: true });
}
