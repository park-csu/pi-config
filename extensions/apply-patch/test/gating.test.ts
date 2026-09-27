import test from "node:test";
import assert from "node:assert/strict";
import extension from "../index.js";

async function harness(initial: string[], externalPatch = false) {
  let active = [...initial];
  let registered: any;
  const handlers = new Map<string, Function[]>();
  const pi: any = {
    registerTool(tool: any) {
      registered = externalPatch ? { name: "apply_patch", parameters: {} } : tool;
      if (!active.includes(tool.name)) active.push(tool.name);
    },
    getAllTools() { return [registered]; },
    on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    getActiveTools() { return [...active]; },
    setActiveTools(names: string[]) { active = [...names]; },
  };
  await extension(pi);
  const ctx = (id: string) => ({ model: { provider: "openai", id }, hasUI: false, ui: { notify() {} } });
  return {
    active: () => active,
    start(id: string) { for (const fn of handlers.get("session_start") ?? []) fn({}, ctx(id)); },
    select(id: string) { for (const fn of handlers.get("model_select") ?? []) fn({ model: { provider: "openai", id } }, ctx(id)); },
  };
}

test("matching model replaces edit/write and switching restores owned tools", async () => {
  const h = await harness(["read", "edit", "write"]);
  h.start("gpt-5");
  assert.deepEqual(h.active(), ["read", "apply_patch"]);
  h.select("other-model");
  assert.deepEqual(new Set(h.active()), new Set(["read", "edit", "write"]));
});

test("does not gate a same-name tool owned by an earlier extension", async () => {
  const h = await harness(["read", "edit", "write", "apply_patch"], true);
  h.start("claude");
  assert.deepEqual(h.active(), ["read", "edit", "write", "apply_patch"]);
  h.select("gpt-5");
  assert.deepEqual(h.active(), ["read", "edit", "write", "apply_patch"]);
  h.select("claude");
  assert.deepEqual(h.active(), ["read", "edit", "write", "apply_patch"]);
});

test("nonmatching model leaves unrelated tools and does not enable disabled tools", async () => {
  const h = await harness(["read", "edit"]);
  h.start("claude");
  assert.deepEqual(h.active(), ["read", "edit"]);
  h.select("gpt-5");
  assert.deepEqual(h.active(), ["read", "apply_patch"]);
  h.select("claude");
  assert.deepEqual(new Set(h.active()), new Set(["read", "edit"]));
  assert.equal(h.active().includes("write"), false);
});
