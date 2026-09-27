# apply-patch specification

## Purpose

Provide a Codex/V4A-compatible `apply_patch` custom tool for pi. On matching
models it replaces the active `edit` and `write` tools.

## Interface

The tool accepts `{ "input": string }`. Input contains one envelope:

```text
*** Begin Patch
*** Update File: src/example.ts
@@
-old
+new
*** End Patch
```

Register the patch language through `constrainedSampling` with an
`openai_lark` grammar. Providers without grammar-tool support fall back to the
normal function schema. Register the tool with `executionMode: "sequential"`.

Supported sections are Add File, Update File, optional Move to, and Delete
File. Updates support context lines, additions, removals, `@@` anchors, and
`*** End of File`.

Matching tries exact lines, trailing-whitespace-insensitive lines, trimmed
lines, then conservative Unicode punctuation normalization.

## Application behavior

1. Parse and validate the complete patch before mutation.
2. Apply sections sequentially in patch order, one file at a time.
3. Queue each source and move destination with `withFileMutationQueue()`.
4. Write directly to the target, following symlinks and preserving hardlinks.
5. Use Codex 0.154.0 default text/EOF and file-creation permission semantics.
6. Stop after a section fails and report applied and failed sections.
7. Do not roll back earlier successful sections.

Update/delete sources are preflighted before any mutation. Duplicate resolved
source paths are rejected. Add and Move overwrite existing regular files.
Environment ID is rejected. Invalid UTF-8 update/delete
sources fail preflight; NUL alone is not a binary-file rejection.
A move writes the destination before deleting the source. If source removal
fails, the destination remains written and its committed change is reported.
See README for the version-pinned differential checks.

During application, publish per-section progress updates. Final interactive
rendering shows per-file operation summaries, line counts, move destinations,
and bounded syntax-highlighted diff previews. Rendering failures must not
affect patch application.

Report paths preserve the original patch spelling independently of resolved I/O
paths. Progress counts successful and failed operations, not individual committed
paths. Partial failures retain their committed changes in the final error details
through Pi's `tool_result` middleware. Invalid UTF-8 overwrite previews display
the replacement text with a comparison-unavailable warning.

Grammar is pinned to the official Codex 0.154.0 asset. Success text uses A/M/D
ordering; verification errors follow the native handler wrapper. Known Linux
errno and UTF-8 error details use the tested Codex binary's text; unsupported
platform errors retain the original message rather than inventing a match.

## Model gating

Configuration is read from `~/.pi/agent/apply-patch.json`:

```json
{ "modelRegex": "^gpt" }
```

The expression is tested against both `<provider>/<modelId>` and `<modelId>`.
For matching models, activate `apply_patch` and remove active `edit` and
`write`. Restore only tool changes owned by this extension when the model stops
matching.

## Non-goals

- Native OpenAI Responses API `apply_patch_call` support
- Git integration
- Arbitrary invalid-UTF-8 updates
- Cross-file transactions or rollback
