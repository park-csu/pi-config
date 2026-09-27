import { createToolRegistrar } from "ui-kit/tools";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, join, mkdirSync, readFileSync, run, writeBody, applyEdit, snippetAround, publish, writeFileSync, cleanup, createQueue, type Session } from "./_common.ts";

export default function (pi: ExtensionAPI) {
  const registerTool = createToolRegistrar(pi);
  let current: Session | undefined;
  const serial = createQueue();
  pi.on("session_shutdown", () => { cleanup(current); current = undefined; });
  registerTool({ name: "write_svg", label: "Write SVG", description: "Write a complete SVG source to the managed session file. Call render_svg to preview it.", parameters: Type.Object({ source: Type.String({ minLength: 1 }) }), async execute(_id, p, signal, _update, _ctx) {
    return serial(async () => {
      signal?.throwIfAborted();
      const source = p.source.trim();
      if (!source.includes("<svg") || !source.includes("</svg>")) throw new Error("`source` must be a complete <svg>...</svg> document.");
      cleanup(current); current = await writeBody("svg", "diagram.svg", source, _ctx.cwd);
      return { content: [{ type: "text", text: "SVG written. Call render_svg to preview it." }], details: { ok: true, path: current.bodyPath } };
    });
  }});
  registerTool({ name: "edit_svg", label: "Edit SVG", description: "Apply one exact-match replacement to the managed SVG source.", parameters: Type.Object({ old_text: Type.String({ minLength: 1 }), new_text: Type.String() }), async execute(_id, p, signal) {
    return serial(async () => {
      signal?.throwIfAborted();
      if (!current || !existsSync(current.bodyPath)) throw new Error("edit_svg: call write_svg first.");
      const source = readFileSync(current.bodyPath, "utf8"), result = applyEdit(source, p.old_text, p.new_text);
      writeFileSync(current.bodyPath, result.updated, "utf8");
      return { content: [{ type: "text", text: `Applied edit:\n${snippetAround(result.updated, result.index)}` }], details: { ok: true, path: current.bodyPath } };
    });
  }});
  registerTool({ name: "render_svg", label: "Render SVG", description: "Render the current SVG to an inline PNG; set save_as to publish into cwd/viz.", parameters: Type.Object({ save_as: Type.Optional(Type.String()) }), async execute(_id, p, signal, _update, ctx) {
    return serial(async () => {
      if (!current || !existsSync(current.bodyPath)) throw new Error("render_svg: call write_svg first.");
      mkdirSync(current.workDir, { recursive: true }); const out = join(current.workDir, `render-${Date.now()}.png`);
      let result = await run("resvg", [current.bodyPath, out], current.workDir, 60_000, signal);
      signal?.throwIfAborted();
      if (result.code !== 0 || !existsSync(out)) result = await run("rsvg-convert", ["-z", "2", current.bodyPath, "-o", out], current.workDir, 60_000, signal);
      signal?.throwIfAborted();
      if (result.code !== 0 || !existsSync(out)) result = await run("magick", ["-density", "192", "-background", "white", current.bodyPath, out], current.workDir, 60_000, signal);
      signal?.throwIfAborted();
      if (result.code !== 0 || !existsSync(out)) throw new Error(`SVG render failed. Install resvg, rsvg-convert, or ImageMagick (magick); no dependency is installed automatically.\n${result.stderr || result.stdout}`);
      const data = readFileSync(out).toString("base64"), content: any[] = [{ type: "image", data, mimeType: "image/png" }];
      if (p.save_as) { const published = publish(out, p.save_as, current.cwd); content.unshift({ type: "text", text: `Published to viz/.\nfilename: ${published.filename}\npath: ${published.path}\nLook at the image to verify it.` }); return { content, details: { ok: true, ...published } }; }
      content.unshift({ type: "text", text: "Preview render (not saved). Look at the image and iterate with edit_svg." }); return { content, details: { ok: true, path: out } };
    });
  }});
}
