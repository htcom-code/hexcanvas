import { defineHexCanvasElement, HexCanvasElement } from "@hexcanvas/element";
import type {
  AddressRadix,
  BinaryBuffer,
  ByteGroupSize,
  ByteSource,
  EditMode,
  FeatureMode,
  HexEngine,
  HexSpacing,
  HexTextOverrides,
  HexTheme,
  Keymap,
  LabelWidth,
  Platform,
  SearchMode,
  SearchProvider,
} from "@hexcanvas/core";

defineHexCanvasElement();

/** Everything the action and `createHexEditor` take. Only `source` is required. */
export interface HexEditorOptions {
  /** The document. A `ByteSource`, or the older synchronous `BinaryBuffer`, which is adapted. */
  source: ByteSource | BinaryBuffer;
  /** Bytes on each row. Defaults to 16. */
  bytesPerRow?: number;
  /** Row height in CSS pixels. Defaults to the editor's own. */
  rowHeight?: number;
  /** Address column base. Defaults to hexadecimal. */
  addressRadix?: AddressRadix;
  /** Extra spacing every N bytes. Defaults to 1 (no grouping). */
  byteGroup?: ByteGroupSize;
  /** Monospace font for the grid. Column widths are measured from it, not assumed. */
  font?: string;
  /**
   * `"read-only"`, `"overwrite"` (the default) or `"insert"`. The editor never
   * changes it itself.
   */
  editMode?: EditMode;
  /**
   * Grid colours, overriding the ones resolved from the `--hexcanvas-*` custom
   * properties. Leave it unset and CSS decides.
   */
  theme?: HexTheme;
  /** Draw the plain-text column beside the hex one. Defaults to true. */
  asciiColumn?: boolean;
  /** Draw decoration labels. Defaults to false; a range can opt in on its own. */
  decorationLabels?: boolean;
  /** Characters of room reserved for labels. Defaults to 16. */
  labelWidth?: LabelWidth;
  /** Defaults to `"off"`, so Ctrl+F is left to the browser until find is asked for. */
  search?: FeatureMode;
  /** Defaults to whatever `search` is. */
  replace?: FeatureMode;
  /** Defaults to whatever `search` is. */
  goto?: FeatureMode;
  /** Replaces the scan. Listen for `searchrequest` when running `search: "custom"`. */
  searchProvider?: SearchProvider;
  /** Modes the panel offers. Defaults to `["hex", "text"]`. */
  searchModes?: readonly SearchMode[];
  /** Whose default keys to use. Detected when omitted. */
  platform?: Platform;
  /** Overrides the default keys per command. */
  keymap?: Keymap;
  /** Replaces the strings the editor shows. Partial: the rest stay English. */
  text?: HexTextOverrides;
  /** The gaps between the columns. Anything omitted keeps its default. */
  spacing?: HexSpacing;
  /**
   * Receives the `HexEngine` once the element is upgraded, for driving search,
   * history or the cursor from outside.
   */
  onEngine?: (engine: HexEngine) => void;
}

/**
 * What a Svelte action hands back: the two hooks its runtime calls. Declared here
 * rather than imported from `svelte/action`, because this package deliberately has
 * no Svelte dependency — the shape is Svelte's contract, not ours to change.
 */
export interface ActionReturn {
  /** Called when the object passed to `use:` changes. */
  update(options: HexEditorOptions): void;
  /** Called when the element leaves the DOM. */
  destroy(): void;
}

/**
 * A Svelte action rather than a component, so the package needs no compiler and
 * no Svelte dependency, and the editor chrome stays in the custom element.
 *
 * ```svelte
 * <hexcanvas-editor use:hexEditor={{ source }} on:change={…} />
 * ```
 *
 * Applied to any other element, it upgrades nothing — use it on the element or
 * mount one yourself with `createHexEditor`.
 */
export function hexEditor(node: HTMLElement, options: HexEditorOptions): ActionReturn {
  if (!(node instanceof HexCanvasElement)) {
    throw new TypeError("use:hexEditor expects a <hexcanvas-editor> element; use createHexEditor to mount one.");
  }
  apply(node, options);
  options.onEngine?.(node.engine);
  return {
    update: (next) => apply(node, next),
    destroy: () => {},
  };
}

/** Mounts an editor into any container — Svelte, Angular, or plain HTML. */
export function createHexEditor(container: Element, options: HexEditorOptions): HexCanvasElement {
  const element = document.createElement("hexcanvas-editor") as HexCanvasElement;
  container.append(element);
  apply(element, options);
  options.onEngine?.(element.engine);
  return element;
}

function apply(element: HexCanvasElement, options: HexEditorOptions): void {
  attribute(element, "bytes-per-row", options.bytesPerRow);
  attribute(element, "row-height", options.rowHeight);
  attribute(element, "address-radix", options.addressRadix);
  attribute(element, "byte-group", options.byteGroup);
  attribute(element, "edit-mode", options.editMode);
  attribute(element, "font", options.font);
  attribute(element, "ascii-column", options.asciiColumn);
  attribute(element, "decoration-labels", options.decorationLabels);
  attribute(element, "label-width", options.labelWidth);
  attribute(element, "search", options.search);
  attribute(element, "replace", options.replace);
  attribute(element, "goto", options.goto);
  attribute(element, "platform", options.platform);
  if (options.theme) element.theme = options.theme;
  element.searchProvider = options.searchProvider;
  element.searchModes = options.searchModes;
  element.keymap = options.keymap;
  element.text = options.text;
  element.spacing = options.spacing;
  if (element.source !== options.source) element.source = options.source;
}

/** Removed rather than stringified when absent, so the element keeps its default. */
function attribute(element: Element, name: string, value: string | number | boolean | undefined): void {
  if (value === undefined) element.removeAttribute(name);
  else element.setAttribute(name, String(value));
}

export { HexCanvasElement };
