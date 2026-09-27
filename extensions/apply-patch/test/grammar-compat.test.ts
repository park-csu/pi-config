import assert from "node:assert/strict";
import test from "node:test";
import extension, { APPLY_PATCH_LARK_GRAMMAR } from "../index.js";

const CODEX_RUST_V0_154_0_APPLY_PATCH_LARK_GRAMMAR = `start: begin_patch hunk+ end_patch
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

test("matches the Codex rust-v0.154.0 apply_patch grammar exactly", () => {
  assert.equal(
    APPLY_PATCH_LARK_GRAMMAR,
    CODEX_RUST_V0_154_0_APPLY_PATCH_LARK_GRAMMAR,
  );
});

test("registers the exact grammar on apply_patch", async () => {
  const registered: any[] = [];
  const pi: any = {
    registerTool(tool: any) {
      registered.push(tool);
    },
    on() {},
    getActiveTools() {
      return [];
    },
    setActiveTools() {},
  };

  await extension(pi);

  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, "apply_patch");
  assert.equal(
    registered[0].constrainedSampling.variants.openai_lark,
    CODEX_RUST_V0_154_0_APPLY_PATCH_LARK_GRAMMAR,
  );
});
