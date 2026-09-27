import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, copyFile, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

function installedPi() {
  if (process.env.PI_TEST_PACKAGE_ROOT) return process.env.PI_TEST_PACKAGE_ROOT;
  try {
    let dir = dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim()));
    while (dirname(dir) !== dir) {
      const manifest = join(dir, "package.json");
      if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === "@earendil-works/pi-coding-agent") return dir;
      dir = dirname(dir);
    }
  } catch {}
}

const packageRoot = installedPi();
test("Pi menu: ordering, preview, cancellation, reload and interactive-only one-shot selection", { skip: !packageRoot }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-snippets-test-"));
  try {
    await copyFile(fileURLToPath(new URL("index.ts", import.meta.url)), join(root, "index.ts"));
    await mkdir(join(root, "snippets"));
    const snippet = (name, placement, order, body) => `---\nname: ${name}\nplacement: ${placement}\norder: ${order}\n---\n${body}\n`;
    await writeFile(join(root, "snippets", "z.md"), snippet("Before", "prepend", 50, "BEFORE"));
    await writeFile(join(root, "snippets", "a.md"), snippet("After", "append", 1, "AFTER"));
    const { loadExtensions, createExtensionRuntime } = await import(pathToFileURL(join(packageRoot, "dist/core/extensions/loader.js")));
    const loaded = await loadExtensions([join(root, "index.ts")], root, undefined, createExtensionRuntime());
    assert.deepEqual(loaded.errors, []);
    const extension = loaded.extensions[0];
    const frames = [], widgets = [];
    let keys = [], accepted;
    const theme = { fg: (_color, text) => text, bold: text => text };
    const ctx = { cwd: root, mode: "tui", hasUI: true, ui: {
      theme, setWidget: (_id, value) => widgets.push(value), notify() {},
      custom: async factory => {
        accepted = undefined;
        const component = factory({ terminal: { rows: 20 }, requestRender() {} }, theme, {}, value => { accepted = value; });
        frames.push(component.render(60).join("\n"));
        for (const key of keys) {
          component.handleInput(key);
          frames.push(component.render(60).join("\n"));
        }
        assert.notEqual(accepted, undefined, "menu must complete");
        return accepted;
      },
    } };
    const start = extension.handlers.get("session_start")[0];
    const input = extension.handlers.get("input")[0];
    const menu = async sequence => { keys = sequence; await extension.commands.get("snippets").handler("", ctx); };
    const send = (text = "TASK", source = "interactive") => input({ text, source }, ctx);
    await start({}, ctx);
    assert.equal(await send(), undefined);

    await menu([" ", "\t", "\x1b", "\x1b[B", " ", "\r"]);
    assert.ok(frames.some(frame => frame.includes("Preview: Before") && frame.includes("BEFORE")));
    assert.ok(widgets.at(-1).join("\n").includes("Before"));
    assert.equal(await send("worker completion", "extension"), undefined);
    assert.deepEqual(await send(), { action: "transform", text: "BEFORE\n\nTASK\n\nAFTER" });
    assert.equal(widgets.at(-1), undefined);
    assert.equal(await send(), undefined, "one-shot reset");

    await menu([" ", "\x1b"]);
    assert.equal(await send(), undefined, "cancel does not enable a selection");
    await menu([" ", "\r"]);
    await menu([" ", "\x1b"]);
    assert.deepEqual(await send(), { action: "transform", text: "BEFORE\n\nTASK" }, "cancel preserves the previous selection");

    await menu([" ", "\r"]);
    await writeFile(join(root, "snippets", "z.md"), snippet("Before", "prepend", 50, "UPDATED"));
    assert.deepEqual(await send(), { action: "transform", text: "UPDATED\n\nTASK" }, "read current contents at send time");
    await menu([" ", "\r"]);
    await start({}, ctx);
    assert.equal(await send(), undefined, "new session resets selection");
    await menu([" ", "\r"]);
    await rm(join(root, "snippets", "z.md"));
    assert.equal(await send(), undefined, "deleted snippets are not injected");
  } finally { await rm(root, { recursive: true, force: true }); }
});
