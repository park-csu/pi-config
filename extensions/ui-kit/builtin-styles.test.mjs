import test from "node:test";
import assert from "node:assert/strict";
import { registerBuiltinToolStyles } from "./builtin-styles.ts";

function fixture() {
  const registered = [];
  let active = ["read", "bash", "apply_patch"];
  const tools = [
    { name: "read", sourceInfo: { source: "builtin" } },
    { name: "bash", sourceInfo: { source: "builtin" } },
    { name: "edit", sourceInfo: { source: "builtin" } },
    { name: "write", sourceInfo: { source: "extension" } },
    { name: "grep", sourceInfo: { source: "sdk" } },
  ];
  return {
    registered, getAllTools: () => tools,
    getActiveTools: () => [...active],
    setActiveTools: value => { active = [...value]; },
    registerTool(definition) {
      registered.push(definition);
      active.push(definition.name);
      tools.find(tool => tool.name === definition.name).sourceInfo.source = "extension";
    },
    on() {},
  };
}

test("builtin styling preserves active tools, schemas, execution and custom overrides", () => {
  const pi = fixture(), before = pi.getActiveTools();
  const definitions = ["read", "bash", "edit", "write", "grep", "find"].map(name => ({
    name, parameters: { type: "object" }, description: name, execute() {},
  }));
  registerBuiltinToolStyles(pi, "/test", () => definitions);
  assert.deepEqual(pi.registered.map(tool => tool.name), ["read", "bash", "edit"]);
  assert.deepEqual(pi.getActiveTools(), before);
  for (const tool of pi.registered) {
    const original = definitions.find(definition => definition.name === tool.name);
    assert.equal(tool.execute, original.execute);
    assert.equal(tool.parameters, original.parameters);
    assert.equal(tool.renderShell, original.renderShell);
  }
  registerBuiltinToolStyles(pi, "/test", () => { throw Error("must not override custom tools"); });
  assert.equal(pi.registered.length, 3);
});

test("failed registration restores the active tool list", () => {
  const pi = fixture(), active = pi.getActiveTools();
  pi.registerTool = () => {
    pi.setActiveTools(["unexpected"]);
    throw Error("registration failed");
  };
  assert.throws(() => registerBuiltinToolStyles(pi, "/test", () => [{ name: "read" }]), /registration failed/);
  assert.deepEqual(pi.getActiveTools(), active);
});
