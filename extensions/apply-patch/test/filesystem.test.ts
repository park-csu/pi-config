import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parsePatch } from "../src/parser.js";
import { applyPatchOperations } from "../src/transaction.js";

const envelope = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;
const run = (cwd: string, body: string, signal?: AbortSignal) => applyPatchOperations(parsePatch(envelope(body)), cwd, signal);

async function tempDir() { return mkdtemp(join(tmpdir(), "pi-apply-patch-test-")); }

test("creates, updates, deletes, moves, and replaces sequentially", async () => {
  const cwd = await tempDir();
  await writeFile(join(cwd, "update.txt"), "old\n", { mode: 0o640 });
  await writeFile(join(cwd, "delete.txt"), "bye\n");
  await writeFile(join(cwd, "move.txt"), "move\n", { mode: 0o600 });
  await writeFile(join(cwd, "replace.txt"), "before\n");
  const details = await run(cwd, `*** Add File: nested/new.txt
+new
*** Update File: update.txt
@@
-old
+updated
*** Delete File: delete.txt
*** Update File: move.txt
*** Move to: moved.txt
@@
-move
+moved
*** Add File: replace.txt
+after`);
  assert.equal(await readFile(join(cwd, "nested/new.txt"), "utf8"), "new\n");
  assert.equal(await readFile(join(cwd, "update.txt"), "utf8"), "updated\n");
  assert.equal((await stat(join(cwd, "update.txt"))).mode & 0o777, 0o640);
  await assert.rejects(readFile(join(cwd, "delete.txt")), /ENOENT/);
  await assert.rejects(readFile(join(cwd, "move.txt")), /ENOENT/);
  assert.equal(await readFile(join(cwd, "moved.txt"), "utf8"), "moved\n");
  assert.equal((await stat(join(cwd, "moved.txt"))).mode & 0o777, 0o666 & ~process.umask());
  assert.equal(await readFile(join(cwd, "replace.txt"), "utf8"), "after\n");
  assert.equal(details.failures.length, 0);
  assert.match(details.diff, /--- update\.txt/);
  assert.equal(details.preview.files.length, 5);
  assert.equal(details.preview.files.find((file) => file.moveTo)?.moveTo, "moved.txt");
  assert.ok(details.preview.added > 0);
  assert.ok(details.preview.removed > 0);
  assert.match(details.preview.files.find((file) => file.path === "nested/new.txt")!.diff, /^\+1 new/m);
  assert.match(details.preview.files.find((file) => file.path === "update.txt")!.diff, /^-1 old$/m);
  assert.match(details.preview.files.find((file) => file.path === "update.txt")!.diff, /^\+1 updated$/m);
});

test("preflight failure prevents earlier changes", async () => {
  const cwd = await tempDir();
  await writeFile(join(cwd, "a.txt"), "a\n");
  const details = await run(cwd, `*** Update File: a.txt
@@
-a
+changed
*** Update File: missing.txt
@@
-x
+y`);
  assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "a\n");
  assert.equal(details.failures.length, 1);
  assert.match(details.failures[0]!.message, /Failed to read file to update .*missing\.txt: No such file or directory \(os error 2\)/);
});

test("valid UTF8 with NUL uses normal context matching and can be deleted", async () => {
  const cwd = await tempDir();
  await writeFile(join(cwd, "binary"), Buffer.from([0, 1, 2]));
  const update = await run(cwd, "*** Update File: binary\n@@\n-x\n+y");
  assert.match(update.failures[0]!.message, /Failed to find expected lines/);
  const deletion = await run(cwd, "*** Delete File: binary");
  assert.equal(deletion.failures.length, 0);
  await assert.rejects(lstat(join(cwd, "binary")), /ENOENT/);
});

test("updates through symbolic links without replacing the link", async () => {
  const cwd = await tempDir();
  await writeFile(join(cwd, "target"), "old\n");
  await symlink("target", join(cwd, "link"));
  const details = await run(cwd, "*** Update File: link\n@@\n-old\n+new");
  assert.equal(details.failures.length, 0);
  assert.equal((await lstat(join(cwd, "link"))).isSymbolicLink(), true);
  assert.equal(await readFile(join(cwd, "target"), "utf8"), "new\n");
});

test("move to a symlink alias follows Codex write-then-unlink behavior", async () => {
  const cwd = await tempDir();
  await writeFile(join(cwd, "source"), "old\n");
  await symlink("source", join(cwd, "destination"));
  const details = await run(cwd, `*** Update File: source
*** Move to: destination
@@
-old
+new`);
  assert.equal(details.failures.length, 0);
  await assert.rejects(readFile(join(cwd, "source")), /ENOENT/);
  assert.equal((await lstat(join(cwd, "destination"))).isSymbolicLink(), true);
});

test("follows symlinks in parent path components", async () => {
  const cwd = await tempDir();
  const outside = await tempDir();
  await symlink(outside, join(cwd, "linked-dir"));
  const details = await run(cwd, "*** Add File: linked-dir/new.txt\n+new");
  assert.equal(details.failures.length, 0);
  assert.equal(await readFile(join(outside, "new.txt"), "utf8"), "new\n");
});

test("retains the committed destination when source deletion makes a move fail", {
  skip: typeof process.getuid === "function" && process.getuid() === 0,
}, async () => {
  const cwd = await tempDir();
  const locked = join(cwd, "locked");
  await mkdir(locked);
  await writeFile(join(locked, "source"), "old\n");
  await chmod(locked, 0o500);
  try {
    const details = await run(cwd, `*** Update File: locked/source
*** Move to: destination
@@
-old
+new`);
    assert.equal(details.failures.length, 1);
    assert.equal(await readFile(join(locked, "source"), "utf8"), "old\n");
    assert.equal(await readFile(join(cwd, "destination"), "utf8"), "new\n");
  } finally {
    await chmod(locked, 0o700);
  }
});

test("truncates large diffs and saves the complete diff", async () => {
  const cwd = await tempDir();
  const lines = Array.from({ length: 2100 }, (_, i) => `+line ${i}`).join("\n");
  const details = await run(cwd, `*** Add File: large.txt\n${lines}`);
  assert.ok(details.diffTruncation);
  assert.ok(details.fullDiffPath);
  assert.match(details.diff, /Diff truncated/);
  assert.match(await readFile(details.fullDiffPath!, "utf8"), /line 2099/);
});

test("aborted operations do not mutate files", async () => {
  const cwd = await tempDir();
  await writeFile(join(cwd, "a"), "A\n");
  const controller = new AbortController();
  controller.abort();
  const details = await run(cwd, "*** Update File: a\n@@\n-A\n+B", controller.signal);
  assert.equal(details.failures.length, 1);
  assert.equal(await readFile(join(cwd, "a"), "utf8"), "A\n");
});

test("reports sequential progress without letting rendering failures affect application", async () => {
  const cwd = await tempDir();
  const updates: Array<{ applied: number; failed: number; total: number }> = [];
  const operations = parsePatch(envelope("*** Add File: a\n+A\n*** Add File: b\n+B"));
  const details = await applyPatchOperations(operations, cwd, undefined, (current) => {
    updates.push({ ...current.progress! });
    if (updates.length === 1) throw new Error("renderer failed");
  });
  assert.deepEqual(updates, [
    { applied: 1, failed: 0, total: 2 },
    { applied: 2, failed: 0, total: 2 },
  ]);
  assert.equal(details.failures.length, 0);
  assert.equal(await readFile(join(cwd, "b"), "utf8"), "B\n");
});

test("same-file concurrent calls serialize", async () => {
  const cwd = await tempDir();
  await writeFile(join(cwd, "a.txt"), "start\n");
  await Promise.all([
    run(cwd, "*** Update File: a.txt\n@@\n+one\n*** End of File"),
    run(cwd, "*** Update File: a.txt\n@@\n+two\n*** End of File"),
  ]);
  assert.match(await readFile(join(cwd, "a.txt"), "utf8"), /^start\n(?:one\ntwo|two\none)\n$/);
});
