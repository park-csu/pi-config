import test from "node:test";
import assert from "node:assert/strict";
import { parsePatch } from "../src/parser.js";
import { applyHunks, decodeTextFile, encodeTextFile } from "../src/apply.js";

const patch = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;

test("parses add, update, move, delete, and multiple files", () => {
  const operations = parsePatch(patch(`*** Add File: a.txt\n+hello\n*** Update File: b.txt\n*** Move to: c.txt\n@@ old\n-x\n+y\n*** Delete File: d.txt`));
  assert.deepEqual(operations.map((op) => op.kind), ["add", "update", "delete"]);
  assert.equal(operations[1]!.kind === "update" && operations[1]!.moveTo, "c.txt");
});

test("rejects malformed envelopes and sections", () => {
  assert.throws(() => parsePatch("*** Update File: a\n@@\n-x\n+y"), /first line/);
  assert.deepEqual(parsePatch("*** Begin Patch\n*** End Patch"), []);
  assert.throws(() => parsePatch(patch("*** Add File: a\nno prefix")), /not a valid hunk header/);
  assert.deepEqual(parsePatch(patch("*** Add File: a"))[0], {
    kind: "add", path: "a", lines: [], patchLine: 2,
  });
  assert.throws(() => parsePatch(patch("*** Delete File: a\n+x")), /not a valid hunk header/);
  assert.throws(() => parsePatch(patch("*** Update File: a\n*** Nope")), /Unexpected line/);
});

test("supports exact, whitespace, and unicode fallback matching", () => {
  for (const source of ["alpha\nbeta   \n", "alpha\n  beta  \n", "alpha\n‘beta’\n"]) {
    const expected = source.includes("‘") ? "'beta'" : "beta";
    const operations = parsePatch(patch(`*** Update File: a\n@@\n-${expected}\n+changed`));
    const op = operations[0]!;
    assert.equal(op.kind, "update");
    const result = applyHunks(decodeTextFile(Buffer.from(source), "a"), op.hunks, "a");
    assert.equal(result.lines[1], "changed");
  }
});

test("Codex NormalizeToLf matching uses patch context text", () => {
  const op = parsePatch(patch("*** Update File: a\n@@\n keep\n-old\n+new"))[0]!;
  assert.equal(op.kind, "update");
  const result = applyHunks(decodeTextFile(Buffer.from("  keep  \nold\n"), "a"), op.hunks, "a");
  assert.deepEqual(result.lines, ["keep", "new"]);
});

test("uses forward cursor and EOF anchors", () => {
  const op = parsePatch(patch(`*** Update File: a\n@@\n same\n-one\n+first\n@@\n same\n-two\n+second\n*** End of File`))[0]!;
  assert.equal(op.kind, "update");
  const result = applyHunks(decodeTextFile(Buffer.from("same\none\nsame\ntwo\n"), "a"), op.hunks, "a");
  assert.deepEqual(result.lines, ["same", "first", "same", "second"]);
});

test("appends context-free insertion and reports missing anchor location", () => {
  const ambiguous = parsePatch(patch("*** Update File: a\n@@\n+x"))[0]!;
  assert.equal(ambiguous.kind, "update");
  assert.deepEqual(applyHunks(decodeTextFile(Buffer.from("a\n"), "a"), ambiguous.hunks, "a").lines, ["a", "x"]);
  const bad = parsePatch(patch("*** Update File: a\n@@ anchor\n-nope\n+x"))[0]!;
  assert.equal(bad.kind, "update");
  assert.throws(() => applyHunks(decodeTextFile(Buffer.from("other\n"), "a"), bad.hunks, "a"), /Failed to find context 'anchor' in a/);
});

test("Codex default keeps untouched BOM/CR but writes changed lines with LF", () => {
  const file = decodeTextFile(Buffer.from("\uFEFFa\r\nb\r\n"), "a");
  const op = parsePatch(patch("*** Update File: a\n@@\n-b\n+c"))[0]!;
  assert.equal(op.kind, "update");
  assert.equal(encodeTextFile(applyHunks(file, op.hunks, "a")).toString(), "\uFEFFa\r\nc\n");
});
