import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Node 24 can strip TS; resolve the source's emitted-JS import names without tsx.
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
    const url = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
    if (existsSync(fileURLToPath(url))) return next(url.href, context);
  }
  return next(specifier, context);
} });
const { parsePatch } = await import("../src/parser.ts");
const { applyHunks, decodeTextFile, encodeTextFile } = await import("../src/apply.ts");
const codex = process.env.CODEX_BINARY || "codex";
const version = spawnSync(codex, ["--version"], { encoding: "utf8" });

for (const [name, source, body] of [
  ["CRLF", "a\r\nb\r\n", "-b\n+c"],
  ["mixed EOL", "a\r\nb\nc\r\n", "-b\n+B"],
  ["no final newline", "a\nb", "-b\n+c"],
  ["BOM retained outside hunk", "\uFEFFa\nb\n", "-b\n+c"],
  ["BOM must match", "\uFEFFa\n", "-a\n+c"],
  ["BOM explicit match", "\uFEFFa\n", "-\uFEFFa\n+c"],
  ["NUL in valid UTF8", "a\0b\ntail\n", "-tail\n+c"],
  ["delete all lines", "a\n", "-a"],
  ["blank final line", "a\n\n", "+b"],
  ["invalid UTF8", Buffer.from([0xff, 10]), "-a\n+b"],
]) {
  test(`Codex 0.154.0 byte comparison: ${name}`, () => {
    assert.equal(version.status, 0, version.stderr);
    assert.match(version.stdout, /^codex-cli 0\.154\.0\s*$/);
    const cwd = mkdtempSync(join(tmpdir(), "patch-eol-oracle-"));
    try {
      writeFileSync(join(cwd, "file"), source);
      const patch = `*** Begin Patch\n*** Update File: file\n@@\n${body}\n*** End Patch`;
      const native = spawnSync(codex, ["--codex-run-as-apply-patch", patch], {
        cwd, encoding: "utf8", timeout: 5000,
      });
      if (native.error?.code === "ERR_INVALID_ARG_VALUE") {
        throw native.error;
      }
      let actual, failed = false;
      try {
        const op = parsePatch(patch)[0];
        actual = encodeTextFile(applyHunks(decodeTextFile(Buffer.from(source), "file"), op.hunks, "file"));
      } catch { failed = true; }
      assert.equal(failed, native.status !== 0, native.stderr || native.error?.message);
      if (!failed) assert.deepEqual(actual, readFileSync(join(cwd, "file")));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}
