// pi 子进程环境的纯函数：只保留 undici 支持的代理协议，丢弃裸 host:port
// 和 socks5h 等会让初始化失败的值。
const PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
const URL_SCHEME = /^(?:https?|socks5?):\/\//i;

export function sanitizePiEnv(input = {}) {
	const env = { ...input };
	for (const key of PROXY_KEYS) {
		const value = env[key];
		if (value && !URL_SCHEME.test(value)) delete env[key];
	}
	return env;
}
