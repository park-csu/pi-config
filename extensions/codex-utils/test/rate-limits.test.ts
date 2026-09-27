import assert from "node:assert/strict";
import test from "node:test";
import { parseCodexRateLimitEvent } from "pi-codex-status";
import { mergeCodexUsageSnapshots } from "../rate-limits.js";

test("Codex rate-limit events map to the displayed 5-hour window", () => {
	const snapshot = parseCodexRateLimitEvent({
		type: "codex.rate_limits",
		plan_type: "pro",
		rate_limits: {
			primary: { used_percent: 42, window_minutes: 300, reset_at: 1_800_000_000 },
			secondary: { used_percent: 12, window_minutes: 10080, reset_at: 1_801_000_000 },
		},
		credits: { has_credits: false, unlimited: false, balance: "0" },
	});

	assert.equal(snapshot?.defaultLimit?.primary?.leftPercent, 58);
	assert.equal(snapshot?.defaultLimit?.primary?.windowSeconds, 18_000);
	assert.equal(snapshot?.defaultLimit?.secondary?.leftPercent, 88);
	assert.equal(snapshot?.account.plan, "pro");
});

test("event snapshots preserve API metadata and additional limits", () => {
	const existing = {
		schemaVersion: 1 as const,
		source: "api" as const,
		fetchedAt: "2026-01-01T00:00:00.000Z",
		account: { email: "user@example.com", plan: "pro" },
		defaultLimit: {
			id: "codex",
			name: "Codex",
			primary: { usedPercent: 20, leftPercent: 80, windowSeconds: 300 },
		},
		additionalLimits: [{ id: "codex_spark", name: "Spark", primary: { usedPercent: 10, leftPercent: 90 } }],
		credits: { balance: "5" },
	};
	const update = parseCodexRateLimitEvent({
		type: "codex.rate_limits",
		rate_limits: { primary: { used_percent: 35, window_minutes: 300 } },
	});

	const merged = mergeCodexUsageSnapshots(existing, update!);
	assert.equal(merged.defaultLimit?.primary?.leftPercent, 65);
	assert.equal(merged.defaultLimit?.primary?.resetAt, undefined);
	assert.equal(merged.additionalLimits.length, 1);
	assert.equal(merged.additionalLimits[0]?.id, "codex_spark");
	assert.equal(merged.account.email, "user@example.com");
	assert.equal(merged.credits?.balance, "5");
});
