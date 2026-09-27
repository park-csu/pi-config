import assert from "node:assert/strict";
import test from "node:test";
import { searchWithFallback, providerOrder } from "../search-routing.js";

function context(keys: Record<string, string>, signal?: AbortSignal) {
  return {
    signal,
    modelRegistry: {
      getApiKeyForProvider: async (provider: string) => keys[provider],
    },
  } as any;
}

test("successful first provider does not call fallback", async () => {
  const oldFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ results: [{ title: "T", url: "https://t.test", content: "ok" }] }));
  };
  try {
    const result = await searchWithFallback({ query: "pi" }, context({ tavily: "t", exa: "e" }));
    assert.equal(result.provider, "tavily");
    assert.deepEqual(calls, ["https://api.tavily.com/search"]);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("empty first provider falls back to Exa and maps its response", async () => {
  const oldFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify(calls.length === 1
      ? { results: [] }
      : { results: [{ title: "E", url: "https://e.test", highlights: ["found"] }] }));
  };
  try {
    const result = await searchWithFallback({ query: "pi", max_results: 1 }, context({ tavily: "t", exa: "e" }));
    assert.equal(result.provider, "exa");
    assert.deepEqual(calls, ["https://api.tavily.com/search", "https://api.exa.ai/search"]);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("provider order is configurable and invalid values are rejected", () => {
  assert.deepEqual(providerOrder({ WEB_SEARCH_PROVIDERS: "exa,tavily" }), ["exa", "tavily"]);
  assert.throws(() => providerOrder({ WEB_SEARCH_PROVIDERS: "unknown" }), /WEB_SEARCH_PROVIDERS/);
  assert.throws(() => providerOrder({ WEB_SEARCH_PROVIDERS: "" }), /WEB_SEARCH_PROVIDERS/);
});

test("aborted Tavily request does not trigger fallback", async () => {
  const controller = new AbortController();
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    controller.abort();
    throw new DOMException("aborted", "AbortError");
  };
  try {
    await assert.rejects(
      () => searchWithFallback({ query: "pi" }, context({ tavily: "t", exa: "e" }, controller.signal)),
      (error: unknown) => error instanceof DOMException && error.name === "AbortError",
    );
  } finally {
    globalThis.fetch = oldFetch;
  }
});
