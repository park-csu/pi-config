/** Versioned event names for the generic UI panel protocol. */
export const UI_PANELS_PROTOCOL = "ui-kit:v1" as const;
export const UI_PANELS_PROBE_EVENT = `${UI_PANELS_PROTOCOL}:probe` as const;
export const UI_PANELS_READY_EVENT = `${UI_PANELS_PROTOCOL}:ready` as const;
export const UI_PANELS_STOPPED_EVENT = `${UI_PANELS_PROTOCOL}:stopped` as const;

/**
 * The active pi theme. It is intentionally not narrowed here: panel clients
 * can be used by extensions that have their own theme type.
 */
export type PanelTheme = any;

export interface PanelRenderContext {
	now: number;
	frame: number;
}

export interface Panel {
	id: string;
	order?: number;
	animated?: boolean;
	render: (width: number, theme: PanelTheme, context: PanelRenderContext) => string[];
}

/** The only object exposed to panel providers. */
export interface PanelHost {
	upsert(panel: Panel): void;
	remove(id: string): void;
}

export interface PanelProbeEvent {
	accept(host: PanelHost): void;
}

/** Structural type for pi.events and small test/local event buses. */
export interface PanelEventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}
