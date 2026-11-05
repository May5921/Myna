import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	compareVersions,
	isNewerVersion,
	parseSha256,
	selectWindowsAssets,
	sha256File,
	verifySha256File,
} from "../src/core/updater.js";

test("compareVersions 处理 v 前缀、位数和 prerelease", () => {
	assert.equal(compareVersions("0.1.1", "0.1.2"), -1);
	assert.equal(compareVersions("v0.2.0", "0.1.9"), 1);
	assert.equal(compareVersions("1.0", "1.0.0"), 0);
	assert.equal(compareVersions("1.0.0-beta.1", "1.0.0"), -1);
	assert.equal(compareVersions("1.0.0", "1.0.0-beta.1"), 1);
	assert.equal(isNewerVersion("0.1.1", "0.1.2"), true);
	assert.equal(isNewerVersion("0.1.2", "0.1.2"), false);
});

test("selectWindowsAssets 只选安装包和对应 sha256", () => {
	const assets = [
		{ name: "Myna-0.2.0-win64.zip", browser_download_url: "zip" },
		{ name: "Myna-Setup-0.2.0.exe", browser_download_url: "exe" },
		{ name: "Myna-Setup-0.2.0.exe.sha256", browser_download_url: "sha" },
	];
	const picked = selectWindowsAssets(assets, "0.2.0");
	assert.equal(picked.installer.browser_download_url, "exe");
	assert.equal(picked.checksum.browser_download_url, "sha");

	// 没有精确版本时退回第一个 Setup exe
	assert.equal(selectWindowsAssets(assets, "9.9.9").installer.name, "Myna-Setup-0.2.0.exe");
	assert.deepEqual(selectWindowsAssets([], "0.2.0"), { installer: null, checksum: null });
});

test("parseSha256 支持 hash 文件名、星号和裸 hash", () => {
	const hash = "A".repeat(64);
	assert.equal(parseSha256(`${hash}  Myna-Setup-0.2.0.exe`), hash.toLowerCase());
	assert.equal(parseSha256(`${hash} *Myna-Setup-0.2.0.exe\n`, "Myna-Setup-0.2.0.exe"), hash.toLowerCase());
	assert.equal(parseSha256(hash), hash.toLowerCase());
	assert.equal(parseSha256("not a hash"), null);
	assert.equal(parseSha256(`${hash}  other.exe`, "Myna-Setup-0.2.0.exe"), null);
});

test("sha256File / verifySha256File 校验真实文件", async () => {
	const dir = mkdtempSync(join(tmpdir(), "myna-updater-"));
	const file = join(dir, "payload.bin");
	try {
		writeFileSync(file, "hello update");
		const got = await sha256File(file);
		assert.match(got, /^[a-f0-9]{64}$/);
		assert.equal(await verifySha256File(file, got), true);
		assert.equal(await verifySha256File(file, got.toUpperCase()), true);
		assert.equal(await verifySha256File(file, "0".repeat(64)), false);
		assert.equal(await verifySha256File(file, "bad"), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
