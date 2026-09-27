export type FetchFunction = typeof globalThis.fetch;
export type SseDataHandler = (data: string) => void | Promise<void>;

function findFrameDelimiter(text: string): { index: number; length: number } | undefined {
	const candidates = ["\r\n\r\n", "\n\n", "\r\r"];
	let best: { index: number; length: number } | undefined;

	for (const delimiter of candidates) {
		const index = text.indexOf(delimiter);
		if (index >= 0 && (!best || index < best.index)) {
			best = { index, length: delimiter.length };
		}
	}

	return best;
}

/** Return the SSE data field from one complete event frame. */
export function getSseData(frame: string): string | undefined {
	const data: string[] = [];

	for (const line of frame.split(/\r\n|\n|\r/)) {
		if (line.startsWith("data:")) {
			data.push(line.slice("data:".length).replace(/^ /, ""));
		}
	}

	return data.length > 0 ? data.join("\n") : undefined;
}

/** Consume an SSE response body and pass each data field to the caller. */
export async function consumeSseData(body: ReadableStream<Uint8Array>, onData: SseDataHandler): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let pending = "";

	const consumeFrames = async (flush: boolean): Promise<void> => {
		if (flush) {
			pending += decoder.decode();
		}

		while (true) {
			const delimiter = findFrameDelimiter(pending);
			if (!delimiter) break;

			const frame = pending.slice(0, delimiter.index);
			pending = pending.slice(delimiter.index + delimiter.length);
			const data = getSseData(frame);
			if (data !== undefined) {
				await onData(data);
			}
		}
	};

	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			pending += decoder.decode(next.value, { stream: true });
			await consumeFrames(false);
		}

		await consumeFrames(true);
		const data = getSseData(pending);
		if (data !== undefined) {
			await onData(data);
		}
	} finally {
		reader.releaseLock();
	}
}

/**
 * Observe provider SSE data without consuming the body returned to pi-ai.
 *
 * `Response.clone()` tees the body internally, leaving the original response
 * available to the provider's normal Codex parser.
 */
export function captureSseData(
	fetch: FetchFunction,
	onData: SseDataHandler,
): FetchFunction {
	return async (input, init) => {
		const response = await fetch(input, init);
		if (response.body) {
			try {
				const copy = response.clone();
				void consumeSseData(copy.body!, onData).catch(() => undefined);
			} catch {
				// Observability must never change provider request behavior.
			}
		}
		return response;
	};
}
