/** Semantic UI roles resolve through the active Pi theme, never a fixed palette. */
export const uiTone = Object.freeze({
  title: "text",
  toolTitle: "toolTitle",
  body: "muted",
  secondary: "dim",
  active: "accent",
  selected: "accent",
  border: "border",
  borderMuted: "borderMuted",
  warning: "warning",
  error: "error",
} as const);

/** Completion, pauses and user cancellation are ordinary states, not alerts. */
export function statusTone(status: string) {
  if (status === "running") return uiTone.active;
  if (status === "failed" || status === "error") return uiTone.error;
  return uiTone.body;
}
