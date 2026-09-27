# UI Kit

`ui-kit` shares persistent TUI panels and tool renderers between Pi extensions.
Its panel host owns one
widget above the editor and lets unrelated extensions (including OM or
subagents) publish panel state without repeatedly calling `setWidget`. It has
no OM-specific code or imports.

## Appearance

`ui-kit/appearance` exports semantic `uiTone` roles and `statusTone(status)`.
Use the active theme's `text`/`toolTitle` for titles, `muted` for ordinary information,
and `dim` for supporting details. Reserve `accent` for selection, active work and
progress; use `border`/`borderMuted` for framing. Running is accented, completed,
paused and cancelled states are neutral, and failures use `error`. Actual warnings
retain `warning`. These roles reference theme tokens, including oxocarbon, without
hardcoded colors. Markdown, code highlighting and diff colors retain their native
semantic tokens.

## Tool renderers

Use the shared registrar for every tool in a participating extension. It preserves
Pi's registration types, execution and schema, adds title styling, then exposes
only `renderCall`, `renderResult`, and `renderShell` to local viewers.

Tool names are neutral white while running, `success` after completion, and
`error` on failure. Command text and file paths stay neutral; no frame or
background is added. Existing components, expansion, result highlighting and
interactive dialogs retain their native behavior. `styleToolDefinition` is
exported from `ui-kit/tools` for other display adapters.

On TUI session start, built-in tools receive the same styling through Pi's
public tool-definition factories. Existing extension/SDK overrides are skipped,
and the active tool list is preserved. The bash header renders the tool name
separately from the command while retaining native output and timing.
Read image-resizing and bash shell/prefix settings are carried over from Pi's
settings. No installed Pi implementation files are patched.

```ts
import { createToolRegistrar } from "ui-kit/tools";

export default function (pi) {
  const registerTool = createToolRegistrar(pi);
  registerTool({
    name: "example",
    // The same parameters, execute, renderCall and renderResult as a Pi tool.
  });
}
```

Viewers call `getToolRenderers(pi.events)` from `ui-kit/tools` and pass the matching
entry to Pi's `ToolExecutionComponent`. The synchronous `ui-kit:tools:v1:probe`
event queries providers regardless of their load order. Each provider responds
with its currently registered tools; re-registering a tool replaces its renderer.
Providers unsubscribe on session shutdown and reconnect on session start.
Tools without custom renderers receive a status-aware title and retain Pi's
default result rendering. The recorded subagent viewer uses the same styling.

Callbacks stay in their process; they are never serialized into worker logs and
the registry does not expose `execute`. The subagent viewer combines recorded
arguments/results with renderers loaded in the parent. Worker-only or unrelated
third-party extensions fall back to the viewer's default display. Keep renderers
dependent on their arguments, results and render context so replay works reliably.

`ui-kit/panels` exports the panel client, host and types without loading the Pi
extension entrypoint. Load `ui-kit` itself once to install the shared panel widget.
Run `/reload` after changing extension code.

## Versioned protocol

The protocol version is `ui-kit:v1`.

```ts
const PROBE = "ui-kit:v1:probe";
const READY = "ui-kit:v1:ready";
const STOPPED = "ui-kit:v1:stopped";

interface Panel {
  id: string;
  order?: number;
  animated?: boolean;
  render: (
    width: number,
    theme: unknown,
    context: { now: number; frame: number },
  ) => string[];
}

interface PanelHost {
  upsert(panel: Panel): void;
  remove(id: string): void;
}
```

`ui-kit` listens for `PROBE` with payload `{ accept(host) }`. If the current
session is TUI mode, it calls `accept` synchronously with the active host.
After `session_start` has registered the widget, it emits `READY` with that
same host. It emits `STOPPED` with the old host during shutdown; that host is
already inactive and both methods become no-ops.

There is exactly one host per session. Replacement must invalidate the old
host and emit its `STOPPED` before emitting `READY` for the new host. Only the
framework answers `PROBE` or emits `READY`/`STOPPED`; clients do not relay them.

## Pi package

This directory is also the `ui-kit` Pi package (`0.1.0`). Load this package
once when sharing its host with clients such as `subagents` or OM.

Panel IDs are replacement keys: upserting an existing ID replaces its panel,
rather than adding a duplicate. Ordering is recalculated from the current
`order` (missing means `0`) and then the ID using a deterministic code-unit
comparison. Update/insertion time is never a tie-breaker. A panel update can
therefore change its order only by changing its `order` value.

The host is only offered in `ctx.mode === "tui"`. In RPC, JSON, and print modes
there is no widget, host, or `READY` event.

## Rendering and safety

* `render` is called once per active panel per widget render. One panel throwing
  does not prevent other panels from rendering; it becomes a bounded
  `[ui-kit: panel <id> render failed]` line. Non-array results and
  non-string lines are reported similarly.
* Output is capped at **200 total lines** (`MAX_PANEL_LINES`), across all
  panels. Providers should stay compact: this custom component does not
  inherit Pi's string-array widget line cap.
* Every line is sanitized and then truncated with pi-tui's installed
  `truncateToWidth` utility. Width `0` returns an empty line. Newlines, tabs,
  C0/C1 controls, OSC/DCS/CSI/APC sequences, and bidi embedding/isolate
  controls cannot escape into the terminal. Numeric SGR styling such as
  `\x1b[31m` is retained; pi-tui handles its ANSI reset behavior. Width
  accounting therefore follows pi-tui, including its handling of common
  combining, CJK, emoji, ZWJ, and flag graphemes.
* `now` is one `Date.now()` sample for a host render. `frame` starts at `0`
  and is shared by all panels. A single 120 ms interval increments it and
  requests a TUI render only while at least one `animated` panel exists.
  Static panels do not start that interval.

Providers should only call `host.upsert()` or `host.remove()` after their state
changes. They must not call `setWidget`; doing so would reintroduce widget
replacement/reorder jitter.

## Direct event-bus adapter

An extension that does not use the optional helper can attach as follows:

```ts
const panel = {
  id: "example",
  order: 20,
  render: (width, theme, { now, frame }) => [
    `${theme.fg("accent", "Example")} ${now} ${frame}`,
  ],
};

pi.events.emit("ui-kit:v1:probe", {
  accept(host) {
    host.upsert(panel);
  },
});

pi.events.on("ui-kit:v1:ready", (host) => {
  host.upsert(panel); // useful if the probe happened before session_start
});

pi.events.on("ui-kit:v1:stopped", () => {
  // Drop session-local host references. Do not retain the old host.
});
```

The `ready` listener is important when the provider is loaded before the
framework or when a session is reloaded. A compatible adapter can use these
three event names and the two host methods without importing this directory.
The snippet illustrates only the protocol: create subscriptions during
`session_start`, retain their unsubscribe functions, and remove owned panels
and subscriptions during `session_shutdown`. Guard retained probe callbacks
against an old session, as the OM and subagent adapters do.

## Optional `client.ts` helper

`createPanelClient(pi.events)` stores local panels by ID, probes immediately,
also follows `READY`, and forgets a stopped host. It replays the stored set
only when the host identity changes, so repeated probe/ready events do not
duplicate panels:

```ts
import { createPanelClient } from "../ui-kit/client.ts";

const panels = createPanelClient(pi.events);
panels.upsert({
  id: "provider-status",
  order: 10,
  render: (_width, _theme, { frame }) => [`frame ${frame}`],
});

pi.on("session_shutdown", () => panels.dispose());
```

`upsert` and `remove` are no-ops after `dispose()`. Create a new client for a
new extension runtime after `/reload`; the old client must be disposed.

## Lifecycle and reload

The framework does not start timers or register widgets at module load. On
each TUI `session_start` it:

1. tears down any host left by a repeated start,
2. subscribes to the probe event,
3. registers the one above-editor widget,
4. emits `READY`.

On `session_shutdown` it invalidates the host, emits `STOPPED`, unsubscribes
from the bus, stops animation, and clears the widget. Cleanup is idempotent.
Pi reloads extension instances: the old instance receives shutdown and a new
instance receives `session_start` with reason `reload`. Consumers should keep
durable data in their own state and recreate session resources in
`session_start`.

## Testing

From this directory:

```sh
node --test ./*.test.mjs
```

The tests use only Node's built-in test runner, the installed pi-tui
`visibleWidth`/`truncateToWidth` functions, and fake timers. They cover
ordering, replacement, render isolation, malformed output, line caps,
zero/narrow Unicode width, SGR/control sanitization, animation start/stop,
stale hosts, TUI/non-TUI lifecycle, repeated starts, and client
probe/ready/stopped behavior.

## Deliberate limitations

This is a display adapter, not a terminal emulator or a sandbox for trusted
JavaScript callbacks. Width behavior follows the installed pi-tui version and
can still differ from a particular terminal/font combination. Only numeric
SGR is preserved; hyperlinks, cursor movement, images, and other terminal
protocols are intentionally removed. The fixed 200-line cap is a safety bound,
not a viewport negotiation API; a future protocol version should add explicit
pagination or height negotiation rather than silently changing v1 behavior.
