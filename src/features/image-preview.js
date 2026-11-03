// 工具结果图片：缩略图 + 点击放大（灯光箱）
// 只负责交互与样式；缩略图节点由 app.js 的 appendToolImages 生成。
export function init(ctx) {
	const CSS = `
.tool-imgs { display: flex; flex-wrap: wrap; gap: 8px; padding: 8px 0 2px; }
.tool-img {
	display: block; max-width: 280px; max-height: 200px;
	border: 1px solid var(--line); border-radius: 8px;
	background: #fff; cursor: zoom-in;
	transition: box-shadow 120ms ease;
}
.tool-img:hover { box-shadow: 0 2px 10px rgba(0,0,0,.1); }

.imgbox {
	position: fixed; inset: 0; z-index: 1200;
	display: flex; align-items: center; justify-content: center;
	background: rgba(20,20,22,.82); padding: 32px;
	cursor: zoom-out; animation: imgbox-in 120ms ease;
}
.imgbox[hidden] { display: none; }
.imgbox img {
	max-width: 100%; max-height: 100%;
	border-radius: 8px; background: #fff;
	box-shadow: 0 24px 80px rgba(0,0,0,.45);
}
.imgbox-cap {
	position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%);
	color: rgba(255,255,255,.72); font: 12px/1.4 var(--ui);
	letter-spacing: .01em; white-space: nowrap;
}
@keyframes imgbox-in { from { opacity: 0 } to { opacity: 1 } }
`;
	const style = document.createElement("style");
	style.textContent = CSS;
	document.head.append(style);

	let box = null;
	let pic = null;
	let cap = null;

	function ensure() {
		if (box) return;
		box = document.createElement("div");
		box.className = "imgbox";
		box.hidden = true;
		box.setAttribute("role", "dialog");
		box.setAttribute("aria-label", "图片预览");
		pic = document.createElement("img");
		pic.alt = "图片预览";
		cap = document.createElement("div");
		cap.className = "imgbox-cap";
		box.append(pic, cap);
		document.body.append(box);
		box.addEventListener("click", close);
	}

	function open(src, label) {
		ensure();
		pic.src = src;
		cap.textContent = label || "";
		box.hidden = false;
	}

	function close() {
		if (!box || box.hidden) return;
		box.hidden = true;
		pic.src = "";
	}

	document.addEventListener("click", (e) => {
		const img = e.target?.closest?.(".tool-img");
		if (!img) return;
		e.preventDefault();
		e.stopPropagation();
		const size = img.naturalWidth && img.naturalHeight ? ` · ${img.naturalWidth}×${img.naturalHeight}` : "";
		open(img.src, `${img.dataset.name || "工具结果图片"}${size}`);
	});

	document.addEventListener(
		"keydown",
		(e) => {
			if (e.key !== "Escape" || !box || box.hidden) return;
			// 吞掉这一下，避免 app.js 的全局 Esc 顺带 abort
			e.preventDefault();
			e.stopPropagation();
			close();
		},
		true,
	);

	window.__piImageOpen = (src, label) => open(src, label);
}
