import type { CodexUsageSnapshot, RateLimit } from "pi-codex-status";

function mergeLimit(existing: RateLimit | undefined, update: RateLimit | undefined): RateLimit | undefined {
	if (!existing) return update;
	if (!update) return existing;

	const primary =
		existing.primary && update.primary
			? { ...existing.primary, ...update.primary }
			: update.primary ?? existing.primary;
	const secondary =
		existing.secondary && update.secondary
			? { ...existing.secondary, ...update.secondary }
			: update.secondary ?? existing.secondary;

	return {
		...existing,
		...update,
		...(primary ? { primary } : {}),
		...(secondary ? { secondary } : {}),
	};
}

/** Merge a partial Codex response/event snapshot without discarding other limits. */
export function mergeCodexUsageSnapshots(
	existing: CodexUsageSnapshot | undefined,
	update: CodexUsageSnapshot,
): CodexUsageSnapshot {
	if (!existing) return update;

	const byId = new Map(
		(Array.isArray(existing.additionalLimits) ? existing.additionalLimits : []).map((limit) => [limit.id, limit]),
	);
	for (const limit of update.additionalLimits) {
		byId.set(limit.id, mergeLimit(byId.get(limit.id), limit)!);
	}

	const defaultLimit = mergeLimit(existing.defaultLimit, update.defaultLimit);
	const credits =
		existing.credits || update.credits ? { ...existing.credits, ...update.credits } : undefined;
	const spendControl =
		existing.spendControl || update.spendControl
			? { ...existing.spendControl, ...update.spendControl }
			: undefined;

	return {
		...existing,
		...update,
		account: { ...existing.account, ...update.account },
		...(defaultLimit ? { defaultLimit } : {}),
		additionalLimits: [...byId.values()],
		...(credits ? { credits } : {}),
		...(spendControl ? { spendControl } : {}),
	};
}
