import { Text } from "@earendil-works/pi-tui";
import { uiTone } from "ui-kit/appearance";

const STYLED = Symbol.for("ui-kit.tool-title-styles.v1");

type Definition = {
  name: string;
  renderCall?: (...args: any[]) => any;
  renderResult?: (...args: any[]) => any;
};

function titleColor(context: any) {
  if (context?.isError) return uiTone.error;
  if (context?.isPartial === false) return "success";
  return uiTone.title;
}

function rendererTheme(theme: any, context: any) {
  return new Proxy(theme, {
    get(target, key) {
      if (key === "fg") {
        return (color: string, text: string) => {
          if (color === "toolTitle" || color === "customMessageLabel") color = titleColor(context);
          else if (color === "accent") color = "text";
          return target.fg(color, text);
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Change presentation only: preserve execution, schemas, shell and inner components. */
export function styleToolDefinition<T extends Definition>(
  definition: T,
  options: { shellCommand?: boolean } = {},
): T {
  if ((definition as any)[STYLED]) return definition;
  const originalCall = definition.renderCall;
  const originalResult = definition.renderResult;
  const styled = {
    ...definition,
    renderCall(args: any, theme: any, context: any) {
      const colors = rendererTheme(theme, context);
      const component = originalCall?.(args, colors, context);
      if (options.shellCommand) {
        // Run the native call renderer first: it owns shell timing state.
        const text = component?.setText ? component : new Text("", 0, 0);
        const command = typeof args?.command === "string" ? args.command : "…";
        const timeout = args?.timeout ? theme.fg("dim", ` (timeout ${args.timeout}s)`) : "";
        text.setText(colors.fg("toolTitle", theme.bold(definition.name)) +
          theme.fg("text", ` $ ${command}`) + timeout);
        return text;
      }
      return originalCall ? component :
        new Text(colors.fg("toolTitle", theme.bold(definition.name)), 0, 0);
    },
    ...(originalResult ? {
      renderResult(result: any, renderOptions: any, theme: any, context: any) {
        const status = { ...context, isPartial: renderOptions?.isPartial ?? context?.isPartial };
        return originalResult(result, renderOptions, rendererTheme(theme, status), context);
      },
    } : {}),
  };
  Object.defineProperty(styled, STYLED, { value: true });
  return styled as T;
}
