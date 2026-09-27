import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatCodexModelText, renderCodexFooter } from "../footer.js";

test("Codex footer puts Fast before thinking and quota after it", () => {
	assert.equal(
		formatCodexModelText(
			"gpt-5.6-luna",
			"xhigh",
			true,
			true,
			{ label: "weekly", leftPercent: 26 },
			String,
		),
		"gpt-5.6-luna fast • xhigh • (weekly 26% left)",
	);
});

test("Codex footer omits Fast when disabled", () => {
	assert.equal(
		formatCodexModelText("gpt-5.6-luna", "medium", true, false, undefined, String),
		"gpt-5.6-luna • medium",
	);
});

test("footer preserves themed plugin statuses at narrow widths and retains usage warnings", () => {
	const theme = {
		fg: (color: string, text: string) => `\x1b[${color === "error" ? 31 : color === "warning" ? 33 : 36}m${text}\x1b[39m`,
	} as Parameters<typeof renderCodexFooter>[2];
	const ctx = {
		cwd: "/project/한글",
		model: { id: "example-model", provider: "openai-codex", reasoning: true, contextWindow: 272000 },
		thinkingLevel: "xhigh",
		sessionManager: { getEntries: () => [], getSessionName: () => "작업" },
		getContextUsage: () => ({ percent: 92, contextWindow: 272000 }),
	} as unknown as Parameters<typeof renderCodexFooter>[0];
	const footerData = {
		getGitBranch: () => "main",
		getAvailableProviderCount: () => 1,
		getExtensionStatuses: () => new Map([
			["a", theme.fg("muted", "tavily 980")],
			["b", theme.fg("accent", "om obs ━━━─── pool ━───── ctx ━━━━──")],
			["c", theme.fg("muted", "log 기록.md")],
			["hidden", "HIDDEN"],
		]),
	};
	const state = {
		fastEnabled: false,
		selectedUsage: { label: "weekly" as const, leftPercent: 10 },
		formatPercent: String,
		quotaTone: () => "warning" as const,
		hiddenStatusKeys: new Set(["hidden"]),
	};
	for (const width of [20, 40, 80, 160]) {
		const lines = renderCodexFooter(ctx, footerData, theme, state, width);
		assert.ok(lines.every(line => visibleWidth(line) <= width), `overflow at width ${width}`);
		const plain = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
		for (const label of ["tavily 980", "om", "obs", "pool", "ctx", "기록.md"]) assert.ok(plain.includes(label), label);
		assert.ok(!plain.includes("HIDDEN"));
		if (width === 160) {
			assert.ok(lines[1]!.includes("\x1b[31m92.0%"));
			assert.ok(lines[1]!.includes("\x1b[33m(weekly 10% left)"));
		}
	}
	assert.deepEqual(renderCodexFooter(ctx, footerData, theme, state, 0), []);
});
