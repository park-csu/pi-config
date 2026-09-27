import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePatch } from "../src/parser.js";
import { applyPatchOperations } from "../src/transaction.js";

const envelope = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;
const run = (cwd: string, body: string, onProgress?: (details: Awaited<ReturnType<typeof applyPatchOperations>>) => void) =>
  applyPatchOperations(parsePatch(envelope(body)), cwd, undefined, onProgress);

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-apply-patch-reporting-"));
}

test("reports the original operation paths in results and previews", async () => {
  const cwd = await tempDir();
  try {
    await writeFile(join(cwd, "update.txt"), "old\n");
    await writeFile(join(cwd, "delete.txt"), "delete\n");
    await writeFile(join(cwd, "move.txt"), "move\n");

    const details = await run(cwd, `*** Add File: ./new.txt
+new
*** Update File: ./update.txt
@@
-old
+updated
*** Delete File: ./delete.txt
*** Update File: ./move.txt
*** Move to: ./moved.txt
@@
-move
+moved`);

    assert.deepEqual(details.created, ["./new.txt"]);
    assert.deepEqual(details.updated, ["./update.txt"]);
    assert.deepEqual(details.deleted, ["./delete.txt"]);
    assert.deepEqual(details.moved, [{ from: "./move.txt", to: "./moved.txt" }]);
    assert.deepEqual(details.preview.files.map(({ path, moveTo }) => ({ path, moveTo })), [
      { path: "./new.txt", moveTo: undefined },
      { path: "./update.txt", moveTo: undefined },
      { path: "./delete.txt", moveTo: undefined },
      { path: "./move.txt", moveTo: "./moved.txt" },
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("shows replacement text and warns when an invalid UTF-8 overwrite cannot be compared", async () => {
  const cwd = await tempDir();
  try {
    await writeFile(join(cwd, "binary.dat"), Buffer.from([0xff, 0x00]));
    const details = await run(cwd, `*** Add File: ./binary.dat
+replacement`);

    assert.equal(details.failures.length, 0);
    assert.match(details.diff, /\+replacement/);
    assert.ok(details.preview.added > 0);
    assert.match(details.preview.files[0]!.diff, /replacement/);
    assert.match(details.preview.warning ?? "", /UTF-8|compar/i);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("counts a partial move as failed, while retaining its committed destination", {
  skip: process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0),
}, async () => {
  const cwd = await tempDir();
  const locked = join(cwd, "locked");
  try {
    await mkdir(locked);
    await writeFile(join(locked, "source.txt"), "old\n");
    await chmod(locked, 0o500);
    const progress: Array<{ applied: number; failed: number; total: number }> = [];
    const details = await run(cwd, `*** Update File: ./locked/source.txt
*** Move to: ./destination.txt
@@
-old
+new`, (current) => {
      progress.push({ ...current.progress! });
    });

    assert.deepEqual(progress, [{ applied: 0, failed: 1, total: 1 }]);
    assert.deepEqual(details.created, ["./destination.txt"]);
    assert.equal(details.preview.files[0]!.path, "./destination.txt");
    assert.equal(await readFile(join(cwd, "destination.txt"), "utf8"), "new\n");
    assert.equal(await readFile(join(locked, "source.txt"), "utf8"), "old\n");
  } finally {
    await chmod(locked, 0o700).catch(() => {});
    await rm(cwd, { recursive: true, force: true });
  }
});
