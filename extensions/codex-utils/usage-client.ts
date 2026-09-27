import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	defaultCacheFile,
	isFresh,
	normalizeApiUsage,
	readCachedSnapshot,
	resolveAuth,
	type ApiUsageResponse,
	type CacheOptions,
	type CodexUsageSnapshot,
	writeCachedSnapshot,
} from "pi-codex-status";

// Codex's ChatGPT backend client uses GET /backend-api/wham/usage.
// The older pi-codex-status default (/backend-api/codex/usage) can receive
// an HTML challenge even with valid OAuth credentials.
export const CODEX_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";

async function piAccountId(authFile = join(homedir(), ".pi/agent/auth.json")): Promise<string> {
	let auth: { "openai-codex"?: { accountId?: unknown } };
	try {
		auth = JSON.parse(await readFile(authFile, "utf8"));
	} catch {
		throw new Error("Pi Codex login unavailable; run /login for openai-codex");
	}
	const id = auth?.["openai-codex"]?.accountId;
	if (typeof id !== "string" || !id) {
		throw new Error("Pi Codex account ID unavailable; run /login for openai-codex");
	}
	return id;
}

export async function readCurrentAccountCachedSnapshot(
	cacheFile = defaultCacheFile(),
	authFile?: string,
): Promise<CodexUsageSnapshot | undefined> {
	const id = await piAccountId(authFile);
	const cached = await readCachedSnapshot(cacheFile);
	return cached?.account.accountId === id ? cached : undefined;
}

export async function getCodexUsage(options: CacheOptions = {}): Promise<CodexUsageSnapshot> {
	const accountId = await piAccountId(options.authFile);
	const cacheFile = options.cacheFile ?? defaultCacheFile();
	if (!options.noCache) {
		const cached = await readCurrentAccountCachedSnapshot(cacheFile, options.authFile);
		if (
			isFresh(cached, options.maxAgeMs ?? 60_000) &&
			(cached.endpoint === CODEX_USAGE_ENDPOINT || cached.source === "event" || cached.source === "headers")
		) return cached;
	}

	const auth = await resolveAuth({ source: "pi", ...(options.authFile ? { authFile: options.authFile } : {}) });
	if (auth.accountId !== accountId) {
		throw new Error("Pi Codex credentials changed accounts during the usage request");
	}
	// Match Codex's backend request: one authenticated GET to the ChatGPT
	// WHAM usage route. It does not retry a 403 or switch routes.
	const response = await fetch(CODEX_USAGE_ENDPOINT, {
		headers: {
			authorization: `Bearer ${auth.accessToken}`,
			"chatgpt-account-id": accountId,
			accept: "application/json",
			"user-agent": "pi-codex-utils/0.1.0",
		},
		signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
	});
	if (!response.ok) {
		throw new Error(`Codex usage request failed (HTTP ${response.status})${response.status === 401 ? "; run /login for openai-codex" : ""}`);
	}
	let api: ApiUsageResponse;
	try {
		api = await response.json() as ApiUsageResponse;
	} catch {
		throw new Error("Codex usage endpoint did not return JSON");
	}
	const snapshot = normalizeApiUsage(api, {
		endpoint: CODEX_USAGE_ENDPOINT, authSource: "pi",
		...(options.includeRaw ? { includeRaw: true } : {}),
	});
	if (snapshot.account.accountId && snapshot.account.accountId !== accountId) {
		throw new Error("Codex usage response does not match the active Pi account");
	}
	snapshot.account.accountId = accountId;
	await writeCachedSnapshot(snapshot, cacheFile).catch(() => undefined);
	return snapshot;
}
