import { uiTone } from "ui-kit/appearance";
import { createToolRegistrar } from "ui-kit/tools";
import { createProvider, lazyApi, type Api } from "@earendil-works/pi-ai";
import { keyHint, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  formatSearchResponse,
  formatUsageResponse,
  formatUsageStatus,
  TavilyClient,
  truncateContent,
  type TavilyExtractResponse,
  type TavilyExtractResult,
  type TavilySearchResponse,
  type TavilyUsageResponse,
} from "./tavily.js";
import { formatExaSearchResponse, type ExaContentsResponse, type ExaContentsResult } from "./exa.js";
import { fetchWithFallback, searchWithFallback } from "./search-routing.js";

const searchSchema = Type.Object({
  query: Type.String({ description: "Search query", minLength: 1 }),
  search_depth: Type.Optional(Type.Union([
    Type.Literal("basic"),
    Type.Literal("advanced"),
    Type.Literal("fast"),
    Type.Literal("ultra-fast"),
  ], { description: "Search depth/speed. Defaults to basic." })),
  auto_parameters: Type.Optional(Type.Boolean({
    description: "Let Tavily infer search parameters. Explicit parameters still take precedence. Defaults to false.",
  })),
  topic: Type.Optional(Type.Union([
    Type.Literal("general"),
    Type.Literal("news"),
    Type.Literal("finance"),
  ], { description: "Search category. Defaults to general." })),
  max_results: Type.Optional(Type.Integer({
    description: "Maximum number of results. Defaults to 5.",
    minimum: 1,
    maximum: 20,
  })),
  chunks_per_source: Type.Optional(Type.Integer({
    description: "Maximum relevant snippets per result. Supported by basic, advanced, and fast search. Defaults to 3.",
    minimum: 1,
    maximum: 3,
  })),
  time_range: Type.Optional(Type.Union([
    Type.Literal("day"),
    Type.Literal("week"),
    Type.Literal("month"),
    Type.Literal("year"),
  ], { description: "Limit results to a recent time range." })),
  start_date: Type.Optional(Type.String({
    description: "Only results after this date (YYYY-MM-DD).",
    pattern: "^\\d{4}-\\d{2}-\\d{2}$",
  })),
  end_date: Type.Optional(Type.String({
    description: "Only results before this date (YYYY-MM-DD).",
    pattern: "^\\d{4}-\\d{2}-\\d{2}$",
  })),
  include_domains: Type.Optional(Type.Array(Type.String(), {
    description: "Domains to include.",
    maxItems: 300,
  })),
  exclude_domains: Type.Optional(Type.Array(Type.String(), {
    description: "Domains to exclude.",
    maxItems: 150,
  })),
  country: Type.Optional(Type.String({
    description: "Country whose results should be prioritized. Available only for the general topic.",
    minLength: 1,
  })),
  include_answer: Type.Optional(Type.Union([
    Type.Boolean(),
    Type.Literal("basic"),
    Type.Literal("advanced"),
  ], { description: "Include a generated answer: false, true/basic, or advanced. Defaults to false." })),
  exact_match: Type.Optional(Type.Boolean({
    description: "Require quoted phrases in the query to match exactly. Defaults to false.",
  })),
  include_favicon: Type.Optional(Type.Boolean({
    description: "Include favicon URLs in result metadata. Defaults to false.",
  })),
  include_usage: Type.Optional(Type.Boolean({
    description: "Include credits consumed by this request in its metadata. Enabled internally for credit tracking.",
  })),
}, { additionalProperties: false });

const fetchSchema = Type.Object({
  url: Type.String({
    description: "Public HTTP(S) URL to fetch and extract.",
    minLength: 1,
    pattern: "^https?://",
  }),
  extract_depth: Type.Optional(Type.Union([
    Type.Literal("basic"),
    Type.Literal("advanced"),
  ], { description: "Extraction depth. Advanced improves complex-page extraction; defaults to basic." })),
  format: Type.Optional(Type.Union([
    Type.Literal("markdown"),
    Type.Literal("text"),
  ], { description: "Extracted content format. Defaults to markdown." })),
  query: Type.Optional(Type.String({
    description: "Optional query used to rerank and return the most relevant page chunks.",
    minLength: 1,
  })),
  chunks_per_source: Type.Optional(Type.Integer({
    description: "Relevant chunks to return when query is provided. Defaults to 3.",
    minimum: 1,
    maximum: 5,
  })),
  timeout: Type.Optional(Type.Number({
    description: "Extraction timeout in seconds. Tavily defaults depend on extract depth.",
    minimum: 1,
    maximum: 60,
  })),
  include_favicon: Type.Optional(Type.Boolean({
    description: "Include the page favicon URL in metadata. Defaults to false.",
  })),
  include_usage: Type.Optional(Type.Boolean({
    description: "Include credits consumed by this request in metadata. Enabled internally for credit tracking.",
  })),
  max_chars: Type.Optional(Type.Integer({
    description: "Maximum extracted characters returned to the model. Defaults to 50000.",
    minimum: 1000,
    maximum: 100000,
  })),
}, { additionalProperties: false });

export type WebSearchInput = Static<typeof searchSchema>;
export type WebFetchInput = Static<typeof fetchSchema>;

interface SearchDetails {
  provider: "tavily" | "exa";
  query: string;
  resultCount: number;
  titles: string[];
  urls: string[];
  favicons?: string[];
  requestId?: string;
  responseTime?: number | string;
  credits?: number;
  costDollars?: number;
  fallbackReason?: string;
  unsupportedOptions?: string[];
}

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
  const content = result.content[0];
  return content?.type === "text" ? content.text ?? "" : "";
}

function formatDuration(value: number | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? `${numeric.toFixed(2).replace(/\.?0+$/, "")}s` : String(value);
}

function formatCredits(credits: number | undefined): string | undefined {
  if (typeof credits !== "number") return undefined;
  return `${credits} credit${credits === 1 ? "" : "s"}`;
}

function excerpt(text: string, maxLines = 40, maxChars = 8000): { text: string; truncated: boolean } {
  const lines = text.split("\n");
  let output = lines.slice(0, maxLines).join("\n");
  let truncated = lines.length > maxLines;
  if (output.length > maxChars) {
    output = output.slice(0, maxChars);
    truncated = true;
  }
  return { text: output.trimEnd(), truncated };
}

function quoted(value: string): string {
  return `"${value.replaceAll("\n", " ")}"`;
}

function renderSearchCall(args: WebSearchInput, theme: any): Text {
  let text = theme.fg(uiTone.toolTitle, theme.bold("web_search "));
  text += theme.fg(uiTone.body, quoted(args.query));
  const options = [
    args.search_depth ?? (args.auto_parameters ? "auto depth" : "basic"),
    args.topic ?? (args.auto_parameters ? "auto topic" : "general"),
    `${args.max_results ?? 5} results`,
    args.time_range,
    args.country,
    args.include_domains?.length ? `in ${args.include_domains.join(", ")}` : undefined,
    args.exclude_domains?.length ? `excluding ${args.exclude_domains.join(", ")}` : undefined,
  ].filter((value): value is string => Boolean(value));
  if (options.length) text += `\n${theme.fg(uiTone.secondary, options.join(" · "))}`;
  return new Text(text, 0, 0);
}

function renderFetchCall(args: WebFetchInput, theme: any): Text {
  let text = theme.fg(uiTone.toolTitle, theme.bold("web_fetch "));
  text += theme.fg(uiTone.body, args.url);
  const options = [
    args.extract_depth ?? "basic",
    args.format ?? "markdown",
    args.query ? `focus ${quoted(args.query)}` : undefined,
  ].filter((value): value is string => Boolean(value));
  if (options.length) text += `\n${theme.fg(uiTone.secondary, options.join(" · "))}`;
  return new Text(text, 0, 0);
}

interface FetchDetails {
  provider: "tavily" | "exa";
  url: string;
  contentLength: number;
  truncated: boolean;
  failedResults: TavilyExtractResponse["failed_results"];
  requestId?: string;
  responseTime?: number | string;
  credits?: number;
  favicon?: string;
  fallbackReason?: string;
  unsupportedOptions?: string[];
}

async function client(ctx: ExtensionContext): Promise<TavilyClient> {
  const apiKey = await ctx.modelRegistry.getApiKeyForProvider("tavily");
  if (!apiKey) {
    throw new Error("Tavily API key is not configured. Run /login tavily and retry.");
  }
  return new TavilyClient({ apiKey });
}

export default function piWeb(pi: ExtensionAPI) {
  const registerTool = createToolRegistrar(pi);
  pi.registerProvider(createProvider<Api>({
    id: "tavily",
    name: "Tavily",
    auth: {
      apiKey: {
        name: "Tavily API key",
        async login(interaction) {
          return {
            type: "api_key",
            key: await interaction.prompt({
              type: "secret",
              message: "Enter your Tavily API key",
              placeholder: "tvly-...",
            }),
          };
        },
        async resolve({ credential }) {
          if (!credential?.key) return undefined;
          return {
            auth: { apiKey: credential.key },
            source: "~/.pi/agent/auth.json",
          };
        },
      },
    },
    models: [],
    // Tavily has no language models; this implementation is never invoked.
    api: lazyApi(() => import("@earendil-works/pi-ai/api/openai-completions")),
  }));
  pi.registerProvider(createProvider<Api>({
    id: "exa",
    name: "Exa",
    auth: {
      apiKey: {
        name: "Exa API key",
        async login(interaction) {
          return {
            type: "api_key",
            key: await interaction.prompt({
              type: "secret",
              message: "Enter your Exa API key",
              placeholder: "exa-...",
            }),
          };
        },
        async resolve({ credential }) {
          if (!credential?.key) return undefined;
          return { auth: { apiKey: credential.key }, source: "~/.pi/agent/auth.json" };
        },
      },
    },
    models: [],
    api: lazyApi(() => import("@earendil-works/pi-ai/api/openai-completions")),
  }));

  let cachedUsage: TavilyUsageResponse | undefined;
  let usageFetchedAt = 0;
  let usageRequest: Promise<TavilyUsageResponse> | undefined;
  let usageMonth = new Date().toISOString().slice(0, 7);

  function preserveNewerLocalCounters(
    previous: TavilyUsageResponse,
    fetched: TavilyUsageResponse,
  ): TavilyUsageResponse {
    const counterKeys = [
      "usage",
      "search_usage",
      "crawl_usage",
      "extract_usage",
      "map_usage",
      "research_usage",
    ] as const;
    for (const scope of ["key", "account"] as const) {
      const oldScope = previous[scope];
      const newScope = fetched[scope];
      if (!oldScope || !newScope) continue;
      for (const key of counterKeys) {
        const oldValue = oldScope[key];
        const newValue = newScope[key];
        if (typeof oldValue === "number" && (typeof newValue !== "number" || oldValue > newValue)) {
          newScope[key] = oldValue;
        }
      }
    }
    const oldPlanUsage = previous.account?.plan_usage;
    if (
      fetched.account
      && typeof oldPlanUsage === "number"
      && (typeof fetched.account.plan_usage !== "number" || oldPlanUsage > fetched.account.plan_usage)
    ) {
      fetched.account.plan_usage = oldPlanUsage;
    }
    return fetched;
  }

  function showUsageStatus(ctx: ExtensionContext, usage: TavilyUsageResponse): void {
    if (!ctx.hasUI) return;
    const status = formatUsageStatus(usage);
    ctx.ui.setStatus("01-tavily-usage", status ? ctx.ui.theme.fg(uiTone.body, status) : undefined);
  }

  async function refreshUsage(ctx: ExtensionContext, force = false): Promise<TavilyUsageResponse> {
    if (!force && cachedUsage && Date.now() - usageFetchedAt < 60_000) return cachedUsage;
    if (usageRequest) return usageRequest;

    usageRequest = (async () => {
      let usage = await (await client(ctx)).usage(ctx.signal);
      const currentMonth = new Date().toISOString().slice(0, 7);
      if (cachedUsage && usageMonth === currentMonth) {
        usage = preserveNewerLocalCounters(cachedUsage, usage);
      }
      cachedUsage = usage;
      usageMonth = currentMonth;
      usageFetchedAt = Date.now();
      showUsageStatus(ctx, usage);
      return usage;
    })();
    try {
      return await usageRequest;
    } finally {
      usageRequest = undefined;
    }
  }

  function recordRequestCredits(
    ctx: ExtensionContext,
    endpoint: "search" | "extract",
    credits: number | undefined,
  ): void {
    if (!cachedUsage || typeof credits !== "number" || credits <= 0) return;

    const endpointKey = `${endpoint}_usage` as const;
    const account = cachedUsage.account;
    if (account) {
      account.plan_usage = (account.plan_usage ?? 0) + credits;
      account.usage = (account.usage ?? 0) + credits;
      account[endpointKey] = (account[endpointKey] ?? 0) + credits;
    }
    const key = cachedUsage.key;
    if (key) {
      key.usage = (key.usage ?? 0) + credits;
      key[endpointKey] = (key[endpointKey] ?? 0) + credits;
    }
    usageFetchedAt = Date.now();
    showUsageStatus(ctx, cachedUsage);
  }

  async function refreshUsageQuietly(ctx: ExtensionContext): Promise<void> {
    try {
      await refreshUsage(ctx);
    } catch {
      // Missing credentials and transient usage endpoint failures must not
      // turn an otherwise successful search/extract request into an error.
      if (ctx.hasUI) ctx.ui.setStatus("01-tavily-usage", undefined);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    await refreshUsageQuietly(ctx);
  });

  pi.registerCommand("tavily-usage", {
    description: "Show Tavily plan and API-key credit usage",
    handler: async (_args, ctx) => {
      try {
        const usage = await refreshUsage(ctx, true);
        ctx.ui.notify(formatUsageResponse(usage), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the current web with Tavily and fall back to Exa on failure or no results. Returns source titles, URLs, and relevant snippets. Use web_fetch to read a result in depth.",
    promptSnippet: "Search the web with Tavily, falling back to Exa only when needed",
    promptGuidelines: [
      "Use web_search for current or externally sourced information, then cite the returned URLs.",
      "Use web_fetch when a search snippet does not contain enough detail.",
    ],
    parameters: searchSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const useAutomaticParameters = params.auto_parameters ?? false;
      const tavilyBody = {
        query: params.query,
        ...(params.search_depth
          ? { search_depth: params.search_depth }
          : useAutomaticParameters ? {} : { search_depth: "basic" }),
        ...(params.topic
          ? { topic: params.topic }
          : params.country ? { topic: "general" } : useAutomaticParameters ? {} : { topic: "general" }),
        auto_parameters: useAutomaticParameters,
        max_results: params.max_results ?? 5,
        ...(params.chunks_per_source !== undefined ? { chunks_per_source: params.chunks_per_source } : {}),
        ...(params.time_range ? { time_range: params.time_range } : {}),
        ...(params.start_date ? { start_date: params.start_date } : {}),
        ...(params.end_date ? { end_date: params.end_date } : {}),
        ...(params.include_domains ? { include_domains: params.include_domains } : {}),
        ...(params.exclude_domains ? { exclude_domains: params.exclude_domains } : {}),
        ...(params.country ? { country: params.country } : {}),
        include_answer: params.include_answer ?? false,
        exact_match: params.exact_match ?? false,
        include_raw_content: false,
        include_images: false,
        include_favicon: params.include_favicon ?? false,
        // Always request the tiny usage object so the footer can update
        // immediately; /usage account totals may be delayed or rate-limited.
        include_usage: true,
      };
      const routed = await searchWithFallback(tavilyBody, ctx, signal);
      const response = routed.response;
      const results = routed.provider === "tavily"
        ? (response as TavilySearchResponse).results
        : (response as import("./exa.js").ExaSearchResponse).results ?? [];

      const details: SearchDetails = {
        provider: routed.provider,
        query: params.query,
        resultCount: results.length,
        titles: results.map((result) => result.title ?? result.url),
        urls: results.map((result) => result.url),
        favicons: results.flatMap((result) => result.favicon ? [result.favicon] : []),
        requestId: routed.provider === "tavily"
          ? (response as TavilySearchResponse).request_id
          : (response as import("./exa.js").ExaSearchResponse).requestId,
        responseTime: routed.provider === "tavily"
          ? (response as TavilySearchResponse).response_time
          : undefined,
        credits: routed.provider === "tavily"
          ? (response as TavilySearchResponse).usage?.credits
          : undefined,
        costDollars: routed.provider === "exa"
          ? (response as import("./exa.js").ExaSearchResponse).costDollars?.total
          : undefined,
        fallbackReason: routed.fallbackReason,
        unsupportedOptions: routed.provider === "exa"
          ? ["search_depth", "auto_parameters", "topic", "chunks_per_source", "country", "include_answer", "exact_match", "include_favicon"]
              .filter((name) => (params as Record<string, unknown>)[name] !== undefined)
          : undefined,
      };
      recordRequestCredits(ctx, "search", routed.tavilyCredits);
      const text = routed.provider === "tavily"
        ? formatSearchResponse(response as TavilySearchResponse)
        : formatExaSearchResponse(response as import("./exa.js").ExaSearchResponse);
      const notices = [
        routed.provider === "exa" ? "Search provider: Exa." : undefined,
        details.fallbackReason ? `Fallback: ${details.fallbackReason}.` : undefined,
        details.unsupportedOptions?.length
          ? `Exa ignored unsupported options: ${details.unsupportedOptions.join(", ")}.`
          : undefined,
      ].filter(Boolean);
      return {
        content: [{ type: "text" as const, text: [...notices, text].join("\n\n") }],
        details,
      };
    },
    renderCall(args, theme) {
      return renderSearchCall(args, theme);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return new Text(theme.fg(uiTone.active, "Searching the web…"), 0, 0);
      const raw = textContent(result);
      if (context.isError) return new Text(theme.fg(uiTone.error, raw || "Search failed"), 0, 0);
      const details = result.details as SearchDetails | undefined;
      if (!details) return new Text(raw, 0, 0);

      const metadata = [
        `${details.resultCount} result${details.resultCount === 1 ? "" : "s"}`,
        formatCredits(details.credits),
        formatDuration(details.responseTime),
      ].filter((value): value is string => Boolean(value));
      let text = theme.fg(uiTone.body, "✓ ") + theme.fg(uiTone.body, metadata.join(" · "));
      text += ` · ${theme.fg(uiTone.secondary, details.provider)}`;
      if (details.fallbackReason) text += `\n  ${theme.fg(uiTone.warning, `Fallback: ${details.fallbackReason}`)}`;
      if (details.costDollars !== undefined) text += `\n  ${theme.fg(uiTone.secondary, `Estimated cost: $${details.costDollars}`)}`;
      if (details.unsupportedOptions?.length) {
        text += `\n  ${theme.fg(uiTone.warning, `Exa ignored unsupported options: ${details.unsupportedOptions.join(", ")}`)}`;
      }
      const shown = expanded ? details.urls.length : Math.min(details.urls.length, 3);
      for (let index = 0; index < shown; index++) {
        const title = details.titles[index] || details.urls[index]!;
        text += `\n  ${theme.fg(uiTone.secondary, `${index + 1}. `) + theme.fg(uiTone.title, theme.bold(title))}`;
        text += `\n     ${theme.fg(uiTone.secondary, details.urls[index]!)}`;
      }
      if (!expanded && details.urls.length > shown) {
        text += `\n  ${theme.fg(uiTone.secondary, `… ${details.urls.length - shown} more · ${keyHint("app.tools.expand", "all results")}`)}`;
      }
      if (expanded && raw) {
        const output = excerpt(raw);
        text += `\n\n${theme.fg(uiTone.title, output.text)}`;
        if (output.truncated) text += `\n${theme.fg(uiTone.secondary, "… display excerpt truncated; full result remains in tool output")}`;
      }
      return new Text(text, 0, 0);
    },
  });

  registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch and extract readable content from a public web page with Tavily, falling back to Exa on failure or empty extraction. Use URLs returned by web_search when possible.",
    promptSnippet: "Fetch readable content from a web URL with Tavily, falling back to Exa when needed",
    parameters: fetchSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const tavilyBody = {
        urls: params.url,
        extract_depth: params.extract_depth ?? "basic",
        format: params.format ?? "markdown",
        ...(params.query ? { query: params.query } : {}),
        ...(params.chunks_per_source ? { chunks_per_source: params.chunks_per_source } : {}),
        ...(params.timeout !== undefined ? { timeout: params.timeout } : {}),
        include_images: false,
        include_favicon: params.include_favicon ?? false,
        include_usage: true,
      };
      const routed = await fetchWithFallback(tavilyBody, ctx, signal);
      const response = routed.response;
      const result = routed.provider === "tavily"
        ? (response as TavilyExtractResponse).results.find(item => item.raw_content.trim().length > 0)
        : (response as ExaContentsResponse).results?.find((item: ExaContentsResult) =>
          (item.text?.trim().length ?? 0) > 0 || (item.highlights?.some(value => value.trim().length > 0) ?? false),
        );
      if (!result) {
        throw new Error(`Could not fetch ${params.url}: provider returned no extracted content.`);
      }

      const content = routed.provider === "tavily"
        ? (result as TavilyExtractResult).raw_content
        : params.query && (result as ExaContentsResult).highlights?.some(value => value.trim().length > 0)
          ? (result as ExaContentsResult).highlights!.join(" ")
          : (result as ExaContentsResult).text?.trim()
            ? (result as ExaContentsResult).text!
          : (result as ExaContentsResult).highlights?.join(" ") ?? "";
      if (!content) throw new Error(`Could not fetch ${params.url}: provider returned empty content.`);
      const contentLength = content.length;
      const output = truncateContent(content, params.max_chars ?? 50_000);
      const details: FetchDetails = {
        provider: routed.provider,
        url: result.url,
        contentLength,
        truncated: output.truncated,
        failedResults: routed.provider === "tavily" ? (response as TavilyExtractResponse).failed_results : undefined,
        requestId: routed.provider === "tavily"
          ? (response as TavilyExtractResponse).request_id
          : (response as ExaContentsResponse).requestId,
        responseTime: routed.provider === "tavily" ? (response as TavilyExtractResponse).response_time : undefined,
        credits: routed.provider === "tavily" ? (response as TavilyExtractResponse).usage?.credits : undefined,
        favicon: result.favicon,
        fallbackReason: routed.fallbackReason,
        unsupportedOptions: routed.provider === "exa"
          ? ["extract_depth", "format", "chunks_per_source", "include_favicon"]
              .filter(name => (params as Record<string, unknown>)[name] !== undefined)
          : undefined,
      };
      if (routed.provider === "tavily") {
        recordRequestCredits(ctx, "extract", (response as TavilyExtractResponse).usage?.credits);
      }
      return {
        content: [{
          type: "text" as const,
          text: [
            routed.provider === "exa" ? "Fetch provider: Exa." : undefined,
            routed.fallbackReason ? `Fallback: ${routed.fallbackReason}.` : undefined,
            `Source: ${result.url}\n\n${output.text}`,
          ].filter(Boolean).join("\n\n"),
        }],
        details,
      };
    },
    renderCall(args, theme) {
      return renderFetchCall(args, theme);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return new Text(theme.fg(uiTone.active, "Fetching with Tavily…"), 0, 0);
      const raw = textContent(result);
      if (context.isError) return new Text(theme.fg(uiTone.error, raw || "Fetch failed"), 0, 0);
      const details = result.details as FetchDetails | undefined;
      if (!details) return new Text(raw, 0, 0);

      const metadata = [
        `${details.contentLength.toLocaleString()} chars`,
        details.truncated ? "model output truncated" : undefined,
        formatCredits(details.credits),
        formatDuration(details.responseTime),
      ].filter((value): value is string => Boolean(value));
      let text = theme.fg(uiTone.body, "✓ ") + theme.fg(uiTone.body, metadata.join(" · "));
      text += `\n  ${theme.fg(uiTone.secondary, details.url)}`;
      if (details.provider === "exa") text += `\n  ${theme.fg(uiTone.secondary, "exa")}`;
      if (details.fallbackReason) text += `\n${theme.fg(uiTone.warning, `Fallback: ${details.fallbackReason}`)}`;
      if (details.unsupportedOptions?.length) {
        text += `\n${theme.fg(uiTone.warning, `Exa ignored unsupported options: ${details.unsupportedOptions.join(", ")}`)}`;
      }
      if (details.failedResults?.length) {
        text += `\n${theme.fg(uiTone.warning, `${details.failedResults.length} URL extraction failure(s)`)}`;
      }
      if (expanded && raw) {
        const output = excerpt(raw);
        text += `\n\n${theme.fg(uiTone.title, output.text)}`;
        if (output.truncated) text += `\n${theme.fg(uiTone.secondary, "… display excerpt truncated; full result remains in tool output")}`;
      } else if (!expanded) {
        text += `\n  ${theme.fg(uiTone.secondary, keyHint("app.tools.expand", "content excerpt"))}`;
      }
      return new Text(text, 0, 0);
    },
  });
}

export { TavilyClient, TavilyError } from "./tavily.js";
export { ExaClient, ExaError } from "./exa.js";
