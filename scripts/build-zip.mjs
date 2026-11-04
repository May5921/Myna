import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { readFileSync } from "node:fs";

// 把 dist/Myna 打成 zip（Windows 用 PowerShell Compress-Archive，不引入第三方打包依赖）。
// 需要先跑 npm run build:portable。

const root = process.cwd();
const src = join(root, "dist", "Myna");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const out = join(root, "dist", `Myna-${pkg.version}-win64.zip`);

if (!existsSync(src)) {
	console.error("找不到 dist/Myna，请先 npm run build:portable");
	process.exit(1);
}

if (process.platform !== "win32") {
	console.log("当前不是 Windows，跳过 zip 打包（便携版目录已生成）。");
	process.exit(0);
}

console.log("压缩 dist/Myna …");
execFileSync(
	"powershell",
	["-NoProfile", "-Command", `Compress-Archive -Path '${src}' -DestinationPath '${out}' -Force`],
	{ stdio: "inherit" },
);

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
console.log(`完成：${out}  ${mb(statSync(out).size)}`);
