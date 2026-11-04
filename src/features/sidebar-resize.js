// 左侧栏宽度：拖动右缘调整、双击复位、键盘可调，宽度本地持久化。
// 只改 --sidebar-width 这个 token，#app 的 grid 自己会跟着走；
// 不碰 app.js 的折叠逻辑（折叠时 #side display:none，手柄随侧栏一起消失）。
const WIDTH_KEY = "pi-mini.sidebar-width";
const DEFAULT_WIDTH = 275;
const MIN_WIDTH = 200;
const MAX_WIDTH = 460;
// 中间消息列再窄就难读了：窗口变小时优先牺牲侧栏宽度
const MIN_THREAD = 480;
const STEP = 8;
const STEP_LARGE = 32;

const CSS = `
#side { position: relative; }
.sbar-grip {
	position: absolute;
	top: 0;
	bottom: 0;
	right: -3px;
	z-index: 7;
	width: 7px;
	cursor: col-resize;
	touch-action: none;
	background: none;
	border: 0;
	padding: 0;
}
.sbar-grip::after {
	content: "";
	position: absolute;
	top: 0;
	bottom: 0;
	right: 3px;
	width: 1px;
	background: transparent;
	transition: background-color 120ms ease;
}
.sbar-grip:hover::after,
.sbar-grip.is-dragging::after {
	background: var(--line-strong);
}
.sbar-grip:focus-visible {
	outline: none;
}
.sbar-grip:focus-visible::after {
	width: 2px;
	right: 2px;
	background: var(--link);
}
body.sbar-resizing {
	cursor: col-resize;
	user-select: none;
}
body.sbar-resizing * {
	cursor: col-resize !important;
	user-select: none !important;
}
@media (prefers-reduced-motion: reduce) {
	.sbar-grip::after { transition: none; }
}
`;

const clamp = (value) => {
	const room = Math.max(MIN_WIDTH, window.innerWidth - MIN_THREAD);
	const max = Math.min(MAX_WIDTH, room);
	const n = Math.round(Number(value));
	if (!Number.isFinite(n)) return Math.min(DEFAULT_WIDTH, max);
	return Math.max(MIN_WIDTH, Math.min(max, n));
};

const readWidth = () => {
	try {
		const raw = localStorage.getItem(WIDTH_KEY);
		if (raw == null) return DEFAULT_WIDTH;
		const n = Number(raw);
		return Number.isFinite(n) ? n : DEFAULT_WIDTH;
	} catch {
		return DEFAULT_WIDTH;
	}
};

const writeWidth = (width) => {
	try {
		localStorage.setItem(WIDTH_KEY, String(width));
	} catch {}
};

export function init(ctx) {
	const side = document.getElementById("side");
	const app = document.getElementById("app");
	if (!side || !app) return;
	if (side.querySelector(".sbar-grip")) return; // 幂等

	if (!document.head.querySelector('style[data-feature="sidebar-resize"]')) {
		const style = document.createElement("style");
		style.dataset.feature = "sidebar-resize";
		style.textContent = CSS;
		document.head.append(style);
	}

	const root = document.documentElement;
	const setWidth = (value) => {
		const width = clamp(value);
		root.style.setProperty("--sidebar-width", `${width}px`);
		return width;
	};

	// 启动时恢复；首次进入不写回，免得把用户的默认值顶掉
	let width = setWidth(readWidth());

	const grip = document.createElement("button");
	grip.type = "button";
	grip.className = "sbar-grip";
	grip.tabIndex = 0;
	grip.setAttribute("role", "separator");
	grip.setAttribute("aria-orientation", "vertical");
	grip.setAttribute("aria-label", "调整侧栏宽度");
	grip.title = "拖动调整宽度，双击复位，或用方向键微调";
	side.append(grip);

	const syncAria = () => {
		grip.setAttribute("aria-valuenow", String(width));
		grip.setAttribute("aria-valuemin", String(MIN_WIDTH));
		grip.setAttribute("aria-valuemax", String(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - MIN_THREAD))));
	};
	syncAria();

	let drag = null;

	grip.addEventListener("pointerdown", (e) => {
		if (e.button !== 0) return;
		e.preventDefault();
		drag = { startX: e.clientX, startWidth: width, pointerId: e.pointerId };
		grip.classList.add("is-dragging");
		document.body.classList.add("sbar-resizing");
		try {
			grip.setPointerCapture(e.pointerId);
		} catch {}
	});

	grip.addEventListener("pointermove", (e) => {
		if (!drag || e.pointerId !== drag.pointerId) return;
		width = setWidth(drag.startWidth + (e.clientX - drag.startX));
		syncAria();
	});

	const endDrag = (e) => {
		if (!drag) return;
		if (e && e.pointerId !== drag.pointerId) return;
		const pointerId = drag.pointerId;
		drag = null;
		grip.classList.remove("is-dragging");
		document.body.classList.remove("sbar-resizing");
		try {
			grip.releasePointerCapture(pointerId);
		} catch {}
		writeWidth(width);
	};
	grip.addEventListener("pointerup", endDrag);
	grip.addEventListener("pointercancel", endDrag);

	// 双击或 Enter 复位：侧栏宽窄来回拉之后给一条确定性退路
	grip.addEventListener("dblclick", (e) => {
		e.preventDefault();
		width = setWidth(DEFAULT_WIDTH);
		syncAria();
		writeWidth(width);
	});

	grip.addEventListener("keydown", (e) => {
		const step = e.shiftKey ? STEP_LARGE : STEP;
		let next = null;
		if (e.key === "ArrowLeft") next = width - step;
		else if (e.key === "ArrowRight") next = width + step;
		else if (e.key === "Home") next = MIN_WIDTH;
		else if (e.key === "End") next = MAX_WIDTH;
		else if (e.key === "Enter" || e.key === " ") next = DEFAULT_WIDTH;
		if (next === null) return;
		e.preventDefault();
		e.stopPropagation();
		width = setWidth(next);
		syncAria();
		writeWidth(width);
	});

	// 窗口变窄时把侧栏收回可用范围，别把消息列挤没
	let resizeTimer = 0;
	window.addEventListener("resize", () => {
		clearTimeout(resizeTimer);
		resizeTimer = setTimeout(() => {
			const next = setWidth(width);
			if (next !== width) {
				width = next;
				syncAria();
				writeWidth(width);
			} else {
				syncAria();
			}
		}, 120);
	});
}
