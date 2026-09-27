import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extension from "../index.js";

test("partial failure retains committed details on the final error result", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "patch-tool-failure-"));
  const handlers = new Map<string, Function>();
  let tool: any;
  extension({
    registerTool(value: any) { tool = value; },
    on(name: string, handler: Function) { handlers.set(name, handler); },
  } as any);
  try {
    await mkdir(join(cwd, "directory"));
    const input = "*** Begin Patch\n*** Add File: first\n+written\n*** Add File: directory\n+blocked\n*** End Patch";
    let message = "";
    await assert.rejects(async () => {
      try {
        await tool.execute("call-1", { input }, undefined, undefined, { cwd });
      } catch (error: any) {
        message = error.message;
        throw error;
      }
    });
    assert.equal(await readFile(join(cwd, "first"), "utf8"), "written\n");
    // Pi converts thrown tool errors to empty details, then runs tool_result.
    const event = { type: "tool_result", toolName: "apply_patch", toolCallId: "call-1",
      input: { input }, content: [{ type: "text", text: message }], details: {}, isError: true };
    assert.ok(handlers.has("tool_result"));
    assert.equal(await handlers.get("tool_result")!({ ...event, toolName: "bash" }, {}), undefined);
    assert.equal(await handlers.get("tool_result")!({ ...event, toolCallId: "other-call" }, {}), undefined);
    const patch = await handlers.get("tool_result")!(event, {});
    assert.equal(patch.isError, true);
    assert.deepEqual(patch.details.created, ["first"]);
    assert.equal(patch.details.failures.length, 1);
    assert.match(patch.details.diff, /written/);
    assert.equal(patch.details.preview.files[0].path, "first");
    // Restoration is one-shot and must never affect another tool's result.
    assert.equal(await handlers.get("tool_result")!(event, {}), undefined);
    assert.equal(await handlers.get("tool_result")!({ ...event, toolName: "bash" }, {}), undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("native handler verification errors differ from standalone stderr wrapping", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "patch-native-verification-"));
  let tool: any;
  extension({ registerTool(value: any) { tool = value; }, on() {} } as any);
  try {
    const cases = [
      ["bad", "apply_patch verification failed: invalid patch: The first line of the patch must be '*** Begin Patch'"],
      ["*** Begin Patch\n*** Update File: missing\n@@\n-old\n+new\n*** End Patch",
        `apply_patch verification failed: Failed to read file to update ${join(cwd, "missing")}: No such file or directory (os error 2)`],
      ["*** Begin Patch\n*** Environment ID: remote\n*** Add File: a\n+x\n*** End Patch",
        "apply_patch environment selection is unavailable for this turn"],
    ];
    for (const [input, expected] of cases) {
      await assert.rejects(tool.execute("verification", { input }, undefined, undefined, { cwd }),
        (error: any) => error.message === expected);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("success summary matches Codex A/M/D ordering, including moves and no-op updates", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "patch-tool-summary-"));
  let tool: any;
  extension({ registerTool(value: any) { tool = value; }, on() {} } as any);
  try {
    await writeFile(join(cwd, "old"), "old\n");
    await writeFile(join(cwd, "same"), "same\n");
    await writeFile(join(cwd, "gone"), "gone\n");
    const input = "*** Begin Patch\n*** Update File: old\n*** Move to: moved\n@@\n-old\n+new\n*** Add File: added\n+added\n*** Update File: same\n@@\n-same\n+same\n*** Delete File: gone\n*** End Patch";
    const result = await tool.execute("summary-1", { input }, undefined, undefined, { cwd });
    assert.equal(result.content[0].text,
      "Success. Updated the following files:\nA added\nM moved\nM same\nD gone\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
