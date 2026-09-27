# Main-assistant Markdown mirror

Inspired by [amosblomqvist/learn's md-log](https://github.com/amosblomqvist/learn/blob/main/extensions/md-log.ts).
No dependencies or Neovim RPC integration.

After `/reload`, create a **dedicated existing file**, then link it:

```sh
touch /tmp/pi-assistant.md
nvim /tmp/pi-assistant.md
```

In Pi:

```text
/md-log /tmp/pi-assistant.md
/md-unlog
```

`/md-log` **overwrites the entire file immediately**, backfilling the active
branch's recorded assistant messages. It rewrites the mirror when an assistant
message finishes, on branch navigation, and when the linked session resumes.
There are no token-by-token updates.

- Includes main-assistant text and Markdown, including progress messages.
- Excludes user prompts, thinking, tool calls/results, summaries and child
  completion messages. Main-assistant summaries of child work remain included.
- One-way only: edits to the file never become prompts and are overwritten.
- The link survives resume, but forks/clones must link their own file.
- Unlinking leaves the file intact. A write error disables mirroring.
- Child sessions do not register this extension's hooks or commands.

In Neovim, use `:setlocal autoread` and `:checktime` to refresh from disk.
Do not edit the mirror; use a separate note for your own writing.
No Neovim settings or existing notes are modified automatically.

Tests:

```sh
node --test extensions/md-log/index.test.mjs
```

## Pi package

This directory is also the `md-log` Pi package (`0.1.0`); its package manifest
loads `index.ts` as the extension entry point.
