import assert from "node:assert/strict";
import test from "node:test";
import extension from "../index.js";

async function fixture(
  t: test.TestContext,
  request: typeof fetch,
  keys: Record<string, string> = { tavily: "test-tavily", exa: "test-exa" },
) {
  const originalFetch = globalThis.fetch;
  const names = ["WEB_SEARCH_PROVIDERS", "TAVILY_BASE_URL", "EXA_BASE_URL", "TAVILY_API_KEY", "EXA_API_KEY"];
  const env = names.map(name => [name, process.env[name]] as const);
  names.forEach(name => delete process.env[name]);
  globalThis.fetch = request;
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [name, value] of env) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const tools = new Map<string, any>();
  const providers: any[] = [];
  extension({
    registerProvider(provider: any) { providers.push(provider); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand() {},
    on() {},
  } as any);
  const ctx: any = {
    hasUI: false,
    modelRegistry: { getApiKeyForProvider: async (name: string) => keys[name] },
  };
  assert.deepEqual(providers.map(provider => provider.id), ["tavily", "exa"]);
  return {
    search: (params: Record<string, unknown>, signal?: AbortSignal) =>
      tools.get("web_search").execute("test", params, signal, undefined, ctx),
    fetch: (params: Record<string, unknown>, signal?: AbortSignal) =>
      tools.get("web_fetch").execute("test", params, signal, undefined, ctx),
  };
}

test("web_search falls back on Tavily HTTP 432 and reports Exa limitations to the model", async t => {
  const urls: string[] = [];
  const { search } = await fixture(t, async (url, init) => {
    urls.push(String(url));
    if (urls.length === 1) return new Response('{"detail":"quota exhausted"}', { status: 432 });
    assert.equal(new Headers(init?.headers).get("x-api-key"), "test-exa");
    assert.equal(JSON.parse(String(init?.body)).query, "test query");
    return Response.json({
      results: [{ title: "Exa source", url: "https://example.org", highlights: ["A snippet"] }],
      costDollars: { total: 0.005 },
    });
  });
  const result = await search({ query: "test query", exact_match: true });
  assert.deepEqual(urls, ["https://api.tavily.com/search", "https://api.exa.ai/search"]);
  assert.equal(result.details.provider, "exa");
  assert.equal(result.details.costDollars, 0.005);
  assert.match(result.content[0].text, /Fallback: tavily failed/);
  assert.match(result.content[0].text, /ignored unsupported options: exact_match/);
  assert.match(result.content[0].text, /https:\/\/example.org/);
});

test("web_search respects its explicit cancellation signal, without ctx.signal", async t => {
  const controller = new AbortController();
  let requests = 0;
  const { search } = await fixture(t, async (_url, init) => {
    requests++;
    assert.equal(init?.signal, controller.signal);
    controller.abort();
    throw controller.signal.reason;
  });
  await assert.rejects(search({ query: "cancel" }, controller.signal), { name: "AbortError" });
  assert.equal(requests, 1);
  await assert.rejects(search({ query: "already cancelled" }, controller.signal), { name: "AbortError" });
  assert.equal(requests, 1);
});

test("web_search falls back when Tavily key is absent", async t => {
  const urls: string[] = [];
  const { search } = await fixture(t, async url => {
    urls.push(String(url));
    return Response.json({ results: [{ url: "https://example.org", title: "Found" }] });
  }, { exa: "test-exa" });
  assert.equal((await search({ query: "test" })).details.provider, "exa");
  assert.deepEqual(urls, ["https://api.exa.ai/search"]);
});

test("web_search honors single-provider configuration and reports missing credentials", async t => {
  const { search } = await fixture(t, async () => {
    assert.fail("No network call expected without a key");
  }, {});
  process.env.WEB_SEARCH_PROVIDERS = "exa";
  await assert.rejects(search({ query: "test" }), /\/login exa/);
  process.env.WEB_SEARCH_PROVIDERS = "typo";
  await assert.rejects(search({ query: "test" }), /WEB_SEARCH_PROVIDERS/);
});

test("web_fetch succeeds with Tavily without calling Exa", async t => {
  const calls: string[] = [];
  const { fetch } = await fixture(t, async url => {
    calls.push(String(url));
    return Response.json({ results: [{ url: "https://example.org", raw_content: "Tavily content" }] });
  });
  const result = await fetch({ url: "https://example.org", format: "text", max_chars: 1000 });
  assert.equal(result.details.provider, "tavily");
  assert.match(result.content[0].text, /Tavily content/);
  assert.deepEqual(calls, ["https://api.tavily.com/extract"]);
});

test("web_fetch falls back on Tavily failure and forwards Exa content options", async t => {
  const calls: string[] = [];
  const { fetch } = await fixture(t, async (url, init) => {
    calls.push(String(url));
    if (calls.length === 1) return new Response("unavailable", { status: 503 });
    assert.equal(String(url), "https://api.exa.ai/contents");
    assert.equal(new Headers(init?.headers).get("x-api-key"), "test-exa");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      ids: ["https://example.org"], text: true, highlights: { query: "important section" },
    });
    return Response.json({ results: [{ url: "https://example.org", text: "Exa content", highlights: ["Relevant Exa highlight"] }] });
  });
  const result = await fetch({ url: "https://example.org", query: "important section", format: "text" });
  assert.equal(result.details.provider, "exa");
  assert.match(result.content[0].text, /Fallback: Tavily failed/);
  assert.match(result.content[0].text, /Relevant Exa highlight/);
});

test("web_fetch falls back on empty Tavily extraction and reports Exa failure", async t => {
  const { fetch } = await fixture(t, async (url, init) => {
    if (String(url).endsWith("/extract")) return Response.json({ results: [] });
    assert.equal(new Headers(init?.headers).get("x-api-key"), "test-exa");
    return new Response("bad gateway", { status: 502 });
  });
  await assert.rejects(fetch({ url: "https://example.org" }), /Exa contents failed \(502/);
});

test("web_fetch treats whitespace extraction as empty and preserves Tavily error if Exa fails", async t => {
  const { fetch } = await fixture(t, async (url) => {
    if (String(url).endsWith("/extract")) return Response.json({ results: [{ url: "https://example.org", raw_content: " \n " }] });
    return new Response("Exa unavailable", { status: 503 });
  });
  await assert.rejects(fetch({ url: "https://example.org" }), error =>
    error instanceof Error
      && error.message.includes("Tavily returned no extracted content")
      && error.message.includes("Exa contents failed (503"),
  );
});

test("web_fetch reports Exa-ignored extraction options", async t => {
  const { fetch } = await fixture(t, async url => {
    if (String(url).endsWith("/extract")) return new Response("failure", { status: 500 });
    return Response.json({ results: [{ url: "https://example.org", text: "content" }] });
  });
  const result = await fetch({
    url: "https://example.org", extract_depth: "advanced", format: "text",
    chunks_per_source: 2, include_favicon: true,
  });
  assert.deepEqual(result.details.unsupportedOptions, ["extract_depth", "format", "chunks_per_source", "include_favicon"]);
});

test("web_fetch rejects blank Exa text and highlights", async t => {
  const { fetch } = await fixture(t, async url => {
    if (String(url).endsWith("/extract")) return new Response("failure", { status: 500 });
    return Response.json({ results: [{ url: "https://example.org", text: " \t", highlights: ["\n"] }] });
  });
  await assert.rejects(fetch({ url: "https://example.org" }), /no extracted content/);
});

test("web_fetch abort does not call Exa", async t => {
  const controller = new AbortController();
  let calls = 0;
  const { fetch } = await fixture(t, async () => {
    calls++;
    controller.abort();
    throw controller.signal.reason;
  });
  await assert.rejects(fetch({ url: "https://example.org" }, controller.signal), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("web_fetch enforces max_chars on Exa fallback output", async t => {
  const content = "x".repeat(1200);
  const { fetch } = await fixture(t, async url => {
    if (String(url).endsWith("/extract")) return new Response("failure", { status: 500 });
    return Response.json({ results: [{ url: "https://example.org", text: content }] });
  });
  const result = await fetch({ url: "https://example.org", max_chars: 1000 });
  assert.equal(result.details.truncated, true);
  assert.match(result.content[0].text, /\[Content truncated at 1000 characters/);
});
