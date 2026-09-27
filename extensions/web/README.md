# web

Configurable web tools for pi:

- `web_search` searches the configured providers in order (Tavily, then Exa by
  default) and returns citation-friendly results. It calls only one provider
  successfully: an error or empty result set moves to the next provider.
- `web_fetch` extracts readable Markdown or text from a URL with Tavily and
  falls back to Exa when Tavily fails or returns no extracted content. Exa
  returns readable text and uses the optional query for highlights; other
  Tavily-specific extraction controls remain applied only by Tavily.

## Setup

Run `/login tavily` and enter your Tavily API key. Pi stores it under the
`tavily` entry in `~/.pi/agent/auth.json` with the rest of its credentials.
Run `/login exa` to configure the search and fetch fallback key. The separate
`TAVILY_API_KEY` and `EXA_API_KEY` environment variables are also supported.
`/tavily-usage` continues to use Tavily.

Set `WEB_SEARCH_PROVIDERS=exa,tavily` to change the order. It must contain
each provider at most once and only use `tavily` and `exa`; invalid
configuration is reported rather than silently replaced.
Set `WEB_SEARCH_PROVIDERS=tavily` or `WEB_SEARCH_PROVIDERS=exa` to use only
one provider (no fallback). Set the variable before starting pi, for example:

```sh
WEB_SEARCH_PROVIDERS=tavily,exa pi
```

Because this directory is under `~/.pi/agent/extensions/`, pi discovers it
automatically. Run `/reload` in an existing pi session.

`TAVILY_BASE_URL` may optionally override `https://api.tavily.com` for a proxy
or compatible endpoint.
`EXA_BASE_URL` may optionally override `https://api.exa.ai`.

Run `/tavily-usage` to see plan and API-key credit usage. Remaining plan
credits are also shown in Pi's footer. Usage refreshes are cached for one
minute to avoid excessive calls to Tavily's usage endpoint. Search and extract
responses request Tavily's per-call credit count so the footer can update
immediately even when account totals are delayed.

Tool rows show the exact search query or fetched URL in collapsed mode.
Search results include source titles and URLs; expanding a row shows all
sources and a bounded output excerpt. Fetch rows show the resolved source,
content size, truncation state, credits, timing, and an expanded excerpt.

Exa uses its documented `POST /search` API with `x-api-key`, `numResults`,
domain/date filters, and `contents.highlights`; Exa highlights are mapped to
the same citation-friendly result output.
When Exa is selected, Tavily-only options such as search depth, topic,
country, answer generation, and exact matching are not emulated; the tool
result explicitly lists any such ignored options. `time_range` is mapped to
an Exa publication-date lower bound.
