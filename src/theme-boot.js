// 首屏前套用主题/字号，避免暗色模式闪白。逻辑与 src/theme.js 保持一致，改动两边同步。
(() => {
	try {
		const read = (k, d) => {
			const v = localStorage.getItem(k);
			return v == null ? d : v;
		};
		const pref = read("myna.theme", "system");
		const dark = pref === "dark" || (pref === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
		const root = document.documentElement;
		root.dataset.theme = dark ? "dark" : "light";
		const size = (k, d, min, max) => {
			const n = Number(read(k, d));
			return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n * 2) / 2)) : d;
		};
		const body = size("myna.font.body", 14, 10, 22);
		const code = size("myna.font.code", 12.5, 9, 20);
		const term = size("myna.font.term", 12.5, 9, 20);
		root.style.setProperty("--text-body", `${body}px`);
		root.style.setProperty("--leading-body", `${Math.round(body * 1.65)}px`);
		root.style.setProperty("--prose-leading", `${Math.round(body * 1.72)}px`);
		root.style.setProperty("--code-size", `${code}px`);
		root.style.setProperty("--term-size", `${term}px`);
		const clean = (v) => String(v || "").replace(/[;{}]/g, "").slice(0, 160).trim();
		const ui = clean(read("myna.font.ui", ""));
		const mono = clean(read("myna.font.mono", ""));
		if (ui) root.style.setProperty("--ui", `${ui}, -apple-system, "Segoe UI", system-ui, sans-serif`);
		if (mono) root.style.setProperty("--mono", `${mono}, ui-monospace, "Cascadia Mono", Consolas, monospace`);
	} catch {}
})();
