import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	formatJson,
	parseCodexRateLimitEvent,
	type CodexUsageSnapshot,
	writeCachedSnapshot,
} from "pi-codex-status";
import codexStatusExtension from "pi-codex-status/extension";
import { getBankedResetNotices, getBankedResetSummary } from "./banked-reset.js";
import { captureSseData } from "./codex-events.js";
import { statusOnlyApi } from "./status-ui.js";
import {
	addFastServiceTier,
	FAST_STATE_TYPE,
	quotaTone,
	restoreFastState,
	selectUsageWindow,
} from "./fast.js";
import { renderCodexFooter } from "./footer.js";
import { formatUsageStatus, formatUsageStatusline } from "./format-usage.js";
import { mergeCodexUsageSnapshots } from "./rate-limits.js";
import { getCodexUsage, readCurrentAccountCachedSnapshot } from "./usage-client.js";

const FOOTER_STATUS_KEY = "02-codex-status";
const LEGACY_FOOTER_STATUS_KEY = "codex-status";
const CAFFEINE_FOOTER_STATUS_KEY = "01-caffeine";
const LEGACY_BANKED_RESET_STATUS_KEY = "03-banked-reset";
const HIDDEN_FOOTER_STATUS_KEYS = new Set([
	FOOTER_STATUS_KEY, LEGACY_FOOTER_STATUS_KEY, LEGACY_BANKED_RESET_STATUS_KEY,
]);
const CAFFEINE_STATUS_EVENT = "pi-caffeine:status";
const CACHE_TTL_MS = 60_000;
const RATE_LIMIT_NOTICE_COOLDOWN_MS = 60_000;
const BANKED_RESET_REFRESH_MS = 10 * 60_000;

function contextWithoutLegacyFooter<T extends ExtensionContext>(ctx: T): T {
	const ui = new Proxy(ctx.ui, {
		get(target, property, receiver) {
			if (property === "setStatus") {
				return (key: string, text: string | undefined) => {
					if (key !== LEGACY_FOOTER_STATUS_KEY) {
						target.setStatus(key, text);
					}
				};
			}
			const value = Reflect.get(target, property, receiver) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	});

	return new Proxy(ctx, {
		get(target, property, receiver) {
			return property === "ui" ? ui : Reflect.get(target, property, receiver);
		},
	});
}

export default function piCodexUtilsExtension(pi: ExtensionAPI) {
	let fastEnabled = false;
	let usageSnapshot: CodexUsageSnapshot | undefined;
	let lastRateLimitNoticeAt = 0;
	let caffeineEnabled = false;
	let endpointRefreshInFlight: Promise<void> | undefined;
	let endpointRefreshPending = false;
	let endpointRefreshContext: ExtensionContext | undefined;
	let rateLimitEventQueue = Promise.resolve();
	let activeContext: ExtensionContext | undefined;
	let codexProviderWrapped = false;
	let stopped = false;
	let bankedResetCheckedAt = 0;
	let bankedResetRefreshInFlight: Promise<void> | undefined;
	let bankedResetTimer: ReturnType<typeof setInterval> | undefined;
	let bankedResetStartupPending = true;

	function formatPercent(value: number): string {
		return Number.isInteger(value) ? String(value) : value.toFixed(1);
	}

	function updateFooterStatus(ctx: ExtensionContext): void {
		if (stopped) return;
		// Clear status emitted by the upstream extension's older footer integration.
		ctx.ui.setStatus(LEGACY_FOOTER_STATUS_KEY, undefined);

		const parts: string[] = [];
		if (ctx.model?.provider === "openai-codex") {
			if (fastEnabled) {
				parts.push(ctx.ui.theme.fg("dim", "• fast"));
			}

			const selected = selectUsageWindow(usageSnapshot?.defaultLimit);
			if (selected) {
				const quota = `(${selected.label} ${formatPercent(selected.leftPercent)}% left)`;
				parts.push(ctx.ui.theme.fg(quotaTone(selected.leftPercent), quota));
			}
		}

		if (caffeineEnabled) {
			ctx.ui.setStatus(CAFFEINE_FOOTER_STATUS_KEY, ctx.ui.theme.fg("muted", "☕ awake"));
		} else {
			ctx.ui.setStatus(CAFFEINE_FOOTER_STATUS_KEY, undefined);
		}

		const text = parts.join(" ");
		ctx.ui.setStatus(FOOTER_STATUS_KEY, text || undefined);
	}

	function installFooter(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		ctx.ui.setFooter((tui, theme, footerData) => {
			const dispose = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose,
				invalidate() {},
				render: (width) =>
					renderCodexFooter(
						ctx,
						footerData,
						theme,
						{
							fastEnabled,
							selectedUsage: selectUsageWindow(usageSnapshot?.defaultLimit),
							formatPercent,
							quotaTone,
							hiddenStatusKeys: HIDDEN_FOOTER_STATUS_KEYS,
						},
						width,
					),
			};
		});
	}

	pi.events.on(CAFFEINE_STATUS_EVENT, (data) => {
		const status = data as { enabled?: unknown; ctx?: ExtensionContext };
		if (typeof status.enabled !== "boolean" || !status.ctx) return;
		caffeineEnabled = status.enabled;
		updateFooterStatus(status.ctx);
	});

	async function syncUsageFromCache(ctx: ExtensionContext): Promise<void> {
		if (stopped) return;
		const cached = await readCurrentAccountCachedSnapshot().catch(() => undefined);
		if (stopped) return;
		usageSnapshot = cached;
		updateFooterStatus(ctx);
	}

	function recordRateLimitEvent(data: string): void {
		let update: CodexUsageSnapshot | undefined;
		try {
			update = parseCodexRateLimitEvent(data);
		} catch {
			// Other Codex SSE data is expected and is not a rate-limit event.
			return;
		}
		if (!update) return;

		// Reflect the event immediately. The cache write is serialized below so
		// concurrent Codex streams cannot overwrite one another.
		usageSnapshot = mergeCodexUsageSnapshots(usageSnapshot, update);
		if (activeContext) {
			try {
				updateFooterStatus(activeContext);
			} catch {
				// The session may have been replaced while the stream was ending.
			}
		}

		rateLimitEventQueue = rateLimitEventQueue
			.then(async () => {
				const cached = await readCurrentAccountCachedSnapshot().catch(() => undefined);
				const merged = mergeCodexUsageSnapshots(cached ?? usageSnapshot, update);
				usageSnapshot = merged;
				await writeCachedSnapshot(merged).catch(() => undefined);
				if (activeContext) {
					try {
						updateFooterStatus(activeContext);
					} catch {
						// The session may have been replaced while the stream was ending.
					}
				}
			})
			.catch(() => undefined);
	}

	function installCodexRateLimitCapture(ctx: ExtensionContext): void {
		if (codexProviderWrapped) return;

		const provider = ctx.modelRegistry.getProvider("openai-codex");
		if (!provider) return;

		const wrappedProvider = {
			...provider,
			stream: (...args: Parameters<typeof provider.stream>) => {
				const [model, context, options] = args;
				return provider.stream(model, context, {
					...options,
					fetch: captureSseData(options?.fetch ?? globalThis.fetch, recordRateLimitEvent),
				});
			},
			streamSimple: (...args: Parameters<typeof provider.streamSimple>) => {
				const [model, context, options] = args;
				return provider.streamSimple(model, context, {
					...options,
					fetch: captureSseData(options?.fetch ?? globalThis.fetch, recordRateLimitEvent),
				});
			},
		};

		try {
			// Keep the built-in Codex provider's auth, model catalog, transport
			// selection, and request processing; only observe its SSE body.
			pi.registerProvider(wrappedProvider as typeof provider);
			codexProviderWrapped = true;
		} catch {
			// Quota observation is optional; a provider registration failure must
			// not prevent normal Codex requests.
		}
	}

	async function refreshUsage(ctx: ExtensionContext): Promise<void> {
		const cached = await readCurrentAccountCachedSnapshot().catch(() => undefined);
		if (stopped) return;
		if (cached) {
			usageSnapshot = cached;
			updateFooterStatus(ctx);
		}

		const fresh = await getCodexUsage({ maxAgeMs: CACHE_TTL_MS }).catch(() => undefined);
		if (stopped) return;
		if (fresh) {
			usageSnapshot = fresh;
			updateFooterStatus(ctx);
		}
	}

	function scheduleAuthoritativeUsageRefresh(ctx: ExtensionContext): void {
		if (stopped) return;
		endpointRefreshPending = true;
		endpointRefreshContext = ctx;
		if (endpointRefreshInFlight) return;

		endpointRefreshInFlight = (async () => {
			while (endpointRefreshPending) {
				endpointRefreshPending = false;
				const refreshContext = endpointRefreshContext ?? ctx;
				const fresh = await getCodexUsage({ noCache: true }).catch(() => undefined);
				if (stopped) return;
				if (fresh) {
					usageSnapshot = fresh;
					updateFooterStatus(refreshContext);
				}
			}
		})()
			.catch(() => undefined)
			.finally(() => {
				endpointRefreshInFlight = undefined;
				endpointRefreshContext = undefined;
			});
	}

	function refreshBankedResets(ctx: ExtensionContext, force = false): void {
		if (stopped || ctx.model?.provider !== "openai-codex" || ctx.hasUI === false) return;
		if (bankedResetRefreshInFlight || (!force && Date.now() - bankedResetCheckedAt < BANKED_RESET_REFRESH_MS)) return;
		bankedResetCheckedAt = Date.now();
		bankedResetRefreshInFlight = (async () => {
			// Read-only inventory request. No redemption or reset action is exposed.
			const summary = await getBankedResetSummary();
			if (stopped) return;
			const notices = await getBankedResetNotices(summary).catch(() => []);
			if (stopped) return;
			// Every Pi startup gets one current message. Subsequent polls only
			// notify on new credits or the 24-hour expiry transition.
			const shouldShow = summary.availableCount > 0 &&
				(bankedResetStartupPending || notices.length > 0);
			bankedResetStartupPending = false;
			if (shouldShow) {
				showBankedResetSummary(summary, ctx);
			}
		})()
			.catch(() => undefined)
			.finally(() => { bankedResetRefreshInFlight = undefined; });
	}

	function bankedResetExpiresSoon(summary: Awaited<ReturnType<typeof getBankedResetSummary>>): boolean {
		return summary.nextExpiresAt !== undefined &&
			summary.nextExpiresAt > Date.now() &&
			summary.nextExpiresAt <= Date.now() + 24 * 60 * 60 * 1000;
	}

	function bankedResetMessage(summary: Awaited<ReturnType<typeof getBankedResetSummary>>): string {
		const count = `${summary.availableCount} banked Codex reset${summary.availableCount === 1 ? "" : "s"}`;
		const expiry = summary.nextExpiresAt
			? new Date(summary.nextExpiresAt).toLocaleString()
			: undefined;
		if (bankedResetExpiresSoon(summary)) {
			return `${count} available — expires within 24 hours (${expiry}).`;
		}
		return `${count} available${expiry ? ` (next expiry: ${expiry})` : ""}.`;
	}

	function showBankedResetSummary(
		summary: Awaited<ReturnType<typeof getBankedResetSummary>>,
		ctx: ExtensionContext,
	): void {
		const text = bankedResetMessage(summary);
		if (ctx.hasUI === false) {
			console.log(text);
		} else {
			// statusOnlyApi turns this into a rendered entry excluded from model context.
			statusApi.sendMessage({
				customType: "codex-status",
				content: text,
				display: true,
				details: { kind: "banked-reset", availableCount: summary.availableCount },
			});
		}
	}

	function startBankedResetPolling(ctx: ExtensionContext): void {
		if (bankedResetTimer) clearInterval(bankedResetTimer);
		if (ctx.mode !== "tui") return;
		bankedResetTimer = setInterval(() => {
			if (activeContext) refreshBankedResets(activeContext);
		}, BANKED_RESET_REFRESH_MS);
		bankedResetTimer.unref?.();
	}

	function describeFastMode(ctx: ExtensionContext): string {
		const provider = ctx.model?.provider;
		const applicability =
			provider === "openai-codex"
				? "applies to the current model"
				: `waiting for an openai-codex model (current: ${provider ?? "none"})`;
		return `Codex Fast mode is ${fastEnabled ? "on" : "off"}${fastEnabled ? `; ${applicability}` : ""}.`;
	}

	function setFastMode(enabled: boolean, ctx: ExtensionContext): void {
		if (fastEnabled !== enabled) {
			fastEnabled = enabled;
			pi.appendEntry(FAST_STATE_TYPE, { enabled });
		}
		updateFooterStatus(ctx);
		ctx.ui.notify(describeFastMode(ctx), "info");
	}

	async function showUsage(args: string, ctx: ExtensionContext): Promise<void> {
		let kind = "status";
		let refresh = false;
		for (const part of args.trim().split(/\s+/).filter(Boolean)) {
			if (["status", "json", "raw", "statusline"].includes(part)) kind = part;
			else if (["refresh", "--refresh", "-r"].includes(part)) refresh = true;
			else {
				ctx.ui.notify(`Unknown /status argument: ${part}`, "error");
				return;
			}
		}

		try {
			const snapshot = await getCodexUsage({
				maxAgeMs: CACHE_TTL_MS,
				noCache: refresh || kind === "raw",
				includeRaw: kind === "raw",
			});
			if (stopped) return;
			usageSnapshot = snapshot;
			updateFooterStatus(ctx);
			if (refresh || kind === "raw") refreshBankedResets(ctx, true);
			const content = kind === "json" ? formatJson(snapshot)
				: kind === "raw" ? JSON.stringify(snapshot.raw ?? snapshot, null, 2)
				: kind === "statusline" ? formatUsageStatusline(snapshot)
				: formatUsageStatus(snapshot);
			if (ctx.hasUI === false) {
				console.log(content.replace(/^```(?:json)?\n/, "").replace(/\n```$/, ""));
			} else {
				// The upstream renderer remains registered; statusOnlyApi stores this
				// as a UI-only entry rather than sending it to the model.
				statusApi.sendMessage({
					customType: "codex-status",
					content,
					display: true,
					details: { kind, snapshot },
				});
			}
		} catch (error) {
			if (stopped) return;
			ctx.ui.notify(`Codex usage unavailable: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}

	// Keep the upstream renderer and response-header parsing. Replace its
	// commands and startup fetch so quota requests use Codex's WHAM API route.
	const statusApi = statusOnlyApi(pi);
	const legacyApi = new Proxy(statusApi, {
		get(target, property, receiver) {
			if (property === "on") {
				return (
					eventName: string,
					handler: (event: unknown, ctx: ExtensionContext) => unknown,
				) => {
					// Our startup refresh uses Codex's WHAM route. The upstream
					// startup handler would duplicate it through blocked fetch().
					if (eventName === "session_start") return;
					(target.on as (name: string, callback: (event: unknown, ctx: ExtensionContext) => unknown) => void)(
						eventName,
						(event, ctx) => handler(event, contextWithoutLegacyFooter(ctx)),
					);
				};
			}
			if (property === "registerCommand") {
				return (
					name: string,
					options: {
						handler: (args: string, ctx: ExtensionContext) => void | Promise<void>;
					} & Record<string, unknown>,
				) => {
					target.registerCommand(name, {
						...options,
						handler: async (args, ctx) => {
							await showUsage(args, ctx);
						},
					});
				};
			}
			const value = Reflect.get(target, property, receiver) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	// pi-codex-status targets an older pi API whose runtime shape remains compatible.
	(codexStatusExtension as unknown as (api: ExtensionAPI) => void)(legacyApi);

	pi.registerCommand("fast", {
		description: "Enable, disable, or inspect Codex Fast mode",
		getArgumentCompletions: (prefix) => {
			const items = [
				{ value: "on", label: "on", description: "Use the Fast/Priority service tier" },
				{ value: "off", label: "off", description: "Use the default service tier" },
				{ value: "status", label: "status", description: "Show the current setting" },
			];
			const filtered = items.filter((item) => item.value.startsWith(prefix.trim().toLowerCase()));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "status";
			if (action === "on") {
				setFastMode(true, ctx);
				return;
			}
			if (action === "off") {
				setFastMode(false, ctx);
				return;
			}
			if (action === "status") {
				updateFooterStatus(ctx);
				ctx.ui.notify(describeFastMode(ctx), "info");
				return;
			}

			ctx.ui.notify("Usage: /fast on | /fast off | /fast status", "error");
		},
	});

	pi.registerCommand("banked-reset", {
		description: "Show available Codex banked resets and their next expiry (read-only)",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /banked-reset", "error");
				return;
			}
			try {
				const summary = await getBankedResetSummary();
				if (!stopped) showBankedResetSummary(summary, ctx);
			} catch (error) {
				if (!stopped) ctx.ui.notify(
					`Banked reset status unavailable: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});

	// Replacement/reload creates a new extension instance. In-flight I/O from
	// this instance may finish later, but must never touch its retired context.
	pi.on("session_shutdown", () => {
		stopped = true;
		if (bankedResetTimer) clearInterval(bankedResetTimer);
		bankedResetTimer = undefined;
		activeContext = undefined;
		endpointRefreshPending = false;
		endpointRefreshContext = undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		activeContext = ctx;
		bankedResetStartupPending = true;
		ctx.ui.setStatus(LEGACY_BANKED_RESET_STATUS_KEY, undefined);
		startBankedResetPolling(ctx);
		fastEnabled = restoreFastState(ctx.sessionManager.getBranch());
		installFooter(ctx);
		installCodexRateLimitCapture(ctx);
		if (ctx.model?.provider === "openai-codex") {
			void refreshUsage(ctx);
			refreshBankedResets(ctx);
		} else {
			updateFooterStatus(ctx);
		}
	});

	pi.on("model_select", (event, ctx) => {
		activeContext = ctx;
		installCodexRateLimitCapture(ctx);
		if (event.model.provider === "openai-codex") {
			void refreshUsage(ctx);
			refreshBankedResets(ctx);
		} else {
			updateFooterStatus(ctx);
		}
	});

	pi.on("after_provider_response", async (event, ctx) => {
		activeContext = ctx;
		// The upstream handler has just refreshed the shared cache from x-codex-* headers.
		if (ctx.model?.provider === "openai-codex") {
			await syncUsageFromCache(ctx);
			if (stopped) return;
			if (event.status === 429 && Date.now() - lastRateLimitNoticeAt >= RATE_LIMIT_NOTICE_COOLDOWN_MS) {
				lastRateLimitNoticeAt = Date.now();
				const selected = selectUsageWindow(usageSnapshot?.defaultLimit);
				const quota = selected
					? ` ${selected.label}: ${formatPercent(selected.leftPercent)}% left.`
					: "";
				ctx.ui.notify(
					`Codex rate limited (HTTP 429).${quota}${fastEnabled ? " Fast mode is still on; use /fast off to retry at the default tier." : ""}`,
					"warning",
				);
			}
		} else {
			updateFooterStatus(ctx);
		}
	});

	pi.on("agent_settled", (_event, ctx) => {
		activeContext = ctx;
		// Headers can describe the request before Codex finishes accounting for it.
		// Refresh once the complete run settles, without delaying the next prompt.
		if (ctx.model?.provider === "openai-codex") {
			scheduleAuthoritativeUsageRefresh(ctx);
			refreshBankedResets(ctx);
		}
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!fastEnabled || ctx.model?.provider !== "openai-codex") {
			return;
		}
		return addFastServiceTier(event.payload);
	});
}
