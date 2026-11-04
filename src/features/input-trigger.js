// 输入内联建议：@ 文件引用 + / 命令
// 交互语义对齐 pi TUI 的 CombinedAutocompleteProvider（pi-tui/dist/autocomplete.js）：
//   / 命令：仅首行、尚未输入空格时触发，插入 "/name "
//   @ 文件：token 以 @ 开头时触发；文件插入 "@path "，目录插入 "@dir/"（保持弹层，继续补全下一级）
//   路径含空格或用户已输入 @" 时插入 @"..."
// 文件索引走主进程 pi:list-files，命令列表走 pi RPC get_commands。
export function init(ctx) {
	const input = ctx.input;
	if (!input) return;

	const pi = ctx.pi || {};
	const FILE_TTL = 8000;
	const CMD_TTL = 60000;
	const MAX_ITEMS = 20;

	const SLASH_ICON =
		'<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M10.5 2.6 5.5 13.4" stroke-linecap="round"/></svg>';
	const FILE_ICON =
		'<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M4 1.8h5l3 3v9.4H4z" stroke-linejoin="round"/><path d="M9 1.8v3h3"/></svg>';
	const FOLDER_ICON =
		'<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1.8 4.2c0-.5.4-.9.9-.9h3l1.3 1.5h6.3c.5 0 .9.4.9.9v5.9c0 .5-.4.9-.9.9H2.7c-.5 0-.9-.4-.9-.9V4.2Z" stroke-linejoin="round"/></svg>';
	const DRILL_ICON =
		'<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 3.5 10.5 8 6 12.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

	// 与 pi 一致：空白、引号、等号与 CJK 标点分隔 token；CJK 字母属于路径本身
	const DELIMS = /[\s"'=]/;
	const CJK_PUNCT = /[，．：；！？（）［］｛｝“”‘’…—]/;
	const WRAPPERS = { "(": ")", "[": "]", "{": "}", "<": ">", "`": "`" };

	const isDelim = (ch) => !!ch && (DELIMS.test(ch) || CJK_PUNCT.test(ch));

	const baseName = (path) => {
		const i = path.lastIndexOf("/");
		return i < 0 ? path : path.slice(i + 1);
	};
	const dirName = (path) => {
		const i = path.lastIndexOf("/");
		return i < 0 ? "" : path.slice(0, i);
	};
	const depthOf = (path) => path.split("/").length;
	const isSubsequence = (text, query) => {
		let i = 0;
		for (const ch of text) {
			if (ch === query[i]) i++;
			if (i === query.length) return true;
		}
		return i === query.length;
	};

	// ---------- 弹层 ----------
	const CSS = `
	.sug {
		position: fixed;
		z-index: 11;
		display: flex;
		flex-direction: column;
		min-width: 0;
		background: var(--bg);
		border: 1px solid var(--line);
		border-radius: 12px;
		box-shadow: var(--shadow-menu);
		/* Codex --suggestion-menu-gutter = 4px；外壳 padding 与行圆角 12-4=8 必须成对 */
		padding: 4px;
		overflow: hidden;
		animation: sug-in 110ms ease-out;
	}
	@keyframes sug-in {
		from { opacity: 0; transform: translateY(4px) scale(0.985); }
	}
	.sug[hidden] { display: none; }
	.sug-list {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		scrollbar-width: thin;
	}
	.sug-list::-webkit-scrollbar { width: 8px; }
	.sug-list::-webkit-scrollbar-thumb { border: 2px solid transparent; }
	.sug-group {
		padding: 6px 8px 4px;
		font-size: 12px;
		line-height: 16px;
		color: var(--faint);
	}
	.sug-item {
		display: flex;
		align-items: center;
		gap: 8px;
		height: 30px;
		padding: 0 8px;
		border-radius: 8px;
		color: var(--text);
		font-size: 14px;
		line-height: 20px;
		cursor: pointer;
		user-select: none;
	}
	.sug-item.on { background: var(--hover); }
	.sug-ico {
		flex: none;
		width: 14px;
		display: grid;
		place-items: center;
		color: var(--dim);
	}
	.sug-item.on .sug-ico { color: var(--text); }
	.sug-main {
		flex: 1 1 auto;
		min-width: 0;
		display: flex;
		align-items: baseline;
		gap: 8px;
	}
	.sug-name {
		flex: none;
		max-width: 40%;
		font-size: 14px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	/* 右列（目录）为空时不该留 60% 空白把主标签截到 40% */
	.sug-name.grow {
		flex: 0 1 auto;
		max-width: 100%;
	}
	.sug-dir, .sug-desc {
		flex: 1 1 0;
		min-width: 0;
		font-size: 12px;
		color: var(--faint);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		text-align: right;
	}
	.sug-tab {
		display: none;
		flex: none;
		font: 11px/16px var(--mono);
		color: var(--faint);
		background: var(--hover);
		border-radius: 4px;
		padding: 0 4px;
	}
	.sug-item.on .sug-tab { display: inline-flex; }
	.sug-drill {
		flex: none;
		display: grid;
		place-items: center;
		width: 16px;
		color: var(--faint);
	}
	.sug-tag {
		flex: none;
		font-size: 11px;
		line-height: 1.5;
		color: var(--faint);
		border: 1px solid var(--line);
		border-radius: 5px;
		padding: 0 4px;
	}
	.sug-foot {
		flex: none;
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 4px 4px 0;
		border-top: 1px solid var(--line);
		margin-top: 4px;
		font-size: 11px;
		color: var(--faint);
	}
	.sug-foot .k {
		font: 11px/1.4 var(--mono);
		color: var(--faint);
		border: 1px solid var(--line);
		border-radius: 4px;
		padding: 0 4px;
		margin-left: 8px;
	}
	.sug-foot .k:first-child { margin-left: 0; }
	.sug-note { margin-left: auto; }
	@media (prefers-reduced-motion: reduce) { .sug { animation: none; } }
	`;
	const style = document.createElement("style");
	style.textContent = CSS;
	document.head.append(style);

	const box = document.querySelector("#composer .box") || input.parentElement;
	let pop = null;
	let list = null;
	let note = null;
	let rowEls = [];
	let items = [];
	let index = -1;
	let hoverAfter = 0;
	let mode = "file";
	let range = null;
	let isOpen = false;
	// Esc / Shift+Tab 关闭去重：按「模式 + token 原文 + query」记账（ARCHITECTURE.md §2）：
	// 同 token 同 query 保持关闭，换 token 或 query 变了才允许重开。
	// 不用整段 value 比较：那样在草稿别处敲字会误解除，而光标挪到另一个同值 token 又不重开。
	let dismissedSig = null;
	// 弹层内非候选行（滚动条 / 外壳 / 页脚）按下时置位，用来让 blur 别把菜单关掉
	let popPressAt = 0;
	let demoTimer = 0;
	let demoActive = false;
	let demoPrev = "";
	let demoPrevCaret = 0;
	let fileState = { cwd: "", at: 0, files: [], truncated: false, loading: false };
	let cmdState = { at: 0, commands: [], loading: false };
	let demoCwd = "";

	const ensurePop = () => {
		if (pop) return;
		pop = document.createElement("div");
		pop.className = "sug";
		pop.id = "sug";
		pop.hidden = true;

		list = document.createElement("div");
		list.className = "sug-list";
		list.id = "sug-list";
		// listbox 落在滚动容器上、aria-activedescendant 指向其子行（ARCHITECTURE.md §2）
		list.setAttribute("role", "listbox");
		list.setAttribute("aria-label", "输入建议");

		const foot = document.createElement("div");
		foot.className = "sug-foot";
		for (const [key, label] of [
			["↑↓", "选择"],
			["Enter", "插入"],
			["Esc", "关闭"],
		]) {
			const k = document.createElement("span");
			k.className = "k";
			k.textContent = key;
			const t = document.createElement("span");
			t.textContent = label;
			foot.append(k, t);
		}
		note = document.createElement("span");
		note.className = "sug-note";
		foot.append(note);

		pop.append(list, foot);
		document.body.append(pop);

		// 只在候选行上阻止默认行为：保住 textarea 焦点，click 才能落到行上。
		// 整个弹层 preventDefault 会把滚动条的原生拖动也一起吃掉。
		pop.addEventListener("mousedown", (e) => {
			const row = e.target instanceof Element ? e.target.closest(".sug-item") : null;
			if (row && list.contains(row)) {
				e.preventDefault();
				popPressAt = 0;
				return;
			}
			// 滚动条 / 外壳 / 页脚：放行默认行为，松手后由 mouseup 把焦点还给输入框
			popPressAt = performance.now();
		});
		document.addEventListener(
			"mouseup",
			(e) => {
				if (!popPressAt) return;
				popPressAt = 0;
				const inside = e.target instanceof Element && pop.contains(e.target);
				if (!inside) {
					// 松手在弹层外：按 blur 的语义关掉，别把焦点抢回来
					close();
					return;
				}
				if (isOpen && document.activeElement !== input) input.focus({ preventScroll: true });
			},
			true,
		);
		pop.addEventListener("click", (e) => {
			const row = e.target instanceof Element ? e.target.closest(".sug-item") : null;
			if (!row || !list.contains(row)) return;
			const i = Number(row.dataset.i);
			if (!Number.isInteger(i) || !items[i]) return;
			index = i;
			accept();
		});
		pop.addEventListener("mousemove", (e) => {
			// 弹层在静止指针下出现时浏览器会补发一次 mousemove，别把它当成选中
			if (performance.now() < hoverAfter) return;
			const row = e.target instanceof Element ? e.target.closest(".sug-item") : null;
			if (!row || !list.contains(row)) return;
			const i = Number(row.dataset.i);
			if (Number.isInteger(i) && i !== index) setIndex(i, false);
		});
	};

	const place = () => {
		ensurePop();
		const r = box.getBoundingClientRect();
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const GAP = 8; // 弹层与输入框的间距
		const EDGE = 8; // 视口边缘留白
		// 行高 30（.sug-item）+ 组标题 26（.sug-group 6+16+4）+ 外壳 padding 8 + 页脚 26：
		// 150px 是「至少 3 行候选完整可见（含组标题与页脚）」的下限
		const MIN_H = 30 * 3 + 26 + 8 + 26;
		const CAP_H = 320;
		const w = Math.max(160, Math.min(r.width, vw - 16));
		const left = Math.max(8, Math.min(r.left, vw - w - 8));
		const spaceUp = r.top - GAP - EDGE;
		const spaceDown = vh - r.bottom - GAP - EDGE;
		// 默认向上长（贴近输入框）；上方连 3 行都放不下且下方更宽裕时改向下长，别把菜单顶出视口
		const up = spaceUp >= MIN_H || spaceUp >= spaceDown;
		const room = up ? spaceUp : spaceDown;
		const h = Math.min(Math.max(MIN_H, Math.min(CAP_H, room)), Math.max(MIN_H, vh - EDGE * 2));
		pop.style.left = `${left}px`;
		pop.style.width = `${w}px`;
		pop.style.maxHeight = `${h}px`;
		if (up) {
			pop.style.top = "auto";
			pop.style.bottom = `${Math.max(EDGE, vh - r.top + GAP)}px`;
		} else {
			pop.style.bottom = "auto";
			pop.style.top = `${Math.max(EDGE, r.bottom + GAP)}px`;
		}
	};

	const openPopup = () => {
		ensurePop();
		isOpen = true;
		hoverAfter = performance.now() + 250;
		pop.hidden = false;
		input.setAttribute("aria-expanded", "true");
	};

	const close = () => {
		if (!isOpen) return;
		isOpen = false;
		index = -1;
		popPressAt = 0;
		if (pop) pop.hidden = true;
		if (list) list.replaceChildren();
		items = [];
		rowEls = [];
		// 三个 aria 状态成对收尾：展开态、当前行、行上的 aria-selected（行已随 replaceChildren 移除）
		input.setAttribute("aria-expanded", "false");
		input.removeAttribute("aria-activedescendant");
	};

	const setIndex = (i, scroll = true) => {
		if (!items.length) {
			index = -1;
			input.removeAttribute("aria-activedescendant");
			return;
		}
		const last = items.length - 1;
		// -1 = 未预选；其余钳制在 [0, last]，NaN / Infinity 一律当未预选处理
		index = Number.isFinite(i) ? (i < 0 ? -1 : Math.min(last, Math.max(0, Math.trunc(i)))) : -1;
		for (let k = 0; k < rowEls.length; k++) {
			const on = k === index;
			rowEls[k].classList.toggle("on", on);
			rowEls[k].setAttribute("aria-selected", on ? "true" : "false");
		}
		const row = index >= 0 ? rowEls[index] || null : null;
		if (!row) {
			// 行没建出来时宁可不设，也别把 aria-activedescendant 设成空串
			input.removeAttribute("aria-activedescendant");
			return;
		}
		input.setAttribute("aria-activedescendant", row.id);
		if (scroll) row.scrollIntoView({ block: "nearest" });
	};

	const rowFor = (item, i) => {
		const row = document.createElement("div");
		row.className = "sug-item";
		row.id = `sug-${i}`;
		row.dataset.i = String(i);
		row.setAttribute("role", "option");
		row.setAttribute("aria-selected", "false");

		const ico = document.createElement("span");
		ico.className = "sug-ico";
		ico.innerHTML = item.kind === "command" ? SLASH_ICON : item.dir ? FOLDER_ICON : FILE_ICON;

		const main = document.createElement("span");
		main.className = "sug-main";

		if (item.kind === "command") {
			const name = document.createElement("span");
			name.className = "sug-name";
			name.textContent = `/${item.name}`;
			main.append(name);
			// 没有描述就不要把命令名重复显示一遍（DSH 仅在有 description 时渲染右列）
			if (item.description && item.description !== item.name) {
				const desc = document.createElement("span");
				desc.className = "sug-desc";
				desc.textContent = item.description;
				main.append(desc);
			}
			row.title = item.description || item.name;
		} else {
			const name = document.createElement("span");
			name.className = "sug-name";
			name.textContent = item.dir ? `${baseName(item.path)}/` : baseName(item.path);
			const dir = document.createElement("span");
			dir.className = "sug-dir";
			dir.textContent = dirName(item.path);
			main.append(name);
			if (dir.textContent) main.append(dir);
			else name.classList.add("grow");
			row.title = item.path;
		}
		row.append(ico, main);

		if (item.dir) {
			const tab = document.createElement("span");
			tab.className = "sug-tab";
			tab.textContent = "Tab";
			const drill = document.createElement("span");
			drill.className = "sug-drill";
			drill.innerHTML = DRILL_ICON;
			row.append(tab, drill);
		}
		if (item.kind === "command" && item.source) {
			const tag = document.createElement("span");
			tag.className = "sug-tag";
			tag.textContent = item.source;
			row.append(tag);
		}
		return row;
	};

	const render = () => {
		if (!items.length) {
			close();
			return;
		}
		ensurePop();
		rowEls = items.map(rowFor);
		const group = document.createElement("div");
		group.className = "sug-group";
		group.setAttribute("role", "presentation"); // 分组标题不是可选项，别让读屏念成 option
		group.textContent = mode === "command" ? "命令" : "文件";
		list.replaceChildren(group, ...rowEls);
		note.textContent = mode === "file" && fileState.truncated ? "索引仅收录前 2000 项" : "";
		openPopup();
		place();
		setIndex(-1, false);
	};

	// ---------- @ 触发范围 ----------
	const boundaryOk = (line, i) => {
		if (i <= 0) return true;
		const prev = line[i - 1];
		return isDelim(prev) || Object.prototype.hasOwnProperty.call(WRAPPERS, prev);
	};

	const unclosedQuoteStart = (line) => {
		let inQuote = false;
		let start = -1;
		for (let i = 0; i < line.length; i++) {
			if (line[i] !== '"') continue;
			inQuote = !inQuote;
			start = inQuote ? i : -1;
		}
		return inQuote ? start : -1;
	};

	const tokenStart = (line) => {
		let i = line.length;
		while (i > 0 && !isDelim(line[i - 1])) i--;
		return i;
	};

	const stripWrappers = (line, i) => {
		while (i < line.length) {
			const closer = WRAPPERS[line[i]];
			if (!closer || line.indexOf(closer, i + 1) !== -1) break;
			i++;
		}
		return i;
	};

	const atRange = () => {
		const caret = input.selectionStart ?? input.value.length;
		if (input.selectionEnd !== caret) return null;
		const value = input.value;
		const nl = caret > 0 ? value.lastIndexOf("\n", caret - 1) : -1;
		const lineStart = nl + 1;
		const line = value.slice(lineStart, caret);

		const q = unclosedQuoteStart(line);
		if (q >= 0) {
			let start = q;
			if (q > 0 && line[q - 1] === "@") start = q - 1;
			if (line[start] !== "@" || !boundaryOk(line, start)) return null;
			return { start: lineStart + start, end: caret, query: line.slice(q + 1), quoted: true };
		}

		let start = stripWrappers(line, tokenStart(line));
		if (line[start] !== "@" || !boundaryOk(line, start)) return null;
		return { start: lineStart + start, end: caret, query: line.slice(start + 1), quoted: false };
	};

	// ---------- / 触发范围 ----------
	const commandRange = () => {
		const caret = input.selectionStart ?? input.value.length;
		if (input.selectionEnd !== caret) return null;
		const before = input.value.slice(0, caret);
		if (before.includes("\n")) return null;
		const lead = before.length - before.trimStart().length;
		const body = before.slice(lead);
		if (!body.startsWith("/")) return null;
		if (/\s/.test(body)) return null;
		const query = body.slice(1);
		if (query.includes("/")) return null;
		return { start: lead, end: caret, query };
	};

	// ---------- 数据 ----------
	const rankFiles = () => {
		const q = String(range?.query || "").toLowerCase().replace(/\\/g, "/");
		const scored = [];
		for (const f of fileState.files) {
			if (!f || typeof f.path !== "string") continue;
			const base = baseName(f.path).toLowerCase();
			const full = f.path.toLowerCase();
			let score = 0;
			if (!q) {
				score = 1;
			} else if (base === q) {
				score = 100;
			} else if (base.startsWith(q)) {
				score = 80;
			} else if (base.includes(q)) {
				score = 50;
			} else if (full.startsWith(q)) {
				score = 44;
			} else if (full.includes(q)) {
				score = 30;
			} else if (isSubsequence(base, q)) {
				score = 18;
			} else {
				continue;
			}
			if (f.dir) score += 8;
			scored.push({ f, score });
		}
		scored.sort((a, b) => {
			// 空 query 时先列浅层条目，否则深目录会把根目录文件挤掉
			if (!q) {
				return (
					depthOf(a.f.path) - depthOf(b.f.path) ||
					(b.f.dir ? 1 : 0) - (a.f.dir ? 1 : 0) ||
					a.f.path.length - b.f.path.length ||
					a.f.path.localeCompare(b.f.path)
				);
			}
			return (
				b.score - a.score ||
				depthOf(a.f.path) - depthOf(b.f.path) ||
				a.f.path.length - b.f.path.length ||
				a.f.path.localeCompare(b.f.path)
			);
		});
		return scored.slice(0, MAX_ITEMS).map((x) => x.f);
	};

	const renderFiles = () => {
		if (mode !== "file" || !range) return;
		items = rankFiles().map((f) => {
			const raw = typeof f.path === "string" ? f.path : "";
			// 目录统一去掉尾部斜杠：钻取拼接时只补一个，显示也不会出现 "a//"
			return { kind: "file", path: f.dir ? raw.replace(/\/+$/, "") : raw, dir: !!f.dir };
		});
		render();
	};

	const rankCommands = () => {
		const q = String(range?.query || "").toLowerCase();
		const scored = [];
		for (const c of cmdState.commands) {
			const name = c.name.toLowerCase();
			const bare = name.startsWith("skill:") ? name.slice(6) : name;
			let score = 0;
			if (!q) {
				score = 1;
			} else if (bare.startsWith(q)) {
				score = 90;
			} else if (name.startsWith(q)) {
				score = 85;
			} else if (bare.includes(q)) {
				score = 60;
			} else if (name.includes(q)) {
				score = 55;
			} else if (isSubsequence(bare, q) || isSubsequence(name, q)) {
				score = 25;
			} else {
				continue;
			}
			scored.push({ c, score });
		}
		scored.sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name));
		return scored.slice(0, MAX_ITEMS).map((x) => x.c);
	};

	const renderCommands = () => {
		if (mode !== "command" || !range) return;
		items = rankCommands();
		render();
	};

	const ensureFiles = () => {
		if (fileState.loading) return;
		const now = Date.now();
		const cwd = demoCwd || ctx.state?.cwd || "";
		if (fileState.cwd === cwd && now - fileState.at < FILE_TTL) {
			renderFiles();
			return;
		}
		if (!pi.listFiles) return;
		fileState.loading = true;
		fileState.at = now;
		pi.listFiles(cwd || undefined)
			.then((d) => {
				fileState = {
					cwd: d?.cwd || cwd,
					at: Date.now(),
					files: Array.isArray(d?.files) ? d.files : [],
					truncated: !!d?.truncated,
					loading: false,
				};
				update();
			})
			.catch(() => {
				// 失败后 8s 内不再重扫，避免每次按键都打 IPC
				fileState = { cwd, at: Date.now(), files: [], truncated: false, loading: false };
			})
			.finally(() => {
				fileState.loading = false;
			});
	};

	const ensureCommands = () => {
		if (cmdState.loading) return;
		const now = Date.now();
		if (now - cmdState.at < (cmdState.commands.length ? CMD_TTL : 5000)) {
			renderCommands();
			return;
		}
		if (!pi.command) return;
		cmdState.loading = true;
		pi.command({ type: "get_commands" })
			.then((d) => {
				const list = Array.isArray(d?.commands) ? d.commands : [];
				cmdState = {
					at: Date.now(),
					commands: list
						.map((c) => ({
							kind: "command",
							name: String(c?.name || ""),
							description: String(c?.description || ""),
							source: String(c?.source || ""),
						}))
						.filter((c) => c.name),
					loading: false,
				};
				update();
			})
			.catch(() => {
				cmdState = { at: Date.now(), commands: [], loading: false };
			})
			.finally(() => {
				cmdState.loading = false;
			});
	};

	// 关闭去重指纹：模式 + token 原文（含 @ / /）+ query
	const rangeSig = (m, r) =>
		r ? `${m}\u0000${input.value.slice(r.start, r.end)}\u0000${String(r.query ?? "")}` : "";

	// 当前光标处的触发态指纹（无触发态时为空串）
	const currentSig = () => {
		const cmd = commandRange();
		if (cmd) return rangeSig("command", cmd);
		const at = atRange();
		return at ? rangeSig("file", at) : "";
	};

	const update = () => {
		if (!demoActive && document.activeElement !== input) {
			close();
			return;
		}
		const cmd = commandRange();
		const at = cmd ? null : atRange();
		const nextMode = cmd ? "command" : at ? "file" : "";
		const nextRange = cmd || at;
		const sig = nextRange ? rangeSig(nextMode, nextRange) : "";
		if (dismissedSig !== null) {
			// 不在触发态（sig 为空）：只关，不解除记账；仍是同一个 token+query：保持关闭
			if (!sig || sig === dismissedSig) {
				close();
				return;
			}
			// 换了 token 或 query 变了：解除
			dismissedSig = null;
		}
		if (!nextRange) {
			close();
			return;
		}
		mode = nextMode;
		range = nextRange;
		index = -1;
		close();
		if (nextMode === "command") ensureCommands();
		else ensureFiles();
	};

	// ---------- 插入 ----------
	const replaceRange = (start, end, text, caretOffset = text.length) => {
		const value = input.value;
		input.value = value.slice(0, start) + text + value.slice(end);
		const caret = start + caretOffset;
		input.setSelectionRange(caret, caret);
		input.focus();
		input.dispatchEvent(new Event("input", { bubbles: true }));
	};

	const accept = () => {
		if (!range || !items.length) return;
		const item = items[index < 0 ? 0 : index];
		if (!item) return;
		if (item.kind === "command") {
			replaceRange(range.start, range.end, `/${item.name} `);
			close();
			return;
		}
		const path = item.path;
		// 目录拼一个斜杠就够（path 在 renderFiles 里已去掉尾斜杠，这里再兜一道）；根目录不补
		const value = item.dir && path && !path.endsWith("/") ? `${path}/` : path;
		const quoted = range.quoted || /\s/.test(path);
		// 光标后已有闭合引号：目录复用它（光标留在引号内继续补全），文件连引号一起替换
		const tailQuote = range.quoted && input.value[range.end] === '"';
		if (item.dir) {
			const text = quoted ? (tailQuote ? `@"${value}` : `@"${value}"`) : `@${value}`;
			replaceRange(range.start, range.end, text, quoted && !tailQuote ? text.length - 1 : text.length);
			return;
		}
		const text = quoted ? `@"${value}" ` : `@${value} `;
		replaceRange(range.start, range.end + (tailQuote ? 1 : 0), text);
		close();
	};

	// ---------- 键盘（挂在 document 捕获阶段：app.js 在 input 上的监听先于本模块注册）----------
	const onKeyDown = (e) => {
		if (!isOpen || e.target !== input || e.isComposing) return;
		switch (e.key) {
			case "ArrowDown":
				e.preventDefault();
				e.stopPropagation();
				setIndex(index + 1);
				break;
			case "ArrowUp":
				e.preventDefault();
				e.stopPropagation();
				// 未预选时从末尾进入；已预选时到顶就留在顶部（与 ArrowDown 到底一致）
				setIndex(index < 0 ? items.length - 1 : Math.max(0, index - 1));
				break;
			case "Enter":
				if (e.shiftKey) return;
				e.preventDefault();
				e.stopPropagation();
				accept();
				break;
			case "Tab":
				if (e.shiftKey) {
					// Shift+Tab 只关菜单，不消费补全
					e.preventDefault();
					e.stopPropagation();
					dismissedSig = rangeSig(mode, range);
					close();
					break;
				}
				// 无高亮时放行：让 Tab 正常做焦点遍历，不抢焦点（ARCHITECTURE.md §2「无高亮时放行」）
				if (index < 0) return;
				e.preventDefault();
				e.stopPropagation();
				accept();
				break;
			case "Escape":
				e.preventDefault();
				e.stopPropagation();
				dismissedSig = rangeSig(mode, range);
				close();
				break;
		}
	};
	document.addEventListener("keydown", onKeyDown, true);

	ensurePop(); // 先把 listbox 建出来，aria-controls 才有指向目标
	input.setAttribute("aria-autocomplete", "list");
	input.setAttribute("aria-haspopup", "listbox");
	input.setAttribute("aria-controls", "sug-list");
	input.setAttribute("aria-expanded", "false");

	input.addEventListener("input", update);
	input.addEventListener("click", update);
	input.addEventListener("keyup", (e) => {
		if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") update();
	});
	input.addEventListener("blur", () => {
		// 在弹层里按滚动条会短暂夺焦（滚动条不阻止默认行为）：此时不关，等 mouseup 把焦点还回来
		if (popPressAt) return;
		close();
	});
	window.addEventListener("resize", () => {
		if (isOpen) place();
	});
	if (box && typeof ResizeObserver === "function") {
		new ResizeObserver(() => {
			if (isOpen) place();
		}).observe(box);
	}

	// ---------- 开发截图钩子 ----------
	const endDemo = () => {
		if (!demoActive) return;
		demoActive = false;
		demoCwd = "";
		clearTimeout(demoTimer);
		input.value = demoPrev;
		try {
			input.setSelectionRange(demoPrevCaret, demoPrevCaret);
		} catch {}
		// 还原草稿别把菜单弹回来：先按还原后的光标重算一遍触发态，记成「已被关闭」
		dismissedSig = currentSig();
		input.dispatchEvent(new Event("input", { bubbles: true }));
	};

	window.__piSuggestDemo = (kind = "file", cwd = "") => {
		endDemo();
		demoActive = true;
		// 截图钩子要强制弹出：清掉上一轮 Esc 留下的关闭记账
		dismissedSig = null;
		demoCwd = String(cwd || "");
		demoPrev = input.value;
		demoPrevCaret = input.selectionStart ?? demoPrev.length;
		const value = kind === "command" ? "/" : "@";
		input.focus();
		input.value = value;
		input.setSelectionRange(value.length, value.length);
		update();
		demoTimer = setTimeout(endDemo, 4000);
		return true;
	};
}
