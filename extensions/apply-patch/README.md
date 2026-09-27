# apply-patch

A pi extension that provides a Codex/V4A-compatible `apply_patch` custom tool. On matching models it replaces active `edit` and `write` tools.

## Install

From this checkout:

```bash
pi install /absolute/path/to/extensions/apply-patch
```

For a project-only installation:

```bash
pi install -l /absolute/path/to/extensions/apply-patch
```

To try it without changing settings:

```bash
pi -e /absolute/path/to/extensions/apply-patch
```

On Node 24 with Pi installed on PATH, run `npm test` without installing dependencies.
Alternatively set `PI_TEST_PACKAGE_ROOT` to the installed Pi package directory.
For a focused check, use `node test/run-tests.mjs tool-failure.test.ts` (one or
more test basenames). Unknown test names are rejected instead of silently skipped.
`npm run test:codex` compares output bytes with installed `codex-cli 0.154.0`
(`CODEX_BINARY` can override the executable). It uses disposable temporary files
and makes no model requests. Typechecking still requires the package's development dependencies.

## Configuration

The optional configuration file is `~/.pi/agent/apply-patch.json`:

```json
{
  "modelRegex": "^gpt"
}
```

That is the default. The regular expression is tested against both `provider/modelId` and `modelId`. An invalid file falls back to `^gpt` and emits one concise warning when UI is available.

For matching models, the extension removes `edit` and `write` only when they are active and activates `apply_patch`. On a switch to a nonmatching model it undoes only tool changes recorded by this extension runtime. Tools that were already disabled are not enabled. Tool-management extensions still share one active set, so their ordering and later calls to `setActiveTools()` matter.

## Tool and grammar

The tool accepts `{ "input": "..." }`, where `input` contains exactly one envelope:

```text
*** Begin Patch
*** Update File: src/example.ts
@@
-old value
+new value
*** End Patch
```

On OpenAI-compatible models with grammar-tool support, pi sends this as a Lark-constrained custom tool and maps the freeform patch text into `input`. Other models use the normal function-tool schema. Tool execution is sequential.

Supported sections:

```text
*** Add File: path       # every body line starts with +
*** Update File: path    # one or more @@ hunks
*** Move to: new-path    # optional, immediately after Update File
*** Delete File: path    # no body
```

Update lines begin with a space (context), `-` (remove), or `+` (add). A hunk may use `@@ existing line` as a forward anchor and `*** End of File` as an EOF constraint. Matching tries exact lines, trailing-whitespace-insensitive lines, trimmed lines, then conservative Unicode quote/dash/space normalization.
The parser also accepts Codex's lenient envelope/heredoc and implicit first-hunk
forms; the provider grammar remains narrower. Empty patches parse but fail application.
The registered grammar is pinned exactly to Codex `rust-v0.154.0`'s
`codex-rs/core/assets/tools/apply_patch.lark`, including implicit hunks.
Multiple operations on the same resolved source path are rejected during preflight,
including delete-then-add; use Add File to overwrite instead.
Pure insertion hunks append at EOF even with an anchor (which must still match).
Matching retries without a final empty context line when necessary. Hunks match
the original source, and sorted replacements apply in reverse order.

## Safety and limitations

Update/delete sources are verified before mutation. Patch sections then apply
sequentially with pi's per-file mutation queue and direct writes. The first
application failure stops subsequent sections; earlier successful changes remain.
Add and Move can overwrite existing regular files.

Text editing targets Codex 0.154.0's default `NormalizeToLf` behavior: untouched
CR characters survive, changed lines use patch text, and nonempty output receives
a final LF if needed. BOM is ordinary source text, not independently restored.
Valid UTF-8 containing NUL is accepted; invalid UTF-8 update/delete sources fail
preflight. Add can overwrite invalid UTF-8 files.

Tool rendering uses pi's default write-style tool box so pending, success, and error states match the rest of the built-in tools. Inside it, each file has an `Added|Edited|Deleted|Moved path (+N -N)` heading without a bullet, line-numbered context, full-width success/error backgrounds on changed lines, and intra-line highlighting for one-line replacements. Collapsed previews show 10 lines and use pi's configured expand-key hint. The complete combined unified diff remains available in tool details and is saved to a temporary file when normal output truncation applies.

### Compatibility verification

The byte comparison suite covers ten text/EOF cases against Codex 0.154.0's standalone patch engine;
native-handler preflight is checked separately against version-pinned source.
Eight additional filesystem comparisons cover symlinks, hardlinks, parent symlinks,
new move destination permissions, same-path moves, failed overwrite moves and
write-only Add/Move destinations. Twenty-five parser/application comparisons cover
lenient envelopes, hunks, heredocs, Unicode whitespace, and parser error text.
Writes follow symlinks and preserve hardlinks. A new move destination uses normal
creation permissions, not source permissions. Failed moves leave the written
destination in place, including overwritten content; no restoration is attempted.
Errors mark the Pi tool call as failed. The documented `tool_result` middleware
restores committed details after Pi converts a thrown error to an error result;
it never changes failure into success. Partial-move progress counts the operation
as failed, while retaining the written destination in the change report.
Invalid UTF-8 overwrite previews show replacement text with an explicit
incomparable-original warning.

Success summaries use Codex's A/M/D ordering and preserve patch path spelling.
Verification errors use the native-handler prefix, not standalone stderr's
parser formatting. The supported Linux errno messages and Rust UTF-8 diagnostics
are checked separately; unknown OS errors retain their original message. This
mapping targets the tested Linux Codex binary and must be revisited for other
platforms/libc builds. Diff/usage presentation and provider transport remain Pi-specific.
Environment ID is explicitly rejected rather than
silently applying a remote-environment patch locally.
These checks are a regression baseline, not proof that every possible input matches.

## Not OpenAI's native tool protocol

This is a pi custom function tool with an `input` property. It does **not** send OpenAI Responses API `{ "type": "apply_patch" }` definitions and does not parse or emit `apply_patch_call` provider items. Native protocol support belongs in a provider/pi-ai integration.
