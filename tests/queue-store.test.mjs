import { test } from "node:test";
import assert from "node:assert/strict";

import {
	QUEUE_STORE_MAX,
	QUEUE_STORE_NEW,
	parseQueueStore,
	queueStoreKey,
} from "../src/core/queue-store.js";

test("queueStoreKey 按会话分桶，空会话落到 _new", () => {
	assert.equal(queueStoreKey("C:/work/session.jsonl"), "pi-mini.queue.C:/work/session.jsonl");
	assert.equal(queueStoreKey("  C:/work/session.jsonl  "), "pi-mini.queue.C:/work/session.jsonl");
	assert.equal(queueStoreKey(""), QUEUE_STORE_NEW);
	assert.equal(queueStoreKey(null), QUEUE_STORE_NEW);
});

test("parseQueueStore 容忍脏数据并跳过空文本", () => {
	assert.deepEqual(parseQueueStore(null), []);
	assert.deepEqual(parseQueueStore(""), []);
	assert.deepEqual(parseQueueStore("not json"), []);
	assert.deepEqual(parseQueueStore('{"text":"x"}'), []);
	assert.deepEqual(
		parseQueueStore(JSON.stringify([{ text: "a" }, { text: "   " }, { text: 2 }, null, { text: " b " }])),
		[{ text: "a" }, { text: " b " }],
	);
});

test("parseQueueStore 最多保留 QUEUE_STORE_MAX 条", () => {
	const rows = Array.from({ length: QUEUE_STORE_MAX + 10 }, (_, i) => ({ text: `q${i}` }));
	const parsed = parseQueueStore(JSON.stringify(rows));
	assert.equal(parsed.length, QUEUE_STORE_MAX);
	assert.equal(parsed[0].text, "q0");
	assert.equal(parseQueueStore(JSON.stringify(rows), 3).length, 3);
});
