// 附件：图片 + 文档（pdf/docx/pptx/xlsx/md）。图片进 prompt.images，
// 文档抽成纯文本拼进 prompt 正文（不保留排版、不做 OCR）。
// 只覆盖 ctx.attachments.get / clear，不改 submit
import { docAccept, docKind, extractDoc, isDocFile } from "../core/doc-extract.js";

const MAX_COUNT = 6;
const MAX_BYTES = 10 * 1024 * 1024; // 单张图片原始体积上限
const MAX_DOC_BYTES = 25 * 1024 * 1024; // 单个文档原始体积上限
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
	.att-plus[data-full="1"] { color: var(--faint); cursor: default; }
	.att-plus[data-full="1"]:hover { background: none; color: var(--faint); }
	.att-rail {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		padding: 2px 2px 6px;
		margin: 10px 14px 0; /* 与 #input 的左右 14px 对齐，否则缩略图比正文缩进一格 */
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
	.att-item[data-doc="1"] { width: auto; max-width: 190px; }
	.att-doc {
		display: flex;
		align-items: center;
		gap: 6px;
		height: 44px;
		padding: 0 10px 0 8px;
		border: 1px solid var(--line);
		border-radius: 6px;
		background: var(--surface-2);
		max-width: 190px;
	}
	.att-doc-kind {
		flex: none;
		font: 10px/1 var(--mono);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--faint);
	}
	.att-doc-name {
		font-size: 12px;
		color: var(--text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.att-doc-meta { flex: none; font-size: 11px; color: var(--faint); }
	.att-del {
		position: absolute;
		top: 2px;
		right: 2px;
		width: 16px;
		height: 16px;
		display: grid;
		place-items: center;
		border-radius: 50%;
		background: var(--dim);
		color: var(--bg);
		font: 11px/1 var(--mono);
		cursor: pointer;
		/* 默认不挡缩略图：hover / 键盘聚焦 / 无指针设备才显形（DSH ComposerAttachments .remove） */
		opacity: 0;
		transition: opacity 120ms ease, background-color 120ms ease;
	}
	.att-item:hover .att-del, .att-del:focus-visible { opacity: 1; }
	.att-del:hover, .att-del:focus-visible { background: var(--text); }
	.att-del:focus-visible { outline: 1px solid var(--text); outline-offset: 1px; }
	@media (hover: none) {
		.att-del { opacity: 1; }
	}
	.att-note {
		flex: 0 1 auto;
		min-width: 0;
		overflow: hidden;
		color: var(--faint);
		font: 11px/16px var(--ui);
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.att-note[hidden] { display: none; }
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

	// 文档：抽纯文本，随消息正文一起发出
	const processDoc = async (file) => {
		const r = await extractDoc(file);
		return {
			id: nextId(),
			kind: "doc",
			name: r.name,
			text: r.text,
			chars: r.chars,
			truncated: r.truncated,
		};
	};

	const rail = document.createElement("div");
	rail.className = "att-rail";
	rail.hidden = true;
	box.insertBefore(rail, input);

	// 拒绝原因必须能看见：console 里 warn 一百遍用户也不知道图为什么没加上
	const noteEl = document.createElement("span");
	noteEl.className = "att-note";
	noteEl.hidden = true;
	let noteTimer = 0;
	const flashNote = (text) => {
		noteEl.textContent = text;
		noteEl.hidden = false;
		rail.hidden = false;
		clearTimeout(noteTimer);
		noteTimer = setTimeout(() => {
			noteEl.hidden = true;
			rail.hidden = items.length === 0;
		}, 2400);
	};

	const picker = document.createElement("input");
	picker.type = "file";
	picker.accept = `image/*,${docAccept()}`;
	picker.multiple = true;
	picker.className = "att-picker";
	picker.hidden = true;
	document.body.append(picker);

	const plusBtn = document.createElement("button");
	plusBtn.type = "button";
	plusBtn.className = "att-plus";
	plusBtn.title = "添加图片或文档";
	plusBtn.setAttribute("aria-label", "添加图片或文档");
	plusBtn.innerHTML =
		'<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 3.5v9M3.5 8h9" stroke-linecap="round" /></svg>';
	bar.insertBefore(plusBtn, bar.firstElementChild);

	const syncPlus = () => {
		const full = items.length >= MAX_COUNT;
		plusBtn.dataset.full = full ? "1" : "0";
		plusBtn.disabled = full; // 达上限就是禁用态，不能点了没反应
		const label = full ? `最多 ${MAX_COUNT} 个附件` : "添加图片或文档";
		plusBtn.title = label;
		plusBtn.setAttribute("aria-label", label);
	};

	// app.js 的 updateSend 只在 input 事件里跑：图加减 / 清空后补一次，让「只有图片」也点亮发送键
	const notifyInput = () => input.dispatchEvent(new Event("input", { bubbles: true }));

	const render = () => {
		rail.replaceChildren();
		for (const it of items) {
			const wrap = document.createElement("div");
			wrap.className = "att-item";

			let thumb;
			if (it.kind === "doc") {
				wrap.dataset.doc = "1";
				thumb = document.createElement("div");
				thumb.className = "att-doc";
				const kind = document.createElement("span");
				kind.className = "att-doc-kind";
				const ext = docKind(it.name);
				kind.textContent = ext === "markdown" ? "md" : ext || "doc";
				const nm = document.createElement("span");
				nm.className = "att-doc-name";
				nm.textContent = it.name;
				const meta = document.createElement("span");
				meta.className = "att-doc-meta";
				const size = it.chars < 1000 ? `${it.chars} 字` : `${(it.chars / 1000).toFixed(1)}k 字`;
				meta.textContent = it.truncated ? `${size}（已截断）` : size;
				thumb.append(kind, nm, meta);
			} else {
				thumb = document.createElement("img");
				thumb.className = "att-thumb";
				thumb.src = it.url;
				thumb.alt = it.name;
				thumb.draggable = false;
			}

			const del = document.createElement("button");
			del.type = "button";
			del.className = "att-del";
			del.textContent = "×";
			del.title = "删除";
			del.setAttribute("aria-label", `删除附件 ${it.name}`);
			del.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				const at = items.findIndex((x) => x.id === it.id);
				items = items.filter((x) => x.id !== it.id);
				render();
				notifyInput();
				// render 重建了整条 rail，按钮已从文档里消失 → 焦点会掉到 body，手动还给邻居
				const btns = rail.querySelectorAll(".att-del");
				const next = at >= 0 && btns[at] ? btns[at] : plusBtn;
				next.focus({ preventScroll: true });
			});

			wrap.append(thumb, del);
			rail.append(wrap);
		}
		rail.append(noteEl);
		rail.hidden = items.length === 0 && noteEl.hidden;
		syncPlus();
	};

	const isImage = (f) => Boolean(f) && typeof f.type === "string" && f.type.startsWith("image/");

	const addFiles = (files) => {
		const all = Array.from(files || []);
		const imgs = all.filter(isImage);
		const docs = all.filter(isDocFile);
		const list = [...imgs, ...docs];
		const unsupported = all.length - list.length;
		if (!list.length) {
			if (all.length) {
				console.warn("[attachments] 不支持的文件类型，已忽略", all.length, "个");
				flashNote("只支持图片和 PDF / Word / PPT / Excel / Markdown");
			}
			return;
		}
		const skipped = [];
		if (unsupported > 0) {
			console.warn("[attachments] 忽略不支持的文件", unsupported, "个");
			skipped.push("有文件类型不支持");
		}
		for (const f of list) {
			const doc = isDocFile(f);
			if (items.length + pending >= MAX_COUNT) {
				console.warn(`[attachments] 最多 ${MAX_COUNT} 个附件，已忽略`, f.name || f.type);
				skipped.push(`最多 ${MAX_COUNT} 个附件`);
				continue;
			}
			const limit = doc ? MAX_DOC_BYTES : MAX_BYTES;
			if (f.size > limit) {
				console.warn("[attachments] 文件超过上限，已忽略", f.name || f.type, f.size);
				skipped.push(`${doc ? "文档" : "图片"}不能超过 ${Math.round(limit / 1024 / 1024)}MB`);
				continue;
			}
			pending++;
			const myGen = gen;
			chain = chain
				.then(() => (doc ? processDoc(f) : processFile(f)))
				.then((item) => {
					if (myGen !== gen) return; // 期间已被 clear，丢弃
					items.push(item);
					render();
					notifyInput();
				})
				.catch((e) => {
					console.warn("[attachments] 处理失败", f.name || f.type, e?.message || e);
					// 解析失败必须让用户看见，不能只进 console
					flashNote(`${f.name || "文件"}：${e?.message || "处理失败"}`);
				})
				.finally(() => {
					pending--;
				});
		}
		if (skipped.length) {
			flashNote(skipped.length > 1 ? `${skipped[0]}（已忽略 ${skipped.length} 项）` : skipped[0]);
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
	const atLimit = () => items.length + pending >= MAX_COUNT;
	box.addEventListener("dragover", (e) => {
		if (!hasFilePayload(e.dataTransfer)) return;
		e.preventDefault();
		const full = atLimit();
		try {
			// 满额就别给「可放下」的加号光标：dropEffect=none 是浏览器的拒绝态
			e.dataTransfer.dropEffect = full ? "none" : "copy";
		} catch {}
		box.classList.toggle("att-drop", !full);
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
	// 完整项返回：气泡渲染要用 url/name，发给 pi 时再由调用方剥成 {type,data,mimeType}
	ctx.attachments.get = () => items.map((it) => ({ ...it }));
	ctx.attachments.clear = () => {
		gen++;
		items = [];
		picker.value = "";
		render();
		notifyInput();
	};
	// 队列接管：把 rail 上已解码的图整体取走（DSH 的 admit 语义——附件随消息走，不留在编辑器里）
	ctx.attachments.take = () => {
		const out = items;
		ctx.attachments.clear();
		return out;
	};
	// 出队/失败回滚时把图放回 rail；gen++ 让还在解码的旧图作废，避免混进新一批
	ctx.attachments.set = (list) => {
		if (!Array.isArray(list) || !list.length) return;
		gen++;
		items = list.map((it) => ({ ...it, id: nextId() }));
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

	// 测试用：取当前附件队列的完整快照（验证气泡渲染所需的 url/name 没被丢）
	window.__piAttachSnapshot = () => ctx.attachments.get();

	// 演示/截图之间清场用
	window.__piAttachClear = () => {
		ctx.attachments.clear();
	};

	render();
}
