import type { Hunk } from "./parser.js";
import { PatchError } from "./parser.js";

export interface TextFile {
  lines: string[];
  finalNewline: boolean;
  bom: boolean;
  eol: "\n" | "\r\n";
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function decodeTextFile(bytes: Buffer, path: string): TextFile {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new PatchError(`Validation failure: file is not valid UTF-8 and cannot be updated: ${path}`);
  }
  // Codex NormalizeToLf splits on LF, retaining CR and BOM as source text.
  const finalNewline = text.endsWith("\n");
  const lines = text.length === 0 ? [] : text.slice(0, finalNewline ? -1 : undefined).split("\n");
  return { lines, finalNewline, bom: false, eol: "\n" };
}

export function encodeTextFile(file: TextFile): Buffer {
  let text = file.lines.join(file.eol);
  if (file.finalNewline) text += file.eol;
  if (file.bom) text = `\uFEFF${text}`;
  return Buffer.from(text, "utf8");
}

const punctuation = new Map<string, string>([
  ["‘", "'"], ["’", "'"], ["‚", "'"], ["‛", "'"],
  ["“", "\""], ["”", "\""], ["„", "\""], ["‟", "\""],
  ["‐", "-"], ["‑", "-"], ["‒", "-"], ["–", "-"], ["—", "-"], ["―", "-"], ["−", "-"],
  [" ", " "], [" ", " "], [" ", " "], [" ", " "], [" ", " "], [" ", " "],
  [" ", " "], [" ", " "], [" ", " "], [" ", " "], [" ", " "], ["　", " "],
]);

function unicodeNormalize(line: string): string {
  return trimWhitespace([...line].map((char) => punctuation.get(char) ?? char).join(""));
}

// Rust str::trim uses Unicode White_Space; JS trim additionally removes BOM.
const trimWhitespace = (line: string) => line.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
const matchers: Array<(line: string) => string> = [
  (line) => line,
  (line) => line.replace(/\p{White_Space}+$/gu, ""),
  trimWhitespace,
  unicodeNormalize,
];

function equalAt(source: string[], wanted: string[], index: number, normalize: (line: string) => string): boolean {
  return wanted.every((line, offset) => normalize(source[index + offset] ?? "\0") === normalize(line));
}

function findSequence(source: string[], wanted: string[], start: number, eof: boolean): number | undefined {
  if (wanted.length === 0) return start;
  if (wanted.length > source.length) return undefined;
  const last = source.length - wanted.length;
  const searchStart = eof ? last : start;
  for (const normalize of matchers) {
    for (let i = searchStart; i <= last; i++) {
      if (equalAt(source, wanted, i, normalize)) return i;
      if (eof) break;
    }
  }
  return undefined;
}

function findAnchor(source: string[], anchor: string, start: number): number | undefined {
  return findSequence(source, [anchor], start, false);
}

export function applyHunks(file: TextFile, hunks: Hunk[], path: string): TextFile {
  const originalLines = [...file.lines];
  const replacements: Array<{ start: number; oldLength: number; newLines: string[] }> = [];
  let cursor = 0;

  hunks.forEach((hunk) => {
    if (hunk.anchor !== undefined) {
      const anchorIndex = findAnchor(originalLines, hunk.anchor, cursor);
      if (anchorIndex === undefined) {
        throw new PatchError(`Failed to find context '${hunk.anchor}' in ${path}`);
      }
      cursor = anchorIndex + 1;
    }

    const oldLines = hunk.lines.filter((line) => line.kind !== "add").map((line) => line.text);
    const newLines = hunk.lines.filter((line) => line.kind !== "remove").map((line) => line.text);
    if (oldLines.length === 0) {
      const insertionIndex = originalLines.at(-1) === "" ? originalLines.length - 1 : originalLines.length;
      replacements.push({ start: insertionIndex, oldLength: 0, newLines });
      return;
    }

    let pattern = oldLines;
    let replacement = newLines;
    let matchIndex = findSequence(originalLines, pattern, cursor, hunk.eof);
    if (matchIndex === undefined && pattern.at(-1) === "") {
      pattern = pattern.slice(0, -1);
      if (replacement.at(-1) === "") replacement = replacement.slice(0, -1);
      matchIndex = findSequence(originalLines, pattern, cursor, hunk.eof);
    }
    if (matchIndex === undefined) {
      throw new PatchError(`Failed to find expected lines in ${path}:\n${oldLines.join("\n")}`);
    }
    replacements.push({ start: matchIndex, oldLength: pattern.length, newLines: replacement });
    cursor = matchIndex + pattern.length;
  });

  const lines = [...originalLines];
  replacements.sort((a, b) => a.start - b.start);
  for (const replacement of [...replacements].reverse()) {
    lines.splice(replacement.start, replacement.oldLength, ...replacement.newLines);
  }
  return { ...file, lines, finalNewline: lines.length > 0 && lines.at(-1) !== "" };
}

export function addedFile(lines: string[]): TextFile {
  return { lines, finalNewline: lines.length > 0, bom: false, eol: "\n" };
}
