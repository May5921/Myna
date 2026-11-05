// 用户轮次导轨（DSH 风格）：#stream 右缘一条细刻度栏，每根刻度对应一轮用户消息。
// 刻度按行在滚动内容里的真实偏移（行顶 / scrollHeight）映射，而不是按序号均分：
// 长回答后面的轮次自然被推得更远，和历史分页后重新渲染的布局一致。
// hover / 键盘聚焦显示「你 + 摘录 + 3/12」，点击把该轮平滑滚入视口并短暂高亮；
// 离视口中线最近的一根刻度用更强的前景色标记。
// 只自注入样式与 DOM（.trail- 前缀、只用 CSS 变量），不改 app.js / base.css，
// 也不写 stream 的 scrollTop 或应用的 stickBottom 状态。
// 更新来源：scroll / window resize / MutationObserver（新行、会话切换、历史分页）/
// ResizeObserver（侧栏、右栏、窗口尺寸），rAF 合帧；无轮询。

const TICK_H = 8;
const EXCERPT_MAX = 160;
const FLASH_MS = 900;

const CSS = `
.trail-rail {
	position: fixed;
	z-index: 4;
	width: 12px;
	pointer-events: none;
}
.trail-rail[hidden] { display: none; }

.trail-tick {
	position: absolute;
	left: 0;
	width: 12px;
	height: ${TICK_H}px;
	padding: 0;
	border: 0;
	border-radius: 4px;
	background: none;
	color: inherit;
	transform: translateY(-50%);
	display: grid;
	place-items: center;
	pointer-events: auto;
	cursor: pointer;
}
.trail-tick::before {
	content: "";
	width: 6px;
	height: 2px;
	border-radius: 999px;
	background: var(--faint);
	opacity: 0.55;
	transition: width 120ms ease, height 120ms ease, background-color 120ms ease, opacity 120ms ease;
}
.trail-tick:hover::before,
.trail-tick:focus-visible::before {
	width: 10px;
	background: var(--text);
	opacity: 1;
}
.trail-tick.trail-on::before {
	width: 10px;
	height: 3px;
	background: var(--text);
	opacity: 1;
}
.trail-tick:focus-visible {
	outline: 1px solid var(--faint);
	outline-offset: -2px;
}

.trail-tip {
	position: absolute;
	right: calc(100% + 10px);
	z-index: 1;
	width: max-content;
	max-width: min(280px, calc(100vw - 80px));
	padding: 8px 10px;
	border: 1px solid var(--line-strong);
	border-radius: 10px;
	background: var(--bg);
	box-shadow: var(--shadow-menu);
	color: var(--text);
	font-size: 12px;
	line-height: 1.55;
	text-align: left;
	opacity: 0;
	visibility: hidden;
	pointer-events: none;
	transition: opacity 90ms ease, visibility 0s linear 90ms;
}
.trail-tip.trail-open {
	opacity: 1;
	visibility: visible;
	transition: opacity 90ms ease;
}
.trail-tip-head {
	display: flex;
	align-items: baseline;
	gap: 10px;
	margin-bottom: 3px;
	font-size: 11px;
	line-height: 1.4;
	color: var(--faint);
}
.trail-tip-who {
	color: var(--text);
	font-weight: 550;
}
.trail-tip-n {
	margin-left: auto;
	font-variant-numeric: tabular-nums;
}
.trail-tip-text {
	white-space: normal;
	overflow-wrap: anywhere;
}

/* 点击定位后闪一下，和右栏会话树的 .row.flash 同一个思路，但用独立类名避免互相清掉定时器 */
.row.trail-flash {
	border-radius: 10px;
	animation: trail-flash 1s ease;
}
@keyframes trail-flash {
	0%, 20% { background-color: var(--line-strong); }
	100% { background-color: transparent; }
}
@media (prefers-reduced-motion: reduce) {
	.trail-tick::before,
	.trail-tip {
		transition: none;
	}
	.row.trail-flash {
		animation: none;
		background-color: var(--line-strong);
	}
}
`;

const installed = new WeakSet();
let cssReady = false;

const reducedMotion = () =>
	typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// 只取用户气泡里的文字；图片/空消息给个占位，别让提示空着。
// 用 :scope > .user 限定直接子节点，避免把操作条按钮的文字混进摘录。
function promptText(row) {
	const bubble = row.querySelector(":scope > .user");
	const raw = bubble ? bubble.textContent : row.textContent;
	const text = String(raw || "").replace(/\s+/g, " ").trim();
	if (!text) return row.querySelector(".user-imgs") ? "（图片消息）" : "（空消息）";
	const chars = Array.from(text);
	return chars.length > EXCERPT_MAX
		? `${chars.slice(0, EXCERPT_MAX).join("").trimEnd()}…`
		: text;
}

export function init(ctx) {
	const stream = ctx?.stream || document.getElementById("stream");
	if (!stream || installed.has(stream)) return; // 幂等
	installed.add(stream);

	if (!cssReady) {
		cssReady = true;
		if (!document.head.querySelector('style[data-feature="turn-rail"]')) {
			const style = document.createElement("style");
			style.dataset.feature = "turn-rail";
			style.textContent = CSS;
			document.head.append(style);
		}
	}

	// ---------- DOM：导轨挂在 body 上，用 fixed 坐标跟随 #stream 视口 ----------
	const rail = document.createElement("div");
	rail.className = "trail-rail";
	rail.hidden = true;
	rail.setAttribute("role", "navigation");
	rail.setAttribute("aria-label", "对话轮次导航");

	const tip = document.createElement("div");
	tip.className = "trail-tip";
	tip.id = "trail-rail-tip";
	tip.setAttribute("role", "tooltip");
	const tipHead = document.createElement("div");
	tipHead.className = "trail-tip-head";
	const tipWho = document.createElement("span");
	tipWho.className = "trail-tip-who";
	tipWho.textContent = "你";
	const tipCount = document.createElement("span");
	tipCount.className = "trail-tip-n";
	const tipText = document.createElement("div");
	tipText.className = "trail-tip-text";
	tipHead.append(tipWho, tipCount);
	tip.append(tipHead, tipText);
	rail.append(tip);
	document.body.append(rail);

	// ---------- 状态 ----------
	const ticks = []; // { btn, row, y, yStr }
	let active = -1;
	let shownFor = -1; // 当前提示对应的刻度序号，-1 = 未显示
	let frame = 0;
	let railTop = "";
	let railH = "";
	let railRight = "";
	const flashTimers = new WeakMap();

	// ---------- 提示 ----------
	function positionTip(y) {
		const h = tip.offsetHeight;
		const viewH = stream.clientHeight;
		const maxTop = Math.max(0, viewH - h);
		const top = Math.min(maxTop, Math.max(0, y - h / 2));
		tip.style.top = `${top.toFixed(1)}px`;
	}

	function showTip(i) {
		const t = ticks[i];
		if (!t?.row || rail.hidden) return;
		shownFor = i;
		tipCount.textContent = `${i + 1}/${ticks.length}`;
		tipText.textContent = promptText(t.row);
		positionTip(t.y);
		tip.classList.add("trail-open");
	}

	function hideTip() {
		shownFor = -1;
		tip.classList.remove("trail-open");
	}

	// ---------- 刻度 ----------
	function syncTicks(rows) {
		while (ticks.length > rows.length) ticks.pop().btn.remove();
		while (ticks.length < rows.length) {
			const i = ticks.length;
			const btn = document.createElement("button");
			btn.type = "button";
			btn.className = "trail-tick";
			btn.setAttribute("aria-label", `跳到第 ${i + 1} 轮`);
			// 提示文本在 focus 时同步写入，读屏会把摘录当作描述念出来
			btn.setAttribute("aria-describedby", tip.id);
			btn.addEventListener("pointerenter", () => showTip(i));
			btn.addEventListener("pointerleave", hideTip);
			btn.addEventListener("focus", () => showTip(i));
			btn.addEventListener("blur", hideTip);
			btn.addEventListener("click", () => jumpTo(i));
			rail.append(btn);
			ticks.push({ btn, row: null, y: 0, yStr: "" });
		}
		for (let i = 0; i < rows.length; i++) {
			const t = ticks[i];
			t.row = rows[i];
			const label = `跳到第 ${i + 1} 轮`;
			if (t.btn.getAttribute("aria-label") !== label) t.btn.setAttribute("aria-label", label);
		}
	}

	function setActive(i) {
		if (i === active) return;
		const old = active >= 0 ? ticks[active] : null;
		if (old) {
			old.btn.classList.remove("trail-on");
			old.btn.removeAttribute("aria-current");
		}
		active = i;
		const cur = i >= 0 ? ticks[i] : null;
		if (cur) {
			cur.btn.classList.add("trail-on");
			cur.btn.setAttribute("aria-current", "true");
		}
	}

	function jumpTo(i) {
		const row = ticks[i]?.row;
		if (!row || !row.isConnected) return;
		// 不碰 stream.scrollTop / stickBottom：交给浏览器滚动，应用的 scroll 处理照常生效
		row.scrollIntoView({
			block: "center",
			inline: "nearest",
			behavior: reducedMotion() ? "auto" : "smooth",
		});
		const prev = flashTimers.get(row);
		if (prev) clearTimeout(prev);
		row.classList.remove("trail-flash");
		void row.offsetWidth; // 重启动画
		row.classList.add("trail-flash");
		flashTimers.set(
			row,
			setTimeout(() => {
				row.classList.remove("trail-flash");
				flashTimers.delete(row);
			}, FLASH_MS),
		);
	}

	// ---------- 布局 ----------
	function update() {
		frame = 0;
		if (!rail.isConnected) document.body.append(rail);

		const rows = [...stream.querySelectorAll(".row.mine")];
		if (rows.length < 2) {
			// 空记录 / 只有一轮：导轨没有意义。先同步掉旧刻度，否则会话切换后
			// 会留下上一份历史的刻度（e2e 曾出现 ticks=4 / mine=3）。
			syncTicks(rows);
			hideTip();
			setActive(-1);
			rail.hidden = true;
			return;
		}

		const rect = stream.getBoundingClientRect();
		const viewH = stream.clientHeight;
		if (rect.width < 1 || viewH < 1) {
			// 布局暂时不可测量时也要清掉多余刻度，避免恢复后新旧刻度叠加
			syncTicks(rows);
			hideTip();
			rail.hidden = true;
			return;
		}

		syncTicks(rows);
		rail.hidden = false;

		// fixed 坐标：跟随 #stream 的视口矩形；右缘再让开滚动条（右栏打开时 rect 已经缩进）
		const sbw = Math.max(0, stream.offsetWidth - stream.clientWidth);
		const overflowing = stream.scrollHeight > viewH + 1;
		const gutter = sbw > 0 ? sbw : overflowing ? 10 : 0;
		const topStr = `${rect.top.toFixed(1)}px`;
		const hStr = `${viewH}px`;
		const rStr = `${Math.max(2, window.innerWidth - rect.right + gutter + 2).toFixed(1)}px`;
		if (topStr !== railTop) {
			railTop = topStr;
			rail.style.top = topStr;
		}
		if (hStr !== railH) {
			railH = hStr;
			rail.style.height = hStr;
		}
		if (rStr !== railRight) {
			railRight = rStr;
			rail.style.right = rStr;
		}

		// 行顶在「滚动内容」坐标系里的位置：视口内偏移 + 已滚过的距离
		const scrollTop = stream.scrollTop;
		const total = Math.max(1, stream.scrollHeight);
		const pad = TICK_H / 2;
		const track = Math.max(0, viewH - TICK_H);
		const centers = new Array(rows.length);
		for (let i = 0; i < rows.length; i++) {
			const r = rows[i].getBoundingClientRect();
			const top = r.top - rect.top + scrollTop;
			centers[i] = top + r.height / 2;
			const ratio = Math.min(1, Math.max(0, top / total));
			const t = ticks[i];
			t.y = pad + ratio * track;
			const yStr = t.y.toFixed(2);
			if (yStr !== t.yStr) {
				t.yStr = yStr;
				t.btn.style.top = `${yStr}px`;
			}
		}

		// 离视口中线最近的一轮用更强的前景色
		const anchor = scrollTop + viewH / 2;
		let best = 0;
		let bestDist = Infinity;
		for (let i = 0; i < centers.length; i++) {
			const d = Math.abs(centers[i] - anchor);
			if (d < bestDist) {
				bestDist = d;
				best = i;
			}
		}
		setActive(best);

		if (shownFor >= 0) {
			if (shownFor < ticks.length) positionTip(ticks[shownFor].y);
			else hideTip();
		}
	}

	function schedule() {
		if (frame) return;
		frame = requestAnimationFrame(update);
	}

	// ---------- 触发源 ----------
	stream.addEventListener("scroll", schedule, { passive: true });
	window.addEventListener("resize", schedule, { passive: true });
	// 图片解码后行高会变，但没有 DOM 变更事件
	stream.addEventListener("load", schedule, true);
	// 新用户行 / 新助手行 / clearStream 的 innerHTML="" / history 分页的 replaceChildren
	// 都是 #stream 的直接子节点变化；不观察子树，流式 token 不会打醒导轨
	const mo = new MutationObserver(schedule);
	mo.observe(stream, { childList: true });
	// 侧栏折叠、右栏开关（margin-right 过渡）、窗口缩放都会改 #stream 的盒子
	const ro = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
	ro?.observe(stream);
	schedule();
}
