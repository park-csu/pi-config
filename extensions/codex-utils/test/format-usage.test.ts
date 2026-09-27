import assert from "node:assert/strict";
import test from "node:test";
import type { CodexUsageSnapshot, LimitWindow } from "pi-codex-status";
import { formatUsageStatus, formatUsageStatusline } from "../format-usage.js";

function window(seconds: number | undefined, leftPercent: number): LimitWindow {
	return {
		usedPercent: 100 - leftPercent,
		leftPercent,
		...(seconds === undefined ? {} : { windowSeconds: seconds }),
		resetAt: 1_800_000_000,
	};
}

function snapshot(primary?: LimitWindow, secondary?: LimitWindow): CodexUsageSnapshot {
	return {
		schemaVersion: 1, source: "api", fetchedAt: "2026-09-27T09:00:00Z",
		account: { plan: "pro" },
		defaultLimit: { id: "codex", name: "Codex", ...(primary ? { primary } : {}), ...(secondary ? { secondary } : {}) },
		additionalLimits: [],
	};
}

test("a weekly-only primary window is never labeled 5h", () => {
	const usage = snapshot(window(604_800, 96));
	const boxed = formatUsageStatus(usage);
	assert.match(boxed, /Weekly limit:\s+\[.*\] 96% left/);
	assert.doesNotMatch(boxed, /5h limit:/);
	assert.match(formatUsageStatusline(usage), /^Codex 7d:96% left pro /);
	assert.doesNotMatch(formatUsageStatusline(usage), /5h:/);
	const widths = boxed.split("\n").map((line) => line.length);
	assert.equal(new Set(widths).size, 1, "relabeling must preserve box alignment");
});

test("windows are labeled by duration even when primary and secondary swap", () => {
	const usage = snapshot(window(604_800, 74), window(18_000, 38));
	const boxed = formatUsageStatus(usage);
	assert.match(boxed, /Weekly limit:\s+\[.*\] 74% left/);
	assert.match(boxed, /5h limit:\s+\[.*\] 38% left/);
	assert.match(formatUsageStatusline(usage), /^Codex 7d:74% left 5h:38% left/);
});

test("unknown durations do not inherit positional 5h/weekly labels", () => {
	const usage = snapshot(window(undefined, 50), window(12 * 3600, 60));
	usage.additionalLimits = [{ id: "spark", name: "Spark", primary: window(604_800, 90) }];
	const boxed = formatUsageStatus(usage);
	assert.match(boxed, /Primary limit:\s+\[.*\] 50% left/);
	assert.match(boxed, /12h limit:\s+\[.*\] 60% left/);
	assert.match(boxed, /Spark limit:[^\n]*\n│\s+Weekly limit:\s+\[.*\] 90% left/);
	assert.doesNotMatch(boxed, /5h limit:/);
	assert.match(formatUsageStatusline(usage), /^Codex Primary:50% left 12h:60% left/);
});

test("an actual 5-hour window keeps its 5h label", () => {
	const usage = snapshot(window(18_000, 88), window(604_800, 95));
	assert.match(formatUsageStatus(usage), /5h limit:\s+\[.*\] 88% left/);
	assert.match(formatUsageStatusline(usage), /^Codex 5h:88% left 7d:95% left/);
});
