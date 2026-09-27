import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parsePatch } from "../src/parser.js";
import { applyPatchOperations } from "../src/transaction.js";

const codex = process.env.CODEX_BINARY || "codex";
const cases = [
  { name: "symlink update", body: "*** Update File: alias\n@@\n-old\n+new", kind: "symlink" },
  { name: "hardlink update", body: "*** Update File: alias\n@@\n-old\n+new", kind: "hardlink" },
  { name: "new move destination mode", body: "*** Update File: source\n*** Move to: dest\n@@\n-old\n+new", kind: "move" },
  { name: "same path move", body: "*** Update File: source\n*** Move to: source\n@@\n-old\n+new", kind: "move" },
  { name: "symlink parent add", body: "*** Add File: linked/new\n+new", kind: "parent" },
  { name: "failed move retains overwrite", body: "*** Update File: locked/source\n*** Move to: dest\n@@\n-old\n+new", kind: "failure" },
  { name: "write-only Add destination", body: "*** Add File: dest\n+new", kind: "writeonly" },
  { name: "write-only Move destination", body: "*** Update File: source\n*** Move to: dest\n@@\n-old\n+new", kind: "writeonly" },
];
for (const fixture of cases) {
  test(`Codex filesystem comparison: ${fixture.name}`, {
    skip: process.env.CODEX_DIFFERENTIAL !== "1" ||
      (fixture.kind === "failure" && process.getuid?.() === 0),
  }, async () => {
    const version = spawnSync(codex, ["--version"], { encoding: "utf8" });
    assert.match(version.stdout, /^codex-cli 0\.154\.0\s*$/);
    const root = await mkdtemp(join(tmpdir(), "patch-fs-oracle-"));
    const native = join(root, "native"), pi = join(root, "pi");
    try {
      for (const cwd of [native, pi]) {
        await mkdir(cwd);
        await writeFile(join(cwd, "source"), "old\n", { mode: 0o600 });
        if (fixture.kind === "symlink") await symlink("source", join(cwd, "alias"));
        if (fixture.kind === "hardlink") await link(join(cwd, "source"), join(cwd, "alias"));
        if (fixture.kind === "parent") {
          await mkdir(join(cwd, "real"));
          await symlink("real", join(cwd, "linked"));
        }
        if (fixture.kind === "failure") {
          await mkdir(join(cwd, "locked"));
          await writeFile(join(cwd, "locked/source"), "old\n");
          await writeFile(join(cwd, "dest"), "destination\n");
          await chmod(join(cwd, "locked"), 0o500);
        }
        if (fixture.kind === "writeonly") {
          await writeFile(join(cwd, "dest"), "unreadable\n");
          await chmod(join(cwd, "dest"), 0o200);
        }
      }
      const patch = `*** Begin Patch\n${fixture.body}\n*** End Patch`;
      const expected = spawnSync(codex, ["--codex-run-as-apply-patch", patch], {
        cwd: native, encoding: "utf8", timeout: 5000,
      });
      assert.equal(expected.error, undefined);
      const actual = await applyPatchOperations(parsePatch(patch), pi);
      assert.equal(actual.failures.length > 0, expected.status !== 0, expected.stderr);
      async function state(cwd: string, path: string) {
        try {
          const info = await lstat(join(cwd, path));
          if (fixture.kind === "writeonly" && path === "dest") {
            await chmod(join(cwd, path), 0o600);
          }
          return info.isSymbolicLink()
            ? { link: await readlink(join(cwd, path)) }
            : { bytes: await readFile(join(cwd, path)), mode: info.mode & 0o777 };
        } catch (error: any) {
          if (error.code === "ENOENT") return null;
          throw error;
        }
      }
      for (const path of ["source", "alias", "dest", "real/new", "locked/source"]) {
        assert.deepEqual(await state(pi, path), await state(native, path), path);
      }
    } finally {
      for (const cwd of [native, pi]) await chmod(join(cwd, "locked"), 0o700).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });
}
