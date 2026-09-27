// Run: node ~/.pi/agent/tests/ui-panels.integration.test.mjs
// This is a headless interface harness: it uses the real panel host/controller,
// OM controller, and subagent adapter with a deterministic fake event bus/TUI.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createPanelHost, PANEL_ANIMATION_INTERVAL_MS } from "../extensions/ui-panels/core.ts";
import { StatusController } from "../git/github.com/park-csu/pi-observational-memory/src/ui/status-controller.ts";
import { WorkerWidget } from "../extensions/subagents/activity.ts";
import {
  installUiPanels,
  UI_PANELS_PROBE,
  UI_PANELS_READY,
  UI_PANELS_STOPPED,
} from "../extensions/subagents/ui-panels.ts";

const requireFromOm = createRequire(
  "/home/changsu/.pi/agent/git/github.com/park-csu/pi-observational-memory/package.json",
);
const { truncateToWidth } = requireFromOm("@earendil-works/pi-tui");

function makeBus() {
  const listeners = new Map();
  const emitted = [];
  return {
    emitted,
    on(name, listener) {
      const current = listeners.get(name) ?? [];
      current.push(listener);
      listeners.set(name, current);
      return () => listeners.set(name, (listeners.get(name) ?? []).filter(item => item !== listener));
    },
    emit(name, payload) {
      emitted.push({ name, payload });
      for (const listener of [...(listeners.get(name) ?? [])]) listener(payload);
    },
  };
}

function makeTimers() {
  const intervals = new Map();
  let nextId = 0;
  return {
    intervals,
    driver: {
      setInterval(callback, intervalMs) {
        const id = ++nextId;
        intervals.set(id, { callback, intervalMs });
        return id;
      },
      clearInterval(id) {
        intervals.delete(id);
      },
    },
  };
}

function worker(runId, status = "running") {
  return {
    runId,
    parentRunId: "",
    agent: runId,
    goal: "inspect",
    status,
    activity: status === "running" ? "read" : "done",
    startedAt: 1200,
    elapsedMs: 10,
    turns: 1,
  };
}

function makeScenario(hostFirst) {
  const events = makeBus();
  const timers = makeTimers();
  const theme = { fg: (_color, text) => text };
  const widgetCalls = [];
  const statuses = new Map();
  const components = new Map();
  let renderRequests = 0;
  const tui = { requestRender: () => { renderRequests++; } };
  const ui = {
    theme,
    setStatus: (key, value) => statuses.set(key, value),
    setWidget(key, content) {
      widgetCalls.push({ key, content });
      if (typeof content === "function") components.set(key, content(tui, theme));
      else components.delete(key);
    },
  };

  let activeHost;
  let hostController;
  events.on(UI_PANELS_PROBE, ({ accept }) => {
    if (activeHost) accept(activeHost);
  });

  const om = new StatusController({ eventBus: events, settleMs: 5000 });
  const subagentWidget = new WorkerWidget({
    settleMs: 5000,
    truncate: (line, width) => truncateToWidth(line, width, ""),
  });
  const subagents = installUiPanels({ events }, subagentWidget);

  const startHost = () => {
    hostController = createPanelHost({
      requestRender: () => tui.requestRender(),
      truncateToWidth: (line, width) => truncateToWidth(line, width, ""),
      timers: timers.driver,
      now: () => 1234,
    });
    activeHost = hostController.host;
    // Equivalent to ui-panels/index.ts registering its one persistent widget.
    ui.setWidget("ui-panels:v1", (givenTui, givenTheme) => ({
      render: width => hostController.render(width, givenTheme),
      invalidate() {},
    }));
  };

  if (hostFirst) {
    startHost();
    // READY was already emitted before clients loaded; both must discover by probe.
    events.emit(UI_PANELS_READY, activeHost);
    om.attach(ui);
    subagents.start({ mode: "tui", hasUI: true, ui });
  } else {
    // Clients load first and must attach when the host later emits READY.
    om.attach(ui);
    subagents.start({ mode: "tui", hasUI: true, ui });
    startHost();
    events.emit(UI_PANELS_READY, activeHost);
  }

  return {
    events, timers, theme, ui, om, subagentWidget, subagents,
    hostController, get activeHost() { return activeHost; },
    widgetCalls, statuses, components,
    get renderRequests() { return renderRequests; },
  };
}

for (const hostFirst of [true, false]) {
  test(`shared host integration (${hostFirst ? "host first / probe" : "clients first / ready"})`, () => {
    const scenario = makeScenario(hostFirst);
    const {
      events, timers, theme, om, subagentWidget, subagents, hostController,
      activeHost, widgetCalls,
    } = scenario;

    assert.equal(subagents.host, activeHost);
    assert.ok(events.emitted.some(event => event.name === UI_PANELS_PROBE));
    assert.equal(timers.intervals.size, 0);

    om.workerStart("observer", "om-run");
    subagentWidget.update(worker("subagent"));
    assert.equal(timers.intervals.size, 1, "OM and subagents share one host timer");
    assert.equal(timers.intervals.values().next().value.intervalMs, PANEL_ANIMATION_INTERVAL_MS);

    const liveRows = hostController.render(120, theme);
    assert.equal(liveRows.length, 2);
    assert.match(liveRows[0], /\bobserver\b/, "order 100 OM row comes first");
    assert.match(liveRows[1], /subagent/, "order 200 subagent row comes second");
    for (const icon of ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏", "⠋"]) {
      const rows = hostController.render(120, theme);
      assert.ok(rows[0].startsWith(`om · ${icon}`), "OM advances through the full spinner cycle");
      assert.ok(rows[1].startsWith(icon), "subagents stay in sync with OM");
      assert.deepEqual(hostController.render(120, theme), rows, "extra renders do not advance animation");
      timers.intervals.values().next().value.callback();
    }

    om.workerDone("om-run", 1);
    subagentWidget.update(worker("subagent", "completed"));
    assert.equal(timers.intervals.size, 0, "static panels stop the shared timer");
    const staticRows = hostController.render(120, theme);
    assert.match(staticRows[0], /✓ observer/);
    assert.match(staticRows[1], /✓ subagent/);
    assert.equal(widgetCalls.filter(call => call.key === "ui-panels:v1").length, 1);

    hostController.stop();
    events.emit(UI_PANELS_STOPPED, activeHost);
    assert.equal(subagents.host, undefined);
    const afterStopRequests = scenario.renderRequests;
    activeHost.upsert({ id: "late", render: () => ["late"] });
    assert.deepEqual(hostController.render(120, theme), []);
    assert.equal(scenario.renderRequests, afterStopRequests, "stale host updates are inert");

    // Cleanup fallback/settlement resources created by STOPPED handling.
    om.detach();
    subagents.stop();
  });
}

console.log("PASS: ui-panels host, OM, and subagent adapters agree on probe/ready, order, and timer ownership");
