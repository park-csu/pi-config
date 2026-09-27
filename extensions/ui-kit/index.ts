import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	UI_PANELS_PROBE_EVENT,
	UI_PANELS_READY_EVENT,
	UI_PANELS_STOPPED_EVENT,
} from "./types.ts";
import type { PanelProbeEvent } from "./types.ts";
import { createPanelHost, type PanelHostController } from "./core.ts";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { registerBuiltinToolStyles } from "./builtin-styles.ts";

export * from "./types.ts";
export * from "./core.ts";
export * from "./client.ts";
export * from "./tools.ts";
export * from "./appearance.ts";

export const UI_PANELS_WIDGET_KEY = "ui-kit:v1";

export default function uiKitExtension(pi: ExtensionAPI): void {
	let active: PanelHostController | undefined;
	let activeUI: { setWidget(key: string, content: undefined): void } | undefined;
	let unsubscribeProbe: (() => void) | undefined;

	const stopActive = () => {
		const previous = active;
		const previousUI = activeUI;
		active = undefined;
		activeUI = undefined;

		if (previous) {
			// Invalidate before announcing stopped: callbacks that react to the
			// event cannot mutate a host that is already being torn down.
			previous.stop();
			pi.events.emit(UI_PANELS_STOPPED_EVENT, previous.host);
		}
		unsubscribeProbe?.();
		unsubscribeProbe = undefined;
		previousUI?.setWidget(UI_PANELS_WIDGET_KEY, undefined);
	};

	const subscribeProbe = () => {
		if (unsubscribeProbe) return;
		unsubscribeProbe = pi.events.on(UI_PANELS_PROBE_EVENT, (value) => {
			if (!active || typeof value !== "object" || value === null) return;
			const probe = value as Partial<PanelProbeEvent>;
			if (typeof probe.accept === "function") probe.accept(active.host);
		});
	};

	pi.on("session_start", (_event, ctx) => {
		stopActive();
		if (ctx.mode !== "tui") return;
		registerBuiltinToolStyles(pi, ctx.cwd);
		subscribeProbe();

		let requestRender = () => {};
		const controller = createPanelHost({
			requestRender: () => requestRender(),
			truncateToWidth: (line, width) => truncateToWidth(line, width, ""),
		});
		try {
			ctx.ui.setWidget(UI_PANELS_WIDGET_KEY, (tui) => {
				requestRender = () => tui.requestRender();
				return {
					render: (width: number) => controller.render(width, ctx.ui.theme),
					invalidate() {},
				};
			});
		} catch (error) {
			controller.stop();
			unsubscribeProbe?.();
			unsubscribeProbe = undefined;
			throw error;
		}

		active = controller;
		activeUI = ctx.ui;
		pi.events.emit(UI_PANELS_READY_EVENT, controller.host);
	});

	pi.on("session_shutdown", () => {
		stopActive();
	});
}
