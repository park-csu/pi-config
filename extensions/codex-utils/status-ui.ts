import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATUS_TYPE = "codex-status";

/** Adapt the older quota extension's transcript output to UI-only entries. */
export function statusOnlyApi(pi: ExtensionAPI): ExtensionAPI {
	// Old sessions still contain custom messages. Preserve their display/history,
	// but do not send these quota reports on subsequent agent requests.
	pi.on("context", (event) => ({
		messages: event.messages.filter(
			(message) => message.role !== "custom" || message.customType !== STATUS_TYPE,
		),
	}));

	return new Proxy(pi, {
		get(target, property, receiver) {
			if (property === "sendMessage") {
				return ((message, options) => {
					if (message.customType === STATUS_TYPE) {
						target.appendEntry(STATUS_TYPE, message);
					} else {
						target.sendMessage(message, options);
					}
				}) satisfies ExtensionAPI["sendMessage"];
			}
			if (property === "registerMessageRenderer") {
				return ((customType, renderer) => {
					// Retain the renderer for historical custom messages too.
					target.registerMessageRenderer(customType, renderer);
					if (customType === STATUS_TYPE) {
						target.registerEntryRenderer<Omit<Parameters<typeof renderer>[0], "role" | "timestamp">>(
							customType,
							(entry, options, theme) => renderer({
								...entry.data!,
								role: "custom",
								timestamp: Date.parse(entry.timestamp),
							}, { ...options, outputPad: 0 }, theme),
						);
					}
				}) satisfies ExtensionAPI["registerMessageRenderer"];
			}
			const value = Reflect.get(target, property, receiver) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
