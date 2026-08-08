import { useEffect, useRef, type CSSProperties } from "react";
import { defineHexCanvasElement, type HexCanvasElement } from "@hexcanvas/element";
import type {
  AddressRadix,
  BinaryBuffer,
  ByteGroupSize,
  ByteSelection,
  ByteSource,
  ChangeSet,
  Cursor,
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
  SearchRequest,
} from "@hexcanvas/core";

// Registration is idempotent and no-ops without `customElements`, so importing
// this module is safe on a server; the element upgrades when it reaches a browser.
defineHexCanvasElement();

/** Everything `<HexEditor>` takes. Only `source` is required. */
export interface HexEditorProps {
  /** A `ByteSource`, or the older synchronous `BinaryBuffer`, which is adapted. */
  source: ByteSource | BinaryBuffer;
  /** Bytes on each row. Defaults to 16. */
  bytesPerRow?: number;
  /** Row height in CSS pixels. Defaults to the editor's own. */
  rowHeight?: number;
  /**
   * Grid colours, overriding the ones resolved from the `--hexcanvas-*` custom
   * properties. Leave it unset and CSS decides.
   */
  theme?: HexTheme;
  /** Address column base. Defaults to hexadecimal. */
  addressRadix?: AddressRadix;
  /** Extra spacing every N bytes. Defaults to 1 (no grouping). */
  byteGroup?: ByteGroupSize;
  /** Monospace font for the grid. Column widths are measured from it. */
  font?: string;
  /**
   * Most repaints a second. Uncapped by default, so the editor follows the
   * display; see the element's README before reaching for it.
   */
  maxFps?: number;
  /** Highlight the address of the row holding the cursor. Defaults to true. */
  highlightCursorAddress?: boolean;
  /** Draw the cursor byte inverted in the ASCII column. Defaults to true. */
  highlightCursorAscii?: boolean;
  /** Draw the plain-text column beside the hex one. Defaults to true. */
  asciiColumn?: boolean;
  /** Draw decoration labels. Defaults to false; a range can opt in on its own. */
  decorationLabels?: boolean;
  /** Characters of room reserved for labels. Defaults to 16. */
  labelWidth?: LabelWidth;
  /**
   * What the plain-text column makes of a byte: `"ascii"` (the default),
   * `"cp437"` or `"latin1"`. Reaches the cursor readout and a text copy too.
   * For a code page not named here, set the element's `printable` property.
   */
  textEncoding?: "ascii" | "cp437" | "latin1";
  /**
   * Whether the editor owns find. Defaults to `"off"`, so Ctrl+F reaches the
   * browser rather than an editor with no panel. `"custom"` keeps the scanning
   * and highlighting but leaves the UI to you — see `onSearchRequest`.
   */
  search?: FeatureMode;
  /** Defaults to whatever `search` is. */
  replace?: FeatureMode;
  /** Go to address. Defaults to whatever `search` is. */
  goto?: FeatureMode;
  /** Called in `"custom"` mode instead of a panel opening. */
  onSearchRequest?: (request: SearchRequest) => void;
  /** Replaces the scan — a pattern matcher, or a server that already indexed the file. */
  searchProvider?: SearchProvider;
  /** Modes the panel offers. Defaults to `["hex", "text"]`. */
  searchModes?: readonly SearchMode[];
  /** Whose default keys to use. Detected when omitted. */
  platform?: Platform;
  /** Overrides the default keys per command. Throws on a key it cannot honour. */
  keymap?: Keymap;
  /** Replaces the strings the editor shows. Partial: the rest stay English. */
  text?: HexTextOverrides;
  /** The gaps between the columns. Anything omitted keeps its default. */
  spacing?: HexSpacing;
  /** Edit mode, including `"read-only"`. The editor never changes it on its own. */
  editMode?: EditMode;
  /**
   * Cursor position to hold. Paired with `onCursorChange` this makes the cursor
   * host state — the editor still moves it, and says so, but the host decides.
   */
  cursor?: Partial<Cursor> & { offset: number };
  /** Selected range to hold, or null for none. */
  selection?: ByteSelection | null;
  /**
   * Lands on the element itself, not on anything inside it — the chrome is in a
   * shadow root and is restyled through `::part()`.
   */
  className?: string;
  /** Lands on the element itself, like `className`. */
  style?: CSSProperties;
  /**
   * The document was edited. Carries the changes rather than the new bytes, so a
   * host holding offsets can map them with `changes.mapPos`.
   */
  onChange?: (changes: ChangeSet) => void;
  /**
   * The cursor moved. Pair it with the `cursor` prop to hold the position as your
   * own state; echoing this straight back cannot loop.
   */
  onCursorChange?: (cursor: Cursor) => void;
  /** The selection changed, or was dropped — `undefined` means nothing is selected. */
  onSelectionChange?: (selection: ByteSelection | undefined) => void;
  /** Overrides where copied text goes. Defaults to the system clipboard. */
  onCopy?: (text: string) => void;
  /** Receives the engine so the host can drive the cursor, search or history. */
  onEngine?: (engine: HexEngine) => void;
}

/**
 * A wrapper over `<hexcanvas-editor>`, like the Vue and Svelte bindings. It used
 * to build the chrome a second time — it predated the custom element — which
 * meant every panel existed twice and could drift. React consumers pay for that
 * with a custom element in their tree, and style it through `::part()` rather
 * than by passing class names inwards.
 */
export function HexEditor({
  source,
  bytesPerRow,
  rowHeight,
  theme,
  addressRadix,
  byteGroup,
  font,
  maxFps,
  highlightCursorAddress,
  highlightCursorAscii,
  asciiColumn,
  decorationLabels,
  labelWidth,
  textEncoding,
  search,
  replace,
  goto: gotoMode,
  onSearchRequest,
  searchProvider,
  searchModes,
  platform,
  keymap,
  text,
  spacing,
  editMode,
  cursor,
  selection,
  className,
  style,
  onChange,
  onCursorChange,
  onSelectionChange,
  onCopy,
  onEngine,
}: HexEditorProps) {
  const hostRef = useRef<HexCanvasElement>(null);

  // Objects cannot travel as attributes, so they are assigned as properties.
  useEffect(() => {
    const host = hostRef.current;
    if (host) host.source = source;
  }, [source]);

  useEffect(() => {
    const host = hostRef.current;
    if (host) host.theme = theme;
  }, [theme]);

  useEffect(() => {
    const host = hostRef.current;
    if (host) host.copyHandler = onCopy;
  }, [onCopy]);

  useEffect(() => {
    const host = hostRef.current;
    if (host) host.searchProvider = searchProvider;
  }, [searchProvider]);

  useEffect(() => {
    const host = hostRef.current;
    if (host) host.searchModes = searchModes;
  }, [searchModes]);

  useEffect(() => {
    const host = hostRef.current;
    if (host) host.keymap = keymap;
  }, [keymap]);

  useEffect(() => {
    const host = hostRef.current;
    if (host) host.text = text;
  }, [text]);

  useEffect(() => {
    const host = hostRef.current;
    if (host) host.spacing = spacing;
  }, [spacing]);

  // Setting the position it already holds is a no-op in the element, so echoing
  // the event back into this prop cannot loop.
  useEffect(() => {
    const host = hostRef.current;
    if (host && cursor) host.cursor = cursor;
  }, [cursor]);

  useEffect(() => {
    const host = hostRef.current;
    if (host && selection !== undefined) host.selection = selection;
  }, [selection]);

  useEffect(() => {
    const host = hostRef.current;
    if (host) onEngine?.(host.engine);
  }, [onEngine]);

  // Custom events, so React's synthetic system never sees them; a `change` prop
  // would collide with the DOM event of the same name.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !onChange) return;
    const listener = (event: Event) => onChange((event as CustomEvent<ChangeSet>).detail);
    host.addEventListener("change", listener);
    return () => host.removeEventListener("change", listener);
  }, [onChange]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !onCursorChange) return;
    const listener = (event: Event) => onCursorChange((event as CustomEvent<Cursor>).detail);
    host.addEventListener("cursorchange", listener);
    return () => host.removeEventListener("cursorchange", listener);
  }, [onCursorChange]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !onSelectionChange) return;
    const listener = (event: Event) => onSelectionChange((event as CustomEvent<ByteSelection | undefined>).detail);
    host.addEventListener("selectionchange", listener);
    return () => host.removeEventListener("selectionchange", listener);
  }, [onSelectionChange]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !onSearchRequest) return;
    const listener = (event: Event) => onSearchRequest((event as CustomEvent<SearchRequest>).detail);
    host.addEventListener("searchrequest", listener);
    return () => host.removeEventListener("searchrequest", listener);
  }, [onSearchRequest]);

  return <hexcanvas-editor
    ref={hostRef}
    class={className}
    style={style}
    bytes-per-row={bytesPerRow}
    row-height={rowHeight}
    address-radix={addressRadix}
    byte-group={byteGroup}
    edit-mode={editMode}
    font={font}
    highlight-cursor-address={flag(highlightCursorAddress)}
    highlight-cursor-ascii={flag(highlightCursorAscii)}
    ascii-column={flag(asciiColumn)}
    decoration-labels={flag(decorationLabels)}
    label-width={labelWidth}
    text-encoding={textEncoding}
    search={search}
    replace={replace}
    goto={gotoMode}
    platform={platform}
    max-fps={maxFps}
  />;
}

/** Omitted rather than stringified, so the element keeps its own default. */
const flag = (value: boolean | undefined): string | undefined => (value === undefined ? undefined : String(value));

/**
 * React renders unknown lowercase tags as elements and passes dashed props
 * through as attributes, but it needs to be told the tag exists.
 */
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "hexcanvas-editor": {
        ref?: import("react").Ref<HexCanvasElement>;
        class?: string;
        style?: import("react").CSSProperties;
        "bytes-per-row"?: number;
        "row-height"?: number;
        "address-radix"?: AddressRadix;
        "byte-group"?: ByteGroupSize;
        "edit-mode"?: EditMode;
        font?: string;
        "highlight-cursor-address"?: string;
        "highlight-cursor-ascii"?: string;
        "ascii-column"?: string;
        "decoration-labels"?: string;
        "label-width"?: LabelWidth;
        search?: FeatureMode;
        replace?: FeatureMode;
        goto?: FeatureMode;
        platform?: Platform;
        "max-fps"?: number;
      };
    }
  }
}
