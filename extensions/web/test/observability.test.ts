import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import extension from "../index.js";

initTheme("dark", false);

const theme: any = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

async function getTools(): Promise<Map<string, any>> {
  const tools = new Map<string, any>();
  const pi: any = {
    registerProvider() {},
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand() {},
    on() {},
  };
  await extension(pi);
  return tools;
}

function render(component: { render(width: number): string[] }): string {
  return component.render(180).join("\n");
}

test("collapsed search shows exact query, options, titles, URLs, credits, and timing", async () => {
  const tool = (await getTools()).get("web_search");
  const call = render(tool.renderCall({
    query: "current Tavily API limits",
    search_depth: "advanced",
    topic: "general",
    max_results: 5,
    include_domains: ["docs.tavily.com"],
  }, theme, {}));
  assert.match(call, /current Tavily API limits/);
  assert.match(call, /advanced/);
  assert.match(call, /docs\.tavily\.com/);

  const result = render(tool.renderResult(
    {
      content: [{ type: "text", text: "1. Usage\nhttps://docs.tavily.com/usage" }],
      details: {
        provider: "tavily",
        query: "current Tavily API limits",
        resultCount: 2,
        titles: ["Usage", "Search"],
        urls: ["https://docs.tavily.com/usage", "https://docs.tavily.com/search"],
        credits: 2,
        responseTime: 1.25,
      },
    },
    { expanded: false, isPartial: false },
    theme,
    { isError: false },
  ));
  assert.match(result, /2 results/);
  assert.match(result, /2 credits/);
  assert.match(result, /1\.25s/);
  assert.match(result, /Usage/);
  assert.match(result, /https:\/\/docs\.tavily\.com\/usage/);
});

test("fetch shows requested URL and expanded content excerpt", async () => {
  const tool = (await getTools()).get("web_fetch");
  const call = render(tool.renderCall({
    url: "https://docs.tavily.com/usage",
    extract_depth: "advanced",
    format: "markdown",
    query: "credit limits",
  }, theme, {}));
  assert.match(call, /https:\/\/docs\.tavily\.com\/usage/);
  assert.match(call, /advanced/);
  assert.match(call, /focus "credit limits"/);

  const result = render(tool.renderResult(
    {
      content: [{
        type: "text",
        text: "Source: https://docs.tavily.com/usage\n\n# Usage\nPlan and credit details.",
      }],
      details: {
        provider: "tavily",
        url: "https://docs.tavily.com/usage",
        contentLength: 1234,
        truncated: false,
        failedResults: [],
        credits: 1,
        responseTime: 0.4,
      },
    },
    { expanded: true, isPartial: false },
    theme,
    { isError: false },
  ));
  assert.match(result, /1,234 chars/);
  assert.match(result, /1 credit/);
  assert.match(result, /0\.4s/);
  assert.match(result, /# Usage/);
  assert.match(result, /Plan and credit details/);
});
