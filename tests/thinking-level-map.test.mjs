import test from "node:test";
import assert from "node:assert/strict";
import { copyThinkingLevelMap, hasThinkingLevelMap, normalizeThinkingLevelMap } from "../src/core/thinking-level-map.js";

test("thinking level map keeps only pi levels and valid provider values", () => {
	assert.deepEqual(normalizeThinkingLevelMap({ off: "disabled", low: "low", medium: null, unknown: "drop", max: 3 }), {
		off: "disabled",
		low: "low",
		medium: null,
	});
});

test("thinking level map falls back to the previous model entry", () => {
	assert.deepEqual(normalizeThinkingLevelMap(undefined, { medium: "balanced" }), { medium: "balanced" });
	assert.deepEqual(copyThinkingLevelMap({ medium: "  balanced  " }), { medium: "balanced" });
	assert.equal(copyThinkingLevelMap({ medium: "" }), undefined);
	assert.equal(hasThinkingLevelMap({ unknown: "x" }), false);
});
