// 生成 Windows 安装包（NSIS）：安装后自动创建桌面与开始菜单快捷方式。
// 流程：先把「应用文件 + 运行时依赖 + 内置 pi」摆进 .installer-staging，
// 再交给 electron-builder 打 NSIS（asar 关闭，保持 app:// 按文件路径读取的行为）。
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const staging = join(root, ".installer-staging");
const vendorPi = join(root, "vendor", "pi");
const APP_FILES = ["main.js", "preload.cjs", "index.html", "src", "styles", "assets"];
const RUNTIME_PKGS = ["shiki", "fflate", "pdfjs-dist"];
// pdfjs 只需要渲染层实际 import 的文件，legacy/web/cmaps 都不进包
const PDFJS_KEEP = ["package.json", "build/pdf.mjs", "build/pdf.worker.mjs", "build/pdf.min.mjs", "build/pdf.worker.min.mjs"];

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
execSync(
	"npx electron-builder --win nsis --config.directories.app=.installer-staging --config.directories.output=dist-installer",
	{ cwd: root, stdio: "inherit", env: process.env },
);

const outDir = join(root, "dist-installer");
const setup = readdirSync(outDir).find((f) => f.endsWith(".exe"));
if (!setup) {
	console.error("没有生成安装包");
	process.exit(1);
}
console.log(`完成：${join(outDir, setup)}  ${(statSync(join(outDir, setup)).size / 1024 / 1024).toFixed(1)} MB`);
