import { uiTone } from "ui-kit/appearance";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { SelectedUsageWindow } from "./fast.js";

type FooterData = {
	getGitBranch(): string | null;
	getExtensionStatuses(): ReadonlyMap<string, string>;
	getAvailableProviderCount(): number;
};

type Theme = ExtensionContext["ui"]["theme"];

type Usage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

export interface CodexFooterState {
	fastEnabled: boolean;
	selectedUsage?: SelectedUsageWindow;
	formatPercent(value: number): string;
	quotaTone(leftPercent: number): "dim" | "warning" | "error";
	hiddenStatusKeys: ReadonlySet<string>;
}

function formatTokens(count: number): string {
	if (count < 1_000) return String(count);
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function addUsage(
	totals: Omit<Usage, "cost"> & { cost: number },
	usage: Usage,
): void {
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.cost += usage.cost.total;
}

function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function formatCwd(cwd: string): string {
	const home = process.env.HOME ?? process.env.USERPROFILE;
	if (!home) return cwd;
	const relativeToHome = relative(resolve(home), resolve(cwd));
	const insideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." &&
			!relativeToHome.startsWith(`..${sep}`) &&
			!isAbsolute(relativeToHome));
	if (!insideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

export function formatCodexModelText(
	modelName: string,
	thinkingLevel: string | undefined,
	reasoning: boolean,
	fastEnabled: boolean,
	selectedUsage: SelectedUsageWindow | undefined,
	formatPercent: (value: number) => string,
): string {
	let text = modelName;
	if (fastEnabled) text += " fast";
	if (reasoning) text += ` • ${thinkingLevel === "off" ? "thinking off" : (thinkingLevel ?? "off")}`;
	if (selectedUsage) {
		text += ` • (${selectedUsage.label} ${formatPercent(selectedUsage.leftPercent)}% left)`;
	}
	return text;
}

/** Render pi's normal footer with Codex Fast and quota folded into the model side. */
export function renderCodexFooter(
	ctx: ExtensionContext,
	footerData: FooterData,
	theme: Theme,
	state: CodexFooterState,
	width: number,
): string[] {
	if (width <= 0) return [];
	const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	let latestCacheHitRate: number | undefined;

	for (const entry of ctx.sessionManager.getEntries()) {
		let usage: Usage | undefined;
		if (entry.type === "message" && entry.message.role === "assistant") {
			usage = entry.message.usage;
			const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
			latestCacheHitRate = promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			usage = entry.message.usage;
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			usage = entry.usage;
		}
		if (usage) addUsage(totals, usage);
	}

	let pwd = theme.fg(uiTone.body, formatCwd(ctx.cwd));
	const branch = footerData.getGitBranch();
	if (branch) pwd += theme.fg(uiTone.body, ` (${branch})`);
	const sessionName = ctx.sessionManager.getSessionName();
	if (sessionName) pwd += theme.fg(uiTone.secondary, " • ") + theme.fg(uiTone.title, sessionName);

	const stats: string[] = [];
	if (totals.input) stats.push(`↑${formatTokens(totals.input)}`);
	if (totals.output) stats.push(`↓${formatTokens(totals.output)}`);
	if (totals.cacheRead) stats.push(`R${formatTokens(totals.cacheRead)}`);
	if (totals.cacheWrite) stats.push(`W${formatTokens(totals.cacheWrite)}`);
	if ((totals.cacheRead || totals.cacheWrite) && latestCacheHitRate !== undefined) {
		stats.push(`CH${latestCacheHitRate.toFixed(1)}%`);
	}
	const usingSubscription =
		ctx.model?.provider === "openai-codex" || ctx.model?.provider === "kimi-coding";
	if (totals.cost || usingSubscription) {
		stats.push(`$${totals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
	}

	const contextUsage = ctx.getContextUsage();
	const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const contextDisplay =
		contextUsage?.percent === null || contextUsage?.percent === undefined
			? `?/${formatTokens(contextWindow)} (auto)`
			: `${contextUsage.percent.toFixed(1)}%/${formatTokens(contextWindow)} (auto)`;
	const contextTone =
		(contextUsage?.percent ?? 0) > 90 ? uiTone.error : (contextUsage?.percent ?? 0) > 70 ? uiTone.warning : uiTone.body;
	stats.push(theme.fg(contextTone, contextDisplay));

	let statsLeft = stats.join(" ");
	if (visibleWidth(statsLeft) > width) statsLeft = truncateToWidth(statsLeft, width, "...");

	const modelName = ctx.model?.id ?? "no-model";
	const selectedUsage = ctx.model?.provider === "openai-codex" ? state.selectedUsage : undefined;
	let rightContent = theme.fg(uiTone.title, modelName);
	if (ctx.model?.provider === "openai-codex" && state.fastEnabled) {
		rightContent += theme.fg(uiTone.body, " fast");
	}
	if (ctx.model?.reasoning) {
		rightContent += theme.fg(uiTone.secondary, " • ") +
			theme.fg(uiTone.body, ctx.thinkingLevel === "off" ? "thinking off" : (ctx.thinkingLevel ?? "off"));
	}
	if (selectedUsage) {
		const tone = state.quotaTone(selectedUsage.leftPercent);
		rightContent += theme.fg(uiTone.secondary, " • ") + theme.fg(
			tone,
			`(${selectedUsage.label} ${state.formatPercent(selectedUsage.leftPercent)}% left)`,
		);
	}
	if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
		const withProvider = theme.fg(uiTone.body, `(${ctx.model.provider}) `) + rightContent;
		if (visibleWidth(statsLeft) + 2 + visibleWidth(withProvider) <= width) rightContent = withProvider;
	}

	const availableRight = width - visibleWidth(statsLeft) - 2;
	const right = availableRight > 0 ? truncateToWidth(rightContent, availableRight, "") : "";
	const padding = " ".repeat(Math.max(0, width - visibleWidth(statsLeft) - visibleWidth(right)));
	const lines = [
		truncateToWidth(pwd, width, theme.fg(uiTone.secondary, "...")),
		theme.fg(uiTone.secondary, statsLeft) + padding + right,
	];

	const statuses = Array.from(footerData.getExtensionStatuses())
		.filter(([key]) => !state.hiddenStatusKeys.has(key))
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => sanitizeStatusText(text))
		.filter(Boolean);
	if (statuses.length > 0) {
		const separator = theme.fg(uiTone.borderMuted, "  ·  ");
		let row = "";
		for (const status of statuses) {
			if (row && visibleWidth(row) + 5 + visibleWidth(status) > width) {
				lines.push(row);
				row = "";
			}
			if (visibleWidth(status) > width) {
				lines.push(...wrapTextWithAnsi(status, Math.max(1, width)));
			} else {
				row += (row ? separator : "") + status;
			}
		}
		if (row) lines.push(row);
	}

	return lines;
}
