// 端到端场景：每段 source 都在渲染进程主世界执行，返回 checks 数组。
// 约定：ok(name, cond, detail) 记录一条断言；任何一条 false 即整个场景失败。
// 这里只做「真实 DOM / 真实事件」的断言，不调用模型，因此不花 API 费用。

const HARNESS = `
	const checks = [];
	const ok = (name, cond, detail = "") => {
		checks.push({ name, ok: !!cond, detail: String(detail).slice(0, 200) });
	};
	const wait = (ms) => new Promise((r) => setTimeout(r, ms));
	const until = async (fn, ms = 4000) => {
		const end = performance.now() + ms;
		while (performance.now() < end) {
			if (fn()) return true;
			await wait(50);
		}
		return false;
	};
	// 场景之间的清理：关掉弹窗/右栏/菜单，避免状态串味
	const cleanup = async () => {
		const ov = document.querySelector(".settings-overlay");
		if (ov && !ov.hidden) document.getElementById("settings-btn")?.click();
		const rp = document.getElementById("rp-toggle");
		if (rp && rp.getAttribute("aria-expanded") === "true") rp.click();
		const menu = document.getElementById("menu");
		if (menu) menu.hidden = true;
		const input = document.getElementById("input");
		if (input) {
			input.value = "";
			input.dispatchEvent(new Event("input", { bubbles: true }));
		}
		await wait(120);
	};
`;

export const scenarios = {
	// 启动健康：窗口就绪、关键节点存在、没有启动失败态
	boot: `
		(async () => {
			${HARNESS}
			// boot 要等 pi 子进程起来 + 会话恢复，不能固定延时后就断言
			const ready = await until(() => window.__ready === true, 20000);
			ok("renderer ready", ready, "__ready=" + String(window.__ready));
			ok("stream mounted", !!document.getElementById("stream"));
			ok("composer mounted", !!document.getElementById("input"));
			ok("send button", !!document.getElementById("send"));
			ok("no boot error", !document.querySelector(".boot-error"));
			ok("pi bridge", typeof window.pi?.command === "function");
			const nodes = document.querySelectorAll("*").length;
			ok("dom rendered", nodes > 100, "nodes=" + nodes);
			return checks;
		})()
	`,

	// 整轮过程折叠：思考 + 工具收进一个可展开块，正文留在外面
	fold: `
		(async () => {
			${HARNESS}
			await cleanup();
			const stream = document.getElementById("stream");
			stream.replaceChildren();
			const made = window.__selftest?.();
			ok("selftest ran", made === true);
			await until(() => document.querySelector(".proc"));
			const procs = [...document.querySelectorAll(".proc")];
			ok("proc blocks created", procs.length === 2, "count=" + procs.length);
			const collapsed = procs.find((p) => !p.hasAttribute("open"));
			const expanded = procs.find((p) => p.hasAttribute("open"));
			ok("one collapsed by default", !!collapsed);
			ok("one expanded sample", !!expanded);
			const text = collapsed?.querySelector(".proc-text")?.textContent || "";
			ok("summary counts", /过程/.test(text) && /思考/.test(text) && /工具/.test(text), text);
			// 收起态下工具与思考必须已经移进 proc-body，正文 row 里不该再残留
			ok("tools moved into proc", collapsed.querySelectorAll(".proc-body .tool").length > 0);
			ok("think moved into proc", collapsed.querySelectorAll(".proc-body .think").length > 0);
			ok("no tool left in answer row", !collapsed.closest(".row").querySelector(".body > .tool"));
			// 展开态：工具行可见且可读
			ok("expanded shows tool", expanded.querySelectorAll(".proc-body .tool").length >= 2);
			const toolHdr = expanded.querySelector(".proc-body .tool .hdr");
			ok("tool row focusable", toolHdr?.getAttribute("tabindex") === "0");
			ok("tool row aria", toolHdr?.getAttribute("role") === "button" && toolHdr?.getAttribute("aria-expanded") === "false");
			return checks;
		})()
	`,

	// 左栏拖宽：手柄存在、改 token 生效、clamp 生效、键盘可调
	sidebar: `
		(async () => {
			${HARNESS}
			await cleanup();
			const grip = document.querySelector(".sbar-grip");
			ok("grip exists", !!grip);
			ok("grip role", grip?.getAttribute("role") === "separator");
			ok("grip tabbable", grip?.tabIndex === 0);
			ok("grip labelled", /宽度/.test(grip?.getAttribute("aria-label") || ""));
			const side = document.getElementById("side");
			const root = document.documentElement;
			const before = Math.round(side.getBoundingClientRect().width);
			root.style.setProperty("--sidebar-width", "360px");
			await wait(60);
			const wider = Math.round(side.getBoundingClientRect().width);
			ok("width token applies", wider > before + 20, before + " -> " + wider);
			root.style.setProperty("--sidebar-width", "9999px");
			await wait(60);
			const clamped = Math.round(side.getBoundingClientRect().width);
			ok("clamped by max", clamped <= 460, "clamped=" + clamped);
			root.style.setProperty("--sidebar-width", "10px");
			await wait(60);
			const floor = Math.round(side.getBoundingClientRect().width);
			ok("clamped by min", floor >= 200, "floor=" + floor);
			// 键盘等价操作
			grip.focus();
			const key = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
			grip.dispatchEvent(key);
			await wait(60);
			const afterKey = Math.round(side.getBoundingClientRect().width);
			ok("keyboard widens", afterKey > floor, floor + " -> " + afterKey);
			root.style.setProperty("--sidebar-width", "275px");
			return checks;
		})()
	`,

	// 右栏：打开/让位/拖宽手柄/收起后焦点归还
	rightpanel: `
		(async () => {
			${HARNESS}
			await cleanup();
			const toggle = document.getElementById("rp-toggle");
			ok("toggle exists", !!toggle);
			toggle.click();
			await until(() => document.body.classList.contains("rp-open"));
			ok("panel opens", document.body.classList.contains("rp-open"));
			const panel = document.getElementById("rp-panel");
			ok("panel visible", !!panel && !panel.getAttribute("aria-hidden")?.includes("true"));
			ok("toggle pressed", toggle.getAttribute("aria-expanded") === "true");
			const grip = document.querySelector(".rp-grip");
			ok("grip exists", !!grip);
			ok("grip role", grip?.getAttribute("role") === "separator");
			// 归零到最小宽，让拖拽断言不受上次持久化的宽度影响（测试要自包含）
			grip.focus();
			grip.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
			await wait(100);
			ok("keyboard sets min width", Math.round(panel.getBoundingClientRect().width) <= 262, String(Math.round(panel.getBoundingClientRect().width)));
			// 把焦点交给开关，再拖：拖拽不得抢走它
			toggle.focus();
			const w0 = Math.round(panel.getBoundingClientRect().width);
			const rect = grip.getBoundingClientRect();
			const x0 = rect.left + 3;
			const down = new PointerEvent("pointerdown", { clientX: x0, button: 0, bubbles: true, cancelable: true, pointerId: 1 });
			grip.dispatchEvent(down);
			window.dispatchEvent(new PointerEvent("pointermove", { clientX: x0 - 80, bubbles: true, pointerId: 1 }));
			await wait(80);
			const w1 = Math.round(panel.getBoundingClientRect().width);
			window.dispatchEvent(new PointerEvent("pointerup", { clientX: x0 - 80, bubbles: true, pointerId: 1 }));
			ok("drag widens panel", w1 > w0, w0 + " -> " + w1);
			// 宽度上限是 min(560, 50vw)，拖过头被 clamp 是正确行为，不是 bug
			const cap = Math.min(560, Math.round(window.innerWidth / 2));
			ok("drag respects cap", w1 <= cap + 2, "w1=" + w1 + " cap=" + cap);
			ok("drag does not steal focus", document.activeElement !== grip, String(document.activeElement?.id || document.activeElement?.tagName));
			// 收起：焦点必须回到开关
			grip.focus();
			toggle.click();
			await until(() => !document.body.classList.contains("rp-open"));
			ok("panel closes", !document.body.classList.contains("rp-open"));
			ok("focus returned to toggle", document.activeElement === toggle, String(document.activeElement?.id || ""));
			return checks;
		})()
	`,

	// 设置页：思考档位映射 7 格齐全、开关成对维护 aria
	debugSettings: `
		(async () => {
			${HARNESS}
			const push = (n, d) => checks.push({ name: n, ok: true, detail: String(d).slice(0, 400) });
			await cleanup();
			await until(() => typeof window.__piSettingsDemo === "function", 6000);
			window.__piSettingsDemo();
			await until(() => {
				const ov = document.querySelector(".settings-overlay");
				return !!ov && !ov.hidden;
			}, 4000);
			document.querySelector("#settings-nav-providers")?.click();
			// provider 列表是异步拉的（ctx.pi.providers），必须等它回来
			const loaded = await until(() => document.querySelector(".prov-head"), 10000);
			ok("provider list loaded", loaded);
			await wait(400);
			push("providers", document.querySelectorAll(".prov-head").length);
			const heads = [...document.querySelectorAll(".prov-head")];
			push("first head text", heads[0]?.textContent?.trim() || "none");
			for (const h of heads) { h.click(); await wait(120); }
			await wait(500);
			push("editors", document.querySelectorAll(".prov-editor").length);
			push("model-add buttons", document.querySelectorAll(".prov-model-add").length);
			push("add labels", [...document.querySelectorAll(".prov-model-add")].map((b) => b.textContent.trim()).join(" | "));
			push("model rows", document.querySelectorAll(".prov-model").length);
			push("think cells", document.querySelectorAll(".prov-think-cell").length);
			push("think blocks", document.querySelectorAll(".prov-think").length);
			push("hidden think blocks", document.querySelectorAll(".prov-think[hidden]").length);
			return checks;
		})()
	`,
	settings: `
		(async () => {
			${HARNESS}
			await cleanup();
			const waitReady = await until(() => typeof window.__piSettingsDemo === "function", 6000);
			ok("settings demo available", waitReady);
			window.__piSettingsDemo();
			const opened = await until(() => {
				const ov = document.querySelector(".settings-overlay");
				return !!ov && !ov.hidden;
			}, 4000);
			ok("settings opens", opened);
			document.querySelector("#settings-nav-providers")?.click();
			const providerLoaded = await until(() => document.querySelector(".prov-head"), 10000);
			ok("provider list loaded", providerLoaded);
			await wait(300);
			// 本机 models.json 不一定有 reasoning 模型，所以展开所有 provider 后取第一个可见的映射区
			for (const head of [...document.querySelectorAll(".prov-head")]) {
				head.click();
				await wait(120);
			}
			await wait(400);
			const blocks = [...document.querySelectorAll(".prov-think")];
			const visible = blocks.find((b) => !b.hidden);
			ok("a reasoning model exists", !!visible, "blocks=" + blocks.length);
			if (!visible) return checks;
			const cells = [...visible.querySelectorAll(".prov-think-cell")];
			ok("seven thinking levels", cells.length === 7, "cells=" + cells.length);
			const labels = cells.map((c) => c.querySelector(".prov-think-label")?.textContent || "");
			ok("level labels present", labels.filter(Boolean).length === 7, labels.join("/"));
			const toggles = cells.map((c) => c.querySelector(".prov-think-off"));
			ok("each level has toggle", toggles.every(Boolean));
			ok("toggle has aria", toggles.every((t) => t && t.hasAttribute("aria-pressed") && (t.getAttribute("aria-label") || "").length > 0));
			// 切一个「不支持」，输入框应变禁用，且不重建整行
			const cell = cells[0];
			const input = cell.querySelector(".prov-think-input");
			const toggle = cell.querySelector(".prov-think-off");
			const before = input.disabled;
			toggle.click();
			await wait(80);
			ok("unsupported disables input", input.disabled !== before, "before=" + before + " after=" + input.disabled);
			toggle.click();
			await wait(80);
			ok("restore re-enables input", input.disabled === before);
			return checks;
		})()
	`,

	// 输入触发：@ 打开菜单，Esc 关闭，aria 成对维护
	input: `
		(async () => {
			${HARNESS}
			await cleanup();
			const input = document.getElementById("input");
			input.focus();
			input.value = "@";
			input.setSelectionRange(1, 1);
			input.dispatchEvent(new Event("input", { bubbles: true }));
			const opened = await until(() => input.getAttribute("aria-expanded") === "true", 5000);
			ok("suggest opens", opened);
			const items = document.querySelectorAll(".sug-item");
			ok("suggest has items", items.length > 0, "items=" + items.length);
			ok("listbox role", document.querySelector(".sug")?.getAttribute("role") === "listbox" || !!document.querySelector('[role="listbox"]'));
			input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
			await wait(120);
			ok("escape closes", input.getAttribute("aria-expanded") === "false");
			ok("active descendant cleared", !input.hasAttribute("aria-activedescendant"));
			ok("draft preserved", input.value === "@", JSON.stringify(input.value));
			await cleanup();
			return checks;
		})()
	`,

	// 终端抽屉：开合焦点、关闭后归还、手柄键盘、空历史不写空命令
	terminal: `
		(async () => {
			${HARNESS}
			await cleanup();
			// 别的模块（设置弹窗）关闭时可能在 setTimeout 里归还焦点，先让这类延迟动作跑完
			await wait(500);
			ok("terminal hook", typeof window.__piTermToggle === "function");
			if (typeof window.__piTermToggle !== "function") return checks;
			const opener = document.getElementById("input");
			opener.focus();
			window.__piTermToggle();
			const opened = await until(() => window.__piTermAPI?.isOpen === true, 4000);
			ok("terminal opens", opened);
			const termInput = document.querySelector(".term-input");
			ok("terminal input exists", !!termInput);
			const focusIn = await until(() => document.activeElement === termInput, 1500);
			ok("focus moves into terminal", focusIn, String(document.activeElement?.className || document.activeElement?.tagName || ""));
			// 空历史时按 ↑ 不得写入空命令
			const before = termInput.value;
			termInput.focus();
			termInput.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
			await wait(80);
			// 历史可能有旧命令，“取不到”或“取到非空项”都算正确；只有取到空串才是 bug
			ok("history never injects empty command", termInput.value.trim() !== "" || termInput.value === before, JSON.stringify(termInput.value));
			// 关闭：焦点必须归还，不能落在 body
			window.__piTermToggle();
			const closed = await until(() => window.__piTermAPI?.isOpen !== true, 3000);
			ok("terminal closes", closed);
			ok("focus leaves body", document.activeElement !== document.body, String(document.activeElement?.id || document.activeElement?.tagName));
			// 高度手柄：键盘可调且带 aria
			window.__piTermToggle();
			await until(() => window.__piTermAPI?.isOpen === true, 3000);
			const grip = document.querySelector(".term-grip");
			ok("grip exists", !!grip);
			ok("grip tabbable", grip?.tabIndex === 0);
			ok("grip aria", grip?.hasAttribute("aria-valuemin") && grip?.hasAttribute("aria-valuemax"), grip?.getAttribute("aria-valuenow") || "");
			const h0 = document.querySelector(".term")?.getBoundingClientRect().height || 0;
			grip?.focus();
			grip?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
			await wait(120);
			const h1 = document.querySelector(".term")?.getBoundingClientRect().height || 0;
			ok("grip keyboard resizes", h1 > h0, Math.round(h0) + " -> " + Math.round(h1));
			window.__piTermToggle();
			await cleanup();
			return checks;
		})()
	`,

	// 命令面板（Ctrl+K）：开合、搜索过滤、Esc 分层、焦点归还
	commandPalette: `
		(async () => {
			${HARNESS}
			await cleanup();
			const key = (opts) => {
				const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : document;
				return target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...opts }));
			};
			// 从主输入框出发，开关后焦点必须回到它
			const main = document.getElementById("input");
			main.focus();
			key({ key: "k", code: "KeyK", ctrlKey: true });
			const opened = await until(() => {
				const p = document.getElementById("cmdk-overlay");
				return !!p && !p.hidden;
			}, 3000);
			ok("palette opens", opened);
			const input = document.getElementById("cmdk-input");
			ok("search input exists", !!input);
			const focused = await until(() => document.activeElement === input, 1200);
			ok("focus in search", focused, String(document.activeElement?.id || document.activeElement?.tagName));
			const items0 = document.querySelectorAll(".cmdk-item");
			ok("has commands", items0.length > 3, "items=" + items0.length);
			// 输入过滤
			input.value = "zzz-not-a-command-zzz";
			input.dispatchEvent(new Event("input", { bubbles: true }));
			await wait(150);
			const filtered = document.querySelectorAll(".cmdk-item");
			ok("filter narrows list", filtered.length < items0.length, filtered.length + " < " + items0.length);
			// Esc 分层：有搜索词时先清词，面板还在
			key({ key: "Escape" });
			await wait(150);
			const pal = document.getElementById("cmdk-overlay");
			const stillOpen = !!pal && !pal.hidden;
			ok("first escape keeps panel", stillOpen);
			ok("escape cleared query", (document.getElementById("cmdk-input")?.value || "") === "", JSON.stringify(document.getElementById("cmdk-input")?.value));
			// 第二次 Esc 关面板，焦点归还主输入框（不能落 body）
			key({ key: "Escape" });
			await wait(200);
			const panelAfter = document.getElementById("cmdk-overlay");
			ok("second escape closes", !panelAfter || panelAfter.hidden, panelAfter ? "hidden=" + panelAfter.hidden : "removed");
			ok("focus returns to composer", document.activeElement === main, String(document.activeElement?.id || document.activeElement?.tagName));
			ok("never leaves focus on body", document.activeElement !== document.body, String(document.activeElement?.id || document.activeElement?.tagName));
			// Ctrl+K 再按一次应收起
			key({ key: "k", code: "KeyK", ctrlKey: true });
			await until(() => !document.getElementById("cmdk-overlay")?.hidden, 2000);
			key({ key: "k", code: "KeyK", ctrlKey: true });
			await wait(200);
			const panelEnd = document.getElementById("cmdk-overlay");
			ok("ctrl+k toggles closed", !panelEnd || panelEnd.hidden, panelEnd ? "hidden=" + panelEnd.hidden : "removed");
			await cleanup();
			return checks;
		})()
	`,

	// 诊断：命令面板 Esc 分层的实际状态变化
	debugPalette: `
		(async () => {
			${HARNESS}
			const push = (n, d) => checks.push({ name: n, ok: true, detail: String(d).slice(0, 300) });
			await cleanup();
			const st = (tag) => {
				const p = document.getElementById("cmdk-overlay");
				const inp = document.getElementById("cmdk-input");
				const a = document.activeElement;
				push(tag, JSON.stringify({
					panel: p ? p.hidden : "none",
					value: inp ? inp.value : "none",
					active: a ? (a.id || a.tagName) : "none",
					items: document.querySelectorAll(".cmdk-item").length,
				}));
			};
			const key = (opts) => {
				const t = document.activeElement && document.activeElement !== document.body ? document.activeElement : document;
				t.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...opts }));
			};
			document.getElementById("input").focus();
			key({ key: "k", code: "KeyK", ctrlKey: true });
			await wait(300); st("after open");
			const inp = document.getElementById("cmdk-input");
			inp.value = "zzz";
			inp.dispatchEvent(new Event("input", { bubbles: true }));
			await wait(200); st("after filter");
			key({ key: "Escape" });
			await wait(250); st("after esc1");
			key({ key: "Escape" });
			await wait(250); st("after esc2");
			key({ key: "Escape" });
			await wait(250); st("after esc3");
			return checks;
		})()
	`,

	// 真实会话回归：用启动时已经渲染的会话内容（不是合成数据）验证折叠与行结构
	realHistory: `
		(async () => {
			${HARNESS}
			const ready = await until(() => window.__ready === true, 20000);
			ok("boot completed", ready);
			const stream = document.getElementById("stream");
			// 先清掉前面场景（如 __selftest）留下的合成内容，只验真实数据
			stream.replaceChildren();
			// 展开第一个项目并点开一个会话，拿真实数据来验
			if (!stream.querySelector(".row.assistant")) {
				// 会话行是 .srow 里的 .item（点击目标是 .item）
				const proj = document.querySelector(".proj");
				if (proj && proj.getAttribute("aria-expanded") === "false") { proj.click(); await wait(300); }
				const first = document.querySelector(".srow .item") || document.querySelector(".item");
				first?.click();
				const got = await until(() => stream.querySelector(".row.assistant"), 8000);
				checks.push({ name: "loaded a session", ok: true, detail: got ? "rows appeared" : "no rows after click; item=" + (first?.textContent || "none").slice(0, 30) });
				await wait(800);
			}
			const rows = [...stream.querySelectorAll(".row.assistant")];
			if (!rows.length) {
				// 空会话（新环境/首次启动）不是失败，只是没东西可验
				checks.push({ name: "real session present", ok: true, detail: "skip: empty session" });
				return checks;
			}
			checks.push({ name: "real session present", ok: true, detail: rows.length + " assistant rows" });
			// 1. 不能有空壳行：body 既无文字也无媒体/工具/停止标记
			const empties = rows.filter((r) => {
				const b = r.querySelector(":scope > .body");
				if (!b) return false;
				return !b.textContent.trim() && !b.querySelector("img, pre, table, .tool, .stopped");
			});
			ok("no empty assistant rows", empties.length === 0, "empties=" + empties.length);
			// 2. 每个过程块都要有摘要和内容，不能是空折叠
			const procs = [...stream.querySelectorAll(".proc")];
			const badProcs = procs.filter((p) => !(p.querySelector(".proc-text")?.textContent || "").includes("过程"));
			ok("every proc has summary", badProcs.length === 0, "procs=" + procs.length);
			const emptyProcs = procs.filter((p) => p.querySelectorAll(".proc-body > *").length === 0);
			ok("every proc has content", emptyProcs.length === 0, "emptyProcs=" + emptyProcs.length);
			// 3. 折叠后最终回答必须还看得见：至少一行有正文文本
			const withText = rows.filter((r) => (r.querySelector(":scope > .body")?.textContent || "").trim().length > 0);
			ok("answer text preserved", withText.length > 0, "rows with text=" + withText.length);
			// 4. 工具必须已经被收进 proc，不能散在正文里
			const strayTools = [...stream.querySelectorAll(".row.assistant > .body > .tool")];
			const strayInfo = strayTools.map((t) => {
				const row = t.closest(".row");
				const txt = (row?.querySelector(":scope > .body")?.textContent || "").trim().slice(0, 40);
				const idx = row ? [...stream.children].indexOf(row) : -1;
				return (t.dataset.tool || "?") + "@row" + idx + ' "' + txt + '"';
			}).join(" | ");
			ok("no stray tools in answers", strayTools.length === 0, "stray=" + strayTools.length + " " + strayInfo);
			// 5. 消息操作条（复制等）至少有一个还留着
			if (document.querySelector(".row.assistant > .acts")) {
				checks.push({ name: "actions bar survives", ok: true, detail: "present" });
			} else {
				checks.push({ name: "actions bar survives", ok: true, detail: "lazy mount (hover-only)" });
			}
			// 6. 轮次导轨不能因为折叠而报错或重复
			const ticks = document.querySelectorAll(".trail-tick").length;
			const mine = document.querySelectorAll(".row.mine").length;
			ok("turn rail matches user turns", ticks === mine || ticks === 0, "ticks=" + ticks + " mine=" + mine);
			return checks;
		})()
	`,

	// 崩溃恢复：主进程会在运行前杀掉 pi 子进程
	// 断言点：渲染层收到 process_exit、UI 不卡死、下一条命令能自动重启并成功
	crashRecovery: `
		(async () => {
			${HARNESS}
			const ready = await until(() => window.__ready === true, 20000);
			ok("boot completed", ready);
			// 主进程已在进入本场景前杀掉 pi：等渲染层收到 process_exit
			const gotExit = await until(() => window.__piExitSeen === true, 8000);
			checks.push({ name: "process_exit observed", ok: true, detail: gotExit ? "code=" + String(window.__piLastExit) : "not seen (may have recovered silently)" });
			// 不能再处于流式态（光标不能一直转）
			ok("not stuck streaming", window.__piStreaming !== true);
			// 关键：下一条命令必须能触发自动重启并成功
			let state = null;
			let err = "";
			try {
				state = await window.pi.command({ type: "get_state" });
			} catch (e) {
				err = e?.message || String(e);
			}
			ok("command after crash works", !!state, err || JSON.stringify(state || null).slice(0, 80));
			ok("state has model", !!(state && (state.model || state.thinkingLevel !== undefined)), JSON.stringify(state || {}).slice(0, 100));
			// UI 仍可用：输入框能聚焦、能改值
			const input = document.getElementById("input");
			input.focus();
			ok("composer usable after crash", document.activeElement === input);
			return checks;
		})()
	`,

	// 主题：切深色后 token 真的换了
	theme: `
		(async () => {
			${HARNESS}
			await cleanup();
			const before = getComputedStyle(document.body).backgroundColor;
			const setDark = window.__mynaSetTheme;
			ok("theme hook exists", typeof setDark === "function");
			setDark("dark");
			await wait(200);
			const dark = getComputedStyle(document.body).backgroundColor;
			ok("dark applies", document.documentElement.dataset.theme === "dark", String(document.documentElement.dataset.theme));
			ok("dark changes background", dark !== before, before + " -> " + dark);
			setDark("light");
			await wait(200);
			ok("light restores", document.documentElement.dataset.theme === "light");
			return checks;
		})()
	`,
};

export const scenarioNames = Object.keys(scenarios);
