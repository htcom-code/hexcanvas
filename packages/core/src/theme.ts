import { darkTheme, type HexTheme } from "./canvas-renderer.js";
import { defaultFont } from "./layout.js";

/**
 * The grid is painted, so CSS selectors cannot reach it. Custom properties can:
 * they cross shadow boundaries and are readable from script, so one declaration
 * colours both the DOM chrome and the canvas. Without this a host would set
 * every colour twice — once in CSS, once as a JS theme — and the two drift.
 */
export const themeProperties: Record<keyof HexTheme, string> = {
  background: "--hexcanvas-bg",
  foreground: "--hexcanvas-fg",
  muted: "--hexcanvas-muted",
  selection: "--hexcanvas-selection",
  caret: "--hexcanvas-caret",
  cursorRow: "--hexcanvas-cursor-row",
  cursorByte: "--hexcanvas-cursor-byte",
  cursorByteText: "--hexcanvas-cursor-byte-text",
  decoration: "--hexcanvas-decoration",
  searchMatch: "--hexcanvas-search",
  decorationLabel: "--hexcanvas-decoration-label",
  diffReplace: "--hexcanvas-diff-replace",
  diffInsert: "--hexcanvas-diff-insert",
  diffDelete: "--hexcanvas-diff-delete",
};

/** The custom property the grid font is read from. */
export const fontProperty = "--hexcanvas-font";

/**
 * Resolves the canvas theme from custom properties declared on or above
 * `element`. Anything left undeclared keeps its value from `fallback`.
 */
export function readTheme(element: Element, fallback: HexTheme = darkTheme): HexTheme {
  if (typeof getComputedStyle !== "function") return fallback;
  const computed = getComputedStyle(element);
  const resolved = { ...fallback };
  for (const [key, property] of Object.entries(themeProperties) as [keyof HexTheme, string][]) {
    const value = computed.getPropertyValue(property).trim();
    if (value) resolved[key] = value;
  }
  return resolved;
}

export function readFont(element: Element, fallback: string = defaultFont): string {
  if (typeof getComputedStyle !== "function") return fallback;
  const value = getComputedStyle(element).getPropertyValue(fontProperty).trim();
  return value || fallback;
}
