import type { Panel, PanelHost, PanelRenderContext, PanelTheme } from "./types.ts";

export const PANEL_ANIMATION_INTERVAL_MS = 120;
export const MAX_PANEL_LINES = 200;

interface TimerDriver {
	setInterval(callback: () => void, intervalMs: number): unknown;
	clearInterval(handle: unknown): void;
}

export interface PanelHostOptions {
	requestRender: () => void;
	/**
	 * Inject pi-tui's truncateToWidth. Keeping this dependency at the
	 * integration boundary makes the host logic runnable without a package
	 * resolver in pure Node tests.
	 */
	truncateToWidth: (line: string, width: number) => string;
	now?: () => number;
	timers?: TimerDriver;
}

export interface PanelHostController {
	readonly host: PanelHost;
	render(width: number, theme: PanelTheme): string[];
	stop(): void;
	isActive(): boolean;
	getFrame(): number;
	hasAnimatedPanels(): boolean;
}

const DEFAULT_TIMERS: TimerDriver = {
	setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
	clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

function safeSgrParameters(parameters: string): boolean {
	if (parameters.length > 128) return false;
	if (parameters === "") return true;
	const values = parameters.split(";");
	return (
		values.length <= 32 &&
		values.every((value) => /^\d{1,3}$/.test(value) && Number(value) <= 255)
	);
}

interface CsiSequence {
	end: number;
	final: string;
	parameters: string;
}

function readCsi(text: string, start: number, introducerLength: number): CsiSequence | undefined {
	for (let end = start + introducerLength; end < text.length; end++) {
		const codePoint = text.charCodeAt(end);
		if (codePoint >= 0x40 && codePoint <= 0x7e) {
			return {
				end: end + 1,
				final: text[end]!,
				parameters: text.slice(start + introducerLength, end),
			};
		}
	}
	return undefined;
}

function skipStringControl(text: string, start: number, c1Terminator: number): number {
	for (let index = start; index < text.length; index++) {
		const codePoint = text.charCodeAt(index);
		if (codePoint === 0x07 || codePoint === c1Terminator) return index + 1;
		if (codePoint === 0x1b && text[index + 1] === "\\") return index + 2;
	}
	return text.length;
}

/**
 * Remove terminal controls while retaining numeric SGR styling. Newlines and
 * tabs become spaces so an untrusted line cannot change terminal layout.
 */
export function sanitizeLine(input: string): string {
	let output = "";

	for (let index = 0; index < input.length; ) {
		const codePoint = input.codePointAt(index) ?? 0;
		const character = String.fromCodePoint(codePoint);

		if (codePoint === 0x1b) {
			const next = input[index + 1];
			if (next === "[") {
				const sequence = readCsi(input, index, 2);
				if (sequence?.final === "m" && safeSgrParameters(sequence.parameters)) {
					output += input.slice(index, sequence.end);
					index = sequence.end;
				} else {
					index = sequence?.end ?? input.length;
				}
				continue;
			}
			if (next === "]") {
				index = skipStringControl(input, index + 2, 0x9c);
				continue;
			}
			// Drop ESC-prefixed two-byte commands and incomplete ESC commands.
			index = Math.min(input.length, index + (next === undefined ? 1 : 2));
			continue;
		}

		if (codePoint === 0x9b) {
			const sequence = readCsi(input, index, 1);
			if (sequence?.final === "m" && safeSgrParameters(sequence.parameters)) {
				output += `\x1b[${sequence.parameters}m`;
				index = sequence.end;
			} else {
				index = sequence?.end ?? input.length;
			}
			continue;
		}
		if (codePoint === 0x9d) {
			index = skipStringControl(input, index + 1, 0x9c);
			continue;
		}

		if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0b || codePoint === 0x0c || codePoint === 0x0d) {
			output += " ";
		} else if (
			codePoint < 0x20 ||
			codePoint === 0x7f ||
			(codePoint >= 0x80 && codePoint <= 0x9f) ||
			(codePoint >= 0x202a && codePoint <= 0x202e) ||
			(codePoint >= 0x2066 && codePoint <= 0x2069)
		) {
			// Drop C0/C1 and bidi embedding/isolate controls.
		} else {
			output += character;
		}
		index += character.length;
	}

	return output;
}
function validatePanel(panel: Panel): void {
	if (!panel || typeof panel !== "object") throw new TypeError("ui-kit panel must be an object");
	if (typeof panel.id !== "string" || panel.id.length === 0) {
		throw new TypeError("ui-kit panel id must be a nonempty string");
	}
	if (panel.order !== undefined && (!Number.isFinite(panel.order) || typeof panel.order !== "number")) {
		throw new TypeError("ui-kit panel order must be a finite number");
	}
	if (panel.animated !== undefined && typeof panel.animated !== "boolean") {
		throw new TypeError("ui-kit panel animated must be boolean");
	}
	if (typeof panel.render !== "function") throw new TypeError("ui-kit panel render must be a function");
}

function comparePanels(left: Panel, right: Panel): number {
	const orderDifference = (left.order ?? 0) - (right.order ?? 0);
	if (orderDifference !== 0) return orderDifference;
	return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function errorLine(id: string, reason: string): string {
	return `[ui-kit: panel ${id} ${reason}]`;
}

export function createPanelHost(options: PanelHostOptions): PanelHostController {
	const timers = options.timers ?? DEFAULT_TIMERS;
	const now = options.now ?? (() => Date.now());
	const panels = new Map<string, Panel>();
	let active = true;
	let frame = 0;
	let animationTimer: unknown;

	const hasAnimatedPanels = () => [...panels.values()].some((panel) => panel.animated === true);

	const syncAnimationTimer = () => {
		if (!active || !hasAnimatedPanels()) {
			if (animationTimer !== undefined) {
				timers.clearInterval(animationTimer);
				animationTimer = undefined;
			}
			return;
		}
		if (animationTimer === undefined) {
			animationTimer = timers.setInterval(() => {
				if (!active || !hasAnimatedPanels()) {
					syncAnimationTimer();
					return;
				}
				frame++;
				options.requestRender();
			}, PANEL_ANIMATION_INTERVAL_MS);
		}
	};

	const host: PanelHost = {
		upsert(panel) {
			if (!active) return;
			validatePanel(panel);
			panels.set(panel.id, panel);
			syncAnimationTimer();
			options.requestRender();
		},
		remove(id) {
			if (!active) return;
			if (typeof id !== "string") throw new TypeError("ui-kit panel id must be a string");
			if (!panels.delete(id)) return;
			syncAnimationTimer();
			options.requestRender();
		},
	};

	return {
		host,
		render(width, theme) {
			const widthLimit = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
			if (!active || panels.size === 0) return [];

			const context: PanelRenderContext = { now: now(), frame };
			const lines: string[] = [];
			const append = (line: string) => {
				if (lines.length < MAX_PANEL_LINES) {
					lines.push(options.truncateToWidth(sanitizeLine(line), widthLimit));
				}
			};

			const orderedPanels = [...panels.values()].sort(comparePanels);
			for (const panel of orderedPanels) {
				if (lines.length >= MAX_PANEL_LINES) break;
				let rendered: unknown;
				try {
					rendered = panel.render(widthLimit, theme, context);
				} catch {
					append(errorLine(panel.id, "render failed"));
					continue;
				}
				if (!Array.isArray(rendered)) {
					append(errorLine(panel.id, "returned invalid lines"));
					continue;
				}
				for (const line of rendered) {
					if (lines.length >= MAX_PANEL_LINES) break;
					if (typeof line !== "string") {
						append(errorLine(panel.id, "returned a non-string line"));
						continue;
					}
					append(line);
				}
			}
			return lines;
		},
		stop() {
			if (!active) return;
			active = false;
			if (animationTimer !== undefined) {
				timers.clearInterval(animationTimer);
				animationTimer = undefined;
			}
			panels.clear();
		},
		isActive: () => active,
		getFrame: () => frame,
		hasAnimatedPanels,
	};
}
