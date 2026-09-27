import { createToolRegistrar } from "ui-kit/tools";
import { defineTool, getAgentDir, keyHint, renderDiff, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { parsePatch, PatchError } from "./src/parser.js";
import { verificationError } from "./src/native-errors.js";
import {
  applyPatchOperations,
  type ApplyPatchDetails,
  type ApplyPatchPreview,
  type ApplyPatchPreviewFile,
} from "./src/transaction.js";

const DEFAULT_MODEL_REGEX = "^gpt";
export const PATCH_PREVIEW_MAX_LINES = 16;
export const PATCH_PREVIEW_MAX_CHARS = 4000;
const PATCH_PREVIEW_HEAD_LINES = 8;
const PATCH_PREVIEW_TAIL_LINES = PATCH_PREVIEW_MAX_LINES - PATCH_PREVIEW_HEAD_LINES - 1;
const PATCH_COLLAPSED_MAX_LINES = 10;
const schema = Type.Object({
  input: Type.String({ description: "One V4A patch enclosed by *** Begin Patch and *** End Patch" }),
}, { additionalProperties: false });
export type ApplyPatchInput = Static<typeof schema>;

export const APPLY_PATCH_LARK_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`;

interface ConfigResult { regex: RegExp; warning?: string }
function loadConfig(): ConfigResult {
  const path = join(getAgentDir(), "apply-patch.json");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed?.modelRegex !== "string") throw new Error('"modelRegex" must be a string');
    return { regex: new RegExp(parsed.modelRegex) };
  } catch (error: any) {
    if (error?.code === "ENOENT") return { regex: new RegExp(DEFAULT_MODEL_REGEX) };
    return {
      regex: new RegExp(DEFAULT_MODEL_REGEX),
      warning: `apply-patch: invalid ${path}; using ${JSON.stringify(DEFAULT_MODEL_REGEX)} (${error?.message ?? String(error)})`,
    };
  }
}

function matchesModel(regex: RegExp, model?: { provider: string; id: string }): boolean {
  if (!model) return false;
  for (const value of [`${model.provider}/${model.id}`, model.id]) {
    regex.lastIndex = 0;
    if (regex.test(value)) return true;
  }
  return false;
}

function summary(details: ApplyPatchDetails): string {
  if (!details.failures.length) {
    const modified = details.preview.files
      .filter((file) => file.operation === "update")
      .map((file) => file.moveTo ?? file.path);
    const lines = [
      ...details.created.map((path) => `A ${path}`),
      ...modified.map((path) => `M ${path}`),
      ...details.deleted.map((path) => `D ${path}`),
    ];
    return `Success. Updated the following files:\n${lines.join("\n")}\n`;
  }
  return details.failures.map((failure) => failure.phase === "verification"
    ? verificationError(failure.message) : failure.message).join("\n");
}

function countLines(text: string): number {
  if (!text) return 0;
  return 1 + [...text].filter((character) => character === "\n").length;
}

function truncatePreviewTo(text: string, maxLines: number, maxChars: number): string {
  if (text.length <= maxChars && countLines(text) <= maxLines) return text;
  const lines = text.split("\n");
  const firstChange = lines.findIndex((line) =>
    (line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---")));
  let shown: string[];
  if (firstChange >= 0) {
    const start = Math.max(0, firstChange - 5);
    const end = Math.min(lines.length, start + maxLines - 2);
    shown = [
      ...(start > 0 ? ["…"] : []),
      ...lines.slice(start, end),
      ...(end < lines.length ? ["…"] : []),
    ];
  } else {
    const headLines = Math.max(1, Math.ceil((maxLines - 1) / 2));
    const tailLines = Math.max(0, maxLines - headLines - 1);
    shown = [
      ...lines.slice(0, headLines),
      "…",
      ...lines.slice(-tailLines),
    ];
  }
  const preview = shown.join("\n");
  if (preview.length <= maxChars) return preview;
  return `${preview.slice(0, maxChars - 1).trimEnd()}…`;
}

export function truncatePreview(text: string): string {
  return truncatePreviewTo(text, PATCH_PREVIEW_MAX_LINES, PATCH_PREVIEW_MAX_CHARS);
}

function formatPath(file: ApplyPatchPreviewFile): string {
  return file.moveTo ? `${file.path} → ${file.moveTo}` : file.path;
}

function operationLabel(file: ApplyPatchPreviewFile): string {
  if (file.moveTo) return "Moved";
  if (file.operation === "add") return "Added";
  if (file.operation === "delete") return "Deleted";
  return "Edited";
}

function renderFileHeading(file: ApplyPatchPreviewFile, theme: any): string {
  const title = theme.fg("toolTitle", theme.bold(operationLabel(file)));
  const path = theme.fg("accent", formatPath(file));
  const counts = theme.fg("dim", "(") + theme.fg("toolDiffAdded", `+${file.added}`) +
    " " + theme.fg("toolDiffRemoved", `-${file.removed}`) + theme.fg("dim", ")");
  return `${title} ${path} ${counts}`;
}

function addPreviewLines(container: { addChild(component: Component): void }, diff: string, expanded: boolean, theme: any): void {
  const rawLines = diff.split("\n");
  const renderedLines = renderDiff(diff).split("\n");
  const maxLines = expanded ? renderedLines.length : PATCH_COLLAPSED_MAX_LINES;
  for (let index = 0; index < Math.min(maxLines, renderedLines.length); index++) {
    const prefix = rawLines[index]?.[0];
    const background = prefix === "+"
      ? (text: string) => theme.bg("toolSuccessBg", text)
      : prefix === "-"
        ? (text: string) => theme.bg("toolErrorBg", text)
        : undefined;
    container.addChild(new Text(renderedLines[index]!, 0, 0, background));
  }
  const remaining = renderedLines.length - maxLines;
  if (remaining > 0) {
    container.addChild(new Text(
      `${theme.fg("muted", `... (${remaining} more lines, ${renderedLines.length} total,`)} `
      + `${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
      0,
      0,
    ));
  }
}

function renderFileSection(
  file: ApplyPatchPreviewFile,
  theme: any,
  expanded: boolean,
): Container {
  const section = new Container();
  section.addChild(new Text(renderFileHeading(file, theme), 0, 0));
  if (file.diff) {
    addPreviewLines(section, file.diff, expanded, theme);
  }
  return section;
}

function renderFailureSection(path: string, message: string, theme: any): Container {
  const section = new Container();
  section.addChild(new Text(
    `${theme.fg("toolTitle", theme.bold("apply_patch "))}${theme.fg("accent", path)}`,
    0,
    0,
  ));
  section.addChild(new Spacer(1));
  section.addChild(new Text(theme.fg("error", message), 0, 0));
  return section;
}

function pendingDetails(operations: ReturnType<typeof parsePatch>): ApplyPatchDetails {
  const files: ApplyPatchPreviewFile[] = operations.map((operation) => ({
    operation: operation.kind,
    path: operation.path,
    moveTo: operation.kind === "update" ? operation.moveTo : undefined,
    diff: "",
    added: 0,
    removed: 0,
  }));
  return {
    diff: "",
    created: [],
    updated: [],
    moved: [],
    deleted: [],
    failures: [],
    preview: { files, added: 0, removed: 0 },
    progress: { applied: 0, failed: 0, total: operations.length },
  };
}

export default function piApplyPatch(pi: ExtensionAPI) {
  const registerTool = createToolRegistrar(pi);
  const config = loadConfig();
  let warned = false;
  let removed = new Set<string>();
  let addedApplyPatch = true; // registerTool makes a newly registered tool active.
  const failedResults = new Map<string, ApplyPatchDetails>();

  const applyPatchTool = defineTool({
    name: "apply_patch",
    label: "Apply Patch",
    description: "Apply one V4A patch sequentially. Supports *** Add File, *** Update File, optional *** Move to, and *** Delete File sections. Input must have exactly one *** Begin Patch / *** End Patch envelope. Each resolved source path may appear in only one file section per patch; Delete then Add on the same path is rejected. For multiple edits, use multiple @@ hunks in one Update File section. To replace an entire file, use Add File alone; it overwrites existing files.",
    promptSnippet: "Apply focused V4A file patches",
    promptGuidelines: [
      "Use apply_patch instead of edit or write for file changes when apply_patch is available.",
      "Pass apply_patch exactly one V4A patch envelope with Add, Update, Move to, or Delete sections.",
      "In apply_patch, use only one file section per resolved source path, including relative/absolute aliases. Combine edits into multiple @@ hunks under one Update File; for whole-file replacement, use Add File alone, not Delete followed by Add.",
    ],
    parameters: schema,
    constrainedSampling: {
      type: "grammar",
      variants: { openai_lark: APPLY_PATCH_LARK_GRAMMAR },
    },
    executionMode: "sequential",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
        let operations: ReturnType<typeof parsePatch>;
        try { operations = parsePatch(params.input); }
        catch (error: any) {
          if (String(error?.message).includes("Environment ID is unsupported")) {
            throw new PatchError("apply_patch environment selection is unavailable for this turn");
          }
          throw new PatchError(verificationError(error?.message ?? String(error)));
        }
        const initial = pendingDetails(operations);
        onUpdate?.({
          content: [{ type: "text" as const, text: `Applying patch (0/${operations.length})…` }],
          details: initial,
        });
        const details = await applyPatchOperations(operations, ctx.cwd, signal, (progress) => {
          const completed = (progress.progress?.applied ?? 0) + (progress.progress?.failed ?? 0);
          onUpdate?.({
            content: [{ type: "text" as const, text: `Applying patch (${completed}/${operations.length})…` }],
            details: progress,
          });
        });
        if (details.failures.length) {
          failedResults.set(toolCallId, details);
          throw new PatchError(summary(details));
        }
        return { content: [{ type: "text" as const, text: summary(details) }], details };
      } catch (error: any) {
        if (String(error?.message).startsWith("multiple operations target ")) {
          throw new PatchError(verificationError(error.message));
        }
        if (error instanceof PatchError || error?.name === "AbortError") throw error;
        throw new Error(`Failed to apply patch: ${error?.message ?? String(error)}`);
      }
    },
    renderCall() {
      // The result renderer owns the whole row so each file can have its own
      // apply_patch heading instead of one aggregate call followed by a box.
      return new Container();
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const details = result.details as ApplyPatchDetails | undefined;
      const content = result.content[0];
      const raw = content?.type === "text" ? content.text : "";
      if (!details?.preview || !Array.isArray(details.preview.files)) {
        return new Text(theme.fg("error", raw || "Patch failed"), 0, 0);
      }
      const component = new Container();
      if (details.preview.warning) {
        component.addChild(new Text(theme.fg("warning", details.preview.warning), 0, 0));
        component.addChild(new Spacer(1));
      }
      for (const [index, file] of details.preview.files.entries()) {
        if (index > 0) component.addChild(new Spacer(1));
        component.addChild(renderFileSection(file, theme, expanded));
      }
      for (const [index, failure] of details.failures.entries()) {
        if (details.preview.files.length || index > 0) component.addChild(new Spacer(1));
        component.addChild(renderFailureSection(failure.path, failure.message, theme));
      }
      if (!details.preview.files.length && !details.failures.length) {
        component.addChild(new Text(theme.fg(isPartial ? "warning" : "muted", isPartial ? "apply_patch applying…" : "apply_patch: no content changes"), 0, 0));
      }
      return component;
    },
  });

  registerTool(applyPatchTool);

  // Pi empties details when execute throws. Restore the committed delta through
  // its documented result middleware without converting failure into success.
  pi.on("tool_result", (event) => {
    if (event.toolName !== "apply_patch") return;
    const details = failedResults.get(event.toolCallId);
    if (!details) return;
    failedResults.delete(event.toolCallId);
    return { details, isError: true };
  });
  pi.on("agent_end", () => failedResults.clear());

  // Pi resolves duplicate tool names before exposing definitions. The schema
  // reference identifies whether our registration actually won that resolution.
  const ownsRegisteredTool = () => pi.getAllTools()
    .some((tool) => tool.name === "apply_patch" && tool.parameters === schema);

  const deactivate = () => {
    const active = pi.getActiveTools();
    const ownsTool = ownsRegisteredTool();
    const next = active.filter((name) => !(name === "apply_patch" && addedApplyPatch && ownsTool));
    for (const name of removed) if (!next.includes(name)) next.push(name);
    if (next.join("\0") !== active.join("\0")) pi.setActiveTools(next);
    removed = new Set();
    addedApplyPatch = false;
  };

  const evaluate = (model?: { provider: string; id: string }) => {
    if (!ownsRegisteredTool()) { deactivate(); return; }
    if (!matchesModel(config.regex, model)) { deactivate(); return; }
    const active = pi.getActiveTools();
    const next = active.filter((name) => {
      if (name === "edit" || name === "write") { removed.add(name); return false; }
      return true;
    });
    if (!next.includes("apply_patch")) { next.push("apply_patch"); addedApplyPatch = true; }
    if (next.join("\0") !== active.join("\0")) pi.setActiveTools(next);
  };

  pi.on("session_start", (_event, ctx) => {
    failedResults.clear();
    removed = new Set();
    addedApplyPatch = ownsRegisteredTool() && pi.getActiveTools().includes("apply_patch");
    if (config.warning && !warned && ctx.hasUI) { ctx.ui.notify(config.warning, "warning"); warned = true; }
    evaluate(ctx.model);
  });
  pi.on("model_select", (event) => evaluate(event.model));
  pi.on("session_shutdown", () => {
    failedResults.clear();
    deactivate();
  });
}

export { parsePatch, applyPatchOperations };
