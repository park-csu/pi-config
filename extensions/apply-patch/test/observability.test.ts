import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import extension from "../index.js";

initTheme("dark", false);

const backgrounds: string[] = [];
const theme: any = {
  fg: (_color: string, text: string) => text,
  bg: (color: string, text: string) => {
    backgrounds.push(color);
    return text;
  },
  bold: (text: string) => text,
};

async function getTool(): Promise<any> {
  let tool: any;
  const pi: any = {
    registerTool(value: any) { tool = value; },
    on() {},
    getActiveTools() { return []; },
    setActiveTools() {},
  };
  await extension(pi);
  return tool;
}

function render(component: { render(width: number): string[] }): string {
  return component.render(160).join("\n").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

test("collapsed result shows actual changed lines and expansion hint", async () => {
  backgrounds.length = 0;
  const tool = await getTool();
  const details = {
    diff: "",
    created: [],
    updated: ["src/example.ts"],
    moved: [],
    deleted: [],
    failures: [],
    preview: {
      files: [{
        operation: "update",
        path: "src/example.ts",
        diff: [
          "  1 const before = true;",
          "- 2 const value = \"old\";",
          "+ 2 const value = \"new\";",
          "  3 export { value };",
          "  4 const a = 1;",
          "  5 const b = 2;",
          "  6 const c = 3;",
          "  7 const d = 4;",
          "  8 const e = 5;",
          "  9 const f = 6;",
          " 10 const g = 7;",
          " 11 const h = 8;",
        ].join("\n"),
        added: 1,
        removed: 1,
      }],
      added: 1,
      removed: 1,
    },
    progress: { applied: 1, failed: 0, total: 1 },
  };

  const output = render(tool.renderResult(
    { content: [{ type: "text", text: "Updated: src/example.ts" }], details },
    { expanded: false, isPartial: false },
    theme,
    { isError: false },
  ));

  assert.match(output, /src\/example\.ts/);
  assert.match(output, /Edited src\/example\.ts \(\+1 -1\)/);
  assert.doesNotMatch(output, /• Edited/);
  assert.match(output, /-\s*2 const value = "old";/);
  assert.match(output, /\+\s*2 const value = "new";/);
  assert.match(output, /more lines, 12 total,/);
  assert.match(output, /to expand/);
  assert.ok(backgrounds.includes("toolErrorBg"), "removed line should use the Codex error background");
  assert.ok(backgrounds.includes("toolSuccessBg"), "added line should use the Codex success background");
});

test("final error renders committed changes and incomparable-source warning", async () => {
  const tool = await getTool();
  const output = render(tool.renderResult({
    content: [{ type: "text", text: "Failed to write directory" }],
    details: {
      diff: "+1 replacement",
      created: ["first"], updated: [], moved: [], deleted: [],
      failures: [{ path: "directory", operation: "add", message: "Failed to write directory" }],
      preview: {
        warning: "Original file is not valid UTF-8; replacement is shown as new text because it cannot be compared.",
        files: [{ operation: "add", path: "first", diff: "+1 replacement", added: 1, removed: 0 }],
        added: 1, removed: 0,
      },
    },
  }, { expanded: false, isPartial: false }, theme, { isError: true }));
  assert.match(output, /cannot be compared/);
  assert.match(output, /Added first/);
  assert.match(output, /replacement/);
  assert.match(output, /Failed to write directory/);
});

test("collapsed multi-file result separates every file and its changes", async () => {
  const tool = await getTool();
  const files = Array.from({ length: 4 }, (_, index) => ({
    operation: "update",
    path: `file-${index + 1}.txt`,
    diff: `-1 old-${index + 1}\n+1 new-${index + 1}`,
    added: 1,
    removed: 1,
  }));
  const output = render(tool.renderResult(
    {
      content: [{ type: "text", text: "Updated files" }],
      details: {
        diff: "",
        created: [],
        updated: files.map((file) => file.path),
        moved: [],
        deleted: [],
        failures: [],
        preview: { files, added: 4, removed: 4 },
        progress: { applied: 4, failed: 0, total: 4 },
      },
    },
    { expanded: false, isPartial: false },
    theme,
    { isError: false },
  ));

  for (const file of files) assert.match(output, new RegExp(file.path.replace(".", "\\.")));
  for (let index = 1; index <= files.length; index++) {
    assert.match(output, new RegExp(`Edited file-${index}\\.txt`));
    assert.match(output, new RegExp(`-1 old-${index}`));
    assert.match(output, new RegExp(`\\+1 new-${index}`));
  }
  assert.ok(backgrounds.filter((color) => color === "toolSuccessBg").length >= files.length);
  assert.ok(backgrounds.filter((color) => color === "toolErrorBg").length >= files.length);
});
