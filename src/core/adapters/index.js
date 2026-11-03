// 适配器注册表。用动态 import，缺失的适配器文件不会让整个模块加载失败。
// 契约见 docs/ADAPTER-CONTRACT.md。

const KNOWN = {
	pi: "./pi.js",
};

export function ids() {
	return Object.keys(KNOWN);
}

export async function load(id) {
	const path = KNOWN[id];
	if (!path) throw new Error(`unknown adapter: ${id}`);
	return import(path);
}

export async function create(id, opts) {
	const mod = await load(id);
	if (typeof mod.createAdapter !== "function") {
		throw new Error(`adapter ${id} 缺少 createAdapter`);
	}
	return mod.createAdapter(opts);
}

// 只做"命令是否存在"的探测，不验证登录态。用于启动时自动选后端。
export function detect(commandExists) {
	for (const id of ids()) {
		if (commandExists(id)) return id;
	}
	return null;
}
