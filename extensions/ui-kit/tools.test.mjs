import test from "node:test";
import assert from "node:assert/strict";
import { createToolRegistrar, getToolRenderers } from "./tools.ts";

function bus() {
  const listeners = new Map();
  return {
    on(name, handler) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(handler);
      return () => listeners.get(name).delete(handler);
    },
    emit(name, value) { for (const handler of listeners.get(name) ?? []) handler(value); },
  };
}
function provider(events) {
  const hooks = new Map(), tools = new Map();
  return {
    events, tools,
    registerTool(tool) { tools.set(tool.name, tool); },
    on(name, handler) { if (!hooks.has(name)) hooks.set(name, []); hooks.get(name).push(handler); },
    lifecycle(name) { for (const hook of hooks.get(name) ?? []) hook(); },
  };
}

test("shares styled display callbacks without exposing execution; handles registration order and replacement", () => {
  const events = bus(), pi = provider(events);
  assert.equal(getToolRenderers(events).size, 0);
  const definition = { name: "custom", parameters: {}, execute() { throw Error("must never execute"); },
    renderCall() {}, renderResult() {}, renderShell: "self" };
  createToolRegistrar(pi)(definition);
  const registered = pi.tools.get("custom");
  assert.notEqual(registered, definition);
  assert.equal(registered.execute, definition.execute);
  assert.equal(registered.parameters, definition.parameters);
  const renderer = getToolRenderers(events).get("custom");
  assert.deepEqual(Object.keys(renderer).sort(), ["renderCall", "renderResult", "renderShell"]);
  assert.equal(renderer.renderCall, registered.renderCall);
  assert.equal(renderer.renderResult, registered.renderResult);
  assert.equal(renderer.renderShell, "self");
  assert.equal(getToolRenderers(events).get("custom"), renderer);
  createToolRegistrar(pi)({ ...definition, renderCall() {} });
  assert.notEqual(getToolRenderers(events).get("custom"), renderer);
});

test("all tools are discoverable and shutdown removes only the owning extension", () => {
  const events = bus(), first = provider(events), second = provider(events);
  createToolRegistrar(first)({ name: "one" });
  createToolRegistrar(first)({ name: "two" });
  createToolRegistrar(second)({ name: "three" });
  assert.deepEqual([...getToolRenderers(events).keys()], ["one", "two", "three"]);
  first.lifecycle("session_shutdown");
  assert.deepEqual([...getToolRenderers(events).keys()], ["three"]);
  first.lifecycle("session_start");
  first.lifecycle("session_start");
  assert.equal(getToolRenderers(events).size, 3);
  first.lifecycle("session_shutdown");
  second.lifecycle("session_shutdown");
  assert.equal(getToolRenderers(events).size, 0);
});
