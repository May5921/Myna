import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// 生成免安装便携版：electron 运行时 + 应用文件 + 运行时依赖（不含 electron 包本身）。
// 只用 Node 内置能力，不引入打包器。

const root = process.cwd();
const electronDist = join(root, "node_modules", "electron", "dist");
const outRoot = join(root, "dist");
const outApp = join(outRoot, "pi-mini");

if (!existsSync(electronDist)) {
	console.error("找不到 node_modules/electron/dist，请先 npm install");
	process.exit(1);
}

console.log("清理 dist …");
rmSync(outRoot, { recursive: true, force: true });
mkdirSync(outApp, { recursive: true });

console.log("复制 Electron 运行时 …");
cpSync(electronDist, outApp, { recursive: true });
rmSync(join(outApp, "resources", "default_app.asar"), { force: true });

console.log("复制应用文件 …");
const appDir = join(outApp, "resources", "app");
mkdirSync(appDir, { recursive: true });
for (const name of ["main.js", "preload.cjs", "index.html", "src", "styles"]) {
	cpSync(join(root, name), join(appDir, name), { recursive: true });
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
delete pkg.devDependencies;
delete pkg.scripts;
writeFileSync(join(appDir, "package.json"), JSON.stringify(pkg, null, "\t"));

console.log("复制运行时依赖（跳过 electron）…");
const skip = new Set(["electron", ".bin", "@electron", "@electron-internal", "@types"]);
const nmOut = join(appDir, "node_modules");
mkdirSync(nmOut, { recursive: true });
for (const name of readdirSync(join(root, "node_modules"))) {
	if (skip.has(name)) continue;
	if (name.startsWith(".")) continue;
	if (!existsSync(join(root, "node_modules", name, "package.json"))) continue;
	cpSync(join(root, "node_modules", name), join(nmOut, name), { recursive: true });
}

writeFileSync(
	join(outRoot, "README.txt"),
	[
		"pi-mini 便携版",
		"",
		"1. 双击 pi-mini/electron.exe 启动。",
		"2. 需要系统 PATH 里有 `pi` 命令（pi CLI）。",
		"3. 配置与会话保存在 %USERPROFILE%\\.pi\\agent 下。",
		"",
		"这个目录可整体拷走；删除即卸载。",
	].join("\n"),
);
console.log("完成：", join(outApp, "electron.exe"));
