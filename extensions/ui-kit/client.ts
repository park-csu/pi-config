import {
	UI_PANELS_PROBE_EVENT,
	UI_PANELS_READY_EVENT,
	UI_PANELS_STOPPED_EVENT,
} from "./types.ts";
import type { Panel, PanelEventBus, PanelHost } from "./types.ts";

export interface PanelClient {
	readonly host: PanelHost | undefined;
	upsert(panel: Panel): void;
	remove(id: string): void;
	probe(): void;
	dispose(): void;
}

function isPanelHost(value: unknown): value is PanelHost {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as PanelHost).upsert === "function" &&
		typeof (value as PanelHost).remove === "function"
	);
}

/**
 * Keep a local panel set and attach it to whichever v1 host is active.
 * Repeated ready/probe notifications do not create duplicate entries.
 */
export function createPanelClient(events: PanelEventBus): PanelClient {
	const panels = new Map<string, Panel>();
	let host: PanelHost | undefined;
	let disposed = false;

	const adopt = (nextHost: PanelHost) => {
		if (disposed || !isPanelHost(nextHost) || host === nextHost) return;
		host = nextHost;
		for (const panel of panels.values()) host.upsert(panel);
	};

	const unsubscribeReady = events.on(UI_PANELS_READY_EVENT, (value) => {
		if (isPanelHost(value)) adopt(value);
	});
	const unsubscribeStopped = events.on(UI_PANELS_STOPPED_EVENT, (value) => {
		if (host === value) host = undefined;
	});

	const client: PanelClient = {
		get host() {
			return host;
		},
		upsert(panel) {
			if (disposed) return;
			panels.set(panel.id, panel);
			host?.upsert(panel);
		},
		remove(id) {
			if (disposed) return;
			panels.delete(id);
			host?.remove(id);
		},
		probe() {
			if (disposed) return;
			events.emit(UI_PANELS_PROBE_EVENT, { accept: adopt });
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const panel of panels.values()) host?.remove(panel.id);
			panels.clear();
			host = undefined;
			unsubscribeReady();
			unsubscribeStopped();
		},
	};

	// This also covers a client created after session_start. A client created
	// earlier will attach when the framework emits ready.
	client.probe();
	return client;
}
