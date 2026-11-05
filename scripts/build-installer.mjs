// 生成 Windows 安装包（NSIS）：安装后自动创建桌面与开始菜单快捷方式。
// 流程：先把「应用文件 + 运行时依赖 + 内置 pi」摆进 .installer-staging，
// 再交给 electron-builder 打 NSIS（asar 关闭，保持 app:// 按文件路径读取的行为）。
import { execSync, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const staging = join(root, ".installer-staging");
const vendorPi = join(root, "vendor", "pi");
const APP_FILES = ["main.js", "preload.cjs", "index.html", "THIRD-PARTY-NOTICES.md", "src", "styles", "assets"];
const RUNTIME_PKGS = ["shiki", "fflate", "pdfjs-dist"];
// pdfjs 只需要渲染层实际 import 的文件，legacy/web/cmaps 都不进包
const PDFJS_KEEP = ["package.json", "LICENSE", "build/pdf.mjs", "build/pdf.worker.mjs", "build/pdf.min.mjs", "build/pdf.worker.min.mjs"];

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function collectDeps(names) {
	const out = new Set();
	const walk = (name) => {
		if (out.has(name)) return;
		const pkgPath = join(root, "node_modules", name, "package.json");
		if (!existsSync(pkgPath)) return;
		out.add(name);
		const p = JSON.parse(readFileSync(pkgPath, "utf8"));
		for (const dep of Object.keys(p.dependencies || {})) walk(dep);
	};
	for (const n of names) walk(n);
	return [...out];
}

function findPiRoot() {
	const roots = [];
	try {
		roots.push(execSync("npm root -g", { encoding: "utf8", windowsHide: true }).trim());
	} catch {}
	if (process.env.APPDATA) roots.push(join(process.env.APPDATA, "npm", "node_modules"));
	for (const r of roots) {
		const p = join(r, "@earendil-works", "pi-coding-agent");
		if (existsSync(join(p, "dist", "bundle", "cli.js"))) return p;
	}
	return null;
}

function dirSize(d) {
	let total = 0;
	const walk = (p) => {
		for (const e of readdirSync(p, { withFileTypes: true })) {
			const f = join(p, e.name);
			if (e.isDirectory()) walk(f);
			else total += statSync(f).size;
		}
	};
	try {
		walk(d);
	} catch {}
	return total;
}

console.log("准备 staging …");
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

for (const name of APP_FILES) {
	cpSync(join(root, name), join(staging, name), { recursive: true });
}

const nm = join(staging, "node_modules");
mkdirSync(nm, { recursive: true });
for (const name of collectDeps(RUNTIME_PKGS)) {
	const from = join(root, "node_modules", name);
	const to = join(nm, name);
	if (name === "pdfjs-dist") {
		for (const rel of PDFJS_KEEP) {
			if (!existsSync(join(from, rel))) continue;
			mkdirSync(join(to, rel.split("/").slice(0, -1).join("/")), { recursive: true });
			cpSync(join(from, rel), join(to, rel));
		}
	} else {
		cpSync(from, to, { recursive: true });
	}
}

const piRoot = findPiRoot();
if (!piRoot) {
	console.error("找不到全局安装的 pi，无法内置。先执行：npm install -g @earendil-works/pi-coding-agent");
	process.exit(1);
}
// pi 不进 node_modules：electron-builder 的依赖收集会把它剔掉，走 extraResources 更可控
rmSync(vendorPi, { recursive: true, force: true });
mkdirSync(join(vendorPi, "dist"), { recursive: true });
cpSync(join(piRoot, "dist", "bundle"), join(vendorPi, "dist", "bundle"), { recursive: true });
cpSync(join(piRoot, "package.json"), join(vendorPi, "package.json"));
if (existsSync(join(piRoot, "LICENSE"))) cpSync(join(piRoot, "LICENSE"), join(vendorPi, "LICENSE"));
const jitiSrc = [join(piRoot, "node_modules", "jiti"), join(root, "node_modules", "jiti")].find((p) => existsSync(p));
// extraResources 会过滤 node_modules，改用 lib/jiti + 运行时 NODE_PATH 指过去
if (jitiSrc) cpSync(jitiSrc, join(vendorPi, "lib", "jiti"), { recursive: true });

// electron-builder 读 staging 里的 package.json 决定入口和版本
writeFileSync(
	join(staging, "package.json"),
	JSON.stringify(
		{
			name: "myna",
			productName: "Myna",
			version: pkg.version,
			description: pkg.description,
			main: "main.js",
			license: pkg.license,
			author: "May5921",
			dependencies: { shiki: pkg.dependencies.shiki, fflate: pkg.dependencies.fflate, "pdfjs-dist": pkg.dependencies["pdfjs-dist"] },
		},
		null,
		"\t",
	),
);
console.log(`  app + deps + pi  ${(dirSize(staging) / 1024 / 1024).toFixed(1)} MB`);

// electron-builder 首次会下载 NSIS / winCodeSign，走 git 里配好的同一个代理
const proxy = (() => {
	try {
		return execSync("git config --get http.proxy", { encoding: "utf8" }).trim();
	} catch {
		return "";
	}
})();
if (proxy) {
	process.env.HTTP_PROXY = proxy;
	process.env.HTTPS_PROXY = proxy;
	process.env.http_proxy = proxy;
	process.env.https_proxy = proxy;
}

console.log("调用 electron-builder 生成 NSIS 安装包 …（首次需要下载工具链）");
const builderArgs = [
	"--win",
	"nsis",
	"--config.directories.app=.installer-staging",
	"--config.directories.output=dist-installer",
	// release.mjs 负责上传；这里绝不自动 publish
	"--publish",
	"never",
];

// Azure Trusted Signing：electron-builder 26 支持 --config.win.azureSignOptions.*
// 身份验证走 Azure Identity 环境变量（AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET）。
const azure = {
	endpoint: process.env.AZURE_TRUSTED_SIGNING_ENDPOINT,
	profile: process.env.AZURE_TRUSTED_SIGNING_PROFILE,
	account: process.env.AZURE_TRUSTED_SIGNING_ACCOUNT,
	publisher: process.env.AZURE_TRUSTED_SIGNING_PUBLISHER,
};
const azureReady = Object.values(azure).every(Boolean);
if (azureReady) {
	console.log("使用 Azure Trusted Signing:", azure.account, azure.profile);
	builderArgs.push(
		`--config.win.azureSignOptions.endpoint=${azure.endpoint}`,
		`--config.win.azureSignOptions.certificateProfileName=${azure.profile}`,
		`--config.win.azureSignOptions.codeSigningAccountName=${azure.account}`,
		`--config.win.azureSignOptions.publisherName=${azure.publisher}`,
	);
} else if (process.env.CSC_LINK || process.env.WIN_CSC_LINK) {
	console.log("使用传统证书签名（CSC_LINK）");
} else {
	console.warn("⚠ 未配置代码签名：产物会触发 Windows SmartScreen。见 docs/SIGNING.md");
}

// 直接调用本地 CLI，避免 Windows + Node 24 下 spawnSync npx.cmd 返回 EINVAL，
// 也避免构建结果受 PATH 中 npx 版本影响。
const builderCli = join(root, "node_modules", "electron-builder", "cli.js");
if (!existsSync(builderCli)) {
	console.error("找不到本地 electron-builder CLI，请先 npm install");
	process.exit(1);
}
execFileSync(process.execPath, [builderCli, ...builderArgs], {
	cwd: root,
	stdio: "inherit",
	env: process.env,
});

const outDir = join(root, "dist-installer");
const expectedSetup = `Myna-Setup-${pkg.version}.exe`;
const setup = existsSync(join(outDir, expectedSetup))
	? expectedSetup
	: readdirSync(outDir).find((f) => f.endsWith(".exe"));
if (!setup) {
	console.error("没有生成安装包");
	process.exit(1);
}
if (setup !== expectedSetup) {
	console.error(`安装包版本不匹配：需要 ${expectedSetup}，实际找到 ${setup}`);
	process.exit(1);
}
console.log(`完成：${join(outDir, setup)}  ${(statSync(join(outDir, setup)).size / 1024 / 1024).toFixed(1)} MB`);
