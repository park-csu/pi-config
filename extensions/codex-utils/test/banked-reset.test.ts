import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BANKED_RESET_ENDPOINT, getBankedResetNotices, getBankedResetSummary } from "../banked-reset.js";

async function fixture(run: (authFile: string, dir: string) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "pi-banked-reset-"));
	const authFile = join(dir, "auth.json");
	try {
		await writeFile(authFile, JSON.stringify({ "openai-codex": { access: "token", accountId: "acct" } }));
		await run(authFile, dir);
	} finally { await rm(dir, { recursive: true, force: true }); }
}

test("reads only the fixed GET route using Pi OAuth; validates credits", async () => {
	await fixture(async (authFile) => {
		const old = globalThis.fetch;
		try {
			globalThis.fetch = async (url, init) => {
				assert.equal(url, BANKED_RESET_ENDPOINT);
				assert.equal(init?.method, "GET");
				assert.equal(new Headers(init?.headers).get("authorization"), "Bearer token");
				assert.equal(new Headers(init?.headers).get("chatgpt-account-id"), "acct");
				return new Response(JSON.stringify({ available_count: 1, credits: [
					{ id: "secret-id", reset_type: "codex_rate_limits", status: "available", expires_at: "2030-01-02T00:00:00Z" },
					{ id: "bad", reset_type: "other", status: "available", expires_at: "2030-01-02T00:00:00Z" },
				] }));
			};
			const result = await getBankedResetSummary({ authFile });
			assert.deepEqual(result, { accountId: "acct", availableCount: 1, availableCreditIds: ["secret-id"], nextExpiresAt: Date.parse("2030-01-02T00:00:00Z") });
		} finally { globalThis.fetch = old; }
	});
});

test("new-credit and expiry notices persist across restarts; zero is silent", async () => {
	await fixture(async (_authFile, dir) => {
		const cacheFile = join(dir, "notices.json");
		const summary = { accountId: "acct", availableCount: 1, availableCreditIds: ["id"], nextExpiresAt: 1_000_000 };
		const options = { cacheFile, now: 0 };
		assert.equal((await getBankedResetNotices(summary, options)).length, 2);
		assert.deepEqual(await getBankedResetNotices(summary, options), []);
		assert.deepEqual(await getBankedResetNotices({ accountId: "acct", availableCount: 0, availableCreditIds: [] }, options), []);
		assert.equal((await readFile(cacheFile)).length > 0, true);
		assert.doesNotMatch(await readFile(cacheFile, "utf8"), /"id"/);
	});
});

test("count-only increases notify once and decreases do not imply redemption", async () => {
	await fixture(async (_authFile, dir) => {
		const cacheFile = join(dir, "notices.json");
		const options = { cacheFile };
		const s = (n: number) => ({ accountId: "acct", availableCount: n, availableCreditIds: [] });
		assert.equal((await getBankedResetNotices(s(1), options)).length, 1);
		assert.deepEqual(await getBankedResetNotices(s(1), options), []);
		assert.deepEqual(await getBankedResetNotices(s(0), options), []);
		assert.equal((await getBankedResetNotices(s(2), options)).length, 1);
	});
});

test("count remains authoritative when credit details are incomplete", async () => {
	await fixture(async (authFile) => {
		const previousFetch = globalThis.fetch;
		try {
			globalThis.fetch = async () => new Response(JSON.stringify({
				available_count: 2,
				credits: [{ id: "one", reset_type: "codex_rate_limits", status: "available", expires_at: null }],
			}));
			const summary = await getBankedResetSummary({ authFile });
			assert.equal(summary.availableCount, 2);
			assert.deepEqual(summary.availableCreditIds, ["one"]);
			assert.equal(summary.nextExpiresAt, undefined);
			globalThis.fetch = async () => new Response(JSON.stringify({ available_count: 1, credits: null }));
			assert.equal((await getBankedResetSummary({ authFile })).availableCount, 1);
		} finally { globalThis.fetch = previousFetch; }
	});
});

test("bad responses and HTTP errors are summarized without leaking bodies", async () => {
	await fixture(async (authFile) => {
		const old = globalThis.fetch;
		try {
			globalThis.fetch = async () => new Response("<html>private</html>", { status: 403 });
			await assert.rejects(getBankedResetSummary({ authFile }), (e: Error) => {
				assert.match(e.message, /HTTP 403/); assert.doesNotMatch(e.message, /private/); return true;
			});
			globalThis.fetch = async () => new Response(JSON.stringify({ available_count: 8, credits: "wrong" }));
			await assert.rejects(getBankedResetSummary({ authFile }), /invalid/);
			globalThis.fetch = async () => { throw new Error("timeout"); };
			await assert.rejects(getBankedResetSummary({ authFile }));
		} finally { globalThis.fetch = old; }
	});
});
