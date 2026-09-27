# Prompt Snippets

Imported from [amosblomqvist/pi-config](https://github.com/amosblomqvist/pi-config/tree/f82da563ab05d66729492d64c7ed4e96db3663f3/extensions/prompt-snippets), commit `f82da563`.
The menu is retained; prompts are customized for the installed `delegate` / `delegate_message` roles.
Local input handling applies selections only to interactive user messages, so extension messages do not consume them.

## Local prompts

| Snippet | When to select |
| --- | --- |
| Contract implementation | Primary agent handles the request; bounded delegation is optional |
| Delegate exploration | Optional local scout or external researcher; reuse an existing implementer when appropriate |
| Independent verification | Primary agent reviews actual changes and checks behavior rather than trusting summaries |
| Diagnose, don't fix | Investigate and propose a fix without editing |
| Verify critical facts | Require observed evidence while continuing authorized work |
| Project orientation | Map relevant code, docs, ADRs, and checks |
| Handle directly | Disable optional delegation for this request; the current session performs the work and verification |

The subagents plugin injects primary-agent duties only into the depth-zero session.
Global `~/.pi/agent/AGENTS.md` contains general engineering guidance, not orchestration.
The primary agent owns the request and can perform all work directly, retaining
responsibility for decisions and final verification. Delegation is optional
assistance, not mandatory routing. If used, implementer handles assigned edits/tests
and may delegate focused discovery to scout or researcher. No job or phase requires
a subagent; there are no file-count or search quotas.
Ordinary implementation does not require selecting a snippet. Workers keep their own role and permissions.
Snippets adjust the current request: `Handle directly` disables delegation, `Diagnose, don't fix` limits work to diagnosis,
and `Independent verification` requests primary-agent verification without edits.
`Contract implementation` emphasizes bounded ownership and independent acceptance.
Avoid combining diagnostic-only and implementation instructions, or direct execution and delegation instructions, for the same request.
The separate harness workflow/ADR and `/implement` prompt remain removed; routing is a short prompt policy, not a new execution engine.
No question popup or mandatory confirmation loop is installed.

These snippets do not switch the session model. Role definitions currently select Luna
xhigh; reviewer remains manual-only. Snippets do not create worktrees, change tool
permissions, or enforce an OS sandbox. The subagents plugin retains the existing
primary-agent-three / worker-one active-child limits. No `ask_question` tool is added.
The selection resets after sending, but the injected text remains in conversation history; explicitly change direction when leaving a diagnostic-only task.
Customize behavior by editing or adding markdown files in `snippets/` rather than growing global AGENTS.md.

## Pi package

This directory is also the `prompt-snippets` Pi package (`0.1.0`). Its
manifest includes `index.ts` and the `snippets/` resources.

Verification: `node --test integration.test.mjs` (uses the installed Pi extension loader, no inference).

Mix-and-match single-purpose prompt rules that are prepended or appended to
your message when you send it. Unlike skills, each snippet is a tiny,
standalone instruction — toggle exactly the ones you want per message.

## Usage

- Press **alt+s** or run **/snippets** to open the toggle menu.
  - `up`/`down` to navigate, `space` to toggle, `enter` to apply, `esc` to cancel.
  - `tab` previews the highlighted snippet (name, placement, order, filename,
    and full body; `up`/`down` scroll long bodies). `tab` or `esc` returns to
    the list with your cursor position preserved.
  - The menu is framed with top/bottom border lines and scrolls when the list
    exceeds the viewport (max height adapts to your terminal), with
    `↑ n more` / `↓ n more` indicators when clipped.
- Active snippets show up as a widget above the editor:
  - `↑ prepend: ...` (accent color) — inserted before your message
  - `↓ append: ...` (warning color) — inserted after your message
- When you send a message, active snippet bodies are merged into the message
  text: prepend group (sorted by `order`) → your text → append group (sorted
  by `order`), separated by blank lines.
- Toggles reset to **all off** after each send and at session start.

## Snippet files

Snippets live in `snippets/` next to `index.ts` — one markdown file each,
with frontmatter:

```markdown
---
name: Concise
description: Keep answers short and to the point
placement: prepend
order: 10
---
Keep your response concise. Skip preamble and unnecessary explanation.
```

| Field | Required | Notes |
|---|---|---|
| `name` | no | Display name; defaults to the filename without `.md` |
| `description` | no | Shown next to the name in the toggle menu |
| `placement` | no | `prepend` or `append` (default: `append`) |
| `order` | no | Number; sorts snippets within their group, in the menu and in the applied text (default: `9999`, ties broken by name) |

Files are re-scanned every time the menu opens and every time a message is
sent, so edits take effect immediately — no `/reload` needed.
