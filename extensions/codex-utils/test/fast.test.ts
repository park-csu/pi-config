import assert from "node:assert/strict";
import test from "node:test";
import {
	addFastServiceTier,
	FAST_SERVICE_TIER,
	FAST_STATE_TYPE,
	quotaTone,
	restoreFastState,
	selectUsageWindow,
} from "../fast.js";

test("pi-codex-utils restores the latest Fast mode branch entry", () => {
	const entries = [
		{ type: "custom", customType: FAST_STATE_TYPE, data: { enabled: true } },
		{ type: "message", message: { role: "user" } },
		{ type: "custom", customType: FAST_STATE_TYPE, data: { enabled: false } },
	];

	assert.equal(restoreFastState(entries), false);
	assert.equal(restoreFastState([]), false);
});

test("addFastServiceTier returns a patched copy", () => {
	const payload = { model: "gpt-5.5", service_tier: "default" };
	const result = addFastServiceTier(payload);

	assert.deepEqual(result, { model: "gpt-5.5", service_tier: FAST_SERVICE_TIER });
	assert.equal(payload.service_tier, "default");
});

test("addFastServiceTier leaves non-object payloads unchanged", () => {
	assert.equal(addFastServiceTier(null), null);
	assert.equal(addFastServiceTier("payload"), "payload");
});

test("selectUsageWindow prefers a reported 5-hour window", () => {
	assert.deepEqual(
		selectUsageWindow({
			primary: { leftPercent: 71, windowSeconds: 7 * 24 * 3600 },
			secondary: { leftPercent: 42, windowSeconds: 5 * 3600 },
		}),
		{ label: "5h", leftPercent: 42 },
	);
});

test("selectUsageWindow falls back to a reported weekly window", () => {
	assert.deepEqual(
		selectUsageWindow({
			primary: { leftPercent: 71, windowSeconds: 7 * 24 * 3600 },
		}),
		{ label: "weekly", leftPercent: 71 },
	);
});

test("selectUsageWindow does not guess from primary/secondary position", () => {
	assert.equal(
		selectUsageWindow({
			primary: { leftPercent: 71 },
		}),
		undefined,
	);
});

test("quotaTone changes from normal to yellow to red", () => {
	assert.equal(quotaTone(71), "dim");
	assert.equal(quotaTone(21), "dim");
	assert.equal(quotaTone(20), "warning");
	assert.equal(quotaTone(11), "warning");
	assert.equal(quotaTone(10), "error");
	assert.equal(quotaTone(0), "error");
});
