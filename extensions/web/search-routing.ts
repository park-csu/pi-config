import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TavilyExtractResponse, TavilySearchResponse } from "./tavily.js";
import { TavilyClient } from "./tavily.js";
import { ExaClient, exaContentsBody, exaSearchBody, type ExaContentsResponse, type ExaSearchResponse } from "./exa.js";

export type SearchProvider = "tavily" | "exa";
export type RoutedSearchResult =
  | { provider: "tavily"; response: TavilySearchResponse; fallbackReason?: string; tavilyCredits?: number }
  | { provider: "exa"; response: ExaSearchResponse; fallbackReason?: string; tavilyCredits?: number };

export function providerOrder(env: NodeJS.ProcessEnv = process.env): SearchProvider[] {
  const configured = env.WEB_SEARCH_PROVIDERS;
  if (configured === undefined) return ["tavily", "exa"];
  const values = configured.split(",").map((value) => value.trim().toLowerCase());
  if (values.length === 0 || values.some((value) => value !== "tavily" && value !== "exa")
    || new Set(values).size !== values.length) {
    throw new Error("WEB_SEARCH_PROVIDERS must be a comma-separated nonempty order of tavily and exa.");
  }
  return values as SearchProvider[];
}

export async function searchWithFallback(
  params: Record<string, unknown>,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined = ctx.signal,
  order = providerOrder(),
): Promise<RoutedSearchResult> {
  const errors: string[] = [];
  let fallbackReason: string | undefined;
  let tavilyCredits: number | undefined;
  for (const provider of order) {
    if (signal?.aborted) signal.throwIfAborted();
    try {
      if (provider === "tavily") {
        if (signal?.aborted) signal.throwIfAborted();
        const key = (await ctx.modelRegistry.getApiKeyForProvider("tavily")) || process.env.TAVILY_API_KEY;
        if (signal?.aborted) signal.throwIfAborted();
        const response = await new TavilyClient({ apiKey: key }).search(params, signal);
        tavilyCredits = response.usage?.credits;
        if (response.results.length > 0) return { provider, response, fallbackReason, tavilyCredits };
        errors.push("Tavily returned no results");
        fallbackReason = "Tavily returned no results";
      } else {
        if (signal?.aborted) signal.throwIfAborted();
        const key = (await ctx.modelRegistry.getApiKeyForProvider("exa")) || process.env.EXA_API_KEY;
        if (signal?.aborted) signal.throwIfAborted();
        const response = await new ExaClient({ apiKey: key }).search(exaSearchBody(params as {
          query: string; max_results?: number; include_domains?: string[]; exclude_domains?: string[];
          start_date?: string; end_date?: string; time_range?: string;
        }), signal);
        if ((response.results?.length ?? 0) > 0) return { provider, response, fallbackReason, tavilyCredits };
        errors.push("Exa returned no results");
        fallbackReason = "Exa returned no results";
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      errors.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`);
      fallbackReason = `${provider} failed`;
    }
  }
  throw new Error(`All configured web search providers failed. ${errors.join("; ")}`);
}

export type RoutedFetchResult =
  | { provider: "tavily"; response: TavilyExtractResponse; fallbackReason?: string }
  | { provider: "exa"; response: ExaContentsResponse; fallbackReason?: string };

export async function fetchWithFallback(
  params: Record<string, unknown>,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined = ctx.signal,
): Promise<RoutedFetchResult> {
  const timeout = typeof params.timeout === "number" ? params.timeout : undefined;
  const requestSignal = () => timeout === undefined
    ? signal
    : signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeout * 1000)])
      : AbortSignal.timeout(timeout * 1000);
  let fallbackReason: string | undefined;
  try {
    if (signal?.aborted) signal.throwIfAborted();
    const key = (await ctx.modelRegistry.getApiKeyForProvider("tavily")) || process.env.TAVILY_API_KEY;
    if (signal?.aborted) signal.throwIfAborted();
    const response = await new TavilyClient({ apiKey: key }).extract(params, requestSignal());
    if (response.results.some(result => result.raw_content.trim().length > 0)) return { provider: "tavily", response };
    fallbackReason = "Tavily returned no extracted content";
  } catch (error) {
    if (signal?.aborted) throw error;
    fallbackReason = `Tavily failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  if (signal?.aborted) signal.throwIfAborted();
  const key = (await ctx.modelRegistry.getApiKeyForProvider("exa")) || process.env.EXA_API_KEY;
  if (signal?.aborted) signal.throwIfAborted();
  let response: ExaContentsResponse;
  try {
    response = await new ExaClient({ apiKey: key }).contents(exaContentsBody({
      url: String(params.url ?? params.urls),
      query: typeof params.query === "string" ? params.query : undefined,
    }), requestSignal());
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`All web fetch providers failed. ${fallbackReason}; Exa: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.results?.some(result =>
    (result.text?.trim().length ?? 0) > 0 || (result.highlights?.some(value => value.trim().length > 0) ?? false),
  )) {
    throw new Error(`All web fetch providers failed. ${fallbackReason}; Exa returned no extracted content`);
  }
  return { provider: "exa", response, fallbackReason };
}
