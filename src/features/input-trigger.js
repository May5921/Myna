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
		padding: 5px;
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
		gap: 9px;
		height: 30px;
		padding: 0 8px;
		border-radius: 8px;
		color: var(--text);
		font-size: 14px;
		line-height: 20px;
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
		font: 10px/16px var(--mono);
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
		padding: 0 5px;
	}
	.sug-foot {
		flex: none;
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 5px 4px 1px 6px;
		border-top: 1px solid var(--line);
		margin-top: 4px;
		font-size: 11px;
		color: var(--faint);
	}
	.sug-foot .k {
		font: 10px/1.4 var(--mono);
		color: var(--faint);
		border: 1px solid var(--line);
		border-radius: 4px;
		padding: 0 4px;
		margin-left: 6px;
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
	let dismissedValue = null;
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
		pop.setAttribute("role", "listbox");
		pop.setAttribute("aria-label", "输入建议");

		list = document.createElement("div");
		list.className = "sug-list";

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

		// 点选时不让 textarea 失焦（否则 blur 会先关弹层，click 落空）
		pop.addEventListener("mousedown", (e) => e.preventDefault());
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
		const w = Math.max(160, Math.min(r.width, vw - 16));
		const left = Math.max(8, Math.min(r.left, vw - w - 8));
		pop.style.left = `${left}px`;
		pop.style.width = `${w}px`;
		pop.style.bottom = `${Math.max(8, window.innerHeight - r.top + 8)}px`;
		// 只向上长，给输入框留出 8px 间距
		pop.style.maxHeight = `${Math.max(96, Math.min(320, r.top - 24))}px`;
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
		if (pop) pop.hidden = true;
		if (list) list.replaceChildren();
		items = [];
		rowEls = [];
		input.setAttribute("aria-expanded", "false");
		input.removeAttribute("aria-activedescendant");
	};

	const setIndex = (i, scroll = true) => {
		if (!items.length) return;
		index = i < 0 ? -1 : Math.max(0, Math.min(items.length - 1, i));
		for (let k = 0; k < rowEls.length; k++) {
			const on = k === index;
			rowEls[k].classList.toggle("on", on);
			rowEls[k].setAttribute("aria-selected", on ? "true" : "false");
		}
		if (index < 0) {
			input.removeAttribute("aria-activedescendant");
			return;
		}
		input.setAttribute("aria-activedescendant", rowEls[index]?.id || "");
		if (scroll) rowEls[index]?.scrollIntoView({ block: "nearest" });
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
			const desc = document.createElement("span");
			desc.className = "sug-desc";
			desc.textContent = item.description || item.name;
			main.append(name, desc);
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
		items = rankFiles().map((f) => ({ kind: "file", path: f.path, dir: !!f.dir }));
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

	const update = () => {
		if (!demoActive && document.activeElement !== input) {
			close();
			return;
		}
		if (dismissedValue !== null) {
			if (input.value === dismissedValue) {
				close();
				return;
			}
			dismissedValue = null;
		}
		const cmd = commandRange();
		if (cmd) {
			mode = "command";
			range = cmd;
			index = -1;
			close();
			ensureCommands();
			return;
		}
		const at = atRange();
		if (at) {
			mode = "file";
			range = at;
			index = -1;
			close();
			ensureFiles();
			return;
		}
		close();
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
		const value = item.dir ? `${path}/` : path;
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
				setIndex(index < 0 ? items.length - 1 : index - 1);
				break;
			case "Enter":
				if (e.shiftKey) return;
				e.preventDefault();
				e.stopPropagation();
				accept();
				break;
			case "Tab":
				e.preventDefault();
				e.stopPropagation();
				if (e.shiftKey) {
					// Shift+Tab 只关菜单，不消费补全
					dismissedValue = input.value;
					close();
					break;
				}
				accept();
				break;
			case "Escape":
				e.preventDefault();
				e.stopPropagation();
				dismissedValue = input.value;
				close();
				break;
		}
	};
	document.addEventListener("keydown", onKeyDown, true);

	input.setAttribute("aria-autocomplete", "list");
	input.setAttribute("aria-haspopup", "listbox");
	input.setAttribute("aria-controls", "sug");
	input.setAttribute("aria-expanded", "false");

	input.addEventListener("input", update);
	input.addEventListener("click", update);
	input.addEventListener("keyup", (e) => {
		if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") update();
	});
	input.addEventListener("blur", close);
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
		dismissedValue = demoPrev;
		input.dispatchEvent(new Event("input", { bubbles: true }));
		try {
			input.setSelectionRange(demoPrevCaret, demoPrevCaret);
		} catch {}
	};

	window.__piSuggestDemo = (kind = "file", cwd = "") => {
		endDemo();
		demoActive = true;
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
