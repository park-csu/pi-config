const DEFAULT_BASE_URL = "https://api.exa.ai";

export interface ExaSearchResult {
  title?: string;
  url: string;
  text?: string;
  highlights?: string[];
  score?: number;
  publishedDate?: string;
  favicon?: string;
}

export interface ExaSearchResponse {
  results?: ExaSearchResult[];
  requestId?: string;
  costDollars?: { total?: number };
}

export interface ExaContentsResult {
  url: string;
  text?: string;
  title?: string;
  highlights?: string[];
  favicon?: string;
}

export interface ExaContentsResponse {
  results?: ExaContentsResult[];
  requestId?: string;
}

export class ExaError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ExaError";
  }
}

export interface ExaClientOptions {
  apiKey?: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export class ExaClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly request: typeof globalThis.fetch;

  constructor(options: ExaClientOptions = {}) {
    this.apiKey = options.apiKey ?? "";
    this.baseUrl = (options.baseUrl ?? process.env.EXA_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.request = options.fetch ?? globalThis.fetch;
  }

  async search(body: Record<string, unknown>, signal?: AbortSignal): Promise<ExaSearchResponse> {
    if (!this.apiKey) {
      throw new ExaError("Exa API key is not configured. Run /login exa and retry.");
    }
    const response = await this.request(`${this.baseUrl}/search`, {
      method: "POST",
      headers: { "x-api-key": this.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      const text = (await response.text()).slice(0, 2000).trim();
      throw new ExaError(`Exa search failed (${response.status}${text ? `: ${text}` : ""})`, response.status);
    }
    return await response.json() as ExaSearchResponse;
  }

  async contents(body: Record<string, unknown>, signal?: AbortSignal): Promise<ExaContentsResponse> {
    if (!this.apiKey) {
      throw new ExaError("Exa API key is not configured. Run /login exa and retry.");
    }
    const response = await this.request(`${this.baseUrl}/contents`, {
      method: "POST",
      headers: { "x-api-key": this.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      const text = (await response.text()).slice(0, 2000).trim();
      throw new ExaError(`Exa contents failed (${response.status}${text ? `: ${text}` : ""})`, response.status);
    }
    return await response.json() as ExaContentsResponse;
  }
}

export function exaContentsBody(params: {
  url: string;
  query?: string;
}): Record<string, unknown> {
  return {
    ids: [params.url],
    text: true,
    ...(params.query ? { highlights: { query: params.query } } : {}),
  };
}

export function exaSearchBody(params: {
  query: string;
  max_results?: number;
  include_domains?: string[];
  exclude_domains?: string[];
  start_date?: string;
  end_date?: string;
  time_range?: string;
}): Record<string, unknown> {
  const rangeDays = { day: 1, week: 7, month: 30, year: 365 }[params.time_range ?? ""];
  const rangeStart = rangeDays
    ? new Date(Date.now() - rangeDays * 86_400_000).toISOString()
    : undefined;
  return {
    query: params.query,
    numResults: params.max_results ?? 5,
    ...(params.include_domains ? { includeDomains: params.include_domains } : {}),
    ...(params.exclude_domains ? { excludeDomains: params.exclude_domains } : {}),
    ...(params.start_date
      ? { startPublishedDate: `${params.start_date}T00:00:00.000Z` }
      : rangeStart ? { startPublishedDate: rangeStart } : {}),
    ...(params.end_date ? { endPublishedDate: `${params.end_date}T23:59:59.999Z` } : {}),
    contents: { highlights: true },
  };
}

export function formatExaSearchResponse(response: ExaSearchResponse): string {
  const results = response.results ?? [];
  if (results.length === 0) return "No results found.";
  return results.map((result, index) => {
    const title = result.title ?? result.url;
    const snippet = result.highlights?.join(" ") || result.text || "";
    const score = typeof result.score === "number" ? ` (score: ${result.score.toFixed(3)})` : "";
    return `${index + 1}. ${title}${score}\n   ${result.url}${snippet ? `\n   ${snippet}` : ""}`;
  }).join("\n\n");
}
