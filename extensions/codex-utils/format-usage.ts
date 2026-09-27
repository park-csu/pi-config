import {
	formatDuration,
	formatReset,
	formatStatus as formatBaseStatus,
	type CodexUsageSnapshot,
	type LimitWindow,
	type RateLimit,
} from "pi-codex-status";

function windowLabel(window: LimitWindow, fallback: string): string {
	const seconds = window.windowSeconds;
	if (seconds !== undefined && Number.isFinite(seconds)) {
		if (seconds >= 4 * 3600 && seconds <= 6 * 3600) return "5h";
		if (seconds >= 6 * 86400 && seconds <= 8 * 86400) return "Weekly";
		return formatDuration(seconds) || fallback;
	}
	return fallback;
}

function labeledWindows(limit: RateLimit | undefined): { label: string; window: LimitWindow }[] {
	if (!limit) return [];
	const windows: { label: string; window: LimitWindow }[] = [];
	if (limit.primary) windows.push({ label: windowLabel(limit.primary, "Primary"), window: limit.primary });
	if (limit.secondary) windows.push({ label: windowLabel(limit.secondary, "Secondary"), window: limit.secondary });
	return windows;
}

/** Preserve the upstream box, bars, and account formatting, but label by duration. */
export function formatUsageStatus(snapshot: CodexUsageSnapshot): string {
	const labels = [snapshot.defaultLimit, ...snapshot.additionalLimits]
		.flatMap((limit) => labeledWindows(limit).map(({ label }) => label));
	let index = 0;
	const lines = formatBaseStatus(snapshot, { box: false }).split("\n").map((line) => {
		const match = /^( {0,2})(?:5h|Weekly) limit: *(.*)$/.exec(line);
		if (!match) return line;
		const label = labels[index++];
		return `${`${match[1]}${label} limit:`.padEnd(28, " ")}${match[2]}`;
	});
	const width = Math.max(1, ...lines.map((line) => line.length));
	return [
		`╭${"─".repeat(width + 2)}╮`,
		...lines.map((line) => `│ ${line.padEnd(width, " ")} │`),
		`╰${"─".repeat(width + 2)}╯`,
	].join("\n");
}

function pct(value: number): string {
	return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

export function formatUsageStatusline(snapshot: CodexUsageSnapshot, now = new Date()): string {
	const windows = labeledWindows(snapshot.defaultLimit);
	const parts = windows.map(({ label, window }) =>
		`${label === "Weekly" ? "7d" : label}:${pct(window.leftPercent)} left`);
	if (snapshot.account.plan) parts.push(snapshot.account.plan);
	const reset = windows[0] ? formatReset(windows[0].window.resetAt, now).replace(/^resets /, "reset:") : "";
	if (reset) parts.push(reset);
	if (snapshot.credits?.balance !== undefined) {
		const value = Number(snapshot.credits.balance);
		parts.push(`credits:${Number.isFinite(value) ? Math.floor(value).toLocaleString() : snapshot.credits.balance}`);
	}
	return parts.length ? `Codex ${parts.join(" ")}` : "Codex usage unavailable";
}
