import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rcedit } from "rcedit";

// 生成免安装便携版：Electron 运行时 + 应用文件 + 运行时依赖（不含 electron 包本身）。
// 只用 Node 内置能力 + rcedit（仅用于写 exe 图标/版本信息，不进运行时依赖）。

const root = process.cwd();
const electronDist = join(root, "node_modules", "electron", "dist");
const outRoot = join(root, "dist");
const APP_NAME = "Myna";
const outApp = join(outRoot, APP_NAME);
const EXE = join(outApp, `${APP_NAME}.exe`);

if (!existsSync(electronDist)) {
	console.error("找不到 node_modules/electron/dist，请先 npm install");
	process.exit(1);
}

// 只带上真正运行需要的包（含传递依赖），别把 devDependencies 与整个 pdfjs 文档一起塞进去
const RUNTIME_PKGS = ["shiki", "fflate", "pdfjs-dist"];
function collectDeps(names) {
	const out = new Set();
	const walk = (name) => {
		if (out.has(name)) return;
		const dir = join(root, "node_modules", name);
		const pkgPath = join(dir, "package.json");
		if (!existsSync(pkgPath)) return;
		out.add(name);
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
		for (const dep of Object.keys(pkg.dependencies || {})) walk(dep);
	};
	for (const n of names) walk(n);
	return [...out];
}

// pdfjs 的 legacy/、web/、test 等都不需要；只留渲染层实际 import 的三个文件
const PDFJS_KEEP = ["package.json", "LICENSE", "build/pdf.mjs", "build/pdf.worker.mjs", "build/pdf.worker.min.mjs", "build/pdf.min.mjs"];

console.log("清理 dist …");
rmSync(outRoot, { recursive: true, force: true });
mkdirSync(outApp, { recursive: true });

console.log("复制 Electron 运行时 …");
cpSync(electronDist, outApp, { recursive: true });
rmSync(join(outApp, "resources", "default_app.asar"), { force: true });

console.log("复制应用文件 …");
const appDir = join(outApp, "resources", "app");
mkdirSync(appDir, { recursive: true });
for (const name of ["main.js", "preload.cjs", "index.html", "THIRD-PARTY-NOTICES.md", "src", "styles", "assets"]) {
	cpSync(join(root, name), join(appDir, name), { recursive: true });
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
delete pkg.devDependencies;
delete pkg.scripts;
writeFileSync(join(appDir, "package.json"), JSON.stringify({ ...pkg, name: "myna", productName: APP_NAME }, null, "\t"));

console.log("复制运行时依赖 …");
const nmOut = join(appDir, "node_modules");
mkdirSync(nmOut, { recursive: true });
let total = 0;
for (const name of collectDeps(RUNTIME_PKGS)) {
	const from = join(root, "node_modules", name);
	const to = join(nmOut, name);
	if (name === "pdfjs-dist") {
		for (const rel of PDFJS_KEEP) {
			const f = join(from, rel);
			if (!existsSync(f)) continue;
			mkdirSync(join(to, rel.split("/").slice(0, -1).join("/")), { recursive: true });
			cpSync(f, join(to, rel));
		}
		// 字体和 cmap 是文本抽取以外的高级功能才用，跳过
	} else {
		cpSync(from, to, { recursive: true });
	}
	const size = (() => {
		try {
			let s = 0;
			const walk = (d) => {
				for (const e of readdirSync(d, { withFileTypes: true })) {
					const p = join(d, e.name);
					if (e.isDirectory()) walk(p);
					else s += statSync(p).size;
				}
			};
			walk(to);
			return s;
		} catch {
			return 0;
		}
	})();
	total += size;
	console.log(`  ${name}  ${(size / 1024 / 1024).toFixed(1)} MB`);
}
console.log(`  依赖合计 ${(total / 1024 / 1024).toFixed(1)} MB`);

// 内置 pi：dist/bundle 是自包含的，只需要额外带上 jiti（加载 .ts 扩展用）
console.log("内置 pi …");
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
const piRoot = findPiRoot();
if (!piRoot) {
	console.error("找不到全局安装的 pi，无法生成自带 pi 的便携版。先执行：npm install -g @earendil-works/pi-coding-agent");
	process.exit(1);
} else {
	const piOut = join(appDir, "node_modules", "@earendil-works", "pi-coding-agent");
	mkdirSync(join(piOut, "dist"), { recursive: true });
	cpSync(join(piRoot, "dist", "bundle"), join(piOut, "dist", "bundle"), { recursive: true });
	cpSync(join(piRoot, "package.json"), join(piOut, "package.json"));
	if (existsSync(join(piRoot, "LICENSE"))) cpSync(join(piRoot, "LICENSE"), join(piOut, "LICENSE"));
	// jiti 必须放在 bundle 上层可解析的位置
	const jitiSrc = [join(piRoot, "node_modules", "jiti"), join(root, "node_modules", "jiti")].find((p) => existsSync(p));
	if (jitiSrc) cpSync(jitiSrc, join(nmOut, "jiti"), { recursive: true });
	const size = (() => {
		let total = 0;
		const walk = (d) => {
			for (const e of readdirSync(d, { withFileTypes: true })) {
				const p = join(d, e.name);
				if (e.isDirectory()) walk(p);
				else total += statSync(p).size;
			}
		};
		walk(piOut);
		if (jitiSrc) walk(join(nmOut, "jiti"));
		return total;
	})();
	console.log(`  pi ${readFileSync(join(piRoot, "package.json"), "utf8").match(/"version":[ ]*"([^"]+)"/)?.[1] || ""}  ${(size / 1024 / 1024).toFixed(1)} MB`);
}

console.log("写入 exe 图标与版本信息 …");
const iconPath = join(root, "assets", "icon.ico");
if (existsSync(iconPath)) {
	try {
		// electron.exe 改名后 rcedit 直接作用在这个副本上，不影响 node_modules
		cpSync(join(outApp, "electron.exe"), EXE);
		await rcedit(EXE, {
			icon: iconPath,
			"file-version": pkg.version,
			"product-version": pkg.version,
			"version-string": {
				FileDescription: APP_NAME,
				ProductName: APP_NAME,
				CompanyName: "Myna",
				LegalCopyright: "MIT License",
				OriginalFilename: `${APP_NAME}.exe`,
			},
		});
		rmSync(join(outApp, "electron.exe"), { force: true });
		console.log("  图标/版本写入完成");
	} catch (e) {
		console.warn("  写图标失败（不影响运行）：", e.message);
		if (existsSync(EXE)) rmSync(EXE, { force: true });
	}
} else {
	console.warn("  找不到 assets/icon.ico，跳过");
}

writeFileSync(
	join(outRoot, "README.txt"),
	[
		`${APP_NAME} 便携版`,
		"",
		`1. 双击 ${APP_NAME}/Myna.exe 启动。`,
		"2. 内置 pi，不需要事先安装 Node 或 pi。",
		"3. 配置与会话保存在 %USERPROFILE%\\.pi\\agent 下。",
		"",
		"这个目录可以整体拷走；删除即卸载。",
	].join("\n"),
);
console.log("完成：", EXE);
