import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parsePatch } from "../src/parser.js";
import { applyPatchOperations } from "../src/transaction.js";

for (const kind of ["missing", "invalid", "truncated", "loop", "directory-write"]) {
  test(`Codex exact filesystem error: ${kind}`, { skip: process.env.CODEX_DIFFERENTIAL !== "1" }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "patch-error-oracle-"));
    try {
      const path = join(cwd, "file");
      if (kind === "invalid") await writeFile(path, Buffer.from([0xe2, 0x28, 0xa1]));
      if (kind === "truncated") await writeFile(path, Buffer.from([0xf0, 0x90]));
      if (kind === "loop") await symlink("file", path);
      if (kind === "directory-write") await mkdir(path);
      const body = kind === "directory-write" ? "*** Add File: file\n+new" : "*** Update File: file\n@@\n-old\n+new";
      const patch = `*** Begin Patch\n${body}\n*** End Patch`;
      const codex = spawnSync(process.env.CODEX_BINARY || "codex",
        ["--codex-run-as-apply-patch", patch], { cwd, encoding: "utf8", timeout: 5000 });
      assert.equal(codex.error, undefined);
      assert.equal(codex.status, 1);
      const result = await applyPatchOperations(parsePatch(patch), cwd);
      assert.equal(result.failures.length, 1);
      assert.equal(result.failures[0]!.message + "\n", codex.stderr);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}
