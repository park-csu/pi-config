import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePatch } from "../src/parser.js";
import { applyPatchOperations } from "../src/transaction.js";

const envelope = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;
const run = (cwd: string, body: string) => applyPatchOperations(parsePatch(envelope(body)), cwd);

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-apply-patch-overwrite-"));
}

test("Add File overwrites existing text and binary files", async () => {
  const cwd = await tempDir();
  try {
    const text = join(cwd, "text.txt");
    const binary = join(cwd, "binary.dat");
    await writeFile(text, "old text\n");
    await chmod(text, 0o640);
    await writeFile(binary, Buffer.from([0, 1, 2]));

    const details = await run(cwd, `*** Add File: text.txt
+new text
*** Add File: binary.dat
+replacement`);

    assert.equal(details.failures.length, 0);
    assert.equal(await readFile(text, "utf8"), "new text\n");
    assert.deepEqual(await readFile(binary), Buffer.from("replacement\n"));
    assert.equal((await stat(text)).mode & 0o777, 0o640);
    assert.match(details.diff, /-old text/);
    assert.match(details.diff, /\+new text/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Move overwrites an existing destination, preserving destination mode and deleting source", async () => {
  const cwd = await tempDir();
  try {
    const source = join(cwd, "source.txt");
    const destination = join(cwd, "destination.txt");
    await writeFile(source, "source\n");
    await chmod(source, 0o600);
    await writeFile(destination, "old destination\n");
    await chmod(destination, 0o644);

    const details = await run(cwd, `*** Update File: source.txt
*** Move to: destination.txt
@@
-source
+moved`);

    assert.equal(details.failures.length, 0);
    await assert.rejects(readFile(source), /ENOENT/);
    assert.equal(await readFile(destination, "utf8"), "moved\n");
    assert.equal((await stat(destination)).mode & 0o777, 0o644);
    assert.deepEqual(details.moved, [{ from: "source.txt", to: "destination.txt" }]);
    assert.match(details.diff, /-old destination/);
    assert.match(details.diff, /\+moved/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("failed overwrite move retains the committed destination like Codex", {
  skip: process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0),
}, async () => {
  const cwd = await tempDir();
  const locked = join(cwd, "locked");
  try {
    await mkdir(locked);
    const source = join(locked, "source.txt");
    const destination = join(cwd, "destination.txt");
    await writeFile(source, "source\n");
    await writeFile(destination, "old destination\n");
    await chmod(locked, 0o500);

    const details = await run(cwd, `*** Update File: locked/source.txt
*** Move to: destination.txt
@@
-source
+moved`);

    assert.equal(details.failures.length, 1);
    assert.equal(await readFile(source, "utf8"), "source\n");
    assert.equal(await readFile(destination, "utf8"), "moved\n");
  } finally {
    await chmod(locked, 0o700).catch(() => {});
    await rm(cwd, { recursive: true, force: true });
  }
});
