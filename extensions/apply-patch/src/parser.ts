export type HunkLine = { kind: "context" | "remove" | "add"; text: string; patchLine: number };
export interface Hunk {
  anchor?: string;
  lines: HunkLine[];
  eof: boolean;
  patchLine: number;
}
export type PatchOperation =
  | { kind: "add"; path: string; lines: string[]; patchLine: number }
  | { kind: "delete"; path: string; patchLine: number }
  | { kind: "update"; path: string; moveTo?: string; hunks: Hunk[]; patchLine: number };

export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchError";
  }
}

const BEGIN_PATCH_MARKER = "*** Begin Patch";
const END_PATCH_MARKER = "*** End Patch";
const ADD_FILE_MARKER = "*** Add File: ";
const DELETE_FILE_MARKER = "*** Delete File: ";
const UPDATE_FILE_MARKER = "*** Update File: ";
const MOVE_TO_MARKER = "*** Move to: ";
const EOF_MARKER = "*** End of File";
const ENVIRONMENT_ID_MARKER = "*** Environment ID:";

interface Header {
  kind: "add" | "update" | "delete";
  path: string;
}

const trim = (text: string) => text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
const trimEnd = (text: string) => text.replace(/\p{White_Space}+$/gu, "");

function operationHeader(line: string, trimLeading: boolean): Header | undefined {
  const candidate = trimLeading ? trim(line) : trimEnd(line);
  for (const [marker, kind] of [
    [ADD_FILE_MARKER, "add"],
    [UPDATE_FILE_MARKER, "update"],
    [DELETE_FILE_MARKER, "delete"],
  ] as const) {
    if (candidate.startsWith(marker)) return { kind, path: candidate.slice(marker.length) };
  }
  return undefined;
}

function movePath(line: string): string | undefined {
  const candidate = trimEnd(line);
  return candidate.startsWith(MOVE_TO_MARKER) ? candidate.slice(MOVE_TO_MARKER.length) : undefined;
}

function validatePath(path: string, line: number): string {
  if (path.includes("\0")) throw new PatchError(`Parse failure at patch line ${line}: file path contains NUL`);
  return path;
}

function isEndPatch(line: string, trimLeading: boolean): boolean {
  const candidate = trimLeading ? trim(line) : trimEnd(line);
  return candidate === END_PATCH_MARKER;
}

function checkPatchBoundaries(lines: string[]): void {
  const first = trim(lines[0] ?? "");
  const last = trim(lines.at(-1) ?? "");
  if (first !== BEGIN_PATCH_MARKER) {
    throw new PatchError("Invalid patch: The first line of the patch must be '*** Begin Patch'");
  }
  if (last !== END_PATCH_MARKER) {
    throw new PatchError("Invalid patch: The last line of the patch must be '*** End Patch'");
  }
}

function patchLines(input: string): string[] {
  const trimmed = trim(input).replace(/\r\n/g, "\n");
  const lines = trimmed === "" ? [] : trimmed.split("\n");
  try {
    checkPatchBoundaries(lines);
    return lines;
  } catch (strictError) {
    const first = lines[0];
    const last = lines.at(-1);
    if (
      (first === "<<EOF" || first === "<<'EOF'" || first === "<<\"EOF\"") &&
      last?.endsWith("EOF") &&
      lines.length >= 4
    ) {
      const inner = lines.slice(1, -1);
      checkPatchBoundaries(inner);
      return inner;
    }
    throw strictError;
  }
}

function invalidHunk(message: string, line: number): PatchError {
  return new PatchError(`Invalid patch hunk on line ${line}: ${message}`);
}

function unexpectedLine(line: string, number: number): PatchError {
  return invalidHunk(`Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`, number);
}

function invalidHeader(line: string, number: number): PatchError {
  return invalidHunk(`'${trim(line)}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`, number);
}

function ensureHunkLines(hunks: Hunk[], line: string, number: number, path: string, header: number): void {
  const hunk = hunks.at(-1);
  if (!hunk) throw invalidHunk(`Update file hunk for path '${path}' is empty`, header);
  if (hunk.lines.length === 0) {
    if (line === END_PATCH_MARKER || line === EOF_MARKER) {
      throw invalidHunk("Update hunk does not contain any lines", number);
    }
    throw unexpectedLine(line, number);
  }
}

function invalidUpdateLine(line: string, patchLine: number, hasHunkLines: boolean): PatchError {
  return hasHunkLines
    ? invalidHunk(`Expected update hunk to start with a @@ context marker, got: '${line}'`, patchLine)
    : unexpectedLine(line, patchLine);
}

export function parsePatch(input: string): PatchOperation[] {
  if (typeof input !== "string") throw new PatchError("Parse failure: input must be a string");
  const lines = patchLines(input);

  const operations: PatchOperation[] = [];
  let i = 1;
  const end = lines.length - 1;
  let sawOperation = false;

  while (i < end) {
    const line = lines[i]!;
    const trimmed = trim(line);
    if (!sawOperation && trimmed.startsWith(ENVIRONMENT_ID_MARKER)) {
      throw new PatchError("Validation failure: Environment ID is unsupported; this tool applies only to the current workspace");
    }

    const header = operationHeader(line, true);
    if (!header) {
      throw invalidHeader(line, i + 1);
    }
    const patchLine = i + 1;
    const { kind, path: rawPath } = header;
    const path = validatePath(rawPath, patchLine);
    sawOperation = true;
    i++;

    if (kind === "delete") {
      if (i < end && !operationHeader(lines[i]!, true) && !isEndPatch(lines[i]!, true)) {
        throw invalidHeader(lines[i]!, i + 1);
      }
      operations.push({ kind, path, patchLine });
      continue;
    }

    if (kind === "add") {
      const body: string[] = [];
      while (i < end && !operationHeader(lines[i]!, true) && !isEndPatch(lines[i]!, true)) {
        const line = lines[i]!;
        if (!line.startsWith("+")) {
          throw invalidHeader(line, i + 1);
        }
        body.push(line.slice(1));
        i++;
      }
      operations.push({ kind, path, lines: body, patchLine });
      continue;
    }

    let moveTo: string | undefined = undefined;
    if (i < end) {
      const move = movePath(lines[i]!);
      if (move !== undefined) {
        moveTo = validatePath(move, i + 1);
        i++;
      }
    }

    const hunks: Hunk[] = [];
    let afterEof = false;
    while (i < end) {
      const line = lines[i]!;
      const updateLine = trimEnd(line);
      const nextHeader = operationHeader(line, false);
      if (isEndPatch(line, false) || nextHeader) {
        ensureHunkLines(hunks, updateLine, i + 1, path, patchLine);
        break;
      }

      if (afterEof && updateLine === "") {
        i++;
        continue;
      }
      if (afterEof && updateLine !== "@@" && !updateLine.startsWith("@@ ")) {
        throw invalidHunk(`Expected update hunk to start with a @@ context marker, got: '${line}'`, i + 1);
      }

      if (hunks.length === 0 && moveTo === undefined) {
        const move = movePath(line);
        if (move !== undefined) {
          moveTo = validatePath(move, i + 1);
          i++;
          continue;
        }
      }

      if (updateLine === "@@" || updateLine.startsWith("@@ ")) {
        if (hunks.length > 0) ensureHunkLines(hunks, line, i + 1, path, patchLine);
        hunks.push({
          anchor: updateLine === "@@" ? undefined : updateLine.slice(3),
          lines: [],
          eof: false,
          patchLine: i + 1,
        });
        afterEof = false;
        i++;
        continue;
      }

      if (updateLine === EOF_MARKER) {
        if (hunks.length === 0) { i++; continue; }
        ensureHunkLines(hunks, updateLine, i + 1, path, patchLine);
        hunks.at(-1)!.eof = true;
        afterEof = true;
        i++;
        continue;
      }

      let hunk = hunks.at(-1);
      if (!hunk) {
        hunk = { lines: [], eof: false, patchLine: i + 1 };
        hunks.push(hunk);
      }
      if (line === "") {
        hunk.lines.push({ kind: "context", text: "", patchLine: i + 1 });
      } else if (line.startsWith(" ")) {
        hunk.lines.push({ kind: "context", text: line.slice(1), patchLine: i + 1 });
      } else if (line.startsWith("+")) {
        hunk.lines.push({ kind: "add", text: line.slice(1), patchLine: i + 1 });
      } else if (line.startsWith("-")) {
        hunk.lines.push({ kind: "remove", text: line.slice(1), patchLine: i + 1 });
      } else {
        throw invalidUpdateLine(line, i + 1, hunk.lines.length > 0);
      }
      i++;
    }
    if (hunks.length === 0) {
      throw invalidHunk(`Update file hunk for path '${path}' is empty`, patchLine);
    }
    ensureHunkLines(hunks, END_PATCH_MARKER, i + 1, path, patchLine);
    operations.push({ kind, path, moveTo, hunks, patchLine });
  }

  return operations;
}

