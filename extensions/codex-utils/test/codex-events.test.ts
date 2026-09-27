import assert from "node:assert/strict";
import test from "node:test";
import { captureSseData, getSseData } from "../codex-events.js";

test("SSE data fields support multiline payloads and comments", () => {
	assert.equal(
		getSseData(": keepalive\nevent: codex.rate_limits\ndata: {\"type\":\"codex.rate_limits\",\ndata: \"rate_limits\":{}}\n"),
		'{"type":"codex.rate_limits",\n"rate_limits":{}}',
	);
});

test("SSE data ignores non-data fields", () => {
	assert.equal(getSseData("event: response.completed\nid: 1\n"), undefined);
});

test("SSE capture leaves the provider response readable", async () => {
	let resolveObserved!: () => void;
	const observed = new Promise<void>((resolve) => {
		resolveObserved = resolve;
	});
	const wrappedFetch = captureSseData(
		async () =>
			new Response('event: codex.rate_limits\n\ndata: {"type":"codex.rate_limits"}\n\n'),
		(data) => {
			assert.equal(data, '{"type":"codex.rate_limits"}');
			resolveObserved();
		},
	);

	const response = await wrappedFetch("https://example.test");
	assert.match(await response.text(), /codex\.rate_limits/);
	await observed;
});
