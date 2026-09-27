import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parsePatch } from "../src/parser.js";
import { applyPatchOperations } from "../src/transaction.js";

const envelope = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;
const ordinary = envelope("*** Update File: a\n@@\n-old\n+new");
const cases: Array<[string, string]> = [
  ["ordinary", ordinary],
  ["outer whitespace", ` \n${ordinary}\n \t`],
  ["CRLF patch", ordinary.replaceAll("\n", "\r\n")],
  ["bare CR suffix", `${ordinary}\r`],
  ["empty patch", envelope("")],
  ["empty add", envelope("*** Add File: a")],
  ["implicit hunk", envelope("*** Update File: a\n-old\n+new")],
  ["blank context", envelope("*** Update File: a\n@@\n-old\n+new\n")],
  ["trailing blank after EOF", envelope("*** Update File: a\n@@\n-old\n+new\n*** End of File\n\n")],
  ["space-only after EOF", envelope("*** Update File: a\n@@\n-old\n+new\n*** End of File\n \t")],
  ["indented header", envelope("  *** Add File: a\n+new")],
  ["header trailing spaces", envelope("*** Add File: a   \n+new")],
  ["implicit empty anchor", envelope("*** Update File: a\n@@ \n-old\n+new")],
  ["marker padding", envelope("*** Update File: a\n@@   \n-old\n+new")],
  ["unknown marker", envelope("*** Update File: a\n*** Bogus")],
  ["empty hunk", envelope("*** Update File: a\n@@")],
  ["empty path", envelope("*** Add File: \n+new")],
  ["heredoc", `<<EOF\n${ordinary}\nEOF`],
  ["quoted heredoc", `<<'EOF'\n${ordinary}\nEOF`],
  ["double quoted heredoc", `<<"EOF"\n${ordinary}\nEOF`],
  ["nonmatching heredoc closer", `<<EOF\n${ordinary}\nNOTEOF`],
  ["BOM envelope", `\uFEFF${ordinary}`],
  ["NEL envelope", `\u0085${ordinary}\u0085`],
  ["blank between sections", envelope("*** Add File: a\n+new\n\n*** Delete File: b")],
  ["context after EOF", envelope("*** Update File: a\n@@\n-old\n+new\n*** End of File\n context")],
];
for (const [name, patch] of cases) {
  test(`Codex parser/application comparison: ${name}`, { skip: process.env.CODEX_DIFFERENTIAL !== "1" }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "patch-parser-oracle-"));
    try {
      const codex = process.env.CODEX_BINARY || "codex";
      await writeFile(join(cwd, "a"), "old\n");
      const expected = spawnSync(codex, ["--codex-run-as-apply-patch", patch], { cwd, encoding: "utf8", timeout: 5000 });
      assert.equal(expected.error, undefined);
      const bytes = await readFile(join(cwd, "a")).catch(() => null);
      await writeFile(join(cwd, "a"), "old\n");
      let success = false;
      let operations;
      try { operations = parsePatch(patch); }
      catch (error: any) {
        assert.equal(error.message, expected.stderr.trim(), "parser error text");
      }
      try { if (operations) success = (await applyPatchOperations(operations, cwd)).failures.length === 0; }
      catch { /* Compare rejection, not exception class. */ }
      assert.equal(success, expected.status === 0, expected.stderr);
      assert.deepEqual(await readFile(join(cwd, "a")).catch(() => null), bytes);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}
