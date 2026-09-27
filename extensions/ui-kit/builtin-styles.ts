import {
  SettingsManager,
  createReadToolDefinition, createBashToolDefinition, createEditToolDefinition,
  createWriteToolDefinition, createGrepToolDefinition, createFindToolDefinition,
  createLsToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createToolRegistrar, styleToolDefinition } from "./tools.ts";

function definitions(cwd: string) {
  const settings = SettingsManager.create(cwd);
  return [
    createReadToolDefinition(cwd, { autoResizeImages: settings.getImageAutoResize() }),
    createBashToolDefinition(cwd, {
      commandPrefix: settings.getShellCommandPrefix(),
      shellPath: settings.getShellPath(),
    }),
    createEditToolDefinition(cwd), createWriteToolDefinition(cwd),
    createGrepToolDefinition(cwd), createFindToolDefinition(cwd), createLsToolDefinition(cwd),
  ];
}

/** Public tool overrides only; never replace another extension's or the SDK's tools. */
export function registerBuiltinToolStyles(pi: any, cwd: string, factories = definitions) {
  const builtins = new Set(pi.getAllTools()
    .filter((tool: any) => tool.sourceInfo?.source === "builtin")
    .map((tool: any) => tool.name));
  if (!builtins.size) return;
  const active = pi.getActiveTools();
  const register = createToolRegistrar(pi);
  try {
    for (const definition of factories(cwd)) {
      if (builtins.has(definition.name)) {
        register(styleToolDefinition(definition, { shellCommand: definition.name === "bash" }));
      }
    }
  } finally {
    pi.setActiveTools(active);
  }
}
