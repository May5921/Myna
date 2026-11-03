// 外观：主题（浅/深/跟随系统）与字号/字体。偏好存 localStorage，boot 脚本先套一次避免闪白。
import { clampFontSize, fontSizeSpec, resolveTheme, sanitizeFontFamily } from "./core/prefs.js";
const THEME_KEY = "myna.theme";
const BODY_KEY = "myna.font.body";
const CODE_KEY = "myna.font.code";
const TERM_KEY = "myna.font.term";
const UI_KEY = "myna.font.ui";
const MONO_KEY = "myna.font.mono";

const BODY_DEFAULT = 14;
const CODE_DEFAULT = 12.5;
const TERM_DEFAULT = 12.5;

const read = (key, fallback) => {
	try {
		const v = localStorage.getItem(key);
		return v == null ? fallback : v;
	} catch {
		return fallback;
	}
};
const write = (key, value) => {
	try {
		localStorage.setItem(key, String(value));
	} catch {}
};
const num = (key, fallback, min, max) => clampFontSize(read(key, fallback), fallback, min, max);
const family = (key) => sanitizeFontFamily(read(key, ""));

export const getThemePref = () => {
	const v = read(THEME_KEY, "system");
	return v === "light" || v === "dark" ? v : "system";
};
export const getFontSizes = () => ({
	body: num(BODY_KEY, BODY_DEFAULT, 10, 22),
	code: num(CODE_KEY, CODE_DEFAULT, 9, 20),
	term: num(TERM_KEY, TERM_DEFAULT, 9, 20),
});

const darkQuery = window.matchMedia?.("(prefers-color-scheme: dark)");
let lastDark = null;

export function isDark() {
	return document.documentElement.dataset.theme === "dark";
}

export function applyTheme() {
	const pref = getThemePref();
	const dark = resolveTheme(pref, !!darkQuery?.matches) === "dark";
	document.documentElement.dataset.theme = dark ? "dark" : "light";
	const size = getFontSizes();
	document.documentElement.style.setProperty("--text-body", `${size.body}px`);
	document.documentElement.style.setProperty("--leading-body", `${Math.round(size.body * 1.65)}px`);
	document.documentElement.style.setProperty("--prose-leading", `${Math.round(size.body * 1.72)}px`);
	document.documentElement.style.setProperty("--code-size", `${size.code}px`);
	document.documentElement.style.setProperty("--term-size", `${size.term}px`);
	const ui = family(UI_KEY);
	const mono = family(MONO_KEY);
	if (ui) document.documentElement.style.setProperty("--ui", `${ui}, -apple-system, "Segoe UI", system-ui, sans-serif`);
	else document.documentElement.style.removeProperty("--ui");
	if (mono) document.documentElement.style.setProperty("--mono", `${mono}, ui-monospace, "Cascadia Mono", Consolas, monospace`);
	else document.documentElement.style.removeProperty("--mono");
	// 只有明暗变化需要重跑 shiki；字号/字体改 CSS 变量即可，别让每个滑块 tick 都重高亮
	if (lastDark !== dark) {
		lastDark = dark;
		window.dispatchEvent(new CustomEvent("myna:theme", { detail: { dark } }));
	}
	return { pref, dark, size };
}

export function setThemePref(pref) {
	if (pref !== "light" && pref !== "dark" && pref !== "system") return applyTheme();
	write(THEME_KEY, pref);
	return applyTheme();
}

export function setFontSize(kind, value) {
	const spec = fontSizeSpec(kind);
	const key = spec.key === "body" ? BODY_KEY : spec.key === "code" ? CODE_KEY : TERM_KEY;
	const n = Number(value);
	if (!Number.isFinite(n)) return getFontSizes();
	write(key, clampFontSize(n, spec.fallback, spec.min, spec.max));
	return applyTheme();
}

export function getFontFamilies() {
	return { ui: read(UI_KEY, ""), mono: read(MONO_KEY, "") };
}

export function setFontFamily(kind, value) {
	write(kind === "ui" ? UI_KEY : MONO_KEY, sanitizeFontFamily(value));
	return applyTheme();
}

let listening = false;
export function initTheme() {
	applyTheme();
	// 开发/截图钩子：不刷新页面直接切主题
	window.__mynaSetTheme = (pref) => {
		const r = setThemePref(pref);
		return { ...r, data: document.documentElement.dataset.theme };
	};
	if (!listening && darkQuery?.addEventListener) {
		darkQuery.addEventListener("change", () => {
			if (getThemePref() === "system") applyTheme();
		});
		listening = true;
	}
}
