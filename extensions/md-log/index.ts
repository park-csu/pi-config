import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

// File-based mirror inspired by amosblomqvist/learn/extensions/md-log.ts.
// Only assistant prose is mirrored; nothing is read back into model context.
export function assistantText(message: any): string {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content.filter((block: any) => block.type === "text")
    .map((block: any) => block.text).filter((text: string) => text.trim()).join("\n\n");
}

export function mirrorContent(entries: readonly any[], pending?: any): string {
  const messages = entries.filter(entry => entry.type === "message").map(entry => entry.message);
  // Pi emits message_end to extensions BEFORE persisting that message.
  if (pending) messages.push(pending);
  const text = messages.map(assistantText).filter(Boolean).join("\n\n---\n\n");
  return text ? text + (text.endsWith("\n") ? "" : "\n") : "";
}

export default function mdLog(pi: ExtensionAPI) {
  if (Number(process.env.PI_SUBAGENT_DEPTH ?? 0) > 0) return;
  let file: string | undefined;

  function status(ctx: ExtensionContext) {
    if (ctx.hasUI) ctx.ui.setStatus("md-log", file ? ctx.ui.theme.fg("dim", "log ") + ctx.ui.theme.fg("muted", basename(file)) : undefined);
  }

  function write(ctx: ExtensionContext, target: string, pending?: any) {
    // Require an existing regular file, as the reference does. A removed file
    // must be explicitly linked again rather than silently recreated.
    if (!statSync(target).isFile()) throw new Error("Target is not a regular file");
    writeFileSync(target, mirrorContent(ctx.sessionManager.getBranch(), pending), "utf8");
  }

  function refresh(ctx: ExtensionContext, pending?: any) {
    if (!file) return;
    try {
      write(ctx, file, pending);
    } catch (error) {
      ctx.ui.notify(`md-log: ${String(error)}`, "error");
      file = undefined;
      pi.appendEntry("md-log", { file: null, sessionId: ctx.sessionManager.getSessionId() });
      status(ctx);
    }
  }

  pi.on("session_start", (_event, ctx) => {
    file = undefined;
    const sessionId = ctx.sessionManager.getSessionId();
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== "md-log") continue;
      const data = entry.data as { file?: string | null; sessionId?: string } | undefined;
      // Forks/clones must not inherit another session's output destination.
      if (data?.sessionId === sessionId) file = typeof data.file === "string" ? data.file : undefined;
    }
    refresh(ctx);
    status(ctx);
  });

  pi.on("message_end", (event, ctx) => {
    if (assistantText(event.message)) refresh(ctx, event.message);
  });
  pi.on("session_tree", (_event, ctx) => refresh(ctx));

  pi.registerCommand("md-log", {
    description: "Overwrite an existing Markdown file with main-assistant text; mirror finished messages",
    handler: (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /md-log <existing-file.md> — overwrites its contents", "warning");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Wait for the assistant to finish before linking.", "warning");
        return;
      }
      const target = resolve(ctx.cwd, args.trim());
      try {
        write(ctx, target);
      } catch (error) {
        ctx.ui.notify(`md-log: ${String(error)}`, "error");
        return;
      }
      file = target;
      pi.appendEntry("md-log", { file, sessionId: ctx.sessionManager.getSessionId() });
      status(ctx);
      ctx.ui.notify(`Mirroring assistant text to ${file} (contents overwritten)`, "info");
    },
  });

  pi.registerCommand("md-unlog", {
    description: "Stop mirroring assistant text; keep the output file",
    handler: (_args, ctx) => {
      file = undefined;
      pi.appendEntry("md-log", { file: null, sessionId: ctx.sessionManager.getSessionId() });
      status(ctx);
      ctx.ui.notify("Markdown mirroring stopped.", "info");
    },
  });
}
