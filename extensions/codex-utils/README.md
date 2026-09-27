# codex-utils

Local pi extension for Codex utilities.

## Commands

- `/status` and `/codex-status` — show ChatGPT Codex quota and reset times.
- `/status refresh` (or `/codex-status refresh`) — bypass the local quota cache.
- `/banked-reset` — show available banked resets and the next expiry (read-only).
- `/fast on` — enable Fast mode for subsequent `openai-codex` requests.
- `/fast off` — return to the default service tier.
- `/fast status` — inspect the session setting.

Quota command output is stored as UI-only custom entries, not model messages.
Older `codex-status` messages are filtered from subsequent agent requests.
Historical session files and existing summaries are not rewritten; old reports
can still be present in historical compaction input or already-generated summaries.
Revisit migration if those historical reports must be purged as well.

Regression check: `npm test && npm run typecheck` in this directory.

Fast mode is off by default and persisted in the current session branch. When
enabled, the extension adds `service_tier: "priority"` to `openai-codex`
provider requests. Other providers are left unchanged.

The model side of the normal stats line combines model, Fast mode, thinking
level, and the default Codex API quota, for example:

```text
gpt-5.6-sol fast • medium • (weekly 71% left)
```

Other extension statuses remain on the following footer line.

After a Codex run settles, the extension also performs a non-blocking
authoritative usage refresh. This avoids relying solely on response headers,
which may briefly reflect usage before the latest request is accounted for.
Quota requests use Codex's ChatGPT backend route
`GET https://chatgpt.com/backend-api/wham/usage` with Pi's `openai-codex`
OAuth credentials. They do not require the Codex CLI or app-server. The
extension keeps the shared `pi-codex-status` cache and formatting. If a
quota read fails, provider response headers and rate-limit events can still
update the footer.
The request path follows Codex's
[backend rate-limit client](https://github.com/openai/codex/blob/rust-v0.157.0/codex-rs/backend-client/src/client/rate_limit_resets.rs).

## Banked reset notices

The extension checks the read-only
`GET /backend-api/wham/rate-limit-reset-credits` endpoint on session start
and at most once per 10 minutes during an interactive session, even while
idle. It notifies once
on every Pi startup while a reset is available. Within 24 hours of the
reported expiration, that startup message changes to an expiry warning
instead of adding a second message. During a running session, newly available
resets and the 24-hour expiry transition also trigger a notification.
These in-session changes are deduplicated across restarts in
`~/.cache/pi-codex-status/banked-reset-notices.json` (or
`$XDG_CACHE_HOME/pi-codex-status/banked-reset-notices.json`).
Each alert is a single UI-only session message, not a second temporary popup.
Use
`/banked-reset` to check it again at any time; nothing is added to the footer.

The extension has no redemption action: it never applies or consumes a
banked reset. A count decrease is not treated as evidence that one was used.
Banked resets are separate from normal 5-hour or weekly quota-window resets;
their expiration is determined by the account's credit details. See
[OpenAI's banked-reset explanation](https://help.openai.com/en/articles/20001498-how-banked-codex-resets-work).

Codex Responses also emits `codex.rate_limits` SSE events. The extension
observes those events through the built-in provider without consuming or
rewriting the response stream, updates the footer immediately, and serializes
the merged snapshot to the shared cache. The settled authoritative refresh is
retained as a fallback for WebSocket responses and for final backend
accounting.

Quota windows are identified dynamically from the durations reported by the
Codex usage API. A 5-hour window is preferred when present; otherwise the
weekly window is shown. The combined status is shown only while the active
provider is `openai-codex`; API-key and other providers show no Codex status.
Quota text turns yellow at 20% remaining and red at 10%.
The `/status` summary and `statusline` also label each window by its reported
duration, not its primary/secondary position. Unknown durations are shown
without guessing a 5-hour or weekly label.

For Codex HTTP 429 responses, the extension refreshes the displayed quota and
shows a rate-limit warning. Repeated warnings are limited to once per minute.
Fast mode is not changed automatically; when it is active, the warning suggests
`/fast off` for the next retry.

Fast mode can consume ChatGPT credits at a higher rate. Model and account
support are determined by OpenAI.
