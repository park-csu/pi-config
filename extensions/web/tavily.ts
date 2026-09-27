const DEFAULT_BASE_URL = "https://api.tavily.com";

export interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score?: number;
  favicon?: string;
}

export interface TavilySearchResponse {
  query?: string;
  answer?: string | null;
  results: TavilySearchResult[];
  response_time?: number | string;
  request_id?: string;
  usage?: { credits?: number };
}

export interface TavilyExtractResult {
  url: string;
  raw_content: string;
  images?: string[];
  favicon?: string;
}

export interface TavilyExtractResponse {
  results: TavilyExtractResult[];
  failed_results?: Array<{ url: string; error: string }>;
  response_time?: number | string;
  request_id?: string;
  usage?: { credits?: number };
}

export interface TavilyEndpointUsage {
  usage?: number;
  limit?: number | null;
  search_usage?: number;
  crawl_usage?: number;
  extract_usage?: number;
  map_usage?: number;
  research_usage?: number;
}

export interface TavilyUsageResponse {
  key?: TavilyEndpointUsage;
  account?: TavilyEndpointUsage & {
    current_plan?: string;
    plan_usage?: number;
    plan_limit?: number;
    paygo_usage?: number;
    paygo_limit?: number | null;
  };
  [key: string]: unknown;
}

export interface TavilyClientOptions {
  apiKey?: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export class TavilyError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "TavilyError";
  }
}

export class TavilyClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly request: typeof globalThis.fetch;

  constructor(options: TavilyClientOptions = {}) {
    this.apiKey = options.apiKey ?? "";
    this.baseUrl = (options.baseUrl ?? process.env.TAVILY_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.request = options.fetch ?? globalThis.fetch;
  }

  private async requestJson<T>(path: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
    if (!this.apiKey) {
      throw new TavilyError("Tavily API key is not configured. Run /login tavily and retry.");
    }

    const response = await this.request(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
      signal,
    });

    if (!response.ok) {
      const text = (await response.text()).slice(0, 2000).trim();
      let detail = text;
      try {
        const parsed = JSON.parse(text) as { detail?: unknown; message?: unknown; error?: unknown };
        detail = String(parsed.detail ?? parsed.message ?? parsed.error ?? text);
      } catch {
        // Keep the plain-text response.
      }
      throw new TavilyError(
        `Tavily ${path} failed (${response.status}${response.statusText ? ` ${response.statusText}` : ""})${detail ? `: ${detail}` : ""}`,
        response.status,
      );
    }

    return await response.json() as T;
  }

  private post<T>(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    return this.requestJson<T>(path, {
      method: "POST",
      body: JSON.stringify(body),
    }, signal);
  }

  search(body: Record<string, unknown>, signal?: AbortSignal): Promise<TavilySearchResponse> {
    return this.post<TavilySearchResponse>("/search", body, signal);
  }

  extract(body: Record<string, unknown>, signal?: AbortSignal): Promise<TavilyExtractResponse> {
    return this.post<TavilyExtractResponse>("/extract", body, signal);
  }

  usage(signal?: AbortSignal): Promise<TavilyUsageResponse> {
    return this.requestJson<TavilyUsageResponse>("/usage", { method: "GET" }, signal);
  }
}

export function formatUsageResponse(response: TavilyUsageResponse): string {
  const lines: string[] = [];
  const account = response.account;
  const key = response.key;

  if (account?.current_plan) lines.push(`Plan: ${account.current_plan}`);
  if (typeof account?.plan_usage === "number" && typeof account.plan_limit === "number") {
    lines.push(`Plan credits: ${account.plan_usage.toLocaleString()} / ${account.plan_limit.toLocaleString()} used`);
  }
  if (typeof account?.paygo_usage === "number") {
    const limit = typeof account.paygo_limit === "number" ? ` / ${account.paygo_limit.toLocaleString()}` : "";
    lines.push(`Pay-as-you-go: ${account.paygo_usage.toLocaleString()}${limit} used`);
  }
  if (typeof key?.usage === "number" && typeof key.limit === "number") {
    lines.push(`API key: ${key.usage.toLocaleString()} / ${key.limit.toLocaleString()} used`);
  } else if (typeof key?.usage === "number") {
    lines.push(`API key usage: ${key.usage.toLocaleString()}`);
  }

  const endpointUsage = account ?? key;
  const breakdown = [
    ["search", endpointUsage?.search_usage],
    ["extract", endpointUsage?.extract_usage],
    ["crawl", endpointUsage?.crawl_usage],
    ["map", endpointUsage?.map_usage],
    ["research", endpointUsage?.research_usage],
  ].filter((entry): entry is [string, number] => typeof entry[1] === "number");
  if (breakdown.length > 0) {
    lines.push(`By endpoint: ${breakdown.map(([name, usage]) => `${name} ${usage.toLocaleString()}`).join(", ")}`);
  }

  return lines.length > 0 ? lines.join("\n") : JSON.stringify(response, null, 2);
}

export function formatUsageStatus(response: TavilyUsageResponse): string | undefined {
  const used = response.account?.plan_usage ?? response.key?.usage;
  const limit = response.account?.plan_limit ?? response.key?.limit;
  if (typeof used !== "number" || typeof limit !== "number") return undefined;
  return `${Math.max(0, limit - used).toLocaleString()} (tavily)`;
}

export function formatSearchResponse(response: TavilySearchResponse): string {
  const sections: string[] = [];
  if (response.answer) sections.push(`Answer: ${response.answer}`);

  if (response.results.length === 0) {
    sections.push("No results found.");
  } else {
    sections.push(response.results.map((result, index) => {
      const score = typeof result.score === "number" ? ` (score: ${result.score.toFixed(3)})` : "";
      return `${index + 1}. ${result.title}${score}\n   ${result.url}\n   ${result.content}`;
    }).join("\n\n"));
  }

  return sections.join("\n\n");
}

export function truncateContent(content: string, maxChars: number): { text: string; truncated: boolean } {
  if (content.length <= maxChars) return { text: content, truncated: false };
  return {
    text: `${content.slice(0, maxChars).trimEnd()}\n\n[Content truncated at ${maxChars} characters; original length: ${content.length}]`,
    truncated: true,
  };
}

