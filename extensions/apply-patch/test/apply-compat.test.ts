import test from "node:test";
import assert from "node:assert/strict";
import { applyHunks, type TextFile } from "../src/apply.js";
import type { Hunk } from "../src/parser.js";

const source = (lines: string[]): TextFile => ({
  lines,
  finalNewline: true,
  bom: false,
  eol: "\n",
});

const line = (kind: "context" | "remove" | "add", text: string, patchLine = 1) => ({
  kind,
  text,
  patchLine,
});

const update = (lines: Hunk["lines"], options: Partial<Pick<Hunk, "anchor" | "eof">> = {}): Hunk => ({
  anchor: options.anchor,
  eof: options.eof ?? false,
  lines,
  patchLine: 1,
});

test("inserts at EOF whether or not the hunk has an anchor", () => {
  const unanchored = applyHunks(source(["a", "b"]), [
    update([line("add", "unanchored")]),
  ], "a");
  assert.deepEqual(unanchored.lines, ["a", "b", "unanchored"]);

  const anchored = applyHunks(source(["a", "b"]), [
    update([line("add", "anchored")], { anchor: "a" }),
  ], "a");
  assert.deepEqual(anchored.lines, ["a", "b", "anchored"]);

  assert.throws(() => applyHunks(source(["a", "b"]), [
    update([line("add", "never")], { anchor: "missing" }),
  ], "a"), /Failed to find context/);
});

test("retries a failed match after removing a trailing empty context line", () => {
  const result = applyHunks(source(["a", "b"]), [
    update([
      line("remove", "a"),
      line("add", "replacement"),
      line("context", ""),
    ]),
  ], "a");

  assert.deepEqual(result.lines, ["replacement", "b"]);
});

test("computes all replacements against the original lines and applies them in reverse", () => {
  const result = applyHunks(source(["a", "b", "c", "d"]), [
    update([
      line("remove", "b"),
      line("add", "B"),
      line("add", "B again"),
    ]),
    update([
      line("remove", "c"),
      line("add", "C"),
    ]),
  ], "a");

  assert.deepEqual(result.lines, ["a", "B", "B again", "C", "d"]);
});

test("uses patch context text in the replacement after fuzzy matching", () => {
  const result = applyHunks(source(["  keep  ", "old"]), [
    update([
      line("context", "keep"),
      line("remove", "old"),
      line("add", "new"),
    ]),
  ], "a");

  assert.deepEqual(result.lines, ["keep", "new"]);
});

test("sorts EOF insertions and earlier replacements before applying in reverse", () => {
  const result = applyHunks(source(["a", "b"]), [
    update([line("add", "tail")]),
    update([line("remove", "a"), line("add", "A"), line("add", "extra")]),
  ], "a");
  assert.deepEqual(result.lines, ["A", "extra", "b", "tail"]);
});

test("matches Unicode whitespace and punctuation with native fallback passes", () => {
  const result = applyHunks(source(["\u00a0“keep”\u2009", "old"]), [
    update([
      line("context", "\"keep\""),
      line("remove", "old"),
      line("add", "new"),
    ]),
  ], "a");

  assert.deepEqual(result.lines, ["\"keep\"", "new"]);
});
