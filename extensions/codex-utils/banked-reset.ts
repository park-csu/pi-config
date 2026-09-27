import { randomBytes, createHash } from "node:crypto";
import { readFile, mkdir, open, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveAuth, type CacheOptions } from "pi-codex-status";

export const BANKED_RESET_ENDPOINT = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";

export interface BankedResetSummary {
	accountId: string;
	availableCount: number;
	nextExpiresAt?: number;
	availableCreditIds: string[];
}

export interface BankedResetOptions extends CacheOptions {}
export interface BankedResetNoticeOptions {
	cacheFile?: string;
	now?: number;
}

export async function getBankedResetSummary(options: BankedResetOptions = {}): Promise<BankedResetSummary> {
	const auth = await resolveAuth({ source: "pi", ...(options.authFile ? { authFile: options.authFile } : {}) });
	const accountId = auth.accountId;
	if (!accountId) throw new Error("Pi Codex account ID unavailable; run /login for openai-codex");
	const response = await fetch(BANKED_RESET_ENDPOINT, {
		method: "GET",
		headers: {
			authorization: `Bearer ${auth.accessToken}`,
			"chatgpt-account-id": accountId,
			accept: "application/json",
			"user-agent": "pi-codex-utils/0.1.0",
		},
		signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
	});
	if (!response.ok) throw new Error(`Codex reset-credit request failed (HTTP ${response.status})`);
	let body: unknown;
	try { body = await response.json(); } catch { throw new Error("Codex reset-credit endpoint did not return JSON"); }
	if (!body || typeof body !== "object") throw new Error("Codex reset-credit response was invalid");
	const data = body as { credits?: unknown; available_count?: unknown };
	if (data.credits != null && !Array.isArray(data.credits)) throw new Error("Codex reset-credit response was invalid");
	const credits = (data.credits ?? []) as unknown[];
	const available = credits.filter((credit): credit is {
		id: string; status: string; reset_type: string; expires_at?: string | null;
	} => {
		if (!credit || typeof credit !== "object") return false;
		const c = credit as Record<string, unknown>;
		return typeof c.id === "string" && c.id.length > 0 && c.status === "available" &&
			c.reset_type === "codex_rate_limits" && c.is_supported_by_plan !== false;
	});
	const expiries = available
		.map((credit) => credit.expires_at ? Date.parse(credit.expires_at) : NaN)
		.filter((expiry) => Number.isFinite(expiry) && expiry > Date.now());
	const count = typeof data.available_count === "number" &&
		Number.isSafeInteger(data.available_count) && data.available_count >= 0
		? data.available_count : available.length;
	const ids = available.slice(0, count).map((credit) => credit.id);
	return {
		accountId, availableCount: count, availableCreditIds: ids,
		...(expiries.length ? { nextExpiresAt: Math.min(...expiries) } : {}),
	};
}

interface NoticeState { ids?: string[]; warned?: string[]; lastCount?: number }
const defaultNoticeFile = () => join(
	process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
	"pi-codex-status/banked-reset-notices.json",
);

export async function getBankedResetNotices(
	summary: BankedResetSummary,
	options: BankedResetNoticeOptions = {},
): Promise<string[]> {
	const file = options.cacheFile ?? defaultNoticeFile();
	const accountKey = createHash("sha256").update(summary.accountId).digest("hex");
	let state: Record<string, NoticeState> = {};
	try {
		const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
		if (parsed && typeof parsed === "object") state = parsed as Record<string, NoticeState>;
	} catch { /* absent or malformed state is treated as empty */ }
	const previous = state[accountKey] ?? {};
	const seen = new Set(Array.isArray(previous.ids) ? previous.ids.filter((id) => typeof id === "string") : []);
	const warned = new Set(Array.isArray(previous.warned) ? previous.warned.filter((id) => typeof id === "string") : []);
	const notices: string[] = [];
	let newCredits = 0;
	for (const id of summary.availableCreditIds) {
		const hashedId = createHash("sha256").update(`${summary.accountId}\0${id}`).digest("hex");
		if (!seen.has(hashedId)) newCredits++;
		seen.add(hashedId);
	}
	// Details can be truncated or absent; a count increase still matters when
	// none of the returned IDs are new. A decrease proves neither use nor expiry.
	const countIncrease = summary.availableCount > 0 &&
		summary.availableCount > (Number.isSafeInteger(previous.lastCount) ? previous.lastCount! : 0);
	if (newCredits || countIncrease) {
		notices.push(`${summary.availableCount} banked Codex reset${summary.availableCount === 1 ? "" : "s"} available.`);
	}
	if (summary.availableCount > 0 && summary.nextExpiresAt !== undefined &&
		summary.nextExpiresAt > (options.now ?? Date.now()) &&
		summary.nextExpiresAt <= (options.now ?? Date.now()) + 24 * 60 * 60 * 1000 &&
		!warned.has(String(summary.nextExpiresAt))) {
		notices.push(`A banked Codex reset expires within 24 hours (${new Date(summary.nextExpiresAt).toLocaleString()}).`);
		warned.add(String(summary.nextExpiresAt));
	}
	state[accountKey] = { ids: [...seen], warned: [...warned], lastCount: summary.availableCount };
	await mkdir(dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
	try {
		const handle = await open(temp, "wx", 0o600);
		try { await handle.writeFile(JSON.stringify(state)); } finally { await handle.close(); }
		await rename(temp, file);
	} catch (error) {
		const { unlink } = await import("node:fs/promises");
		await unlink(temp).catch(() => undefined);
		throw error;
	}
	return notices;
}
