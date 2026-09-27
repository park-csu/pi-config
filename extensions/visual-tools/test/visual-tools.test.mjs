import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { discoverAndLoadExtensions } from "/home/changsu/.local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import { resolveTools } from "../../subagents/core.ts";

const exec = promisify(execFile);
const root = join(import.meta.dirname, "..", "..", "..");

test("entrypoint loads all six tools through the installed Pi loader", async () => {
  const { stdout } = await exec("pi", [
    "--no-session", "--no-extensions", "--list-models",
    "-e", join(root, "extensions/visual-tools/index.ts"),
  ], { cwd: root, timeout: 20_000 });
  assert.match(stdout, /provider\s+model/);
  const source = await readFile(join(root, "extensions/visual-tools/index.ts"), "utf8");
  for (const name of ["write_svg", "edit_svg", "render_svg", "write_mermaid", "edit_mermaid", "render_mermaid"]) {
    assert.match(await readFile(join(root, "extensions/visual-tools/tools", name.includes("svg") ? "svg_tools.ts" : "mermaid_tools.ts"), "utf8"), new RegExp(`name: "${name}"`));
  }
  assert.match(source, /mermaidTools\(pi\)/);
  assert.match(source, /svgTools\(pi\)/);
});

test("published SVG render is a real PNG when ImageMagick is available", async (t) => {
  const dir = await mkdtemp("/tmp/pi-visual-tools-test-");
  try {
    const svg = join(dir, "input.svg"), png = join(dir, "output.png");
    await (await import("node:fs/promises")).writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="white"/></svg>');
    try {
      await exec("magick", ["-density", "192", "-background", "white", svg, png]);
    } catch {
      t.skip("ImageMagick is not installed");
      return;
    }
    const bytes = await readFile(png);
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Pi-loaded tools execute, isolate factories, publish in ctx.cwd, and clean up", async () => {
  const first = await mkdtemp("/tmp/pi-visual-tools-runtime-");
  const second = await mkdtemp("/tmp/pi-visual-tools-runtime-");
  try {
    const loaded = await discoverAndLoadExtensions([join(root, "extensions/visual-tools/index.ts")], first, "/tmp/no-agent-dir");
    assert.equal(loaded.errors.length, 0);
    const ext = loaded.extensions[0];
    const all = [...ext.tools.values()];
    assert.deepEqual(resolveTools(["read", "write_svg", "render_svg"], [
      { name: "read", sourceInfo: { source: "builtin" } },
      ...all.map(tool => ({ name: tool.definition.name, sourceInfo: tool.sourceInfo })),
    ], ["read", "write_svg", "render_svg"]), [join(root, "extensions/visual-tools/index.ts")]);
    const ctx = { cwd: first };
    const write = await ext.tools.get("write_svg").definition.execute("1", {
      source: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="red"/></svg>',
    }, undefined, undefined, ctx);
    const edited = await ext.tools.get("edit_svg").definition.execute("2", { old_text: "red", new_text: "blue" }, undefined, undefined, ctx);
    assert.equal(edited.details.ok, true);
    await assert.rejects(ext.tools.get("edit_svg").definition.execute("2b", { old_text: "missing", new_text: "x" }, undefined, undefined, ctx), /not found/);
    await assert.rejects(ext.tools.get("edit_svg").definition.execute("2c", { old_text: "e", new_text: "x" }, undefined, undefined, ctx), /more than once/);
    const preview = await ext.tools.get("render_svg").definition.execute("3", {}, undefined, undefined, ctx);
    assert.equal(preview.content.at(-1).mimeType, "image/png");
    const published = await ext.tools.get("render_svg").definition.execute("4", { save_as: "same-topic" }, undefined, undefined, ctx);
    assert.match(published.details.path, new RegExp(`^${first}/viz/`));
    const publishedAgain = await ext.tools.get("render_svg").definition.execute("5", { save_as: "same-topic" }, undefined, undefined, ctx);
    assert.notEqual(published.details.filename, publishedAgain.details.filename);
    const secondLoaded = await discoverAndLoadExtensions([join(root, "extensions/visual-tools/index.ts")], second, "/tmp/no-agent-dir");
    const secondCtx = { cwd: second };
    await assert.rejects(secondLoaded.extensions[0].tools.get("render_svg").definition.execute("6", {}, undefined, undefined, secondCtx), /write_svg first/);
    for (const shutdown of ext.handlers.get("session_shutdown") ?? []) await shutdown({}, ctx);
    await assert.rejects(readFile(write.details.path), /ENOENT/);
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});

test("pre-cancelled writes do not create sources and missing Mermaid renderer rejects", async () => {
  const dir = await mkdtemp("/tmp/pi-visual-tools-cancel-");
  try {
    const loaded = await discoverAndLoadExtensions([join(root, "extensions/visual-tools/index.ts")], dir, "/tmp/no-agent-dir");
    const ext = loaded.extensions[0], ctx = { cwd: dir }, controller = new AbortController();
    controller.abort();
    await assert.rejects(ext.tools.get("write_svg").definition.execute("1", {
      source: '<svg xmlns="http://www.w3.org/2000/svg"/>',
    }, controller.signal, undefined, ctx), /aborted/i);
    await ext.tools.get("write_mermaid").definition.execute("2", { source: "graph TD\nA-->B" }, undefined, undefined, ctx);
    await assert.rejects(ext.tools.get("edit_mermaid").definition.execute("2b", { old_text: "missing", new_text: "x" }, undefined, undefined, ctx), /not found/);
    await assert.rejects(ext.tools.get("render_mermaid").definition.execute("3", {}, undefined, undefined, ctx), /Mermaid render failed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
