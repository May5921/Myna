// 更新包的纯逻辑：版本比较、GitHub release 资产选择、SHA256 校验。
// 不依赖 Electron，node:test 可直接覆盖。
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export function compareVersions(a, b) {
	const parse = (v) => {
		const raw = String(v || "").replace(/^v/i, "").trim();
		const [core, ...pre] = raw.split("-");
		return {
			nums: core.split(".").map((x) => parseInt(x, 10) || 0),
			pre: pre.join("-"),
		};
	};
	const x = parse(a);
	const y = parse(b);
	for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
		const d = (x.nums[i] || 0) - (y.nums[i] || 0);
		if (d) return d > 0 ? 1 : -1;
	}
	// 正式版高于同号 prerelease；两个 prerelease 按字符串比较
	if (x.pre && !y.pre) return -1;
	if (!x.pre && y.pre) return 1;
	if (x.pre === y.pre) return 0;
	return x.pre > y.pre ? 1 : -1;
}

export function isNewerVersion(current, latest) {
	return compareVersions(latest, current) > 0;
}

// GitHub release assets: [{ name, browser_download_url, size }]
export function selectWindowsAssets(assets, version) {
	const list = Array.isArray(assets) ? assets : [];
	const want = `Myna-Setup-${String(version || "").replace(/^v/i, "")}.exe`;
	const installer =
		list.find((a) => a?.name === want) ||
		list.find((a) => /^Myna-Setup-.+\.exe$/i.test(String(a?.name || "")));
	if (!installer) return { installer: null, checksum: null };
	const checksum =
		list.find((a) => a?.name === `${installer.name}.sha256`) ||
		list.find((a) => /\.sha256$/i.test(String(a?.name || "")) && String(a.name).startsWith(installer.name.replace(/\.exe$/i, ""))) ||
		null;
	return { installer, checksum };
}

// 支持 "hash  filename"、"hash *filename"、裸 hash；返回小写 hex 或 null。
export function parseSha256(text, filename = "") {
	const lines = String(text || "").split(/\r?\n/);
	const target = String(filename || "").trim().toLowerCase();
	for (const line of lines) {
		const m = /^\s*([a-fA-F0-9]{64})\s*\*?(.*)$/.exec(line);
		if (!m) continue;
		const name = m[2].trim().toLowerCase();
		if (!target || !name || name === target || name.endsWith(`/${target}`)) return m[1].toLowerCase();
	}
	return null;
}

export function sha256File(path) {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", () => resolve(hash.digest("hex")));
	});
}

export async function verifySha256File(path, expected) {
	const want = String(expected || "").trim().toLowerCase();
	if (!/^[a-f0-9]{64}$/.test(want)) return false;
	const got = await sha256File(path);
	return got === want;
}
