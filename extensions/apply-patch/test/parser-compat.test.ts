import test from "node:test";
import assert from "node:assert/strict";
import { parsePatch, PatchError } from "../src/parser.js";

test("matches Codex envelope whitespace, empty patches, and heredocs", () => {
  assert.deepEqual(parsePatch(" \n*** Begin Patch \n*** End Patch\n\t"), []);

  const heredoc = "<<'EOF'\n*** Begin Patch\n*** Add File: @/new/../file\n+content\n*** End Patch\nEOF\n";
  const operations = parsePatch(heredoc);
  assert.equal(operations.length, 1);
  assert.deepEqual(operations[0], {
    kind: "add",
    path: "@/new/../file",
    lines: ["content"],
    patchLine: 2,
  });

  assert.deepEqual(parsePatch("*** Begin Patch\n*** Add File: empty\n*** End Patch"),
    [{ kind: "add", path: "empty", lines: [], patchLine: 2 }]);
  assert.throws(
    () => parsePatch("*** Begin Patch\n*** Environment ID: remote\n*** Add File: empty\n*** End Patch"),
    /Environment ID is unsupported/,
  );
});

test("preserves Codex paths and accepts control-marker whitespace", () => {
  const operations = parsePatch(
    "*** Begin Patch\n"
      + "  *** Add File: ./a/../b  \n"
      + "+one\n"
      + " *** Update File: @file  \n"
      + "*** Move to: moved  \n"
      + "@@ anchor   \n"
      + "-old\n"
      + "+new\n"
      + "*** Delete File: .\n"
      + "*** End Patch",
  );

  assert.deepEqual(
    operations.map((operation) => [operation.kind, operation.path]),
    [["add", "./a/../b"], ["update", "@file"], ["delete", "."]],
  );
  assert.equal(operations[1]!.kind === "update" && operations[1]!.moveTo, "moved");
  assert.equal(operations[1]!.kind === "update" && operations[1]!.hunks[0]!.anchor, "anchor");
});

test("accepts implicit hunks, bare empty context lines, and EOF padding", () => {
  const operations = parsePatch(
    "*** Begin Patch\n"
      + "*** Update File: file.txt\n"
      + " before\n"
      + "\n"
      + "+after\n"
      + "*** End of File\n"
      + " \t\n"
      + "*** End Patch",
  );

  assert.equal(operations.length, 1);
  assert.equal(operations[0]!.kind, "update");
  if (operations[0]!.kind !== "update") return;
  assert.deepEqual(
    operations[0]!.hunks[0]!.lines.map(({ kind, text }) => [kind, text]),
    [["context", "before"], ["context", ""], ["add", "after"]],
  );
  assert.equal(operations[0]!.hunks[0]!.eof, true);
});

test("rejects incomplete Codex update chunks", () => {
  assert.throws(
    () => parsePatch("*** Begin Patch\n*** Update File: file.txt\n@@\n*** End Patch"),
    (error: unknown) => error instanceof PatchError && /does not contain any lines/.test(error.message),
  );
  assert.throws(
    () => parsePatch("*** Begin Patch\n*** Update File: file.txt\n+line\nbad\n*** End Patch"),
    (error: unknown) => error instanceof PatchError && /Expected update hunk/.test(error.message),
  );
});
