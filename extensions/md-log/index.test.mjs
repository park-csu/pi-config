import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mdLog, { mirrorContent } from "./index.ts";

const assistant = text => ({ role: "assistant", content: [{ type: "text", text }] });
const entry = message => ({ type: "message", message });

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-md-log-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const events = new Map(), commands = new Map(), notices = [], statuses = [];
  const entries = [entry({ role: "user", content: "private user prompt" }), entry(assistant("First"))];
  let branch = entries;
  const pi = {
    on: (name, handler) => events.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command.handler),
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
  };
  const ctx = {
    cwd, hasUI: true, isIdle: () => true,
    sessionManager: { getEntries: () => entries, getBranch: () => branch, getSessionId: () => "main" },
    ui: { theme: { fg: (_color, text) => text }, notify: (...args) => notices.push(args), setStatus: (...args) => statuses.push(args) },
  };
  mdLog(pi);
  const file = join(cwd, "mirror.md");
  writeFileSync(file, "Existing note — must be overwritten");
  return { cwd, file, pi, ctx, events, commands, entries, notices, statuses, setBranch: value => { branch = value; } };
}

test("only assistant text, not thinking, tools, users, summaries or child completions", () => {
  const rows = [
    entry({ role: "user", content: "user" }),
    entry({ role: "assistant", content: [
      { type: "thinking", thinking: "secret" }, { type: "toolCall", name: "bash" },
      { type: "text", text: "## Answer\n\n```js\n42\n```" },
    ] }),
    entry({ role: "toolResult", content: [{ type: "text", text: "tool output" }] }),
    { type: "custom_message", customType: "subagent-completion", content: "child report" },
    { type: "compaction", summary: "summary" },
  ];
  assert.equal(mirrorContent(rows), "## Answer\n\n```js\n42\n```\n");
});

test("link overwrites, message_end includes not-yet-persisted text exactly once, unlink keeps file", t => {
  const f = fixture(t);
  f.commands.get("md-log")("mirror.md", f.ctx);
  assert.equal(readFileSync(f.file, "utf8"), "First\n");
  assert(!f.events.has("message_update"), "no token streaming");
  const second = assistant("Second");
  f.events.get("message_end")({ message: second }, f.ctx);
  assert.equal(readFileSync(f.file, "utf8"), "First\n\n---\n\nSecond\n");
  f.entries.push(entry(second)); // Actual Pi persistence follows the hook.
  f.events.get("message_end")({ message: assistant("Third") }, f.ctx);
  assert.equal(readFileSync(f.file, "utf8"), "First\n\n---\n\nSecond\n\n---\n\nThird\n");
  f.commands.get("md-unlog")("", f.ctx);
  f.events.get("message_end")({ message: assistant("Not mirrored") }, f.ctx);
  assert(!readFileSync(f.file, "utf8").includes("Not mirrored"));
});

test("active branch, session resume, fork isolation and no read-back", t => {
  const f = fixture(t);
  f.commands.get("md-log")("mirror.md", f.ctx);
  f.setBranch([entry(assistant("Other branch"))]);
  f.events.get("session_tree")({}, f.ctx);
  assert.equal(readFileSync(f.file, "utf8"), "Other branch\n");
  writeFileSync(f.file, "External edits are not prompts");
  mdLog(f.pi); // New extension instance on resume.
  f.events.get("session_start")({ reason: "resume" }, f.ctx);
  assert.equal(readFileSync(f.file, "utf8"), "Other branch\n");
  assert(!JSON.stringify(f.entries).includes("External edits"));
  f.ctx.sessionManager.getSessionId = () => "fork";
  f.events.get("session_start")({ reason: "fork" }, f.ctx);
  f.events.get("message_end")({ message: assistant("Fork answer") }, f.ctx);
  assert.equal(readFileSync(f.file, "utf8"), "Other branch\n");
});

test("reject missing/directory/busy targets and disable on write failure", t => {
  const f = fixture(t);
  for (const path of ["missing.md", "."]) f.commands.get("md-log")(path, f.ctx);
  assert.equal(f.notices.filter(([, level]) => level === "error").length, 2);
  f.ctx.isIdle = () => false;
  f.commands.get("md-log")("mirror.md", f.ctx);
  assert.match(readFileSync(f.file, "utf8"), /Existing note/);
  f.ctx.isIdle = () => true;
  f.commands.get("md-log")("mirror.md", f.ctx);
  rmSync(f.file);
  assert.doesNotThrow(() => f.events.get("message_end")({ message: assistant("Lost") }, f.ctx));
  assert.equal(f.entries.at(-1).data.file, null);
});

test("does not register in subagents", () => {
  const previous = process.env.PI_SUBAGENT_DEPTH;
  process.env.PI_SUBAGENT_DEPTH = "1";
  try {
    mdLog({ on() { assert.fail("worker hook registered"); },
      registerCommand() { assert.fail("worker command registered"); } });
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_DEPTH;
    else process.env.PI_SUBAGENT_DEPTH = previous;
  }
});
