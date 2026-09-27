import test from "node:test";
import assert from "node:assert/strict";
import { Text } from "@earendil-works/pi-tui";
import { styleToolDefinition } from "./tool-styles.ts";
import { ToolExecutionComponent, createBashToolDefinition, createReadToolDefinition, initTheme } from "@earendil-works/pi-coding-agent";
const nativeTheme = await import(new URL("modes/interactive/theme/theme.js",
  import.meta.resolve("@earendil-works/pi-coding-agent")));

const codes = { text: 37, accent: 34, success: 32, error: 31, dim: 90 };
const theme = {
  fg: (color, value) => `\x1b[${codes[color] ?? 39}m${value}\x1b[39m`,
  bold: value => `\x1b[1m${value}\x1b[22m`,
};
const strip = value => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

test("tool titles follow status while paths stay neutral", () => {
  const original = {
    name: "read", parameters: {}, execute() {}, renderShell: "self",
    renderCall(args, colors, ctx) {
      const text = ctx.lastComponent ?? new Text("", 0, 0);
      text.setText(colors.fg("toolTitle", colors.bold("read")) + " " + colors.fg("accent", args.path));
      return text;
    },
  };
  const styled = styleToolDefinition(original);
  assert.equal(styled.execute, original.execute);
  assert.equal(styled.parameters, original.parameters);
  assert.equal(styled.renderShell, original.renderShell);
  assert.equal(styleToolDefinition(styled), styled);
  let previous;
  for (const [context, color] of [
    [{ isPartial: true }, "text"], [{ isPartial: false }, "success"],
    [{ isPartial: false, isError: true }, "error"],
  ]) {
    const component = styled.renderCall({ path: "파일.ts" }, theme, { ...context, lastComponent: previous });
    if (previous) assert.equal(component, previous);
    previous = component;
    const output = component.render(80).join("\n");
    assert.ok(output.includes(theme.fg(color, theme.bold("read"))));
    assert.ok(output.includes(theme.fg("text", "파일.ts")));
    assert.doesNotMatch(strip(output), /[┌┐└┘│]/);
    const baseline = original.renderCall({ path: "파일.ts" }, theme, {});
    for (const width of [1, 4, 20]) {
      assert.deepEqual(component.render(width).map(strip), baseline.render(width).map(strip));
    }
  }
});

test("custom result titles get status colors without losing results, context or empty calls", () => {
  const empty = { render: () => [], invalidate() {} };
  let received;
  const styled = styleToolDefinition({
    name: "patch",
    renderCall: () => empty,
    renderResult(result, options, colors, context) {
      received = { result, options, context };
      return new Text(colors.fg("toolTitle", "patch") + colors.fg("accent", " file.txt"), 0, 0);
    },
  });
  const context = { state: {}, isError: true };
  const result = { content: [] }, options = { isPartial: false, expanded: true };
  assert.equal(styled.renderCall({}, theme, context), empty);
  const output = styled.renderResult(result, options, theme, context).render(80).join("\n");
  assert.ok(output.includes(theme.fg("error", "patch")));
  assert.ok(output.includes(theme.fg("text", " file.txt")));
  assert.deepEqual(received, { result, options, context });
});

test("tools without custom callbacks get a status-aware name without changing native result fallback", () => {
  const definition = styleToolDefinition({ name: "render_svg", execute() {} });
  assert.equal(definition.renderResult, undefined);
  const output = definition.renderCall({}, theme, { isPartial: false }).render(80).join("\n");
  assert.ok(output.includes(theme.fg("success", theme.bold("render_svg"))));
});

test("native bash colors its name, not its command, and retains timing and results", () => {
  initTheme("dark", false);
  const original = createBashToolDefinition(process.cwd());
  const definition = styleToolDefinition(original, { shellCommand: true });
  const context = { state: {}, executionStarted: true, isPartial: true };
  const command = "printf 'hello'";
  let call = definition.renderCall({ command }, theme, context);
  assert.equal(typeof context.state.startedAt, "number");
  assert.ok(call.render(100).join("\n").includes(theme.fg("text", ` $ ${command}`)));
  call = definition.renderCall({ command }, theme, { ...context, lastComponent: call, isPartial: false, isError: true });
  assert.ok(call.render(100).join("\n").includes(theme.fg("error", theme.bold("bash"))));
  const native = new ToolExecutionComponent("bash", "shell", { command },
    { showImages: false }, definition, { requestRender() {} }, process.cwd());
  native.markExecutionStarted();
  native.updateResult({ content: [{ type: "text", text: "expected failure" }], isError: true });
  const output = native.render(100).join("\n");
  assert.ok(output.includes(nativeTheme.theme.fg("error", nativeTheme.theme.bold("bash"))));
  assert.match(strip(output), /expected failure/);
  assert.match(strip(output), /Took/);
});

test("native read colors the completed title while keeping the filename neutral", () => {
  initTheme("dark", false);
  const definition = styleToolDefinition(createReadToolDefinition(process.cwd()));
  const native = new ToolExecutionComponent("read", "read-file", { path: "sample.ts" },
    { showImages: false }, definition, { requestRender() {} }, process.cwd());
  native.markExecutionStarted();
  for (const isError of [false, true]) {
    native.updateResult({ content: [{ type: "text", text: "file contents" }], isError });
    const output = native.render(100).join("\n");
    assert.ok(output.includes(nativeTheme.theme.fg(isError ? "error" : "success", nativeTheme.theme.bold("read"))));
    assert.ok(output.includes(nativeTheme.theme.fg("text", "sample.ts")));
  }
});
