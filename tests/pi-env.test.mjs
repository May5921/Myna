import test from "node:test";
import assert from "node:assert/strict";

import { sanitizePiEnv } from "../src/core/pi-env.js";

test("sanitizePiEnv removes malformed proxy values without mutating input", () => {
	const input = {
		HTTP_PROXY: "127.0.0.1:7890",
		HTTPS_PROXY: "https://proxy.example.test:8443",
		NO_PROXY: "localhost",
	};
	const output = sanitizePiEnv(input);

	assert.equal(output.HTTP_PROXY, undefined);
	assert.equal(output.HTTPS_PROXY, input.HTTPS_PROXY);
	assert.equal(output.NO_PROXY, "localhost");
	assert.equal(input.HTTP_PROXY, "127.0.0.1:7890");
});

test("sanitizePiEnv preserves proxy schemes supported by the caller", () => {
	const env = sanitizePiEnv({
		HTTP_PROXY: "http://127.0.0.1:7890",
		ALL_PROXY: "socks5://127.0.0.1:1080",
		HTTPS_PROXY: "socks5h://127.0.0.1:1080",
	});

	assert.equal(env.HTTP_PROXY, "http://127.0.0.1:7890");
	assert.equal(env.ALL_PROXY, "socks5://127.0.0.1:1080");
	assert.equal(env.HTTPS_PROXY, undefined);
});
