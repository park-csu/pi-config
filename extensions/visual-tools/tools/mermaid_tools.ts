import { createToolRegistrar } from "ui-kit/tools";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, join, mkdirSync, readFileSync, run, writeBody, applyEdit, snippetAround, publish, writeFileSync, cleanup, createQueue, type Session } from "./_common.ts";

export default function (pi: ExtensionAPI) {
  const registerTool = createToolRegistrar(pi);
  let current: Session | undefined;
  const serial = createQueue();
  pi.on("session_shutdown", () => { cleanup(current); current = undefined; });
  registerTool({ name: "write_mermaid", label: "Write Mermaid", description: "Write complete Mermaid source to the managed session file. Call render_mermaid to preview it.", parameters: Type.Object({ source: Type.String({ minLength: 1 }) }), async execute(_id, p, signal, _update, _ctx) {
    return serial(async () => {
      signal?.throwIfAborted();
      current = await writeBody("mermaid", "diagram.mmd", p.source.trim(), _ctx.cwd);
      return { content: [{ type: "text", text: "Mermaid source written. Call render_mermaid to preview it." }], details: { ok: true, path: current.bodyPath } };
    });
  }});
  registerTool({ name: "edit_mermaid", label: "Edit Mermaid", description: "Apply one exact-match replacement to the managed Mermaid source.", parameters: Type.Object({ old_text: Type.String({ minLength: 1 }), new_text: Type.String() }), async execute(_id, p, signal) {
    return serial(async () => {
      signal?.throwIfAborted();
      if (!current || !existsSync(current.bodyPath)) throw new Error("edit_mermaid: call write_mermaid first.");
      const source = readFileSync(current.bodyPath, "utf8"), result = applyEdit(source, p.old_text, p.new_text);
      writeFileSync(current.bodyPath, result.updated, "utf8");
      return { content: [{ type: "text", text: `Applied edit:\n${snippetAround(result.updated, result.index)}` }], details: { ok: true, path: current.bodyPath } };
    });
  }});
  registerTool({ name: "render_mermaid", label: "Render Mermaid", description: "Render current Mermaid source to an inline PNG; set save_as to publish into cwd/viz. Requires the installed Mermaid CLI (mmdc) and a browser.", parameters: Type.Object({ save_as: Type.Optional(Type.String()) }), async execute(_id, p, signal) {
    return serial(async () => {
      if (!current || !existsSync(current.bodyPath)) throw new Error("render_mermaid: call write_mermaid first.");
      mkdirSync(current.workDir, { recursive: true }); const out = join(current.workDir, `render-${Date.now()}.png`);
      const result = await run("mmdc", ["-i", current.bodyPath, "-o", out, "-s", "2", "-b", "white"], current.workDir, 120_000, signal);
      signal?.throwIfAborted();
      if (result.code !== 0 || !existsSync(out)) throw new Error(`Mermaid render failed. Install Mermaid CLI (mmdc) and a supported browser; no heavy dependency is installed automatically.\n${result.stderr || result.stdout}`);
      const data = readFileSync(out).toString("base64"), content: any[] = [{ type: "image", data, mimeType: "image/png" }];
      if (p.save_as) { const published = publish(out, p.save_as, current.cwd); content.unshift({ type: "text", text: `Published to viz/.\nfilename: ${published.filename}\npath: ${published.path}\nLook at the image to verify it.` }); return { content, details: { ok: true, ...published } }; }
      content.unshift({ type: "text", text: "Preview render (not saved). Look at the image and iterate with edit_mermaid." }); return { content, details: { ok: true, path: out } };
    });
  }});
}
