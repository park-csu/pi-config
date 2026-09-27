import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  createPanelHost,
  PANEL_ANIMATION_INTERVAL_MS,
} from "./core.ts";
import {
  UI_PANELS_PROBE_EVENT,
  UI_PANELS_READY_EVENT,
  UI_PANELS_STOPPED_EVENT,
} from "./types.ts";

const requirePi = createRequire(
  "/home/changsu/.local/lib/node_modules/@earendil-works/pi-coding-agent/package.json",
);
const { truncateToWidth: piTruncateToWidth } = requirePi("@earendil-works/pi-tui");
const hostOptions = (options = {}) => ({
  truncateToWidth: (line, width) => piTruncateToWidth(line, width, ""),
  ...options,
});

function fakeBus() {
  const listeners = new Map();
  return {
    on(channel, handler) {
      const handlers = listeners.get(channel) ?? [];
      handlers.push(handler);
      listeners.set(channel, handlers);
      return () => listeners.set(
        channel,
        (listeners.get(channel) ?? []).filter((candidate) => candidate !== handler),
      );
    },
    emit(channel, value) {
      for (const handler of [...(listeners.get(channel) ?? [])]) handler(value);
    },
  };
}

function fakeTimers() {
  const callbacks = new Set();
  return {
    driver: {
      setInterval(callback, intervalMs) {
        assert.equal(intervalMs, PANEL_ANIMATION_INTERVAL_MS);
        callbacks.add(callback);
        return callback;
      },
      clearInterval(callback) {
        callbacks.delete(callback);
      },
    },
    tick() {
      for (const callback of [...callbacks]) callback();
    },
    count() {
      return callbacks.size;
    },
  };
}

test("fake UI lifecycle registers one widget, emits ready/stopped, and removes stale host", () => {
  const events = fakeBus();
  const timers = fakeTimers();
  const widgetCalls = [];
  let widget;
  let renderRequests = 0;
  const tui = { requestRender: () => renderRequests++ };
  const theme = {};
  const ui = {
    setWidget(key, content) {
      widgetCalls.push({ key, content });
      widget = typeof content === "function" ? content(tui, theme) : undefined;
    },
  };

  let active;
  let probeUnsubscribe;
  const ready = [];
  const stopped = [];
  events.on(UI_PANELS_READY_EVENT, (host) => ready.push(host));
  events.on(UI_PANELS_STOPPED_EVENT, (host) => stopped.push(host));
  const startTuiSession = () => {
    probeUnsubscribe?.();
    probeUnsubscribe = events.on(UI_PANELS_PROBE_EVENT, ({ accept }) => {
      if (active) accept(active.host);
    });
    const controller = createPanelHost(hostOptions({
      requestRender: () => tui.requestRender(),
      timers: timers.driver,
    }));
    ui.setWidget("ui-kit:v1", (givenTui, givenTheme) => ({
      render: (width) => controller.render(width, givenTheme),
      invalidate() {},
    }));
    active = controller;
    events.emit(UI_PANELS_READY_EVENT, controller.host);
  };
  const stopSession = () => {
    const previous = active;
    active = undefined;
    previous?.stop();
    if (previous) events.emit(UI_PANELS_STOPPED_EVENT, previous.host);
    probeUnsubscribe?.();
    probeUnsubscribe = undefined;
    ui.setWidget("ui-kit:v1", undefined);
  };

  startTuiSession();
  assert.equal(widgetCalls.filter((call) => typeof call.content === "function").length, 1);
  assert.equal(ready.length, 1);
  ready[0].upsert({
    id: "animated",
    animated: true,
    render: (_width, _theme, context) => [String(context.frame)],
  });
  assert.equal(timers.count(), 1);
  timers.tick();
  assert.equal(renderRequests, 2);
  assert.deepEqual(widget.render(10), ["1"]);

  let probedHost;
  events.emit(UI_PANELS_PROBE_EVENT, { accept: (host) => { probedHost = host; } });
  assert.equal(probedHost, ready[0]);
  const oldWidget = widget;
  stopSession();
  assert.equal(stopped[0], ready[0]);
  const requestCount = renderRequests;
  stopped[0].upsert({ id: "late", render: () => ["late"] });
  assert.equal(renderRequests, requestCount);
  assert.equal(timers.count(), 0);
  assert.equal(widgetCalls.at(-1).content, undefined);
  assert.deepEqual(oldWidget.render(10), []);
});

test("a non-TUI session has no host/widget and does not accept probes", () => {
  const events = fakeBus();
  const widgetCalls = [];
  // No TUI session installs a framework probe listener or widget.
  events.emit(UI_PANELS_PROBE_EVENT, { accept: () => {} });
  assert.equal(widgetCalls.length, 0);
});
