// 外观偏好的纯函数：给 theme.js、theme-boot.js 和测试共用，不碰 DOM。
export function resolveTheme(pref, systemDark) {
	if (pref === "light") return "light";
	if (pref === "dark") return "dark";
	return systemDark ? "dark" : "light";
}

export function clampFontSize(value, fallback, min, max) {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.round(n * 2) / 2));
}

export function sanitizeFontFamily(value) {
	return String(value || "")
		.replace(/[;{}]/g, "")
		.slice(0, 160)
		.trim();
}

export function fontSizeSpec(kind) {
	if (kind === "body") return { key: "body", fallback: 14, min: 10, max: 22 };
	if (kind === "code") return { key: "code", fallback: 12.5, min: 9, max: 20 };
	return { key: "term", fallback: 12.5, min: 9, max: 20 };
}
