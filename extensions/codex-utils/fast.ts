export const FAST_STATE_TYPE = "pi-codex-utils-fast-state";
export const LEGACY_FAST_STATE_TYPE = "codex-utils-fast-state";
export const FAST_SERVICE_TIER = "priority";

export interface UsageWindow {
	leftPercent: number;
	windowSeconds?: number;
}

export interface UsageLimit {
	primary?: UsageWindow;
	secondary?: UsageWindow;
}

export interface SelectedUsageWindow {
	label: "5h" | "weekly";
	leftPercent: number;
}

export type QuotaTone = "dim" | "warning" | "error";

type FastStateEntry = {
	type?: unknown;
	customType?: unknown;
	data?: {
		enabled?: unknown;
	};
};

/** Restore the most recent Fast mode value from the active session branch. */
export function restoreFastState(entries: readonly unknown[]): boolean {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as FastStateEntry;
		if (
			entry?.type === "custom" &&
			(entry.customType === FAST_STATE_TYPE || entry.customType === LEGACY_FAST_STATE_TYPE) &&
			typeof entry.data?.enabled === "boolean"
		) {
			return entry.data.enabled;
		}
	}

	return false;
}

/** Add Codex's Fast/Priority service tier without mutating pi's request payload. */
export function addFastServiceTier(payload: unknown): unknown {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		return payload;
	}

	return {
		...(payload as Record<string, unknown>),
		service_tier: FAST_SERVICE_TIER,
	};
}

function classifyWindow(windowSeconds: number | undefined): "5h" | "weekly" | undefined {
	if (windowSeconds === undefined || !Number.isFinite(windowSeconds)) {
		return undefined;
	}

	const hours = windowSeconds / 3600;
	if (hours >= 4 && hours <= 6) {
		return "5h";
	}
	if (hours >= 6 * 24 && hours <= 8 * 24) {
		return "weekly";
	}
	return undefined;
}

/**
 * Select a default Codex API window by its reported duration, not by
 * primary/secondary position. Prefer the 5-hour window when both exist.
 */
export function selectUsageWindow(limit: UsageLimit | undefined): SelectedUsageWindow | undefined {
	const windows = [limit?.primary, limit?.secondary].filter(
		(window): window is UsageWindow => window !== undefined,
	);

	for (const label of ["5h", "weekly"] as const) {
		const window = windows.find((candidate) => classifyWindow(candidate.windowSeconds) === label);
		if (window) {
			return { label, leftPercent: window.leftPercent };
		}
	}

	return undefined;
}

/** Footer quota color: normal above 20%, yellow at 20%, red at 10%. */
export function quotaTone(leftPercent: number): QuotaTone {
	if (leftPercent <= 10) {
		return "error";
	}
	if (leftPercent <= 20) {
		return "warning";
	}
	return "dim";
}
