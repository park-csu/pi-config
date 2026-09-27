import assert from "node:assert/strict";
import test from "node:test";
import {
  formatSearchResponse,
  formatUsageResponse,
  formatUsageStatus,
  TavilyClient,
  TavilyError,
  truncateContent,
} from "../tavily.js";

test("search sends bearer authentication and JSON", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const mockFetch: typeof fetch = async (url, init) => {
    requestUrl = String(url);
    requestInit = init;
    return new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const client = new TavilyClient({
    apiKey: "secret",
    baseUrl: "https://example.test/",
    fetch: mockFetch,
  });
  await client.search({ query: "pi" });

  assert.equal(requestUrl, "https://example.test/search");
  assert.equal(new Headers(requestInit?.headers).get("authorization"), "Bearer secret");
  assert.deepEqual(JSON.parse(String(requestInit?.body)), { query: "pi" });
});

test("missing API key produces an actionable error", async () => {
  const client = new TavilyClient({ apiKey: "" });
  await assert.rejects(() => client.search({ query: "pi" }), (error: unknown) =>
    error instanceof TavilyError && error.message.includes("/login tavily"));
});

test("API errors include Tavily details", async () => {
  const client = new TavilyClient({
    apiKey: "secret",
    fetch: async () => new Response(JSON.stringify({ detail: "quota exceeded" }), { status: 429 }),
  });
  await assert.rejects(() => client.search({ query: "pi" }), (error: unknown) =>
    error instanceof TavilyError && error.status === 429 && error.message.includes("quota exceeded"));
});

test("formats source URLs and truncates extracted content", () => {
  const formatted = formatSearchResponse({
    answer: "An answer",
    results: [{ title: "Result", url: "https://example.com", content: "Snippet", score: 0.9 }],
  });
  assert.match(formatted, /https:\/\/example\.com/);
  assert.match(formatted, /Snippet/);

  assert.deepEqual(truncateContent("short", 10), { text: "short", truncated: false });
  const long = truncateContent("abcdefghijkl", 5);
  assert.equal(long.truncated, true);
  assert.match(long.text, /^abcde/);
  assert.match(long.text, /original length: 12/);
});

test("usage uses GET and formats remaining plan credits", async () => {
  let requestInit: RequestInit | undefined;
  const client = new TavilyClient({
    apiKey: "secret",
    baseUrl: "https://example.test",
    fetch: async (_url, init) => {
      requestInit = init;
      return new Response(JSON.stringify({
        key: { usage: 10, limit: 100 },
        account: {
          current_plan: "Free",
          plan_usage: 20,
          plan_limit: 100,
          search_usage: 12,
          extract_usage: 8,
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  const usage = await client.usage();
  assert.equal(requestInit?.method, "GET");
  assert.match(formatUsageResponse(usage), /Plan: Free/);
  assert.match(formatUsageResponse(usage), /search 12/);
  assert.equal(formatUsageStatus(usage), "80 (tavily)");
});

test("usage accepts an unlimited API-key limit", async () => {
  const response = {
    key: { usage: 4, limit: null },
    account: { plan_usage: 4, plan_limit: 1000 },
  };
  assert.match(formatUsageResponse(response), /API key usage: 4/);
  assert.equal(formatUsageStatus(response), "996 (tavily)");
});

