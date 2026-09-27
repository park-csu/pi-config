import { test } from "node:test";
import assert from "node:assert/strict";
import { createPanelClient } from "./client.ts";
import {
  UI_PANELS_PROBE_EVENT,
  UI_PANELS_READY_EVENT,
  UI_PANELS_STOPPED_EVENT,
} from "./types.ts";

function bus() {
  const listeners = new Map();
  return {
    on(name, handler) {
      const values = listeners.get(name) ?? [];
      values.push(handler);
      listeners.set(name, values);
      return () => listeners.set(name, (listeners.get(name) ?? []).filter((x) => x !== handler));
    },
    emit(name, value) {
      for (const handler of [...(listeners.get(name) ?? [])]) handler(value);
    },
    listenerCount(name) {
      return (listeners.get(name) ?? []).length;
    },
  };
}

test("client probes, follows ready/stopped hosts, and upserts each id once", () => {
  const events = bus();
  const received = [];
  events.on(UI_PANELS_PROBE_EVENT, ({ accept }) => accept({
    upsert: (panel) => received.push(panel.id),
    remove: () => {},
  }));
  const client = createPanelClient(events);
  client.upsert({ id: "one", render: () => ["one"] });
  client.upsert({ id: "one", render: () => ["updated"] });
  assert.deepEqual(received, ["one", "one"]);

  const second = [];
  const host = { upsert: (panel) => second.push(panel.id), remove: () => {} };
  events.emit(UI_PANELS_READY_EVENT, host);
  assert.deepEqual(second, ["one"]);
  events.emit(UI_PANELS_READY_EVENT, host);
  assert.deepEqual(second, ["one"]);
  client.remove("one");
  assert.equal(client.host, host);

  events.emit(UI_PANELS_STOPPED_EVENT, host);
  assert.equal(client.host, undefined);
  client.dispose();
  assert.equal(events.listenerCount(UI_PANELS_READY_EVENT), 0);
  assert.equal(events.listenerCount(UI_PANELS_STOPPED_EVENT), 0);
  client.upsert({ id: "late", render: () => [] });
  assert.deepEqual(second, ["one"]);
});
