import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  generateDiffString,
  generateUnifiedPatch,
  truncateHead,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { addedFile, applyHunks, decodeTextFile, encodeTextFile } from "./apply.js";
import type { PatchOperation } from "./parser.js";
import { PatchError } from "./parser.js";
import { ioError, utf8Error } from "./native-errors.js";

interface Snapshot { exists: boolean; bytes?: Buffer; mode?: number }

export interface ApplyPatchFailure {
  path: string;
  operation: PatchOperation["kind"];
  message: string;
  phase?: "verification" | "application";
}

export interface ApplyPatchPreviewFile {
  path: string;
  moveTo?: string;
  operation: PatchOperation["kind"];
  diff: string;
  added: number;
  removed: number;
}

export interface ApplyPatchPreview {
  files: ApplyPatchPreviewFile[];
  added: number;
  removed: number;
  warning?: string;
}

export interface ApplyPatchProgress {
  applied: number;
  failed: number;
  total: number;
}

export interface ApplyPatchDetails {
  diff: string;
  diffTruncation?: {
    truncatedBy: "lines" | "bytes" | null;
    totalLines: number;
    totalBytes: number;
    outputLines: number;
    outputBytes: number;
    maxLines: number;
    maxBytes: number;
  };
  fullDiffPath?: string;
  created: string[];
  updated: string[];
  moved: Array<{ from: string; to: string }>;
  deleted: string[];
  failures: ApplyPatchFailure[];
  preview: ApplyPatchPreview;
  progress?: ApplyPatchProgress;
}

export type ApplyPatchProgressCallback = (details: ApplyPatchDetails) => Promise<void> | void;

async function snapshot(path: string): Promise<Snapshot> {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new PatchError(`Validation failure: path is not a regular file: ${path}`);
    return { exists: true, bytes: await readFile(path), mode: info.mode & 0o7777 };
  } catch (error: any) {
    if (error?.code === "ENOENT") return { exists: false };
    throw error;
  }
}

async function previewSnapshot(path: string): Promise<Snapshot> {
  // Like Codex's optional delta read, missing preview bytes must not deny writes.
  try { return await snapshot(path); }
  catch { return { exists: false }; }
}

async function readSource(path: string, operation: "update" | "delete"): Promise<Snapshot> {
  const context = operation === "update" ? `Failed to read file to update ${path}` : `Failed to read ${path}`;
  try {
    const info = await stat(path);
    if (!info.isFile()) throw Object.assign(new Error(), { code: "EISDIR" });
    const bytes = await readFile(path);
    const invalid = utf8Error(bytes);
    if (invalid) throw new PatchError(`${context}: ${invalid}`);
    return { exists: true, bytes, mode: info.mode & 0o7777 };
  } catch (error) {
    if (error instanceof PatchError) throw error;
    throw new PatchError(`${context}: ${ioError(error)}`);
  }
}

function absolute(cwd: string, path: string): string {
  return resolve(cwd, path);
}

async function withQueues<T>(paths: string[], fn: () => Promise<T>, index = 0): Promise<T> {
  if (index === paths.length) return fn();
  return withFileMutationQueue(paths[index]!, () => withQueues(paths, fn, index + 1));
}

async function canonicalQueuePaths(paths: string[]): Promise<string[]> {
  const canonical: string[] = [];
  for (const path of paths) {
    try {
      canonical.push(await realpath(path));
    } catch (error: any) {
      // Canonicalization coordinates writes; it is not a filesystem preflight.
      // Let the actual read/write produce the native operation-specific error.
      canonical.push(resolve(path));
    }
  }
  return [...new Set(canonical)].sort();
}

async function writeNative(path: string, bytes: Buffer, createParents: boolean, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  try {
    await writeFile(path, bytes);
  } catch (error: any) {
    if (!createParents || error?.code !== "ENOENT") throw new PatchError(`Failed to write file ${path}`);
    try { await mkdir(dirname(path), { recursive: true }); }
    catch { throw new PatchError(`Failed to create parent directories for ${path}`); }
    signal?.throwIfAborted();
    try { await writeFile(path, bytes); }
    catch { throw new PatchError(`Failed to write file ${path}`); }
  }
}

function textForDiff(bytes: Buffer | undefined, path: string): string {
  if (!bytes) return "";
  const file = decodeTextFile(bytes, path);
  return file.lines.join("\n") + (file.finalNewline ? "\n" : "");
}

const INCOMPARABLE_UTF8_WARNING =
  "Original file is not valid UTF-8; replacement is shown as new text because it cannot be compared.";

function comparableBytes(bytes: Buffer | undefined, path: string): { bytes?: Buffer; warning?: string } {
  if (!bytes) return {};
  try {
    decodeTextFile(bytes, path);
    return { bytes };
  } catch (error) {
    if (error instanceof PatchError) return { warning: INCOMPARABLE_UTF8_WARNING };
    throw error;
  }
}

function makeDiff(path: string, before: Buffer | undefined, after: Buffer | undefined): string {
  try {
    return generateUnifiedPatch(path, textForDiff(before, path), textForDiff(after, path), 3);
  } catch (error) {
    if (error instanceof PatchError) return "";
    throw error;
  }
}

function makeDisplayDiff(path: string, before: Buffer | undefined, after: Buffer | undefined): string {
  try {
    return generateDiffString(textForDiff(before, path), textForDiff(after, path)).diff;
  } catch (error) {
    if (error instanceof PatchError) return "";
    throw error;
  }
}

function previewFile(
  operation: PatchOperation["kind"],
  path: string,
  diff: string,
  moveTo?: string,
): ApplyPatchPreviewFile {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { operation, path, moveTo, diff, added, removed };
}

function emptyDetails(): ApplyPatchDetails {
  return {
    diff: "",
    created: [],
    updated: [],
    moved: [],
    deleted: [],
    failures: [],
    preview: { files: [], added: 0, removed: 0 },
  };
}

async function applyOne(operation: PatchOperation, cwd: string, signal?: AbortSignal): Promise<ApplyPatchDetails> {
  const source = absolute(cwd, operation.path);
  const destination = operation.kind === "update" && operation.moveTo ? absolute(cwd, operation.moveTo) : undefined;
  const paths = await canonicalQueuePaths(destination ? [source, destination] : [source]);

  return withQueues(paths, async () => {
    signal?.throwIfAborted();
    const before = await (operation.kind === "add" ? previewSnapshot(source) : readSource(source, operation.kind));
    const displaySource = operation.path;

    if (operation.kind === "add") {
      const after = encodeTextFile(addedFile(operation.lines));
      await writeNative(source, after, true, signal);
      const comparison = comparableBytes(before.exists ? before.bytes : undefined, operation.path);
      const details: ApplyPatchDetails = {
        ...emptyDetails(),
        diff: makeDiff(displaySource, comparison.bytes, after),
        created: [displaySource],
        preview: {
          files: [previewFile("add", displaySource, makeDisplayDiff(displaySource, comparison.bytes, after))],
          added: 0,
          removed: 0,
        },
      };
      if (comparison.warning) details.preview.warning = comparison.warning;
      return details;
    }

    if (!before.exists) throw new PatchError(`File not found (cannot ${operation.kind}_file): ${operation.path}`);

    if (operation.kind === "delete") {
      signal?.throwIfAborted();
      try { await rm(source); }
      catch { throw new PatchError(`Failed to delete file ${source}`); }
      const diff = makeDiff(displaySource, before.bytes, undefined);
      return {
        ...emptyDetails(),
        diff,
        deleted: [displaySource],
        preview: {
          files: [previewFile("delete", displaySource, makeDisplayDiff(displaySource, before.bytes, undefined))],
          added: 0,
          removed: 0,
        },
      };
    }

    const after = encodeTextFile(applyHunks(decodeTextFile(before.bytes!, operation.path), operation.hunks, source));
    if (!destination) {
      await writeNative(source, after, false, signal);
      const diff = makeDiff(displaySource, before.bytes, after);
      return {
        ...emptyDetails(),
        diff,
        updated: [displaySource],
        preview: {
          files: [previewFile("update", displaySource, makeDisplayDiff(displaySource, before.bytes, after))],
          added: 0,
          removed: 0,
        },
      };
    }

    const destinationBefore = await previewSnapshot(destination);
    const destinationComparison = comparableBytes(
      destinationBefore.exists ? destinationBefore.bytes : undefined,
      operation.moveTo!,
    );
    await writeNative(destination, after, true, signal);
    // Codex keeps the committed destination even if removing the source fails.
    try {
      await rm(source);
    } catch (error: any) {
      const displayDestination = operation.moveTo!;
      const details: ApplyPatchDetails = {
        ...emptyDetails(),
        created: [displayDestination],
        diff: makeDiff(displayDestination, destinationComparison.bytes, after),
        failures: [{ path: operation.path, operation: "update",
          message: `Failed to remove original ${source}`, phase: "application" }],
        preview: { files: [previewFile("add", displayDestination,
          makeDisplayDiff(displayDestination, destinationComparison.bytes, after))], added: 0, removed: 0 },
      };
      if (destinationComparison.warning) details.preview.warning = destinationComparison.warning;
      return details;
    }
    const displayDestination = operation.moveTo!;
    const diff = [
      makeDiff(displaySource, before.bytes, undefined),
      makeDiff(displayDestination, destinationComparison.bytes, after),
    ].filter(Boolean).join("\n");
    const previewDiff = makeDisplayDiff(
      displayDestination,
      destinationComparison.warning ? undefined : before.bytes,
      after,
    );
    const details: ApplyPatchDetails = {
      ...emptyDetails(),
      diff,
      moved: [{ from: operation.path, to: operation.moveTo! }],
      preview: {
        files: [previewFile("update", displaySource, previewDiff, displayDestination)],
        added: 0,
        removed: 0,
      },
    };
    if (destinationComparison.warning) details.preview.warning = destinationComparison.warning;
    return details;
  });
}

async function verifyUpdate(operation: Extract<PatchOperation, { kind: "update" }>, cwd: string, signal?: AbortSignal): Promise<void> {
  const source = absolute(cwd, operation.path);
  const paths = await canonicalQueuePaths([source]);

  await withQueues(paths, async () => {
    signal?.throwIfAborted();
    const before = await readSource(source, "update");

    encodeTextFile(applyHunks(decodeTextFile(before.bytes!, operation.path), operation.hunks, source));
  }).catch((error: unknown) => {
    if (error instanceof PatchError || (error as Error)?.name === "AbortError") throw error;
    throw new PatchError(`Failed to read file to update ${source}: ${ioError(error)}`);
  });
}

function updatePreviewTotals(preview: ApplyPatchPreview): void {
  preview.added = preview.files.reduce((sum, file) => sum + file.added, 0);
  preview.removed = preview.files.reduce((sum, file) => sum + file.removed, 0);
}

async function notifyProgress(callback: ApplyPatchProgressCallback | undefined, details: ApplyPatchDetails): Promise<void> {
  if (!callback) return;
  try {
    await callback(details);
  } catch {
    // Rendering progress must not affect patch application.
  }
}

export async function applyPatchOperations(
  operations: PatchOperation[],
  cwd: string,
  signal?: AbortSignal,
  onProgress?: ApplyPatchProgressCallback,
): Promise<ApplyPatchDetails> {
  if (operations.length === 0) throw new PatchError("No files were modified.");
  const targets = new Set<string>();
  for (const operation of operations) {
    const path = absolute(cwd, operation.path);
    if (targets.has(path)) throw new PatchError(`multiple operations target ${path}`);
    targets.add(path);
  }

  const result = emptyDetails();
  const diffs: string[] = [];
  let appliedCount = 0;

  let preflightFailed = false;
  for (const operation of operations) {
    if (operation.kind === "add") continue;
    try {
      if (operation.kind === "update") await verifyUpdate(operation, cwd, signal);
      else {
        signal?.throwIfAborted();
        await readSource(absolute(cwd, operation.path), "delete");
      }
    } catch (error: any) {
      result.failures.push({
        path: operation.path,
        operation: operation.kind,
        message: error?.message ?? String(error),
        phase: "verification",
      });
      preflightFailed = true;
      result.progress = {
        applied: 0,
        failed: result.failures.length,
        total: operations.length,
      };
      await notifyProgress(onProgress, result);
      break;
    }
  }

  if (!preflightFailed) for (const operation of operations) {
    let failed = false;
    try {
      const applied = await applyOne(operation, cwd, signal);
      result.created.push(...applied.created);
      result.updated.push(...applied.updated);
      result.moved.push(...applied.moved);
      result.deleted.push(...applied.deleted);
      result.failures.push(...applied.failures);
      failed = applied.failures.length > 0;
      result.preview.files.push(...applied.preview.files);
      if (applied.preview.warning && !result.preview.warning) result.preview.warning = applied.preview.warning;
      updatePreviewTotals(result.preview);
      if (applied.diff) diffs.push(applied.diff);
    } catch (error: any) {
      result.failures.push({
        path: operation.path,
        operation: operation.kind,
        message: error?.message ?? String(error),
        phase: "application",
      });
      failed = true;
    }
    if (!failed) appliedCount++;
    result.progress = {
      applied: appliedCount,
      failed: result.failures.length,
      total: operations.length,
    };
    await notifyProgress(onProgress, result);
    if (failed) break;
  }

  const fullDiff = diffs.join("\n");
  const truncation = truncateHead(fullDiff, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  result.diff = truncation.content;
  if (truncation.truncated) {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-apply-patch-"));
    result.fullDiffPath = join(tempDir, "full.diff");
    await writeFile(result.fullDiffPath, fullDiff, "utf8");
    result.diffTruncation = {
      truncatedBy: truncation.truncatedBy,
      totalLines: truncation.totalLines,
      totalBytes: truncation.totalBytes,
      outputLines: truncation.outputLines,
      outputBytes: truncation.outputBytes,
      maxLines: truncation.maxLines,
      maxBytes: truncation.maxBytes,
    };
    result.diff += `\n[Diff truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full diff: ${result.fullDiffPath}]`;
  }
  return result;
}
