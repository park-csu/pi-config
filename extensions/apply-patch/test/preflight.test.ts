import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePatch } from "../src/parser.js";
import { applyPatchOperations } from "../src/transaction.js";

const envelope = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-apply-patch-preflight-"));
}

test("preflights every update before mutating any file", async () => {
  const cwd = await tempDir();
  try {
    await writeFile(join(cwd, "first.txt"), "first\n");
    await writeFile(join(cwd, "second.txt"), "second\n");
    const operations = parsePatch(envelope(`*** Update File: first.txt
@@
-first
+changed
*** Update File: second.txt
@@
-not present
+changed`));

    const details = await applyPatchOperations(operations, cwd);

    assert.equal(details.failures.length, 1);
    assert.match(details.failures[0]!.message, /Failed to find expected lines/);
    assert.equal(await readFile(join(cwd, "first.txt"), "utf8"), "first\n");
    assert.equal(await readFile(join(cwd, "second.txt"), "utf8"), "second\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("stops after an error while applying an operation", async () => {
  const cwd = await tempDir();
  try {
    await writeFile(join(cwd, "first.txt"), "first\n");
    await writeFile(join(cwd, "second.txt"), "second\n");
    const operations = parsePatch(envelope(`*** Update File: first.txt
@@
-first
+changed
*** Update File: second.txt
@@
-second
+changed
*** Add File: later.txt
+later`));

    const details = await applyPatchOperations(operations, cwd, undefined, async (current) => {
      if (current.progress?.applied === 1) await rm(join(cwd, "second.txt"));
    });

    assert.equal(details.failures.length, 1);
    assert.equal(await readFile(join(cwd, "first.txt"), "utf8"), "changed\n");
    assert.match(details.failures[0]!.message, /Failed to read file to update .*second\.txt: No such file or directory \(os error 2\)/);
    await assert.rejects(readFile(join(cwd, "later.txt")), /ENOENT/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("rejects an empty patch", async () => {
  const cwd = await tempDir();
  try {
    await assert.rejects(
      applyPatchOperations([], cwd),
      (error: unknown) => error instanceof Error && error.message === "No files were modified.",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("native preflight rejects duplicate source paths including normalized aliases", async () => {
  const cwd = await tempDir();
  try {
    await writeFile(join(cwd, "file"), "original\n");
    const operations = parsePatch(envelope("*** Delete File: file\n*** Add File: ./file\n+replacement"));
    await assert.rejects(applyPatchOperations(operations, cwd), /multiple operations target/);
    assert.equal(await readFile(join(cwd, "file"), "utf8"), "original\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
