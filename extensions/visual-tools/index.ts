import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import mermaidTools from "./tools/mermaid_tools.ts";
import svgTools from "./tools/svg_tools.ts";

/** SVG/Mermaid authoring tools for the local subagent loader. */
export default function (pi: ExtensionAPI) {
  mermaidTools(pi);
  svgTools(pi);
}
