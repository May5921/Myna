// 一键发布：npm run release 0.1.1
// 依次完成：改版本号 → 跑测试 → 打包（installer / portable / zip）→ 提交并打 tag
// → 推送 → 建 GitHub Release → 上传两个产物。
// 需要本机 git 已能 push（凭据从 git credential 取），网络走 git 配置的 http.proxy。
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const version = String(process.argv[2] || "").replace(/^v/, "");
const dry = process.argv.includes("--dry");
if (!/^\d+\.\d+\.\d+$/.test(version)) {
	console.error("用法：npm run release 0.1.1");
	process.exit(1);
}

const REPO = "May5921/Myna";
const pkgPath = join(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const run = (cmd, args, opts = {}) =>
	execFileSync(cmd, args, { cwd: root, stdio: "inherit", ...opts });
const capture = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: "utf8" }).trim();

function gitToken() {
	const out = execFileSync("git", ["credential", "fill"], { input: "protocol=https\nhost=github.com\n\n", encoding: "utf8" });
	const line = out.split("\n").find((l) => l.startsWith("password="));
	return line ? line.slice("password=".length) : "";
}
function proxy() {
	try {
		return capture("git", ["config", "--get", "http.proxy"]);
	} catch {
		return "";
	}
}
function gh(method, url, body, extra = []) {
	const token = gitToken();
	const p = proxy();
	const args = ["-sS", "--max-time", "2400"];
	if (p) args.push("-x", p);
	args.push("-X", method, "-H", `Authorization: Bearer ${token}`, "-H", "Accept: application/vnd.github+json");
	if (body) args.push("-H", "Content-Type", "application/json", "-d", JSON.stringify(body));
	args.push(...extra, url);
	return JSON.parse(execFileSync("curl", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }) || "{}");
}
function upload(assetPath, name) {
	const token = gitToken();
	const p = proxy();
	const args = ["-sS", "--max-time", "2400"];
	if (p) args.push("-x", p);
	args.push(
		"-X", "POST",
		"-H", `Authorization: Bearer ${token}`,
		"-H", "Content-Type: application/octet-stream",
		"--data-binary", `@${assetPath}`,
		`https://uploads.github.com/repos/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
	);
	return JSON.parse(execFileSync("curl", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }) || "{}");
}

let releaseId = 0;

console.log(`\n== 发布 v${version} ==`);
const dirty = capture("git", ["status", "--porcelain"]);
if (dirty) {
	console.error("工作区不干净，先提交再发布：\n" + dirty);
	process.exit(1);
}

console.log("\n[1/7] 更新版本号");
pkg.version = version;
writeFileSync(pkgPath, JSON.stringify(pkg, null, "\t") + "\n");

console.log("\n[2/7] 测试");
run("npm", ["test"], { shell: true });
run("npm", ["run", "check"], { shell: true });

console.log("\n[3/7] 打包安装版");
run("node", ["scripts/build-installer.mjs"]);

console.log("\n[4/7] 打包便携版");
run("node", ["scripts/build-portable.mjs"]);
run("node", ["scripts/build-zip.mjs"]);

console.log("\n[5/7] 校验产物并提交");
const setup = join(root, "dist-installer", `Myna-Setup-${version}.exe`);
const zip = join(root, "dist", `Myna-${version}-win64.zip`);
// 产物不齐就不要打 tag，否则还得手工删
for (const f of [setup, zip]) {
	if (!existsSync(f)) {
		console.error("缺少产物：" + f);
		process.exit(1);
	}
}
run("git", ["add", "package.json"]);
run("git", ["commit", "-m", `chore: 发布 v${version}`]);
run("git", ["tag", `v${version}`]);
const mb = (f) => (statSync(f).size / 1024 / 1024).toFixed(1) + " MB";
console.log(`  ${setup}  ${mb(setup)}`);
console.log(`  ${zip}  ${mb(zip)}`);

if (dry) {
	console.log("\n--dry：到此为止（未 push、未发布）");
	process.exit(0);
}

console.log("\n[6/7] 推送到 GitHub");
run("git", ["push", "origin", "HEAD:main"]);
run("git", ["push", "origin", `v${version}`]);

console.log("\n[7/7] 创建 Release 并上传产物");
const body = [
	`Windows 安装版，双击装好，桌面自动出现 Myna 图标。`,
	"",
	"**不需要安装 Node，也不需要装 pi** —— 安装包内置了一份 pi。第一次使用只要在设置里配好模型和 API key。",
	"",
	"| 文件 | 说明 |",
	"|---|---|",
	`| \`Myna-Setup-${version}.exe\` | 安装版（推荐）：装完桌面/开始菜单有图标，可在「设置 → 应用」里卸载 |`,
	`| \`Myna-${version}-win64.zip\` | 便携版：解压即用，不写注册表，删除即卸载 |`,
	"",
	"**关于「未知发布者」**：exe 未做代码签名，Windows 会提示。点「更多信息 → 仍要运行」即可。",
].join("\n");

const rel = gh("POST", `https://api.github.com/repos/${REPO}/releases`, {
	tag_name: `v${version}`,
	name: `Myna v${version}`,
	body,
	draft: false,
	prerelease: false,
});
releaseId = rel.id;
if (!releaseId) {
	console.error("创建 release 失败：", JSON.stringify(rel).slice(0, 300));
	process.exit(1);
}
console.log("  release id: " + releaseId);

for (const [path, name] of [
	[setup, `Myna-Setup-${version}.exe`],
	[zip, `Myna-${version}-win64.zip`],
]) {
	console.log(`  上传 ${name} …`);
	const a = upload(path, name);
	console.log(a.id ? `    ok ${(a.size / 1048576).toFixed(1)} MB` : "    失败 " + JSON.stringify(a).slice(0, 200));
}

console.log(`\n完成：https://github.com/${REPO}/releases/tag/v${version}`);
