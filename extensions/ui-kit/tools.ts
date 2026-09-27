import type { PanelEventBus } from "./types.ts";
import { styleToolDefinition } from "ui-kit/tool-styles";

export { styleToolDefinition } from "ui-kit/tool-styles";

export interface ToolRenderer {
  renderCall?: (...args: any[]) => any;
  renderResult?: (...args: any[]) => any;
  renderShell?: "default" | "self";
}
interface ToolHost {
  registerTool: (definition: any) => void;
  events?: PanelEventBus;
  on(event: "session_start" | "session_shutdown", handler: () => void): unknown;
}
const TOOL_RENDERERS_PROBE = "ui-kit:tools:v1:probe";
const providers = new WeakMap<object, Map<string, ToolRenderer>>();

/** Style tool titles and share only display callbacks on the local event bus. */
export function createToolRegistrar<T extends ToolHost>(pi: T): T["registerTool"] {
  // Preserve the caller's generic schema/context types, including across Pi versions.
  return ((definition: { name: string } & ToolRenderer) => {
    const styled = styleToolDefinition(definition);
    pi.registerTool(styled);
    // Minimal/headless hosts may not provide an event bus.
    const events = pi.events;
    if (!events?.on) return;
    let renderers = providers.get(pi);
    if (!renderers) {
      renderers = new Map();
      providers.set(pi, renderers);
      const owned = renderers;
      let unsubscribe: (() => void) | undefined;
      const subscribe = () => {
        if (unsubscribe) return;
        unsubscribe = events.on(TOOL_RENDERERS_PROBE, payload => {
          const probe = payload as { accept?: (name: string, renderer: ToolRenderer) => void } | null;
          if (typeof probe?.accept === "function") {
            for (const [name, renderer] of owned) probe.accept(name, renderer);
          }
        });
      };
      subscribe();
      pi.on("session_start", subscribe);
      pi.on("session_shutdown", () => { unsubscribe?.(); unsubscribe = undefined; });
    }
    renderers.set(definition.name, Object.freeze({
      renderCall: styled.renderCall,
      renderResult: styled.renderResult,
      renderShell: styled.renderShell,
    }) as ToolRenderer);
  }) as T["registerTool"];
}

/** Resolve live providers on demand; works regardless of extension load order. */
export function getToolRenderers(events: PanelEventBus): Map<string, ToolRenderer> {
  const renderers = new Map<string, ToolRenderer>();
  events.emit(TOOL_RENDERERS_PROBE, {
    accept(name: string, renderer: ToolRenderer) {
      if (typeof name === "string" && renderer) renderers.set(name, renderer);
    },
  });
  return renderers;
}
