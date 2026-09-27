import assert from "node:assert/strict";
import test from "node:test";
import { ExaClient, ExaError, exaSearchBody, formatExaSearchResponse } from "../exa.js";

test("Exa sends documented authentication and maps request fields", async () => {
  let init: RequestInit | undefined;
  const client = new ExaClient({
    apiKey: "secret",
    baseUrl: "https://example.test/",
    fetch: async (_url, requestInit) => {
      init = requestInit;
      return new Response(JSON.stringify({ results: [{ title: "Result", url: "https://example.com", highlights: ["Snippet"] }] }));
    },
  });
  const body = exaSearchBody({
    query: "pi",
    max_results: 2,
    include_domains: ["example.com"],
    start_date: "2025-01-01",
  });
  const response = await client.search(body);
  assert.equal(new Headers(init?.headers).get("x-api-key"), "secret");
  assert.deepEqual(JSON.parse(String(init?.body)), body);
  assert.match(formatExaSearchResponse(response), /https:\/\/example\.com/);
  assert.match(formatExaSearchResponse(response), /Snippet/);
});

test("Exa missing key and API errors are actionable", async () => {
  await assert.rejects(() => new ExaClient({ apiKey: "" }).search({ query: "pi" }), (error: unknown) =>
    error instanceof ExaError && error.message.includes("/login exa"));
  const client = new ExaClient({
    apiKey: "secret",
    fetch: async () => new Response("quota exceeded", { status: 429 }),
  });
  await assert.rejects(() => client.search({ query: "pi" }), (error: unknown) =>
    error instanceof ExaError && error.status === 429 && error.message.includes("quota exceeded"));
});

test("empty Exa responses format as no results", () => {
  assert.equal(formatExaSearchResponse({ results: [] }), "No results found.");
});

test("time range maps to an Exa publication date filter", () => {
  const body = exaSearchBody({ query: "pi", time_range: "week" });
  assert.equal(typeof body.startPublishedDate, "string");
  assert.equal(body.endPublishedDate, undefined);
});
