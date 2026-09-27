import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { statusOnlyApi } from "../status-ui.js";

test("quota reports render as entries, never as model messages", () => {
	const session = SessionManager.inMemory();
	const hooks = new Map<string, Function>();
	const entryRenderers = new Map<string, Function>();
	const messageRenderers = new Map<string, Function>();
	const sent: unknown[] = [];
	const pi = statusOnlyApi({
		on: (name: string, handler: Function) => hooks.set(name, handler),
		appendEntry: (type: string, data: unknown) => session.appendCustomEntry(type, data),
		sendMessage: (...args: unknown[]) => sent.push(args),
		registerMessageRenderer: (type: string, renderer: Function) => messageRenderers.set(type, renderer),
		registerEntryRenderer: (type: string, renderer: Function) => entryRenderers.set(type, renderer),
	} as unknown as ExtensionAPI);
	const renderer = (message: any) => ({ render: () => [message.content], invalidate() {} });
	pi.registerMessageRenderer("codex-status", renderer);
	for (const kind of ["status", "json", "raw", "statusline"]) {
		pi.sendMessage({
			customType: "codex-status", content: `quota ${kind}`, display: true, details: { kind },
		});
	}
	assert.equal(sent.length, 0);
	assert.equal(session.getEntries().length, 4);
	assert.deepEqual(session.buildSessionContext().messages, []);
	assert.equal(messageRenderers.get("codex-status"), renderer);
	const entry = session.getEntries()[0];
	const rendered = entryRenderers.get("codex-status")!(entry, {}, {});
	assert.deepEqual(rendered.render(80), ["quota status"]);

	const user = { role: "user", content: "Keep this", timestamp: 1 };
	const other = { role: "custom", customType: "other", content: "Keep this too", timestamp: 2 };
	const old = { role: "custom", customType: "codex-status", content: "old quota", timestamp: 3 };
	const messages = [user, old, other];
	assert.deepEqual(hooks.get("context")!({ messages }).messages, [user, other]);
	assert.equal(messages.length, 3, "history must not be mutated");
	const unrelated = { customType: "other", content: "normal message", display: true };
	pi.sendMessage(unrelated, { triggerTurn: true });
	assert.deepEqual(sent, [[unrelated, { triggerTurn: true }]]);
});
