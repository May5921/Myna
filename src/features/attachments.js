// 图片附件：粘贴 / 拖拽 / 点击选择，交给共享桥 ctx.attachments，由 app.js 塞进 prompt.images
// 只覆盖 ctx.attachments.get / clear，不改 submit
const MAX_COUNT = 6;
const MAX_BYTES = 10 * 1024 * 1024; // 单张原始体积上限
const MAX_EDGE = 1600; // 最长边上限
const JPEG_QUALITY = 0.85;

export function init(ctx) {
	const input = ctx?.input;
	const composer = document.getElementById("composer");
	const box = composer?.querySelector(".box");
	const bar = box?.querySelector(".cbar");
	if (!input || !box || !bar || !ctx?.attachments) return;
	if (box.querySelector(".att-rail")) return; // 幂等

	const CSS = `
	.att-plus {
		flex: none;
		width: 28px;
		height: 28px;
		display: grid;
		place-items: center;
		border-radius: 50%;
		color: var(--dim);
		transition: background-color 120ms ease, color 120ms ease;
	}
	.att-plus:hover { background: var(--hover); color: var(--text); }
	.att-plus[data-full="1"] { color: var(--faint); }
	.att-rail {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		padding: 2px 2px 6px;
		margin: 10px 12px 0;
	}
	.att-rail[hidden], .att-rail:empty { display: none; }
	.att-item { position: relative; flex: none; width: 44px; height: 44px; }
	.att-thumb {
		display: block;
		width: 44px;
		height: 44px;
		object-fit: cover;
		border: 1px solid var(--line);
		border-radius: 6px;
		background: var(--hover);
	}
	.att-del {
		position: absolute;
		top: -5px;
		right: -5px;
		width: 16px;
		height: 16px;
		display: grid;
		place-items: center;
		border-radius: 50%;
		background: rgba(0, 0, 0, 0.55);
		color: #fff;
		font: 11px/1 var(--mono);
		transition: background-color 120ms ease;
	}
	.att-del:hover, .att-del:focus-visible { background: rgba(0, 0, 0, 0.82); }
	.att-del:focus-visible { outline: 1px solid var(--text); outline-offset: 1px; }
	.box.att-drop { border-color: var(--dim); background: var(--hover); }
	@media (prefers-reduced-motion: reduce) {
		.att-plus, .att-del { transition: none; }
	}
	`;
	const style = document.createElement("style");
	style.id = "att-style";
	style.textContent = CSS;
	document.head.append(style);

	let items = [];
	let pending = 0; // 处理中的名额
	let chain = Promise.resolve();
	let seq = 0;
	let gen = 0; // clear 后丢弃还在解码的旧图，避免发送后突然冒出附件

	const nextId = () => `att-${Date.now().toString(36)}-${(seq++).toString(36)}`;

	const base64Bytes = (b64) => {
		const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
		return Math.floor((b64.length * 3) / 4) - pad;
	};

	const readAsDataURL = (file) =>
		new Promise((resolve, reject) => {
			const fr = new FileReader();
			fr.onload = () => resolve(String(fr.result || ""));
			fr.onerror = () => reject(fr.error || new Error("读取失败"));
			fr.readAsDataURL(file);
		});

	const decodeImage = (src) =>
		new Promise((resolve, reject) => {
			const img = new Image();
			img.onload = () => resolve(img);
			img.onerror = () => reject(new Error("图片解码失败"));
			img.src = src;
		});

	// 只对 PNG 查透明度；换句话说：透明 PNG 保 PNG，其余一律 JPEG 0.85
	const hasAlpha = (g, w, h) => {
		try {
			const px = g.getImageData(0, 0, w, h).data;
			for (let i = 3; i < px.length; i += 4) {
				if (px[i] < 255) return true;
			}
			return false;
		} catch {
			return true; // 取不到像素时保守保留 PNG
		}
	};

	const processFile = async (file) => {
		const dataURL = await readAsDataURL(file);
		const img = await decodeImage(dataURL);
		const natW = img.naturalWidth || img.width;
		const natH = img.naturalHeight || img.height;
		if (!natW || !natH) throw new Error("空图片");

		const scale = Math.min(1, MAX_EDGE / Math.max(natW, natH));
		const w = Math.max(1, Math.round(natW * scale));
		const h = Math.max(1, Math.round(natH * scale));

		const cv = document.createElement("canvas");
		cv.width = w;
		cv.height = h;
		const g = cv.getContext("2d");
		if (!g) throw new Error("canvas 不可用");
		g.drawImage(img, 0, 0, w, h);

		const transparentPng = file.type === "image/png" && hasAlpha(g, w, h);
		const mimeType = transparentPng ? "image/png" : "image/jpeg";
		const out = cv.toDataURL(mimeType, JPEG_QUALITY);
		const data = out.slice(out.indexOf(",") + 1);

		return {
			id: nextId(),
			data,
			mimeType,
			url: `data:${mimeType};base64,${data}`,
			name: file.name || "剪贴板图片",
			w,
			h,
			bytes: base64Bytes(data),
		};
	};

	const rail = document.createElement("div");
	rail.className = "att-rail";
	rail.hidden = true;
	box.insertBefore(rail, input);

	const picker = document.createElement("input");
	picker.type = "file";
	picker.accept = "image/*";
	picker.multiple = true;
	picker.className = "att-picker";
	picker.hidden = true;
	document.body.append(picker);

	const plusBtn = document.createElement("button");
	plusBtn.type = "button";
	plusBtn.className = "att-plus";
	plusBtn.title = "添加图片";
	plusBtn.setAttribute("aria-label", "添加图片");
	plusBtn.innerHTML =
		'<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 3.5v9M3.5 8h9" stroke-linecap="round" /></svg>';
	bar.insertBefore(plusBtn, bar.firstElementChild);

	const syncPlus = () => {
		const full = items.length >= MAX_COUNT;
		plusBtn.dataset.full = full ? "1" : "0";
		plusBtn.title = full ? `最多 ${MAX_COUNT} 张图片` : "添加图片";
	};

	// app.js 的 updateSend 只在 input 事件里跑：图加减 / 清空后补一次，让「只有图片」也点亮发送键
	const notifyInput = () => input.dispatchEvent(new Event("input", { bubbles: true }));

	const render = () => {
		rail.replaceChildren();
		for (const it of items) {
			const wrap = document.createElement("div");
			wrap.className = "att-item";

			const img = document.createElement("img");
			img.className = "att-thumb";
			img.src = it.url;
			img.alt = it.name;
			img.draggable = false;

			const del = document.createElement("button");
			del.type = "button";
			del.className = "att-del";
			del.textContent = "×";
			del.title = "删除";
			del.setAttribute("aria-label", `删除图片 ${it.name}`);
			del.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				items = items.filter((x) => x.id !== it.id);
				render();
				notifyInput();
			});

			wrap.append(img, del);
			rail.append(wrap);
		}
		rail.hidden = items.length === 0;
		syncPlus();
	};

	const isImage = (f) => Boolean(f) && typeof f.type === "string" && f.type.startsWith("image/");

	const addFiles = (files) => {
		const all = Array.from(files || []);
		const list = all.filter(isImage);
		if (!list.length) {
			if (all.length) console.warn("[attachments] 只接受 image/*，已忽略", all.length, "个文件");
			return;
		}
		if (list.length < all.length) {
			console.warn("[attachments] 忽略非图片文件", all.length - list.length, "个");
		}
		for (const f of list) {
			if (items.length + pending >= MAX_COUNT) {
				console.warn(`[attachments] 最多 ${MAX_COUNT} 张，已忽略`, f.name || f.type);
				continue;
			}
			if (f.size > MAX_BYTES) {
				console.warn("[attachments] 单张不能超过 10MB，已忽略", f.name || f.type, f.size);
				continue;
			}
			pending++;
			const myGen = gen;
			chain = chain
				.then(() => processFile(f))
				.then((item) => {
					if (myGen !== gen) return; // 期间已被 clear，丢弃
					items.push(item);
					render();
					notifyInput();
				})
				.catch((e) => console.warn("[attachments] 处理失败", f.name || f.type, e?.message || e))
				.finally(() => {
					pending--;
				});
		}
	};

	const filesFromClipboard = (cd) => {
		const out = [];
		for (const f of cd.files || []) if (isImage(f)) out.push(f);
		if (!out.length) {
			for (const it of cd.items || []) {
				if (it.kind !== "file" || typeof it.type !== "string" || !it.type.startsWith("image/")) continue;
				const f = it.getAsFile();
				if (f) out.push(f);
			}
		}
		return out;
	};

	// ---------- 入口 1：+ 按钮 ----------
	plusBtn.addEventListener("click", (e) => {
		e.preventDefault();
		e.stopPropagation();
		if (items.length >= MAX_COUNT) {
			console.warn(`[attachments] 最多 ${MAX_COUNT} 张`);
			return;
		}
		picker.click();
	});
	picker.addEventListener("change", () => {
		const files = Array.from(picker.files || []);
		picker.value = ""; // 允许再次选同一张
		addFiles(files);
	});

	// ---------- 入口 2：粘贴（捕获，避免 textarea 自己处理）----------
	composer.addEventListener(
		"paste",
		(e) => {
			const cd = e.clipboardData;
			if (!cd) return;
			const files = filesFromClipboard(cd);
			if (!files.length) return;
			e.preventDefault();
			addFiles(files);
		},
		true,
	);

	// ---------- 入口 3：拖拽到 .box ----------
	const hasFilePayload = (dt) => Boolean(dt) && Array.from(dt.types || []).includes("Files");
	box.addEventListener("dragover", (e) => {
		if (!hasFilePayload(e.dataTransfer)) return;
		e.preventDefault();
		try {
			e.dataTransfer.dropEffect = "copy";
		} catch {}
		box.classList.add("att-drop");
	});
	box.addEventListener("dragleave", (e) => {
		if (!box.contains(e.relatedTarget)) box.classList.remove("att-drop");
	});
	box.addEventListener("drop", (e) => {
		if (!hasFilePayload(e.dataTransfer)) return;
		e.preventDefault();
		box.classList.remove("att-drop");
		addFiles(e.dataTransfer.files);
	});

	// ---------- 共享桥 ----------
	ctx.attachments.get = () => items.map((it) => ({ type: "image", data: it.data, mimeType: it.mimeType }));
	ctx.attachments.clear = () => {
		gen++;
		items = [];
		picker.value = "";
		render();
		notifyInput();
	};

	// ---------- 开发钩子：截图验证用，不自动发送 ----------
	window.__piAttachDemo = async () => {
		const cv = document.createElement("canvas");
		cv.width = 120;
		cv.height = 80;
		const g = cv.getContext("2d");
		if (!g) return null;
		g.fillStyle = "#ededed";
		g.fillRect(0, 0, 120, 80);
		g.fillStyle = "#1a1c1f";
		g.fillRect(10, 10, 100, 2);
		g.font = "13px monospace";
		g.fillText("pi", 12, 40);
		g.fillRect(12, 52, 56, 1);
		const blob = await new Promise((resolve) => cv.toBlob(resolve, "image/png"));
		if (!blob) return null;
		const file = new File([blob], "demo.png", { type: "image/png" });
		addFiles([file]);
		await chain;
		return items.length;
	};

	// 演示/截图之间清场用
	window.__piAttachClear = () => {
		ctx.attachments.clear();
	};

	render();
}
