import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	CODEX_USAGE_ENDPOINT,
	getCodexUsage,
	readCurrentAccountCachedSnapshot,
} from "../usage-client.js";

async function fixture(run: (authFile: string, cacheFile: string) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "pi-codex-usage-"));
	const authFile = join(dir, "auth.json");
	const cacheFile = join(dir, "usage.json");
	const previousFetch = globalThis.fetch;
	try {
		await writeFile(authFile, JSON.stringify({
			"openai-codex": { access: "test-token", accountId: "account-one", expires: Date.now() + 3600_000 },
		}));
		await run(authFile, cacheFile);
	} finally {
		globalThis.fetch = previousFetch;
		await rm(dir, { recursive: true, force: true });
	}
}

test("uses Codex's WHAM usage route with Pi OAuth and caches normalized windows", async () => {
	await fixture(async (authFile, cacheFile) => {
		let calls = 0;
		globalThis.fetch = async (input, init) => {
			calls++;
			assert.equal(input, CODEX_USAGE_ENDPOINT);
			assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-token");
			assert.equal(new Headers(init?.headers).get("chatgpt-account-id"), "account-one");
			return new Response(JSON.stringify({
				account_id: "account-one", plan_type: "pro",
				rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18_000 } },
			}), { status: 200, headers: { "content-type": "application/json" } });
		};
		const fresh = await getCodexUsage({ authFile, cacheFile, noCache: true });
		assert.equal(fresh.endpoint, CODEX_USAGE_ENDPOINT);
		assert.equal(fresh.defaultLimit?.primary?.leftPercent, 88);
		assert.equal(fresh.defaultLimit?.primary?.windowSeconds, 18_000);
		assert.equal(fresh.account.accountId, "account-one");
		assert.equal((await readCurrentAccountCachedSnapshot(cacheFile, authFile))?.endpoint, CODEX_USAGE_ENDPOINT);
		const cached = await getCodexUsage({ authFile, cacheFile });
		assert.equal(cached.account.accountId, "account-one");
		assert.equal(calls, 1);
	});
});

test("a previous account's quota is never returned from the shared cache", async () => {
	await fixture(async (authFile, cacheFile) => {
		await writeFile(cacheFile, JSON.stringify({
			schemaVersion: 1, source: "api", fetchedAt: new Date().toISOString(),
			endpoint: CODEX_USAGE_ENDPOINT, account: { accountId: "other" }, additionalLimits: [],
		}));
		assert.equal(await readCurrentAccountCachedSnapshot(cacheFile, authFile), undefined);
		globalThis.fetch = async () => new Response(JSON.stringify({
			account_id: "account-one", rate_limit: { primary_window: { used_percent: 0 } },
		}), { status: 200 });
		assert.equal((await getCodexUsage({ authFile, cacheFile })).account.accountId, "account-one");
	});
});

test("mismatched backend account is rejected without replacing the cache", async () => {
	await fixture(async (authFile, cacheFile) => {
		globalThis.fetch = async () => new Response(JSON.stringify({ account_id: "other" }), { status: 200 });
		await assert.rejects(getCodexUsage({ authFile, cacheFile, noCache: true }), /does not match/);
		await assert.rejects(readFile(cacheFile), { code: "ENOENT" });
	});
});

test("HTML 403 challenge is summarized rather than printed", async () => {
	await fixture(async (authFile, cacheFile) => {
		let calls = 0;
		globalThis.fetch = async () => {
			calls++;
			return new Response("<html>private challenge</html>", { status: 403 });
		};
		await assert.rejects(getCodexUsage({ authFile, cacheFile, noCache: true }), (error: Error) => {
			assert.match(error.message, /HTTP 403/);
			assert.doesNotMatch(error.message, /private challenge/);
			return true;
		});
		assert.equal(calls, 1, "Codex does not retry a 403 via another usage route");
	});
});
