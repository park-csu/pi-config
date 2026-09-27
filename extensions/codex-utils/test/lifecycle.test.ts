import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as fast from "../fast.js";

const source = ts.transpileModule(
	readFileSync(new URL("../index.ts", import.meta.url), "utf8"),
	{ compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

function deferred() {
	let resolve!: (value: unknown) => void;
	const promise = new Promise((done) => { resolve = done; });
	return { promise, resolve };
}

function harness(
	cache: () => Promise<unknown>,
	usage: () => Promise<unknown>,
	banked = {
		summary: async () => ({ availableCount: 0, accountId: "test" }),
		notices: async () => [] as string[],
	},
	mode: "print" | "tui" = "print",
) {
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	const commands = new Map<string, (args: string, ctx: any) => unknown>();
	const messages: unknown[] = [];
	const notices: string[] = [];
	const timers = new Set<object>();
	const exports: any = {};
	runInNewContext(source, {
		exports,
		setInterval: () => {
			const timer = { unref() {} };
			timers.add(timer);
			return timer;
		},
		clearInterval: (timer: object) => timers.delete(timer),
		require(name: string) {
			switch (name) {
				case "pi-codex-status":
					return {
						formatStatus: () => "Status",
						formatJson: () => "{}",
						formatStatusline: () => "Statusline",
					};
				case "./usage-client.js":
					return { getCodexUsage: usage, readCurrentAccountCachedSnapshot: cache };
				case "./banked-reset.js":
					return {
						getBankedResetSummary: banked.summary,
						getBankedResetNotices: banked.notices,
					};
				case "./format-usage.js":
					return { formatUsageStatus: () => "Status", formatUsageStatusline: () => "Statusline" };
				case "pi-codex-status/extension":
					return { default(api: any) {
						api.registerCommand("status", { handler() { throw new Error("blocked fetch"); } });
						api.registerCommand("codex-status", { handler() { throw new Error("blocked fetch"); } });
						api.on("session_start", () => { throw new Error("upstream fetch used"); });
					} };
				case "./status-ui.js": return { statusOnlyApi: (api: unknown) => api };
				case "./fast.js": return fast;
				default: return {};
			}
		},
	});
	exports.default({
		on: (name: string, handler: any) => handlers.set(name, handler),
		events: { on() {} },
		registerCommand: (name: string, options: any) => commands.set(name, options.handler),
		sendMessage: (message: unknown) => messages.push(message),
	});
	let stale = false;
	let accesses = 0;
	let updates = 0;
	const statusWrites: Array<[string, string | undefined]> = [];
	const ctx = {
		mode,
		model: { provider: "openai-codex" },
		modelRegistry: { getProvider() {} },
		sessionManager: { getBranch: () => [] },
		get ui() {
			accesses++;
			assert.equal(stale, false, "retired context must not be accessed");
			return {
				setStatus(key: string, value: string | undefined) { updates++; statusWrites.push([key, value]); },
				setFooter() {},
				theme: { fg: (_tone: string, text: string) => text },
				notify(message: string) { notices.push(message); },
			};
		},
	};
	return {
		emit: (name: string, event = {}) => handlers.get(name)?.(event, ctx),
		command: (name: string, args = "") => commands.get(name)?.(args, ctx),
		messages,
		notices,
		get activeTimers() { return timers.size; },
		stop() {
			handlers.get("session_shutdown")?.({}, ctx);
			stale = true;
		},
		get accesses() { return accesses; },
		get updates() { return updates; },
		statusWrites,
	};
}

test("shutdown during startup cache read skips stale UI and endpoint request", async () => {
	const cache = deferred();
	let requests = 0;
	const h = harness(() => cache.promise, async () => { requests++; });
	h.emit("session_start");
	const before = h.accesses;
	h.stop();
	cache.resolve({});
	await setImmediate();
	assert.equal(h.accesses, before);
	assert.equal(requests, 0);
});

test("shutdown during startup endpoint request discards its result", async () => {
	const usage = deferred();
	const h = harness(async () => ({}), () => usage.promise);
	h.emit("session_start");
	await setImmediate();
	assert.ok(h.updates > 0, "live cache results still update the footer");
	const before = h.accesses;
	h.stop();
	usage.resolve({});
	await setImmediate();
	assert.equal(h.accesses, before);
});

test("shutdown discards authoritative refresh and cancels queued refresh", async () => {
	const usage = deferred();
	let requests = 0;
	const h = harness(async () => undefined, () => { requests++; return usage.promise; });
	h.emit("agent_settled");
	h.emit("agent_settled");
	h.stop();
	usage.resolve({});
	await setImmediate();
	assert.equal(h.accesses, 0);
	assert.equal(requests, 1);
});

test("shutdown during response cache read skips rate-limit notification", async () => {
	const cache = deferred();
	const h = harness(() => cache.promise, async () => undefined);
	const response = h.emit("after_provider_response", { status: 429 });
	h.stop();
	cache.resolve({});
	await response;
	assert.equal(h.accesses, 0);
});

test("live endpoint results still update the footer", async () => {
	const h = harness(async () => undefined, async () => ({}));
	h.emit("session_start");
	await setImmediate();
	assert.ok(h.updates > 0);
});

test("/codex-status uses the standalone WHAM client and preserves UI-only status output", async () => {
	let calls = 0;
	const h = harness(async () => undefined, async () => {
		calls++;
		return { schemaVersion: 1, account: {}, additionalLimits: [] };
	});
	await h.command("codex-status", "refresh");
	assert.equal(calls, 1);
	assert.equal(h.messages.length, 1);
	assert.equal((h.messages[0] as any).customType, "codex-status");
	assert.equal((h.messages[0] as any).content, "Status");
	assert.equal(h.notices.length, 0);
});

test("usage request failure is reported without leaking an HTML challenge", async () => {
	const h = harness(async () => undefined, async () => { throw new Error("Codex usage request failed (403): access denied"); });
	await h.command("status", "refresh");
	assert.equal(h.messages.length, 0);
	assert.match(h.notices[0]!, /Codex usage unavailable:.*403/);
});

test("banked reset availability alerts once without applying it", async () => {
	let reads = 0;
	const h = harness(async () => undefined, async () => undefined, {
		summary: async () => { reads++; return { accountId: "test", availableCount: 1 }; },
		notices: async () => ["1 banked Codex reset available."],
	});
	h.emit("session_start");
	await setImmediate();
	assert.equal(reads, 1);
	assert.equal(h.notices.length, 0, "do not duplicate the session message with a popup");
	assert.equal((h.messages[0] as any).customType, "codex-status");
	assert.match((h.messages[0] as any).content, /1 banked Codex reset available/);
	assert.deepEqual(h.statusWrites.filter(([key]) => key === "03-banked-reset"), [
		["03-banked-reset", undefined],
	]);
	h.emit("agent_settled");
	await setImmediate();
	assert.equal(reads, 1, "background checks are throttled");
});

test("a previously seen banked reset alerts again on startup without a footer", async () => {
	const h = harness(async () => undefined, async () => undefined, {
		summary: async () => ({ accountId: "test", availableCount: 1, nextExpiresAt: 1_800_000_000 }),
		notices: async () => [],
	});
	h.emit("session_start");
	await setImmediate();
	assert.equal(h.notices.length, 0, "every startup gets only a session message");
	assert.equal(h.messages.length, 1, "show one UI-only session entry");
	assert.match((h.messages[0] as any).content, /1 banked Codex reset available/);
	assert.deepEqual(h.statusWrites.filter(([key, value]) => key === "03-banked-reset" && value), []);
	await h.command("banked-reset");
	assert.equal(h.messages.length, 2, "explicit inspection works even after deduplication");
});

test("within 24 hours of expiry startup changes the message rather than adding another", async () => {
	const h = harness(async () => undefined, async () => undefined, {
		summary: async () => ({
			accountId: "test", availableCount: 1, nextExpiresAt: Date.now() + 23 * 60 * 60 * 1000,
		}),
		notices: async () => [
			"1 banked Codex reset available.",
			"A banked Codex reset expires within 24 hours.",
		],
	});
	h.emit("session_start");
	await setImmediate();
	assert.equal(h.notices.length, 0, "do not show an extra popup");
	assert.equal(h.messages.length, 1);
	assert.match((h.messages[0] as any).content, /expires within 24 hours/);
});

test("interactive banked-reset polling is disposed on shutdown", () => {
	const h = harness(async () => undefined, async () => undefined, undefined, "tui");
	h.emit("session_start");
	assert.equal(h.activeTimers, 1);
	h.stop();
	assert.equal(h.activeTimers, 0);
});
