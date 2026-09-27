import test from "node:test";
import assert from "node:assert/strict";
import { ioError, utf8Error } from "../src/native-errors.js";

const bytes = (...values: number[]) => new Uint8Array(values);

test("utf8Error accepts valid UTF-8, including NUL, BOM, and non-BMP text", () => {
  for (const input of [
    bytes(),
    bytes(0x00, 0x41, 0x00),
    bytes(0xef, 0xbb, 0xbf, 0x41),
    bytes(0xc2, 0x80),
    bytes(0xe0, 0xa0, 0x80),
    bytes(0xf0, 0x90, 0x80, 0x80),
    new TextEncoder().encode("prefix 😀 suffix"),
  ]) {
    assert.equal(utf8Error(input), undefined);
  }
});

test("utf8Error reports leading and continuation-byte failures exactly", () => {
  const cases: Array<[number[], string]> = [
    [[0x80], "invalid utf-8 sequence of 1 bytes from index 0"],
    [[0xc0], "invalid utf-8 sequence of 1 bytes from index 0"],
    [[0xf5], "invalid utf-8 sequence of 1 bytes from index 0"],
    [[0xc2, 0x20], "invalid utf-8 sequence of 1 bytes from index 0"],
    [[0xe2, 0x82, 0x20], "invalid utf-8 sequence of 2 bytes from index 0"],
    [[0xf0, 0x90, 0x80, 0x20], "invalid utf-8 sequence of 3 bytes from index 0"],
    [[0x41, 0x80], "invalid utf-8 sequence of 1 bytes from index 1"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(utf8Error(bytes(...input)), expected);
  }
});

test("utf8Error rejects overlong, surrogate, and out-of-range encodings", () => {
  const cases: Array<[number[], string]> = [
    [[0xe0, 0x80, 0x80], "invalid utf-8 sequence of 1 bytes from index 0"],
    [[0xe0, 0x9f, 0x80], "invalid utf-8 sequence of 1 bytes from index 0"],
    [[0xf0, 0x80, 0x80, 0x80], "invalid utf-8 sequence of 1 bytes from index 0"],
    [[0xed, 0xa0, 0x80], "invalid utf-8 sequence of 1 bytes from index 0"],
    [[0xed, 0xbf, 0xbf], "invalid utf-8 sequence of 1 bytes from index 0"],
    [[0xf4, 0x90, 0x80, 0x80], "invalid utf-8 sequence of 1 bytes from index 0"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(utf8Error(bytes(...input)), expected);
  }
});

test("utf8Error reports truncated sequences as incomplete", () => {
  const cases: Array<[number[], string]> = [
    [[0xc2], "incomplete utf-8 byte sequence from index 0"],
    [[0xe2], "incomplete utf-8 byte sequence from index 0"],
    [[0xe2, 0x82], "incomplete utf-8 byte sequence from index 0"],
    [[0xf0, 0x90], "incomplete utf-8 byte sequence from index 0"],
    [[0xf0, 0x90, 0x80], "incomplete utf-8 byte sequence from index 0"],
    [[0x41, 0xf0, 0x90], "incomplete utf-8 byte sequence from index 1"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(utf8Error(bytes(...input)), expected);
  }
});

test("ioError maps the supported Linux errno messages", () => {
  const cases = {
    ENOENT: "No such file or directory (os error 2)",
    EACCES: "Permission denied (os error 13)",
    EPERM: "Operation not permitted (os error 1)",
    EISDIR: "Is a directory (os error 21)",
    ENOTDIR: "Not a directory (os error 20)",
    ELOOP: "Symbolic link loop (os error 40)",
    ENOSPC: "No space left on device (os error 28)",
  };
  for (const [code, expected] of Object.entries(cases)) {
    assert.equal(ioError({ code, message: `Node text for ${code}` }), expected);
  }
});

test("ioError preserves unknown error messages and primitive errors", () => {
  assert.equal(ioError(new Error("original error")), "original error");
  assert.equal(ioError({ code: "EUNKNOWN", message: "original object text" }), "original object text");
  assert.equal(ioError("original string"), "original string");
  assert.equal(ioError(undefined), "undefined");
});
