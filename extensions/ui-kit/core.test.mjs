import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  createPanelHost,
  MAX_PANEL_LINES,
  PANEL_ANIMATION_INTERVAL_MS,
} from "./core.ts";

const requirePi = createRequire(
  "/home/changsu/.local/lib/node_modules/@earendil-works/pi-coding-agent/package.json",
);
const { truncateToWidth: piTruncateToWidth, visibleWidth } = requirePi("@earendil-works/pi-tui");
const truncate = (line, width) => piTruncateToWidth(line, width, "");
const hostOptions = (options = {}) => ({ truncateToWidth: truncate, ...options });

function fakeTimers() {
  const timers = new Map();
  let nextId = 0;
  let clearCount = 0;
  return {
    timers,
    driver: {
      setInterval(callback, intervalMs) {
        const id = ++nextId;
        timers.set(id, { callback, intervalMs });
        return id;
      },
      clearInterval(id) {
        clearCount++;
        timers.delete(id);
      },
    },
    tick() {
      for (const { callback } of [...timers.values()]) callback();
    },
    get clearCount() {
      return clearCount;
    },
  };
}

test("orders panels by order then id, independent of update order", () => {
  const rendered = [];
  const host = createPanelHost(hostOptions({ requestRender() {} }));
  const panel = (id, order) => ({
    id,
    order,
    render() {
      rendered.push(id);
      return [id];
    },
  });

  host.host.upsert(panel("z", 1));
  host.host.upsert(panel("a", 1));
  host.host.upsert(panel("m", 0));
  host.host.upsert(panel("a", 1)); // Replacing a panel does not use update time.
  assert.deepEqual(host.render(80, {}), ["m", "a", "z"]);
  assert.deepEqual(rendered, ["m", "a", "z"]);

  host.host.upsert(panel("z", -1));
  assert.deepEqual(host.render(80, {}), ["z", "m", "a"]);
});

test("truncates safely at zero and narrow Unicode widths", () => {
  const styled = "\x1b[31m界🙂e\u0301abc\x1b[0m";
  for (const width of [0, 1, 2, 3, 4, 7]) {
    const line = truncate(styled, width);
    assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)}`);
    assert.ok(!line.includes("\x1b]"), "OSC must not survive");
  }
  assert.equal(truncate(styled, 0), "");
  assert.equal(visibleWidth("界"), 2);
  assert.equal(visibleWidth("🙂"), 2);
  assert.equal(visibleWidth("e\u0301"), 1);
  assert.match(truncate("\x1b[31mabc", 2), /^\x1b\[31mab\x1b\[0m$/);

  const host = createPanelHost(hostOptions({ requestRender() {} }));
  host.host.upsert({
    id: "unicode",
    render: () => ["\x1b[31m界🙂\x1b[0m\nnext"],
  });
  for (const width of [0, 1, 2, 3]) {
    const lines = host.render(width, {});
    assert.equal(lines.length, 1);
    assert.ok(visibleWidth(lines[0]) <= width);
  }
  host.host.upsert({
    id: "controls",
    render: () => [
      "\x1b[31msafe\x1b[0m \x1b]8;;https://secret.invalid\x07link\x1b]8;;\x07 \x1b[2J",
    ],
  });
  const safeLine = host.render(80, {})[0];
  assert.match(safeLine, /^\x1b\[31msafe\x1b\[0m link /);
  assert.ok(!safeLine.includes("secret.invalid"));
  assert.ok(!safeLine.includes("\x1b[2J"));
});

test("isolates render errors, rejects malformed panels, and caps lines", () => {
  const host = createPanelHost(hostOptions({ requestRender() {} }));
  assert.throws(() => host.host.upsert({ id: "", render: () => [] }), /nonempty/);
  assert.throws(() => host.host.upsert({ id: "bad", order: NaN, render: () => [] }), /finite/);
  assert.throws(() => host.host.upsert({ id: "bad", render: "not a function" }), /function/);

  host.host.upsert({ id: "good", order: 2, render: () => ["good"] });
  host.host.upsert({ id: "throws", order: 0, render: () => { throw new Error("secret"); } });
  host.host.upsert({ id: "wrong", order: 1, render: () => [42, "visible"] });
  const lines = host.render(80, {});
  assert.match(lines[0], /render failed/);
  assert.match(lines[1], /non-string line/);
  assert.equal(lines.at(-1), "good");
  assert.ok(!lines.join("\n").includes("secret"));
  assert.ok(lines.every((line) => visibleWidth(line) <= 80));

  host.host.remove("throws");
  host.host.remove("missing");
  host.host.upsert({
    id: "many",
    render: () => Array.from({ length: MAX_PANEL_LINES + 10 }, (_, i) => String(i)),
  });
  assert.equal(host.render(40, {}).length, MAX_PANEL_LINES);
});

test("uses one animation timer and stops it when the last animated panel is gone", () => {
  const clock = fakeTimers();
  let requests = 0;
  const frames = [];
  const host = createPanelHost(hostOptions({
    requestRender: () => requests++,
    now: () => 1234,
    timers: clock.driver,
  }));
  host.host.upsert({
    id: "animated",
    animated: true,
    render: (_width, _theme, context) => {
      frames.push(context);
      return [String(context.frame)];
    },
  });
  host.host.upsert({ id: "static", render: () => ["static"] });
  assert.equal(clock.timers.size, 1);
  assert.equal(clock.timers.values().next().value.intervalMs, PANEL_ANIMATION_INTERVAL_MS);
  assert.equal(requests, 2);

  host.render(20, {});
  clock.tick();
  assert.equal(host.getFrame(), 1);
  assert.equal(requests, 3);
  host.render(20, {});
  assert.deepEqual(frames.at(-1), { now: 1234, frame: 1 });

  host.host.remove("animated");
  assert.equal(clock.timers.size, 0);
  assert.equal(clock.clearCount, 1);
  const requestsAfterStop = requests;
  clock.tick();
  assert.equal(requests, requestsAfterStop);
  host.host.remove("static");
  assert.deepEqual(host.render(20, {}), []);
});

test("stopped hosts are inert", () => {
  let requests = 0;
  const host = createPanelHost(hostOptions({ requestRender: () => requests++ }));
  host.host.upsert({ id: "one", render: () => ["one"] });
  host.stop();
  const before = requests;
  host.host.upsert({ id: "late", render: () => ["late"] });
  host.host.remove("one");
  assert.equal(requests, before);
  assert.deepEqual(host.render(80, {}), []);
  assert.equal(host.isActive(), false);
});
