import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapPiEvent, createAdapter, caps, id } from "../src/core/adapters/pi.js";

test("pi 事件映射为稳定 IR", () => {
	assert.deepEqual(mapPiEvent({ type: "agent_start" }, "s1"), [{ type: "turn.start", sessionId: "s1" }]);
	assert.deepEqual(mapPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "你好" } }, "s1"), [
		{ type: "text.delta", sessionId: "s1", delta: "你好" },
	]);
	assert.deepEqual(mapPiEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "分析" } }, "s1"), [
		{ type: "reason.delta", sessionId: "s1", delta: "分析" },
	]);
	assert.deepEqual(mapPiEvent({
		type: "tool_execution_end",
		toolCallId: "t1",
		isError: false,
		durationMs: 12,
		result: { content: [{ type: "text", text: "ok" }], details: { diff: "diff" } },
	}, "s1"), [{
		type: "tool.end", sessionId: "s1", toolCallId: "t1", ok: true, output: "ok", diff: "diff", durationMs: 12,
	}]);
	assert.deepEqual(mapPiEvent({ type: "agent_settled", reason: "aborted" }, "s1"), [{
		type: "turn.end", sessionId: "s1", outcome: "aborted",
	}]);
});

test("pi 适配器通过 JSONL 进程完成 start/call/stop", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-adapter-"));
	const fake = join(dir, "fake-pi.mjs");
	const source = `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  const req = JSON.parse(line);
  if (req.type === "get_state") {
    process.stdout.write(JSON.stringify({ id: req.id, type: "response", command: "get_state", success: true, data: { sessionId: "s-test", sessionFile: "f-test" } }) + "\\n");
  } else if (req.type === "prompt") {
    process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "message_end", message: { content: [{ type: "text", text: "hi" }] } }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
    process.stdout.write(JSON.stringify({ id: req.id, type: "response", command: "prompt", success: true, data: {} }) + "\\n");
  }
}
`;
	await writeFile(fake, source, "utf8");
	const events = [];
	const adapter = createAdapter({ cwd: dir, cliPath: fake, nodePath: process.execPath, timeoutMs: 2_000, onEvent: (event) => events.push(event) });
	try {
		const state = await adapter.start();
		assert.equal(state.sessionId, "s-test");
		assert.equal(adapter.sessionId, "s-test");
		const result = await adapter.call({ type: "prompt", text: "hello" });
		assert.equal(typeof result.messageId, "string");
		assert.deepEqual(events.map((event) => event.type), ["turn.start", "text.delta", "text.done", "turn.end"]);
		await adapter.stop();
		await assert.rejects(() => adapter.call({ type: "unknown" }), /unsupported: unknown/);
	} finally {
		await adapter.stop();
		await rm(dir, { recursive: true, force: true });
	}
});

test("pi 适配器暴露能力并拒绝未知命令", async () => {
	assert.equal(id, "pi");
	assert.equal(caps.models, true);
	const adapter = createAdapter({ cwd: process.cwd() });
	await assert.rejects(() => adapter.call({ type: "unknown" }), /unsupported: unknown/);
});
