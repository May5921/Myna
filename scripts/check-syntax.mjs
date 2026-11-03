import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const skip = new Set(["node_modules", "dist", ".git"]);
const files = [];

function walk(dir) {
	for (const name of readdirSync(dir)) {
		if (skip.has(name)) continue;
		const full = join(dir, name);
		const st = statSync(full);
		if (st.isDirectory()) walk(full);
		else if (name.endsWith(".js") || name.endsWith(".cjs")) files.push(full);
	}
}

walk(root);
let failed = 0;
for (const file of files) {
	try {
		execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
	} catch (e) {
		failed++;
		console.error(`✗ ${relative(root, file)}`);
		console.error(String(e.stderr || e.message).trim());
	}
}
console.log(`checked ${files.length} file(s), ${failed} failure(s)`);
process.exit(failed ? 1 : 0);
