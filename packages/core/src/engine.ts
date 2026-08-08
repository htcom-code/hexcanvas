import type { BinaryBuffer } from "./binary-buffer.js";
import { ChangeSet, fromBinaryBuffer, isAbortError, isByteSource, type ByteSource } from "./byte-source.js";
import { HexCanvasRenderer, type HexDisplayOptions, type HexTheme } from "./canvas-renderer.js";
import {
  DecorationStore,
  bookmarkKind,
  byPaintOrder,
  searchKind,
  type Decoration,
  type DecorationInput,
  type DecorationQuery,
} from "./decorations.js";
import { ChangeHistory } from "./history.js";
import {
  commandFor,
  commands,
  formatBinding,
  resolveKeymap,
  resolvePlatform,
  type CommandId,
  type Keybinding,
  type KeyInput,
  type Keymap,
  type Platform,
} from "./keymap.js";
import { createLayout, invalidateFontMetrics, type AddressRadix, type ByteGroupSize, type HexLayout, type HexSpacing, type LabelWidth } from "./layout.js";
import { clampOffset, normalizedSelection, type ByteSelection, type Cursor } from "./model.js";
import { printableTable, substituteChar, type PrintableChar } from "./printable.js";
// `parseHexQuery` is here for paste, which reads hex digits whatever the search
// provider is — pasting is not searching.
import { createByteSearchProvider, parseHexQuery, type SearchMatch, type SearchProvider } from "./search.js";
import { resolveText, type HexText, type HexTextOverrides } from "./text.js";
import { readFont, readTheme } from "./theme.js";
import { createScrollScale, linearRowPlan, rowsIn, type RowPlan, type VisibleRows } from "./viewport.js";

/**
 * Everything `new HexEngine` takes. Only `source` is required; `setOptions` replaces
 * the rest as a set, so an omitted option returns to its default rather than staying.
 */
export interface HexEngineOptions {
  /** A `ByteSource`, or the older synchronous buffer, which is adapted. */
  source: ByteSource | BinaryBuffer;
  /** Bytes on each row. Defaults to 16. */
  bytesPerRow?: number;
  /** Row height in CSS pixels. */
  rowHeight?: number;
  /** Defaults to `"overwrite"`. The editor never changes it itself. */
  editMode?: EditMode;
  /** Base the address column is printed in. Defaults to hexadecimal. */
  addressRadix?: AddressRadix;
  /** Extra spacing every N bytes. Defaults to 1, which is no grouping. */
  byteGroup?: ByteGroupSize;
  /**
   * Grid font. Column widths are measured from whatever it resolves to, and
   * re-measured when a late web font arrives.
   */
  font?: string;
  /** Grid colours, overriding what the custom properties resolve to. */
  theme?: HexTheme;
  /** The options that change how a row is painted without moving anything. */
  display?: HexDisplayOptions;
  /** Draw the plain-text column beside the hex one. Defaults to true. */
  asciiColumn?: boolean;
  /**
   * What a byte looks like in the plain-text column. Defaults to ASCII; see
   * `PrintableChar` for the rule it has to keep, and `cp437Printable` and
   * `latin1Printable` for the two encodings that come up most.
   *
   * Reaches the grid, the cursor description a screen reader reads, and a copy
   * as text — the three places that used to spell out the ASCII test
   * separately. It does **not** reach text search, which encodes what the user
   * typed as UTF-8: below 0x80 the two agree, and above it a text query for a
   * code-page character finds nothing. Hex mode is the exact-bytes answer.
   */
  printable?: PrintableChar;
  /**
   * How many hits a scan highlights before stopping. Defaults to 1,000, and the
   * cap is reported in `searchTruncated` rather than hidden. A host that knows
   * its documents are small can raise it; the ceiling exists because a single
   * `00` over a gigabyte would otherwise build an unbounded overlay list.
   */
  searchMatchLimit?: number;
  /**
   * Paint priority for search hits. Defaults to 5, above structure overlays,
   * because a hit you went looking for should not be buried under them. A host
   * whose own decorations sit at 5 or higher has to be able to move one of the
   * two, and until now only its own.
   */
  searchPriority?: number;
  /** Width of the decoration-label gutter in characters. Defaults to 16. */
  labelWidth?: LabelWidth;
  /** The gaps between the columns. Anything omitted keeps its default. */
  spacing?: HexSpacing;
  /**
   * Whether the editor owns find at all. Defaults to `"off"`: an embedded editor
   * that swallows Ctrl+F without showing anything is worse than one that leaves
   * the key alone, so the feature is asked for rather than assumed.
   */
  search?: FeatureMode;
  /** Defaults to whatever `search` is: replace without find is no use. */
  replace?: FeatureMode;
  /**
   * Go-to-address, kept separate so it can be turned off on its own — but
   * defaulting to `search` so one setting covers the usual case rather than
   * leaving Ctrl+G captured by an editor with no panel to show.
   */
  goto?: FeatureMode;
  /** Called in `"custom"` mode instead of opening a panel. */
  onSearchRequest?: (request: SearchRequest) => void;
  /** Replaces the scan. Independent of the modes: native chrome over a host's engine is a valid pairing. */
  searchProvider?: SearchProvider;
  /** Modes the panel offers. Defaults to `["hex", "text"]`; a provider can add its own. */
  searchModes?: readonly SearchMode[];
  /**
   * Which platform's default keys to use. Detected when omitted; the fallback where
   * there is nothing to ask is Windows, because macOS defaults are built on the key
   * Windows reserves entirely.
   */
  platform?: Platform;
  /** Overrides the default keys, per command. Throws on a key it cannot honour. */
  keymap?: Keymap;
  /**
   * Replaces the strings the library shows. Partial: what is not named keeps its
   * English default. See `HexText` for the whole set.
   */
  text?: HexTextOverrides;
  /** Fires after every applied edit. Byte-level arguments could not describe insert or delete. */
  onChange?: (changes: ChangeSet) => void;
  /** Called when the selection changes, or is dropped. */
  onSelectionChange?: (selection: ByteSelection | undefined) => void;
  /** Fires whenever the cursor moves, so a host can hold it as its own state. */
  onCursorChange?: (cursor: Cursor) => void;
  /** Receives copied text; the engine never touches the platform clipboard. */
  onCopy?: (text: string) => void;
}

/**
 * One value rather than a mode plus a flag: read-only makes the other two
 * meaningless, so a host that had to set both could describe states that do not
 * exist. Overwrite replaces the byte under the cursor; insert grows the document.
 */
export type EditMode = "read-only" | "overwrite" | "insert";

/**
 * `"off"` means the engine does not have the feature: no state, no panel, and
 * the shortcut is left to the platform. `"native"` is the editor's own chrome.
 * `"custom"` keeps the engine's scanning and highlighting but hands the chrome
 * to the host, which is told to open its own by `onSearchRequest`.
 */
export type FeatureMode = "off" | "native" | "custom";

/**
 * Open to extension rather than closed to it: a `searchProvider` that understands
 * regular expressions needs a mode name for them, and the two the library scans
 * itself should not be the only ones expressible.
 */
export type SearchMode = "hex" | "text" | (string & {});

/** Which way `runSearch` moves before it highlights. */
export type SearchDirection = "next" | "previous";

/** What a host with `search: "custom"` is asked for: which panel the user wanted. */
export interface SearchRequest {
  kind: "search" | "replace" | "goto";
}

// Re-exported because it used to live here and hosts import it from the engine.
export { bookmarkKind, searchKind };

/**
 * How many hits are highlighted at once. Scanning stops there rather than
 * building an unbounded overlay list for a query like a single `00` byte over a
 * gigabyte, and the cap is reported rather than hidden.
 */
export const searchMatchLimit = 1_000;

/** Above structure overlays: a hit you are looking for should not be buried. */
const defaultSearchPriority = 5;

/** ASCII, for an engine that named no encoding; see `HexEngineOptions.printable`. */
const defaultPrintableChars = printableTable();

/**
 * Most bytes `describeRegion` reads out of a selection, and most ranges it names
 * where they nest. Both are caps on a sentence rather than on the work: select a
 * megabyte and the count is still the truth, the digits are a sample, and the
 * announcement says which it is. Sixty-four bytes is around fifteen seconds of
 * speech, which is already at the edge of what anyone listens through.
 */
const readAloudBytes = 64;
const readAloudRegions = 3;

/** Bytes as the grid writes them, for an announcement rather than for a frame. */
const hexOf = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(" ");

/** Everything a view needs to redraw itself. Replaced wholesale on every change. */
export interface HexEngineState {
  /** Where the caret is. */
  cursor: Cursor;
  /** The selected range, or undefined when nothing is. */
  selection: ByteSelection | undefined;
  /** Scroll offset the host scroller should hold, in DOM pixels. */
  scrollTop: number;
  /**
   * Horizontal scroll offset in grid pixels, for a row wider than the viewport.
   * Not scaled: no row is long enough to need it.
   */
  scrollLeft: number;
  /** Scrollport width in CSS pixels, as last given to `setViewportSize`. */
  viewportWidth: number;
  /** Scrollport height in CSS pixels. The scroll range is measured against it. */
  viewportHeight: number;
  /** Bumps whenever a byte is written, so views repaint after an edit. */
  revision: number;
  /** Read-only, overwrite or insert. Only a host changes it. */
  editMode: EditMode;
  /** Whether there is a step to undo. */
  canUndo: boolean;
  /** Whether there is a step to redo. */
  canRedo: boolean;
  /** Bumps when decorations are added or removed, so views repaint. */
  decorationRevision: number;
  /** What the chrome should build, if anything. A view reads this rather than being told. */
  searchFeature: FeatureMode;
  /** Whether replace is `"off"`, the editor's own, or the host's. */
  replaceFeature: FeatureMode;
  /** Whether go-to is `"off"`, the editor's own, or the host's. */
  gotoFeature: FeatureMode;
  /** Whether the find panel is showing. */
  searchOpen: boolean;
  /** How that text is read — hex, plain text, or a mode a provider added. */
  searchMode: SearchMode;
  /** Modes the panel should offer. */
  searchModes: readonly SearchMode[];
  /** The text in the find field. */
  searchQuery: string;
  /** Why the query was refused, or undefined. */
  searchError: string | undefined;
  /** True while a scan is in flight; scanning a paged source can await pages. */
  searching: boolean;
  /** Hits currently highlighted, all of them decorations of `searchKind`. */
  searchMatchCount: number;
  /** 1-based position of the hit under the cursor, or 0 when it is not on one. */
  searchMatchIndex: number;
  /** True when the scan stopped at `searchMatchLimit` and more hits exist. */
  searchTruncated: boolean;
  /** Whether the replace row is showing. */
  replaceOpen: boolean;
  /** The text in the replace field. */
  replaceQuery: string;
  /** Outcome or complaint from the last replace, for the panel to show. */
  replaceMessage: string | undefined;
  /** Whether that message is a complaint, so a view can colour it as one. */
  replaceFailed: boolean;
  /** Whether the go-to panel is showing. */
  gotoOpen: boolean;
  /** The text in the go-to field. */
  gotoQuery: string;
  /** Why the address was refused, or undefined. */
  gotoError: string | undefined;
  /**
   * Something to say that is not the cursor — a row read on demand, a region,
   * or whatever a host passes to `announce`.
   *
   * The serial is the load-bearing half. A live region speaks when its text is
   * written, and a view that only writes on a change would swallow the second
   * press of "read this row": the same row, the same words, and silence where
   * the user asked a question. Counting instead of comparing makes "say it
   * again" expressible, and leaves the view free to ignore an announcement it
   * has already made.
   */
  announcement: { text: string; serial: number } | undefined;
}

// `KeyInput` used to live here. It moved to `keymap.js` with the matching, and is
// re-exported because hosts import it from the engine.
export type { KeyInput };

type ScrollScale = ReturnType<typeof createScrollScale>;

const defaultBytesPerRow = 16;
const defaultRowHeight = 22;
const defaultSearchModes: readonly SearchMode[] = ["hex", "text"];
const defaultSearchProvider = createByteSearchProvider();

/**
 * `replace` and `goto` follow `search` when unstated, so the common case is one
 * setting. Stating them separately still works — `search: "native"` with
 * `replace: "off"` is a viewer that finds but does not rewrite.
 */
function resolveFeatures(options: Pick<HexEngineOptions, "search" | "replace" | "goto">): {
  searchFeature: FeatureMode;
  replaceFeature: FeatureMode;
  gotoFeature: FeatureMode;
} {
  const searchFeature = options.search ?? "off";
  return {
    searchFeature,
    replaceFeature: options.replace ?? searchFeature,
    gotoFeature: options.goto ?? searchFeature,
  };
}

/**
 * Framework-free editor core: cursor, selection, scrolling, key handling,
 * pointer handling, editing and search. Bindings translate their platform's
 * events into these calls and redraw from `getState()`.
 */
export class HexEngine {
  private source: ByteSource;
  private unsubscribeSource: () => void;
  private bytesPerRow: number;
  private rowHeight: number;
  private addressRadix: AddressRadix;
  private byteGroup: ByteGroupSize;
  private font: string | undefined;
  private asciiColumn = true;
  private labelWidth: LabelWidth | undefined;
  private spacing: HexSpacing | undefined;
  private searchProvider: SearchProvider;
  private onSearchRequest: HexEngineOptions["onSearchRequest"];
  private platform: Platform = "windows";
  private keys!: ReturnType<typeof resolveKeymap>;
  private strings: HexText = resolveText();
  private theme: HexTheme | undefined;
  /** Resolved from CSS custom properties; the `theme` option outranks it. */
  private cssTheme: HexTheme | undefined;
  private cssFont: string | undefined;
  private styleHost: Element | undefined;
  private display: HexDisplayOptions | undefined;
  /** The chosen encoding's 256 glyphs, rebuilt only when the option changes. */
  private printableChars: readonly string[] = defaultPrintableChars;
  private searchLimit = searchMatchLimit;
  private searchPriority = defaultSearchPriority;
  private onChange: HexEngineOptions["onChange"];
  private onSelectionChange: HexEngineOptions["onSelectionChange"];
  private onCursorChange: HexEngineOptions["onCursorChange"];
  private onCopy: HexEngineOptions["onCopy"];

  private readonly renderer = new HexCanvasRenderer();
  private readonly history = new ChangeHistory();
  private readonly decorationStore = new DecorationStore();
  /** One host source per kind; see `setDecorationSource`. */
  private readonly decorationSources = new Map<string, DecorationQuery>();
  /** Store and sources as one thing to ask, rebuilt when the sources change. */
  private aggregateQuery: DecorationQuery | undefined;
  /** Commands the engine routes for someone else; see `setCommandHandler`. */
  private readonly commandHandlers = new Map<CommandId, () => boolean>();
  private readonly listeners = new Set<() => void>();
  private anchor = 0;
  private dragging = false;
  /** `mode:query` of the last scan, so find-next does not rescan the source. */
  private scannedKey: string | undefined;
  /** The scan in flight and its key, so repeated presses do not start more. */
  private scanning: Promise<number> | undefined;
  private scanningKey: string | undefined;
  /** Bumped when a newer scan starts, so a slow older one cannot land. */
  private scanGeneration = 0;
  /**
   * Stops the superseded scan rather than only discarding it. The generation
   * guard has always thrown the result away; without this the reads behind it
   * ran to the end of the file for a query nobody was waiting on.
   */
  private scanAborter: AbortController | undefined;
  /** Byte ranges written since the last `markSaved`, in current coordinates. */
  private dirty: ByteSelection[] = [];
  /**
   * History state the document was last saved at, or undefined once an edit
   * arrived that the history does not know about; see `recordDirty`.
   */
  private savedState: number | undefined = 0;
  /** True while an edit the engine itself is making runs; see `throughHistory`. */
  private applyingHistory = false;
  private lengthChanged = false;
  private repaintScheduled = false;
  private repaintHandle: number | undefined;
  private rowPlan: RowPlan | undefined;
  private cachedPlan!: RowPlan;
  private cachedLayout!: HexLayout;
  private cachedScale!: ScrollScale;
  private state: HexEngineState;
  /** Counts announcements, so saying the same thing twice is two of them. */
  private announcements = 0;

  constructor(options: HexEngineOptions) {
    this.source = toByteSource(options.source);
    this.unsubscribeSource = this.source.subscribe((changes) => this.onSourceChanged(changes));
    this.bytesPerRow = options.bytesPerRow ?? defaultBytesPerRow;
    this.rowHeight = options.rowHeight ?? defaultRowHeight;
    this.addressRadix = options.addressRadix ?? "hex";
    this.byteGroup = options.byteGroup ?? 1;
    this.font = options.font;
    this.asciiColumn = options.asciiColumn ?? true;
    this.labelWidth = options.labelWidth;
    this.spacing = options.spacing;
    this.searchProvider = options.searchProvider ?? defaultSearchProvider;
    this.onSearchRequest = options.onSearchRequest;
    this.platform = resolvePlatform(options.platform);
    this.strings = resolveText(options.text);
    // Before the state, because an unhonourable keymap should throw out of the
    // constructor rather than leave a half-built engine behind.
    this.keys = resolveKeymap(this.platform, options.keymap, this.strings);
    this.theme = options.theme;
    this.display = options.display;
    // Walked once per option change rather than per byte per frame.
    this.printableChars = options.printable ? printableTable(options.printable) : defaultPrintableChars;
    this.searchLimit = options.searchMatchLimit ?? searchMatchLimit;
    this.searchPriority = options.searchPriority ?? defaultSearchPriority;
    this.onChange = options.onChange;
    this.onSelectionChange = options.onSelectionChange;
    this.onCursorChange = options.onCursorChange;
    this.onCopy = options.onCopy;
    this.state = {
      cursor: { offset: 0, nibble: 0, column: "hex" },
      selection: undefined,
      scrollTop: 0,
      scrollLeft: 0,
      viewportWidth: 0,
      viewportHeight: 0,
      revision: 0,
      editMode: options.editMode ?? "overwrite",
      canUndo: false,
      canRedo: false,
      decorationRevision: 0,
      ...resolveFeatures(options),
      searchOpen: false,
      searchMode: "hex",
      searchModes: options.searchModes ?? defaultSearchModes,
      searchQuery: "",
      searchError: undefined,
      searching: false,
      searchMatchCount: 0,
      searchMatchIndex: 0,
      searchTruncated: false,
      replaceOpen: false,
      replaceQuery: "",
      replaceMessage: undefined,
      replaceFailed: false,
      gotoOpen: false,
      gotoQuery: "",
      gotoError: undefined,
      announcement: undefined,
    };
    this.rebuildDerived();
  }

  // --- reactive surface ---------------------------------------------------

  /**
   * Called after every change, with no argument: read `getState()` for what it is
   * now. Returns the unsubscribe. A field rather than a method so a binding can
   * hand it straight to a store without binding `this`.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * The current state. Replaced rather than mutated on every change, so a binding
   * can compare identity to know whether anything moved.
   */
  getState = (): HexEngineState => this.state;

  private patch(next: Partial<HexEngineState>): void {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }

  /**
   * Length can change under us, so geometry and every held offset are rebuilt
   * from the change set rather than assumed stable.
   */
  private onSourceChanged(changes: ChangeSet): void {
    // An empty change set means bytes became resident, not that the document
    // changed: the geometry is the same and only a repaint is owed. Repainting on
    // each one turned a search over a paged 102 MB file into 400 full repaints,
    // most of them for pages nowhere near the viewport, and cost more than the
    // reads did.
    if (changes.isEmpty) {
      this.scheduleRepaint();
      return;
    }
    this.rebuildDerived();
    // Recorded here rather than in `commit`, so an undo, a redo or an edit applied
    // to the source from outside is tracked as well as a keystroke.
    this.recordDirty(changes);
    this.anchor = clampOffset(changes.mapPos(this.anchor), this.source.length);
    // Highlights are carried across the edit, but the set they came from is stale:
    // the bytes just written may match, or may have stopped matching.
    this.scannedKey = undefined;
    const decorationsMoved = this.decorationStore.map(changes);
    const selection = this.state.selection;
    const mapped = selection && { start: changes.mapPos(selection.start, 1), end: changes.mapPos(selection.end, -1) };
    this.patch({
      revision: this.state.revision + 1,
      decorationRevision: this.state.decorationRevision + (decorationsMoved ? 1 : 0),
      cursor: { ...this.state.cursor, offset: clampOffset(changes.mapPos(this.state.cursor.offset), this.source.length) },
      selection: mapped && mapped.end > mapped.start ? mapped : undefined,
      searchMatchCount: this.decorationStore.countOfKind(searchKind),
    });
    this.patch({ searchMatchIndex: this.matchIndexAt(this.state.cursor.offset) });
  }

  /** Coalesces "bytes arrived" repaints to one a frame. */
  private scheduleRepaint(): void {
    if (this.repaintScheduled) return;
    this.repaintScheduled = true;
    const flush = () => {
      this.repaintScheduled = false;
      this.patch({ revision: this.state.revision + 1 });
    };
    // A frame where there is one; a task where there is not, so a headless host
    // still gets the repaint rather than never seeing the bytes.
    if (typeof requestAnimationFrame === "function") this.repaintHandle = requestAnimationFrame(flush);
    else this.repaintHandle = setTimeout(flush, 0) as unknown as number;
  }

  private rebuildDerived(): void {
    this.cachedLayout = createLayout({
      bytesPerRow: this.bytesPerRow,
      byteLength: this.source.length,
      byteGroup: this.byteGroup,
      addressRadix: this.addressRadix,
      font: this.effectiveFont,
      asciiColumn: this.asciiColumn,
      labelGutter: this.labelsReserved,
      labelWidth: this.labelWidth,
      spacing: this.spacing,
    });
    this.cachedPlan = this.rowPlan ?? linearRowPlan(this.source.length, this.bytesPerRow);
    this.cachedScale = createScrollScale(this.totalRows, this.rowHeight, { viewportHeight: this.state.viewportHeight });
  }

  /**
   * Whether the row needs room for labels. A single range asking for its own
   * label counts, because a label outside the reserved gutter is past `width`
   * and nothing can scroll to it. A hosted decoration source cannot be consulted
   * — it answers windows, not totals — so a host using `setDecorationSource`
   * with per-range labels should set `display.decorationLabels` itself.
   */
  private get labelsReserved(): boolean {
    return (this.display?.decorationLabels ?? false) || this.decorationStore.hasVisibleLabels;
  }

  private get effectiveTheme(): HexTheme | undefined {
    return this.theme ?? this.cssTheme;
  }

  private get effectiveFont(): string | undefined {
    return this.font ?? this.cssFont;
  }

  /**
   * Resolves `--hexcanvas-*` custom properties declared on or above `element`
   * into the canvas theme and grid font, so one CSS declaration colours both
   * the DOM chrome and the painted grid. Call it again when the cascade could
   * have changed — a colour-scheme switch, or a web font finishing loading.
   */
  adoptStyles(element: Element, options: { remeasureFont?: boolean } = {}): void {
    this.styleHost = element;
    const font = readFont(element);
    const fontChanged = font !== this.cssFont;
    if (options.remeasureFont) invalidateFontMetrics();
    this.cssTheme = readTheme(element);
    this.cssFont = font;
    if (fontChanged || options.remeasureFont) this.rebuildDerived();
    this.patch({ revision: this.state.revision + 1 });
  }

  /**
   * Re-reads the custom properties from the element last passed to
   * `adoptStyles`. Colour-scheme changes are picked up by the binding; call
   * this after changing the variables yourself, since watching every attribute
   * that could affect the cascade would cost more than it is worth.
   */
  refreshTheme(options: { remeasureFont?: boolean } = {}): void {
    if (this.styleHost) this.adoptStyles(this.styleHost, options);
  }

  // --- geometry -----------------------------------------------------------

  /**
   * Column geometry: address width, byte and nibble positions, where the text column
   * starts, and the inverse mapping the hit test uses.
   */
  get layout(): HexLayout {
    return this.cachedLayout;
  }

  /** Rows the document occupies under the current plan. */
  get totalRows(): number {
    return this.cachedPlan.rows;
  }

  /**
   * Which bytes each row shows. Replaced by a comparison so a shift can be drawn
   * as a gap; see `RowPlan`. Undefined puts back the usual arithmetic.
   */
  setRowPlan(plan: RowPlan | undefined): void {
    if (plan === this.rowPlan) return;
    this.rowPlan = plan;
    this.rebuildDerived();
    this.patch({ revision: this.state.revision + 1 });
  }

  /**
   * The row plan in force: how many rows, what each shows, and which row an offset is
   * on. A comparison supplies one that keeps two panes level across an insertion.
   */
  get plan(): RowPlan {
    return this.cachedPlan;
  }

  /** Height the host spacer needs so the scroller can reach every row. */
  get scrollHeight(): number {
    return this.cachedScale.height;
  }

  /**
   * Width the host needs to make scrollable so every column can be reached. One
   * row's content width: rows are all the same width, so nothing is scaled here.
   */
  get scrollWidth(): number {
    return this.cachedLayout.width;
  }

  /** Furthest right the view can go before the last column is at the edge. */
  get maxScrollLeft(): number {
    return Math.max(0, this.cachedLayout.width - this.state.viewportWidth);
  }

  /**
   * `scrollTop` translated back into document coordinates. The two differ because a
   * document taller than a browser will scroll is compressed into the range it allows.
   */
  get logicalScrollTop(): number {
    return this.cachedScale.toLogical(this.state.scrollTop);
  }

  /** The rows the viewport covers at the current scroll position. */
  get visibleRows(): VisibleRows {
    return rowsIn(this.cachedPlan.rows, {
      rowHeight: this.rowHeight,
      height: this.state.viewportHeight,
      scrollTop: this.logicalScrollTop,
    });
  }

  // --- host updates -------------------------------------------------------

  /**
   * The source in force, which `setSource` could set but nothing could read
   * back. Exposed for a coordinator that has to watch the document rather than
   * the view — a comparison goes stale on an edit, and `subscribe` here reports
   * repaints as well as changes, so it cannot tell the two apart.
   */
  get byteSource(): ByteSource {
    return this.source;
  }

  /** Replaces the document, moving the subscription with it. */
  setSource(source: ByteSource | BinaryBuffer): void {
    const next = toByteSource(source);
    if (this.source === next) return;
    this.unsubscribeSource();
    this.source = next;
    this.unsubscribeSource = this.source.subscribe((changes) => this.onSourceChanged(changes));
    this.history.clear();
    this.markSaved();
    this.patch({ canUndo: false, canRedo: false });
    this.rebuildDerived();
    this.clearMatches();
    this.patch({ cursor: { offset: 0, nibble: 0, column: "hex" }, selection: undefined, scrollLeft: 0, revision: this.state.revision + 1 });
  }

  /**
   * Replaces every option except the source. Anything omitted returns to its default
   * rather than keeping its current value.
   */
  setOptions(options: Omit<HexEngineOptions, "source">): void {
    this.bytesPerRow = options.bytesPerRow ?? defaultBytesPerRow;
    this.rowHeight = options.rowHeight ?? defaultRowHeight;
    this.addressRadix = options.addressRadix ?? "hex";
    this.byteGroup = options.byteGroup ?? 1;
    this.font = options.font;
    this.asciiColumn = options.asciiColumn ?? true;
    this.labelWidth = options.labelWidth;
    this.spacing = options.spacing;
    this.searchProvider = options.searchProvider ?? defaultSearchProvider;
    this.onSearchRequest = options.onSearchRequest;
    // Resolved into a local first: a keymap that cannot be honoured must leave the
    // engine on its previous one rather than half-updated.
    const platform = resolvePlatform(options.platform);
    const strings = resolveText(options.text);
    const keys = resolveKeymap(platform, options.keymap, strings);
    this.platform = platform;
    this.strings = strings;
    this.keys = keys;
    this.theme = options.theme;
    this.display = options.display;
    // Walked once per option change rather than per byte per frame.
    this.printableChars = options.printable ? printableTable(options.printable) : defaultPrintableChars;
    this.searchLimit = options.searchMatchLimit ?? searchMatchLimit;
    this.searchPriority = options.searchPriority ?? defaultSearchPriority;
    this.onChange = options.onChange;
    this.onSelectionChange = options.onSelectionChange;
    this.onCursorChange = options.onCursorChange;
    this.onCopy = options.onCopy;
    this.rebuildDerived();
    const features = resolveFeatures(options);
    this.patch({
      ...features,
      searchModes: options.searchModes ?? defaultSearchModes,
      // A panel that no longer exists cannot be left open, and its highlights
      // would outlive the only thing that could clear them.
      ...(features.searchFeature === "native" ? {} : { searchOpen: false, replaceOpen: false }),
      ...(features.gotoFeature === "native" ? {} : { gotoOpen: false }),
      // The cursor cannot sit in a column that is not drawn; see `legalColumn`.
      cursor: { ...this.state.cursor, column: this.legalColumn(this.state.cursor.column) },
    });
    if (features.searchFeature === "off") this.clearMatches();
    // Left alone when omitted, so a host that drives the mode elsewhere does not
    // have to repeat it on every options update.
    this.patch(options.editMode ? { editMode: options.editMode } : {});
    // Fewer bytes per row, or a narrower font, can shorten the grid.
    this.setScrollLeft(this.state.scrollLeft);
  }

  /**
   * The size of the scrollport, in CSS pixels. The scroll range is measured against
   * this, so a height change rescales it.
   */
  setViewportSize(width: number, height: number): void {
    if (width === this.state.viewportWidth && height === this.state.viewportHeight) return;
    // The scroll range is measured against the viewport, so its height rescales it.
    const rescale = height !== this.state.viewportHeight;
    this.state = { ...this.state, viewportWidth: width, viewportHeight: height };
    if (rescale) this.rebuildDerived();
    // A wider viewport can leave the horizontal offset past the last column.
    this.state = { ...this.state, scrollLeft: Math.min(this.state.scrollLeft, this.maxScrollLeft) };
    this.patch({});
  }

  /**
   * Vertical scroll, in the scroller's own coordinates rather than in bytes — read
   * `logicalScrollTop` for the document position it lands on.
   */
  setScrollTop(scrollTop: number): void {
    if (scrollTop === this.state.scrollTop) return;
    this.patch({ scrollTop });
  }

  /** Horizontal scroll, in pixels, clamped to the widest row. */
  setScrollLeft(scrollLeft: number): void {
    const next = Math.max(0, Math.min(scrollLeft, this.maxScrollLeft));
    if (next === this.state.scrollLeft) return;
    this.patch({ scrollLeft: next });
  }

  /**
   * Puts the row holding `offset` at the top of the viewport, without moving the
   * cursor. Distinct from `gotoOffset`, which moves the cursor and only scrolls
   * when the cursor would otherwise be off screen.
   *
   * The reason it exists is keeping two engines in step. `createScrollScale`
   * compresses each document against its own length, so two views of documents
   * of different lengths have different scales and copying `scrollTop` from one
   * to the other lands somewhere else in each. An offset means the same thing in
   * both.
   */
  scrollToOffset(offset: number): void {
    if (this.source.length === 0) return;
    this.scrollToRow(this.cachedPlan.rowOf(clampOffset(offset, this.source.length)));
  }

  /**
   * Puts `row` at the top of the viewport, without moving the cursor.
   *
   * The row rather than the offset is what two panes of a comparison have in
   * common. Once a `RowPlan` puts corresponding bytes on the same line, the two
   * documents' offsets no longer agree — that is the whole point of the plan —
   * so going through one would land the other a shift away from where it was
   * asked for. Row `r` means the same line in both.
   */
  scrollToRow(row: number): void {
    const clamped = Math.max(0, Math.min(row, this.cachedPlan.rows - 1));
    const maximum = Math.max(0, this.scrollHeight - this.state.viewportHeight);
    const scrollTop = Math.max(0, Math.min(this.cachedScale.fromLogical(clamped * this.rowHeight), maximum));
    if (scrollTop === this.state.scrollTop) return;
    this.patch({ scrollTop });
  }

  // --- cursor and selection ----------------------------------------------

  /**
   * The one place the cursor's column is sanitised. With the plain-text column
   * off there is nothing at `asciiX`, so a cursor left there would be invisible
   * and would still take typed characters as bytes.
   */
  private legalColumn(column: Cursor["column"]): Cursor["column"] {
    return column === "ascii" && !this.cachedLayout.asciiColumn ? "hex" : column;
  }

  private applyCursor(input: Cursor, selection: ByteSelection | undefined): void {
    const cursor: Cursor = { ...input, column: this.legalColumn(input.column) };
    const moved = cursor.offset !== this.state.cursor.offset || cursor.column !== this.state.cursor.column;
    this.patch({ cursor, selection, searchMatchIndex: this.matchIndexAt(cursor.offset) });
    this.onSelectionChange?.(selection);
    if (moved) this.onCursorChange?.(cursor);
    this.ensureCursorVisible();
  }

  /** Drops the selection and leaves the cursor where it is. */
  clearSelection(): void {
    if (!this.state.selection) return;
    this.anchor = this.state.cursor.offset;
    this.applyCursor(this.state.cursor, undefined);
  }

  /**
   * A text alternative for the painted cursor, for a live region: the grid is
   * pixels, so without this a screen reader has nothing at all to read.
   */
  describeCursor(): string {
    const { cursor, selection } = this.state;
    const parts = [this.cachedLayout.formatAddress(cursor.offset)];
    const byte = this.source.peek(cursor.offset, 1)?.[0];
    if (byte === undefined) parts.push(this.strings.cursorByteNotLoaded);
    else {
      parts.push(this.strings.cursorByte(byte.toString(16).padStart(2, "0").toUpperCase()));
      // The same glyph the grid drew, so what is announced is what is shown.
      const character = this.printableChars[byte]!;
      if (character !== substituteChar) parts.push(this.strings.cursorCharacter(character));
    }
    parts.push(cursor.column === "hex" ? this.strings.cursorHexColumn : this.strings.cursorTextColumn);
    if (selection) parts.push(this.strings.cursorSelection(selection.end - selection.start));
    return parts.join(", ");
  }

  /**
   * A whole row as a sentence, the cursor's by default.
   *
   * The cursor description answers "where am I"; this answers "what is on this
   * line", which is the question the grid answers for free by being visible.
   * Asked for rather than announced as you move, because a row spoken on every
   * arrow key is sixteen bytes of noise between you and the next keystroke.
   */
  describeRow(row: number = this.cachedPlan.rowOf(this.state.cursor.offset)): string {
    const span = this.cachedPlan.at(row);
    const length = Math.max(0, Math.min(span.length, this.source.length - span.offset));
    // A comparison pads the shorter side, and a padded row is not a row of
    // bytes that failed to load — it is a row that is not anywhere.
    if (length === 0) return this.strings.rowGap;
    const address = this.cachedLayout.formatAddress(span.offset);
    const bytes = this.source.peek(span.offset, length);
    if (!bytes) {
      // Ask for it on the way out. The viewport is resident because it is
      // painted, so this is the rare case — a row scrolled past by a host
      // driving the engine, or a source mid-fetch — and asking means the second
      // press answers rather than repeating the same complaint.
      void this.source.ensure(span.offset, length);
      return this.strings.rowNotLoaded(address);
    }
    const rowBytes = bytes.subarray(0, length);
    const text = this.cachedLayout.asciiColumn
      ? Array.from(rowBytes, (byte) => this.printableChars[byte]!).join("")
      : "";
    return this.strings.rowDescription(address, hexOf(rowBytes), text);
  }

  /**
   * What the cursor is inside, on demand: the selection if there is one, and
   * otherwise the ranges decorated where it stands — a parsed field, a bookmark,
   * a search hit.
   *
   * The two in one command because they are one question. A reader who has just
   * selected something wants the selection read back; a reader who has not is
   * asking what this byte belongs to, and answering "nothing is selected" to
   * that would be true and useless.
   */
  describeRegion(): string {
    const { selection, cursor } = this.state;
    if (selection) {
      const length = selection.end - selection.start;
      const shown = Math.min(length, readAloudBytes);
      const bytes = this.source.peek(selection.start, shown);
      return this.strings.regionSelection(
        this.cachedLayout.formatAddress(selection.start),
        // The last selected byte rather than the one after it: that is the
        // address a reader can go to and find themselves still inside.
        this.cachedLayout.formatAddress(selection.end - 1),
        length,
        bytes ? hexOf(bytes.subarray(0, shown)) : this.strings.cursorByteNotLoaded,
        length > shown,
      );
    }
    // Topmost first, which is the order `decorationsAt` answers in, and only the
    // first few: nesting is a parse tree and reading a whole path from the file
    // header down to the byte is not an answer anybody waited for.
    const found = this.decorationsAt(cursor.offset).slice(0, readAloudRegions);
    if (found.length === 0) return this.strings.nothingToRead;
    return found.map((decoration) => this.strings.regionDecoration(
      decoration.label ?? decoration.kind ?? this.strings.unnamedRegion,
      this.cachedLayout.formatAddress(decoration.start),
      this.cachedLayout.formatAddress(decoration.end - 1),
    )).join(", ");
  }

  /**
   * Says something in the editor's live region, over the cursor description
   * until the next state change replaces it.
   *
   * Public because a host with chrome of its own has things to say that the
   * engine does not know about — a parse finished, a file loaded — and the
   * alternative is every host building a live region beside the one that is
   * already there, which is two things talking over each other.
   */
  announce(text: string): void {
    if (text === "") return;
    this.announcements += 1;
    this.patch({ announcement: { text, serial: this.announcements } });
  }

  /** Moves the cursor and drops the selection. The offset is clamped to the document. */
  moveCursor(offset: number, column = this.state.cursor.column, nibble: 0 | 1 = 0): void {
    const next: Cursor = { offset: clampOffset(offset, this.source.length), column, nibble };
    this.anchor = next.offset;
    this.applyCursor(next, undefined);
  }

  /** Moves the cursor while keeping the selection anchor, for shift-navigation. */
  extendSelectionTo(offset: number): void {
    const target = clampOffset(offset, this.source.length);
    this.applyCursor({ ...this.state.cursor, offset: target, nibble: 0 }, normalizedSelection(this.anchor, target));
  }

  /**
   * Selects a byte range from outside — the other half of a structure view,
   * where clicking a field has to highlight the bytes it covers. `"keep"` leaves
   * the cursor alone when it already lies inside the range, which is what a host
   * driving the cursor and the selection as separate inputs needs: otherwise
   * whichever it assigned second would decide where the cursor ended up.
   */
  select(start: number, end: number, cursorAt: "start" | "end" | "keep" = "end"): void {
    const length = this.source.length;
    if (length === 0) return;
    const from = clampOffset(Math.min(start, end), length);
    const to = Math.min(Math.max(Math.max(start, end), from + 1), length);
    const current = this.state.cursor.offset;
    const offset = cursorAt === "start" ? from
      : cursorAt === "keep" && current >= from && current < to ? current
      : clampOffset(to - 1, length);
    this.anchor = from;
    this.applyCursor({ ...this.state.cursor, offset, nibble: 0 }, { start: from, end: to });
  }

  /** Selects the whole document. */
  selectAll(): void {
    if (this.source.length === 0) return;
    this.anchor = 0;
    this.applyCursor({ ...this.state.cursor, offset: 0, nibble: 0 }, { start: 0, end: this.source.length });
  }

  /** Moves the cursor to an offset, clamped to the document. */
  gotoOffset(offset: number): void {
    this.moveCursor(offset);
  }

  /**
   * Accepts `0x1f`, `$1f`, or bare digits read in the current address radix.
   * Returns false when the text is not an address.
   */
  gotoAddress(text: string): boolean {
    const trimmed = text.trim().replace(/[\s_,]/g, "");
    if (!trimmed) return false;
    const prefixed = /^(0x|\$)/i.test(trimmed);
    const digits = prefixed ? trimmed.slice(trimmed.startsWith("$") ? 1 : 2) : trimmed;
    const radix = prefixed || this.addressRadix === "hex" ? 16 : 10;
    if (!(radix === 16 ? /^[0-9a-f]+$/i : /^[0-9]+$/).test(digits)) return false;
    const offset = Number.parseInt(digits, radix);
    if (!Number.isFinite(offset)) return false;
    this.moveCursor(offset);
    return true;
  }

  // --- decorations --------------------------------------------------------

  /**
   * Every decoration of every kind, in document order. Builds an object per range;
   * `decorationsBetween` answers a window instead.
   */
  get decorations(): readonly Decoration[] {
    return this.decorationStore.all;
  }

  /**
   * Adds one range and hands it back with the id it was given. A parse result goes
   * through `setDecorations`, which replaces a whole kind in one repaint.
   */
  addDecoration(decoration: DecorationInput): Decoration {
    const added = this.decorationStore.add(decoration);
    this.bumpDecorations();
    return added;
  }

  /**
   * One repaint for the whole batch; a parse result can be thousands of ranges.
   * Returns how many landed rather than the ranges themselves — handing back an
   * object per range is the cost the store exists to avoid.
   */
  addDecorations(decorations: readonly DecorationInput[]): number {
    if (decorations.length === 0) return 0;
    const added = this.decorationStore.addAll(decorations);
    this.bumpDecorations();
    return added;
  }

  /** Replaces every decoration of `kind`, or all of them when kind is omitted. */
  setDecorations(decorations: readonly DecorationInput[], kind?: string): number {
    const added = this.decorationStore.replace(decorations, kind);
    this.bumpDecorations();
    return added;
  }

  /**
   * Hands a kind over to the host: it owns those offsets and is asked per window
   * rather than copying every range in. That is the difference between a parse of
   * a 3 GB file costing the editor a viewport and costing it the parse.
   *
   * `between` is synchronous because the renderer calls it inside a frame, so it
   * answers with what the host knows — exactly the contract `peek` has for bytes.
   * When the host learns more, `invalidateDecorations(kind)` asks for a repaint.
   *
   * Two things the host takes on with this. Offsets are no longer carried across
   * edits for it: `mapPos` only moves what the store holds, so a host source has
   * to remap itself from `onChange`. And a kind belongs to one source — passing
   * `undefined` gives it back.
   */
  setDecorationSource(kind: string, source: DecorationQuery | undefined): void {
    if (source) this.decorationSources.set(kind, source);
    else if (!this.decorationSources.delete(kind)) return;
    this.aggregateQuery = undefined;
    this.bumpDecorations();
  }

  /** Kinds currently answered by the host rather than by the store. */
  get hostedKinds(): readonly string[] {
    return [...this.decorationSources.keys()];
  }

  /**
   * How many ranges of a kind there are, or of every kind when it is omitted,
   * without building any of them — the counterpart to `decorations`, which makes
   * an object per range.
   *
   * Counts what the store holds. A kind handed over with `setDecorationSource`
   * answers windows rather than totals, so there is nothing to ask it.
   */
  decorationCount(kind?: string): number {
    return kind === undefined ? this.decorationStore.size : this.decorationStore.countOfKind(kind);
  }

  /**
   * Repaints because a source can answer more than it could before — the other
   * half of the `peek`/`ensure` split, for decorations instead of bytes.
   */
  invalidateDecorations(_kind?: string): void {
    this.bumpDecorations();
  }

  /** Ranges covering an offset, innermost first. Store and host sources together. */
  decorationsAt(offset: number, kind?: string): DecorationInput[] {
    return this.decorationsBetween(offset, offset + 1, kind).sort((left, right) => byPaintOrder(right, left));
  }

  /**
   * Ranges overlapping `[from, to)`, in document order — what a host asks to find
   * out what is highlighted in the viewport, or inside the selection.
   */
  decorationsBetween(from: number, to: number, kind?: string): DecorationInput[] {
    const found: DecorationInput[] = kind === undefined || !this.decorationSources.has(kind)
      ? [...this.decorationStore.between(from, to)]
      : [];
    for (const [sourceKind, source] of this.decorationSources) {
      if (kind !== undefined && kind !== sourceKind) continue;
      for (const item of source.between(from, to)) found.push(stampKind(item, sourceKind));
    }
    const matching = kind === undefined ? found : found.filter((item) => item.kind === kind);
    return matching.sort((left, right) => left.start - right.start);
  }

  /** Removes one range by id. False when nothing had that id. */
  removeDecoration(id: string): boolean {
    const removed = this.decorationStore.remove(id);
    if (removed) this.bumpDecorations();
    return removed;
  }

  /** Removes one kind, or every decoration when no kind is named. */
  clearDecorations(kind?: string): void {
    this.decorationStore.clear(kind);
    this.bumpDecorations();
  }

  private get decorationQuery(): DecorationQuery {
    if (this.decorationSources.size === 0) return this.decorationStore;
    this.aggregateQuery ??= {
      between: (from, to) => {
        const found: DecorationInput[] = [...this.decorationStore.between(from, to)];
        for (const [kind, source] of this.decorationSources) {
          for (const item of source.between(from, to)) found.push(stampKind(item, kind));
        }
        return found;
      },
    };
    return this.aggregateQuery;
  }

  private bumpDecorations(): void {
    // A range that asks for its own label changes the row width, so the geometry
    // has to be rebuilt before the repaint that would otherwise clip it away.
    if (this.cachedLayout.labelWidth > 0 !== this.labelsReserved) this.rebuildDerived();
    this.patch({ decorationRevision: this.state.decorationRevision + 1 });
  }

  // --- bookmarks ----------------------------------------------------------

  /**
   * Every bookmark, in document order. Builds an object per bookmark — `bookmarkCount`
   * answers how many without building any.
   */
  bookmarks(): Decoration[] {
    return this.decorationStore.ofKind(bookmarkKind);
  }

  /**
   * How many bookmarks there are, without building any of them. `bookmarks()`
   * materialises an object per range, which is the wrong price for a status bar
   * that only wants a number and repaints on every cursor move.
   */
  get bookmarkCount(): number {
    return this.decorationCount(bookmarkKind);
  }

  /** Returns true when a bookmark was added, false when one was removed. */
  toggleBookmark(offset = this.state.cursor.offset, label?: string): boolean {
    const target = clampOffset(offset, this.source.length);
    const existing = this.decorationStore.at(target, bookmarkKind);
    if (existing) {
      this.removeDecoration(existing.id);
      return false;
    }
    this.addDecoration({
      start: target,
      end: target + 1,
      kind: bookmarkKind,
      label: label ?? this.cachedLayout.formatAddress(target),
    });
    return true;
  }

  /** Moves to the next bookmark after the cursor, wrapping. False when there are none. */
  nextBookmark(): boolean {
    const marks = this.bookmarks();
    if (marks.length === 0) return false;
    const current = this.state.cursor.offset;
    this.moveCursor((marks.find((mark) => mark.start > current) ?? marks[0]!).start);
    return true;
  }

  /** Moves to the bookmark before the cursor, wrapping. False when there are none. */
  previousBookmark(): boolean {
    const marks = this.bookmarks();
    if (marks.length === 0) return false;
    const current = this.state.cursor.offset;
    let target = marks[marks.length - 1]!;
    for (const mark of marks) {
      if (mark.start >= current) break;
      target = mark;
    }
    this.moveCursor(target.start);
    return true;
  }

  // --- clipboard ----------------------------------------------------------

  /** Selected bytes as text; falls back to the cursor byte when nothing is selected. */
  selectionText(format: "hex" | "text" = "hex"): string {
    const range = this.state.selection ?? { start: this.state.cursor.offset, end: this.state.cursor.offset + 1 };
    const end = Math.min(range.end, this.source.length);
    if (end <= range.start) return "";
    const bytes = this.source.peek(range.start, end - range.start);
    if (!bytes) return "";
    // The column as it is drawn, not ASCII regardless: copying a CP437 view
    // used to hand back a row of dots for the half of it that has glyphs.
    if (format === "text") return Array.from(bytes, (byte) => this.printableChars[byte]!).join("");
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(" ");
  }

  /** Copies in the format of the active column: hex on the left, text on the right. */
  copySelection(): string {
    const text = this.selectionText(this.state.cursor.column === "ascii" ? "text" : "hex");
    if (text) this.onCopy?.(text);
    return text;
  }

  /**
   * Scrolls only far enough to put the cursor row fully in view. Rows can be
   * partly visible now that the scroll offset is not snapped, so visibility is
   * decided in pixels rather than by counting rows.
   */
  private ensureCursorVisible(): void {
    this.ensureCursorRowVisible();
    this.ensureCursorColumnVisible();
  }

  private ensureCursorRowVisible(): void {
    const height = this.state.viewportHeight;
    if (height === 0 || this.source.length === 0) return;
    const top = this.logicalScrollTop;
    const cursorTop = this.cachedPlan.rowOf(this.state.cursor.offset) * this.rowHeight;
    const cursorBottom = cursorTop + this.rowHeight;
    const target = cursorTop < top ? cursorTop : cursorBottom > top + height ? cursorBottom - height : undefined;
    if (target === undefined) return;
    const maximum = Math.max(0, this.scrollHeight - height);
    this.patch({ scrollTop: Math.max(0, Math.min(this.cachedScale.fromLogical(target), maximum)) });
  }

  /**
   * The horizontal half. The address column is painted over the grid rather than
   * scrolling with it, so the window a cell has to fit into starts after it —
   * scrolling a byte to `scrollLeft` exactly would park it under the addresses.
   */
  private ensureCursorColumnVisible(): void {
    const width = this.state.viewportWidth;
    if (width === 0 || this.source.length === 0) return;
    const layout = this.cachedLayout;
    const index = this.cachedPlan.indexOf(this.state.cursor.offset);
    const onHex = this.state.cursor.column === "hex";
    const cellLeft = (onHex ? layout.byteX(index) : layout.asciiX(index)) - 2;
    const cellRight = onHex ? layout.byteX(index) + layout.charWidth * 3 : layout.asciiX(index) + layout.charWidth + 2;
    const left = this.state.scrollLeft;
    const target = cellLeft < left + layout.addressWidth
      ? cellLeft - layout.addressWidth
      : cellRight > left + width
        ? cellRight - width
        : undefined;
    if (target === undefined) return;
    this.patch({ scrollLeft: Math.max(0, Math.min(target, this.maxScrollLeft)) });
  }

  // --- pointer ------------------------------------------------------------

  /** Coordinates are relative to the top-left of the viewport, not of the grid. */
  hitTest(x: number, y: number): { offset: number; column: Cursor["column"]; region: "address" | "hex" | "ascii" } {
    const row = Math.floor((this.logicalScrollTop + y) / this.rowHeight);
    // The address column stays put while the grid moves under it, so a click
    // inside it is on the gutter whatever the horizontal offset is.
    const hit = x < this.cachedLayout.addressWidth
      ? { region: "address" as const, index: 0 }
      : this.cachedLayout.hitTest(x + this.state.scrollLeft);
    return {
      offset: clampOffset(this.cachedPlan.at(row).offset + hit.index, this.source.length),
      column: hit.region === "ascii" ? "ascii" : "hex",
      region: hit.region,
    };
  }

  /** Call for the primary button only; a secondary click must not select. */
  pointerDown(x: number, y: number): void {
    const hit = this.hitTest(x, y);
    if (hit.region === "address") {
      // The address column doubles as a bookmark gutter.
      this.toggleBookmark(hit.offset);
      this.moveCursor(hit.offset);
      return;
    }
    this.dragging = true;
    this.anchor = hit.offset;
    this.applyCursor({ offset: hit.offset, nibble: 0, column: hit.column }, undefined);
  }

  /**
   * `buttonsHeld` ends a drag whose release was never delivered — a context
   * menu can swallow the pointerup, and a drag left running turns the next
   * plain click into a selection sweep.
   */
  pointerMove(x: number, y: number, buttonsHeld = true): void {
    if (!this.dragging) return;
    if (!buttonsHeld) {
      this.dragging = false;
      return;
    }
    const hit = this.hitTest(x, y);
    this.applyCursor({ offset: hit.offset, nibble: 0, column: hit.column }, normalizedSelection(this.anchor, hit.offset));
  }

  /** Ends a drag. */
  pointerUp(): void {
    this.dragging = false;
  }

  /** True between `pointerDown` and `pointerUp`. */
  get isDragging(): boolean {
    return this.dragging;
  }

  // --- editing ------------------------------------------------------------

  /** Sets the edit mode. The editor never changes it itself — see `EditMode`. */
  setEditMode(editMode: EditMode): void {
    this.patch({ editMode });
  }

  /** Derived from the mode; there is no separate read-only input to set. */
  get readOnly(): boolean {
    return this.state.editMode === "read-only";
  }

  /** True when the mode allows edits and the source accepts them. */
  get editable(): boolean {
    return !this.readOnly && typeof this.source.apply === "function";
  }

  private commit(changes: ChangeSet, coalesce = false): boolean {
    if (!this.editable) return false;
    if (!this.throughHistory(() => this.history.push(this.source, changes, coalesce))) return false;
    this.patch({ canUndo: this.history.canUndo, canRedo: this.history.canRedo });
    this.onChange?.(changes);
    return true;
  }

  /**
   * Runs a history operation, and settles what it did to the saved point after
   * it has finished rather than while it is happening.
   *
   * Both halves matter. `recordDirty` runs from the source's own notification,
   * which arrives *inside* `push` — before the entry it is pushing exists — so
   * the state id during the callback is the one before the edit, and comparing
   * it there would call the first edit after a save clean and lose it. And the
   * flag is how an edit the engine made is told from one a host applied to the
   * source behind it, which is the only case where a history position stops
   * describing what is on disk.
   */
  private throughHistory<T>(operation: () => T): T {
    this.applyingHistory = true;
    try {
      return operation();
    } finally {
      this.applyingHistory = false;
      if (this.savedState !== undefined && this.history.stateId === this.savedState) {
        this.dirty = [];
        this.lengthChanged = false;
      }
    }
  }

  /**
   * Overwrites one byte, merging with the write before it so a run of typing undoes in
   * one step. Does nothing when the byte already holds that value or is not resident.
   */
  writeByte(offset: number, value: number): void {
    const previous = this.source.peek(offset, 1)?.[0];
    if (previous === undefined || previous === value) return;
    this.commit(ChangeSet.replace(offset, offset + 1, Uint8Array.of(value)), true);
  }

  /** `coalesce` merges with the previous step, which is what typing wants. */
  insertBytes(bytes: Uint8Array, at = this.state.cursor.offset, coalesce = false): void {
    if (bytes.length === 0) return;
    const selection = this.state.selection;
    const changes = selection
      ? ChangeSet.replace(selection.start, Math.min(selection.end, this.source.length), bytes)
      : ChangeSet.insert(clampInsertPoint(at, this.source.length), bytes);
    const start = changes.changes[0]!.from;
    if (this.commit(changes, coalesce && !selection)) this.moveCursor(start + bytes.length);
  }

  /** Deletes the selection. False when nothing is selected. */
  deleteSelection(): boolean {
    const selection = this.state.selection;
    if (!selection || selection.end <= selection.start) return false;
    const start = selection.start;
    if (!this.commit(ChangeSet.remove(start, Math.min(selection.end, this.source.length)))) return false;
    this.moveCursor(start);
    return true;
  }

  /**
   * Deletes the selection, or the byte under the cursor when there is none. False
   * when there was nothing to delete.
   */
  deleteForward(): boolean {
    if (this.deleteSelection()) return true;
    const offset = this.state.cursor.offset;
    if (offset >= this.source.length) return false;
    if (!this.commit(ChangeSet.remove(offset, offset + 1))) return false;
    this.moveCursor(offset);
    return true;
  }

  /**
   * Deletes the selection, or the byte before the cursor when there is none. False
   * when there was nothing to delete.
   */
  deleteBackward(): boolean {
    if (this.deleteSelection()) return true;
    const offset = this.state.cursor.offset;
    if (offset === 0) return false;
    if (!this.commit(ChangeSet.remove(offset - 1, offset))) return false;
    this.moveCursor(offset - 1);
    return true;
  }

  /** Copies the selection and then deletes it. */
  cut(): void {
    this.copySelection();
    this.deleteSelection();
  }

  /**
   * Interprets the text the way the active column reads bytes: hex digits on
   * the left, characters on the right.
   */
  paste(text: string): boolean {
    let bytes: Uint8Array;
    if (this.state.cursor.column === "hex") {
      try {
        bytes = parseHexQuery(text);
      } catch {
        return false;
      }
    } else {
      bytes = new TextEncoder().encode(text);
    }
    if (bytes.length === 0) return false;
    if (this.state.editMode === "overwrite" && !this.state.selection) {
      const at = this.state.cursor.offset;
      const room = Math.min(bytes.length, this.source.length - at);
      if (room <= 0) return false;
      if (!this.commit(ChangeSet.replace(at, at + room, bytes.subarray(0, room)))) return false;
      this.moveCursor(at + room);
      return true;
    }
    this.insertBytes(bytes);
    return true;
  }

  /**
   * Undoes the last step and moves the cursor to it. False when there is nothing to
   * undo, or the document is read-only.
   */
  undo(): boolean {
    if (!this.editable) return false;
    const applied = this.throughHistory(() => this.history.undo(this.source));
    if (!applied) return false;
    this.patch({ canUndo: this.history.canUndo, canRedo: this.history.canRedo });
    this.onChange?.(applied);
    this.moveCursor(applied.changes[0]?.from ?? this.state.cursor.offset);
    return true;
  }

  /**
   * Redoes the step last undone and moves the cursor to it. False when there is
   * nothing to redo, or the document is read-only.
   */
  redo(): boolean {
    if (!this.editable) return false;
    const applied = this.throughHistory(() => this.history.redo(this.source));
    if (!applied) return false;
    this.patch({ canUndo: this.history.canUndo, canRedo: this.history.canRedo });
    this.onChange?.(applied);
    this.moveCursor(applied.changes[0]?.from ?? this.state.cursor.offset);
    return true;
  }

  /** Streams the whole document for writing out; undefined if unsupported. */
  save(): AsyncIterable<Uint8Array> | undefined {
    return this.source.save?.();
  }

  // --- reading back -------------------------------------------------------

  /**
   * The bytes of a range as the document has them **now**, or undefined when they
   * are not resident. A host that parsed the file already has the original; this
   * is for after an edit, when the piece table is the truth and the file on disk
   * is not.
   *
   * A copy, not a view: what `peek` returns can alias the source's own storage and
   * stops being valid at the next change.
   */
  read(offset: number, length: number): Uint8Array | undefined {
    if (length < 0 || offset < 0 || offset + length > this.source.length) return undefined;
    return this.source.peek(offset, length)?.slice();
  }

  /** Makes a range resident so `read` can answer it. The other half of the pair. */
  ensureRead(offset: number, length: number): Promise<void> {
    return this.source.ensure(offset, Math.max(0, Math.min(length, this.source.length - offset)));
  }

  // --- saving in place ----------------------------------------------------

  private recordDirty(changes: ChangeSet): void {
    // An edit applied to the source from outside the engine is not in the
    // history, so from here on a history position says nothing about what is on
    // disk and the saved point has to be given up. Conservative for good: it
    // comes back at the next `markSaved`, which is the moment the two agree
    // again.
    if (!this.applyingHistory) this.savedState = undefined;
    for (const change of changes.changes) {
      if (change.insert.length !== change.to - change.from) this.lengthChanged = true;
    }
    // Existing ranges are in pre-change coordinates until they are carried over.
    const moved = this.dirty.map((range) => ({ start: changes.mapPos(range.start, 1), end: changes.mapPos(range.end, -1) }));
    for (const change of changes.changes) {
      const start = changes.mapPos(change.from, -1);
      moved.push({ start, end: start + change.insert.length });
    }
    this.dirty = merge(moved.filter((range) => range.end > range.start));
  }

  /**
   * True while every edit so far replaced bytes with the same number of bytes.
   * One insert or delete anywhere shifts everything after it, so the original
   * cannot be patched and saving has to rewrite the whole document.
   */
  get lengthUnchanged(): boolean {
    return !this.lengthChanged;
  }

  /** Merged, in document order. Empty when nothing has been written. */
  get dirtyRanges(): readonly ByteSelection[] {
    return this.dirty;
  }

  /**
   * The changed ranges and their current bytes, for a host that can write into
   * the original — a file handle, a device, a remote range request. Undefined
   * once a length-changing edit has happened, which is the case `save()` is for.
   */
  savePatch(): AsyncGenerator<{ offset: number; bytes: Uint8Array }> | undefined {
    if (this.lengthChanged) return undefined;
    const ranges = [...this.dirty];
    const source = this.source;
    return (async function* patches() {
      for (const range of ranges) {
        const length = range.end - range.start;
        await source.ensure(range.start, length);
        const bytes = source.peek(range.start, length);
        if (bytes) yield { offset: range.start, bytes: bytes.slice() };
      }
    })();
  }

  /**
   * Call after writing the document out.
   *
   * Undoing back to here clears the ranges again — not by comparing bytes, which
   * would mean holding a copy of the document to compare against, but by
   * remembering which history state was written out. Being at that state is
   * proof the bytes match it, and it costs a number.
   *
   * Undoing *past* it does not: the document is then something the file has
   * never held, so the ranges it changed are owed a write like any other edit.
   * Neither does undoing part of the way back, where the bytes may well match
   * again and only a comparison could say so.
   */
  markSaved(): void {
    this.dirty = [];
    this.lengthChanged = false;
    this.savedState = this.history.stateId;
  }

  // --- search -------------------------------------------------------------

  /** Opens the editor's own panel. Nothing to open unless find is `"native"`. */
  openSearch(): void {
    if (this.state.searchFeature !== "native") return;
    this.patch({ searchOpen: true });
  }

  /** Closes the find panel and drops the highlighted hits with it. */
  closeSearch(): void {
    if (this.state.searchFeature === "off") return;
    this.patch({ searchOpen: false, replaceOpen: false });
    this.clearMatches();
  }

  /** The text in the find field, for a host driving the panel itself. */
  setSearchQuery(searchQuery: string): void {
    if (this.state.searchFeature === "off") return;
    this.patch({ searchQuery, searchError: undefined });
  }

  /** Which way the query is read: `"hex"`, `"text"`, or a mode a provider adds. */
  setSearchMode(searchMode: SearchMode): void {
    if (this.state.searchFeature === "off") return;
    this.patch({ searchMode, searchError: undefined });
  }

  /** Every hit currently highlighted, in document order. */
  get matches(): Decoration[] {
    return this.decorationStore.ofKind(searchKind);
  }

  /**
   * Highlights every hit, so a search reads as a map of the document rather than
   * one jump at a time.
   *
   * One scan per query, whoever asks: a finished scan is answered from the cache
   * and a scan in flight is handed back as it is. Without that, find-next and the
   * highlighting would read a large document twice for one key press.
   */
  findAllMatches(force = false): Promise<number> {
    if (this.state.searchFeature === "off") return Promise.resolve(0);
    const key = `${this.state.searchMode}:${this.state.searchQuery}`;
    if (!force && key === this.scannedKey) return Promise.resolve(this.state.searchMatchCount);
    if (!force && this.scanning && this.scanningKey === key) return this.scanning;
    this.scanAborter?.abort();
    this.scanAborter = typeof AbortController === "function" ? new AbortController() : undefined;
    const scan = this.scanMatches(key, ++this.scanGeneration, this.scanAborter?.signal);
    this.scanning = scan;
    this.scanningKey = key;
    void scan.finally(() => {
      if (this.scanningKey !== key) return;
      this.scanning = undefined;
      this.scanningKey = undefined;
    });
    return scan;
  }

  private async scanMatches(key: string, generation: number, signal?: AbortSignal): Promise<number> {
    if (this.state.searchQuery === "") {
      this.clearMatches();
      return 0;
    }
    this.patch({ searching: true });
    const found = await this.scanAll(signal);
    // A scan of a large document takes seconds, and the query can have moved on in
    // the meantime. Landing anyway would hang the previous query's hits on the new
    // one and mark them as scanned — and a superseded scan that failed or was
    // cancelled must not clear the newer one's hits either, which is why this is
    // ahead of the empty case rather than after it.
    if (generation !== this.scanGeneration) return this.state.searchMatchCount;
    if (!found) {
      this.clearMatches();
      this.patch({ searching: false });
      return 0;
    }
    this.scannedKey = key;
    this.decorationStore.replace(
      found.map((match) => ({ start: match.start, end: match.end, kind: searchKind, priority: this.searchPriority })),
      searchKind,
    );
    this.patch({
      searching: false,
      decorationRevision: this.state.decorationRevision + 1,
      searchMatchCount: found.length,
      searchMatchIndex: this.matchIndexAt(this.state.cursor.offset, found.length),
      searchTruncated: found.length >= this.searchLimit,
    });
    return found.length;
  }

  /** Drops the highlights; the next search rescans. */
  clearMatches(): void {
    // A scan still running is now for nothing, so stop it rather than only
    // discarding what it returns. The generation moves so it cannot land either.
    this.scanAborter?.abort();
    this.scanAborter = undefined;
    this.scanGeneration++;
    this.scannedKey = undefined;
    if (this.state.searchMatchCount === 0 && this.decorationStore.countOfKind(searchKind) === 0) return;
    this.decorationStore.clear(searchKind);
    this.patch({
      decorationRevision: this.state.decorationRevision + 1,
      searchMatchCount: 0,
      searchMatchIndex: 0,
      searchTruncated: false,
    });
  }

  /**
   * The provider's whole-document scan, or repeated `findNext` when it does not
   * offer one. Undefined means the query was rejected, and the complaint is
   * already in `searchError`.
   */
  private async scanAll(signal?: AbortSignal): Promise<SearchMatch[] | undefined> {
    const { searchMode, searchQuery } = this.state;
    try {
      if (this.searchProvider.findAll) {
        return await this.searchProvider.findAll(this.source, searchQuery, searchMode, this.searchLimit, signal);
      }
      const matched: SearchMatch[] = [];
      let from = 0;
      while (matched.length < this.searchLimit) {
        const match = await this.searchProvider.findNext(this.source, searchQuery, searchMode, from, signal);
        if (!match) break;
        matched.push(match);
        from = match.start + 1;
      }
      return matched;
    } catch (error) {
      // A cancelled scan is not a complaint. The query that superseded it is
      // about to report for itself, and saying "aborted" over its result would
      // be telling the user their live search had failed.
      if (isAbortError(error)) return undefined;
      this.patch({ searchError: message(error, this.strings.invalidQuery) });
      return undefined;
    }
  }

  /** 1-based, or 0 when the cursor is not inside a hit. */
  private matchIndexAt(offset: number, count = this.state.searchMatchCount): number {
    if (count === 0) return 0;
    // The ordinal, not the list: a thousand hits would otherwise be a thousand
    // objects built on every cursor move.
    return this.decorationStore.ordinalOfKindAt(searchKind, offset);
  }

  /**
   * Runs the current query, moving to the next hit in `direction`. Moves first and
   * highlights afterwards, so a nearby match lands without waiting for the scan.
   */
  async runSearch(direction: SearchDirection = "next"): Promise<void> {
    if (this.state.searchFeature === "off") return;
    const { searchMode, searchQuery } = this.state;
    if (searchQuery === "") {
      this.patch({ searchError: this.strings.emptyQuery });
      return;
    }
    const cursor = this.state.cursor.offset;
    this.patch({ searching: true, searchError: undefined });
    let match: SearchMatch | undefined;
    try {
      // Both directions wrap, so a search never dead-ends at the edge of the source.
      match = direction === "next"
        ? await this.searchProvider.findNext(this.source, searchQuery, searchMode, cursor + 1)
          ?? await this.searchProvider.findNext(this.source, searchQuery, searchMode, 0)
        : await this.searchProvider.findPrevious(this.source, searchQuery, searchMode, cursor)
          ?? await this.searchProvider.findPrevious(this.source, searchQuery, searchMode, this.source.length);
    } catch (error) {
      this.patch({ searching: false, searchError: message(error, this.strings.invalidQuery) });
      return;
    }
    this.patch({ searching: false });
    if (!match) {
      // The count and the highlights belong to the query that found something,
      // not to this one. Left standing they contradicted the complaint beside
      // them: "2/205" next to "No matching bytes", in the same strip of chrome.
      this.clearMatches();
      this.patch({ searchError: this.strings.noMatch });
      return;
    }
    this.anchor = match.start;
    // A text query reads as text, so the cursor lands in the column that shows it
    // — unless that column is not drawn, which `applyCursor` corrects.
    this.applyCursor({ offset: match.start, nibble: 0, column: searchMode === "text" ? "ascii" : "hex" }, { start: match.start, end: match.end });
    // Highlighting the rest is a whole-document scan, so it must not stand between
    // the key press and the jump: moving stops at the first hit, which is usually
    // near, while the count and the other highlights arrive when they arrive.
    void this.findAllMatches();
  }


  // --- replace ------------------------------------------------------------

  /** Opens the replace row, and the search panel with it — one without the other is no use. */
  openReplace(): void {
    if (this.state.replaceFeature !== "native") return;
    this.patch({ searchOpen: true, replaceOpen: true, ...noMessage });
  }

  /** Closes the replace row, leaving the find row open. */
  closeReplace(): void {
    if (this.state.replaceFeature === "off") return;
    this.patch({ replaceOpen: false, ...noMessage });
  }

  /** The text in the replace field, for a host driving the panel itself. */
  setReplaceQuery(replaceQuery: string): void {
    if (this.state.replaceFeature === "off") return;
    this.patch({ replaceQuery, ...noMessage });
  }

  /**
   * Read in the same mode as the query, so hex replaces hex and text replaces
   * text. The provider decides, because a pattern's replacement can depend on
   * the match it is rewriting.
   */
  private replacementBytes(match: SearchMatch): Uint8Array | undefined {
    const { searchMode, replaceQuery } = this.state;
    const build = this.searchProvider.replacement ?? defaultSearchProvider.replacement!;
    try {
      return build(match, replaceQuery, searchMode);
    } catch (error) {
      this.patch({ replaceMessage: message(error, this.strings.invalidReplacement), replaceFailed: true });
      return undefined;
    }
  }

  /**
   * Replaces the hit under the cursor and moves to the next one. With the cursor
   * off a hit it only advances, which is what a host expects from a first press
   * after typing a query.
   */
  async replace(): Promise<boolean> {
    if (this.state.replaceFeature === "off") return false;
    if (!this.editable) {
      this.patch({ replaceMessage: this.strings.notEditable, replaceFailed: true });
      return false;
    }
    await this.findAllMatches();
    const target = this.decorationStore.at(this.state.cursor.offset, searchKind);
    if (!target) {
      await this.runSearch("next");
      return false;
    }
    const replacement = this.replacementBytes(target);
    if (!replacement) return false;
    const end = Math.min(target.end, this.source.length);
    if (!this.commit(ChangeSet.replace(target.start, end, replacement))) return false;
    // The hits moved and this one is gone, so the highlight set is stale.
    this.scannedKey = undefined;
    this.patch(noMessage);
    this.moveCursor(target.start + replacement.length);
    await this.runSearch("next");
    return true;
  }

  /**
   * Every hit in one `ChangeSet`, so the whole sweep undoes in a single step.
   * Offsets are in pre-change coordinates, which is what a change set expects —
   * applying one at a time would need each later hit shifted by the ones before it.
   */
  async replaceAll(): Promise<number> {
    if (this.state.replaceFeature === "off") return 0;
    if (!this.editable) {
      this.patch({ replaceMessage: this.strings.notEditable, replaceFailed: true });
      return 0;
    }
    // Forced: a stale set would rewrite ranges that are no longer hits.
    await this.findAllMatches(true);
    const matches = nonOverlapping(this.matches);
    if (matches.length === 0) {
      this.patch({ replaceMessage: this.strings.noMatch, replaceFailed: true });
      return 0;
    }
    const truncated = this.state.searchTruncated;
    // Built per match rather than once, because a provider's replacement may
    // depend on the hit it rewrites. The first failure stops the sweep.
    const edits: { from: number; to: number; insert: Uint8Array }[] = [];
    for (const match of matches) {
      const replacement = this.replacementBytes(match);
      if (!replacement) return 0;
      edits.push({ from: match.start, to: Math.min(match.end, this.source.length), insert: replacement });
    }
    const changes = new ChangeSet(edits);
    if (!this.commit(changes)) return 0;
    this.scannedKey = undefined;
    this.decorationStore.clear(searchKind);
    this.patch({
      decorationRevision: this.state.decorationRevision + 1,
      searchMatchCount: 0,
      searchMatchIndex: 0,
      searchTruncated: false,
      // Said rather than hidden: the cap is the reason more can be left behind.
      replaceMessage: truncated
        ? this.strings.replacedTruncated(matches.length, this.searchLimit)
        : this.strings.replaced(matches.length),
      replaceFailed: false,
    });
    this.moveCursor(matches[0]!.start);
    return matches.length;
  }

  // --- goto ---------------------------------------------------------------

  /**
   * Opens the go-to panel. Does nothing unless go-to is `"native"` — a host that
   * supplies its own panel renders it itself.
   */
  openGoto(): void {
    if (this.state.gotoFeature !== "native") return;
    this.patch({ gotoOpen: true });
  }

  /** Closes the go-to panel. */
  closeGoto(): void {
    if (this.state.gotoFeature === "off") return;
    this.patch({ gotoOpen: false });
  }

  /** The text in the go-to field, for a host driving the panel itself. */
  setGotoQuery(gotoQuery: string): void {
    if (this.state.gotoFeature === "off") return;
    this.patch({ gotoQuery, gotoError: undefined });
  }

  /** Runs the go-to query. Leaves an error on the state when it does not read as an address. */
  runGoto(): void {
    if (this.state.gotoFeature === "off") return;
    if (this.gotoAddress(this.state.gotoQuery)) this.patch({ gotoOpen: false, gotoError: undefined });
    else this.patch({ gotoError: this.strings.notAnAddress });
  }

  // --- keyboard -----------------------------------------------------------

  /**
   * Opens the editor's panel, or tells the host to open its own.
   *
   * `"off"` returns false so the key reaches the platform — Ctrl+F should open
   * the browser's find bar in an editor that has no find of its own. `"custom"`
   * returns true even though nothing opened here: the host was told, so letting
   * the browser's bar open on top of the host's panel would be wrong.
   */
  private requestFeature(mode: FeatureMode, kind: SearchRequest["kind"]): boolean {
    if (mode === "off") return false;
    if (mode === "custom") {
      this.onSearchRequest?.({ kind });
      return true;
    }
    if (kind === "search") this.openSearch();
    else if (kind === "replace") this.openReplace();
    else this.openGoto();
    return true;
  }

  // --- commands ------------------------------------------------------------

  /** Every rebindable command with the keys in force, for a settings screen. */
  get keybindings(): readonly Keybinding[] {
    return this.keys.bindings;
  }

  /** The platform whose defaults are in force, detected or given. */
  get keyPlatform(): Platform {
    return this.platform;
  }

  /**
   * The strings in force, defaults merged with the host's. A view reads them from
   * here rather than being handed them separately, so a host sets them once.
   */
  get text(): HexText {
    return this.strings;
  }

  /**
   * The key bound to a command, written the way this platform writes it — `⇧⌘G`
   * on macOS, `Shift+Ctrl+G` elsewhere. For a tooltip or a menu item; a panel
   * that hardcoded the key would be wrong as soon as a host rebound it.
   */
  /**
   * Claims a command the engine routes but cannot perform, or gives it back
   * with `undefined`. Only the comparison commands are unclaimed; the rest are
   * the engine's own and setting a handler for one does nothing.
   */
  setCommandHandler(id: CommandId, handler: (() => boolean) | undefined): void {
    if (handler === undefined) this.commandHandlers.delete(id);
    else this.commandHandlers.set(id, handler);
  }

  /**
   * The first key bound to a command, written the way the current platform spells it —
   * for a host labelling a button of its own. Undefined when the command is unbound.
   */
  keyFor(id: CommandId): string | undefined {
    const first = this.keys.bindings.find((binding) => binding.id === id)?.keys[0];
    return first === undefined ? undefined : formatBinding(first, this.platform);
  }

  /**
   * Runs a command by name, whatever key ran it. Returns whether it was consumed:
   * a command whose feature is off declines the key so the platform can have it.
   */
  runCommand(id: CommandId): boolean {
    switch (id) {
      case "find": return this.requestFeature(this.state.searchFeature, "search");
      case "replace": return this.requestFeature(this.state.replaceFeature, "replace");
      case "goto": return this.requestFeature(this.state.gotoFeature, "goto");
      case "findNext": return this.advanceSearch("next");
      case "findPrevious": return this.advanceSearch("previous");
      case "toggleBookmark":
        this.toggleBookmark();
        return true;
      case "nextBookmark":
        this.nextBookmark();
        return true;
      case "previousBookmark":
        this.previousBookmark();
        return true;
      // Routed, not performed. A comparison spans two documents, so neither
      // engine can walk it alone — but the key is still the editor's to report
      // and to rebind, which is why the command lives here and the action does
      // not. Unclaimed, it declines, so F4 stays the platform's.
      case "nextDifference":
      case "previousDifference":
        return this.commandHandlers.get(id)?.() ?? false;
      case "readRow":
        this.announce(this.describeRow());
        return true;
      case "readRegion":
        this.announce(this.describeRegion());
        return true;
      case "switchColumn": {
        // With one column there is nothing to switch to, so Tab stays a focus key.
        if (!this.cachedLayout.asciiColumn) return false;
        // Switching columns keeps the selection, so it is not a selection change.
        const cursor = this.state.cursor;
        this.patch({ cursor: { ...cursor, column: cursor.column === "hex" ? "ascii" : "hex", nibble: 0 } });
        return true;
      }
    }
  }

  /**
   * Find-next from the grid, which is where the platform key for it points. With
   * nothing to find yet it opens the panel instead — pressing it before typing a
   * query is how a user asks for the panel, not a no-op.
   */
  private advanceSearch(direction: SearchDirection): boolean {
    if (this.state.searchFeature === "off") return false;
    if (this.state.searchQuery === "") return this.requestFeature(this.state.searchFeature, "search");
    void this.runSearch(direction);
    return true;
  }

  /** Returns true when the engine consumed the key, so the host can preventDefault. */
  handleKey(input: KeyInput): boolean {
    if (this.source.length === 0) return false;
    const cursor = this.state.cursor;
    const current = cursor.offset;
    const modifier = Boolean(input.metaKey || input.ctrlKey);
    const key = input.key.toLowerCase();

    // Rebindable commands first, and by lookup rather than by a chain of tests:
    // which key runs which is the host's to change, so it cannot be spelled out here.
    const command = commandFor(this.keys.lookup, input, this.platform);
    if (command !== undefined) return this.runCommand(command);

    if (modifier && key === "a") {
      this.selectAll();
      return true;
    }
    if (modifier && key === "c") {
      this.copySelection();
      return true;
    }
    if (modifier && key === "x") {
      // Falls back to copying in a document it cannot cut from. It used to report
      // the key as handled and do nothing at all, which reads as a broken key.
      if (this.editable) this.cut();
      else this.copySelection();
      return true;
    }
    // The edit mode is not keyboard-driven: Insert does not exist on every
    // keyboard, so the host sets the mode explicitly instead.
    if (input.key === "Delete" || input.key === "Backspace") {
      if (!this.editable) return false;
      if (input.key === "Delete") this.deleteForward();
      else this.deleteBackward();
      return true;
    }

    const isUndo = modifier && key === "z" && !input.shiftKey;
    const isRedo = (modifier && key === "z" && Boolean(input.shiftKey)) || (modifier && key === "y");
    if (!this.readOnly && (isUndo || isRedo)) {
      if (isUndo) this.undo();
      else this.redo();
      return true;
    }

    const rowStart = Math.floor(current / this.bytesPerRow) * this.bytesPerRow;
    const navigation: Record<string, number> = {
      ArrowLeft: current - 1,
      ArrowRight: current + 1,
      ArrowUp: current - this.bytesPerRow,
      ArrowDown: current + this.bytesPerRow,
      Home: rowStart,
      End: Math.min(this.source.length - 1, rowStart + this.bytesPerRow - 1),
    };
    if (input.key in navigation) {
      if (input.shiftKey) this.extendSelectionTo(navigation[input.key]!);
      else this.moveCursor(navigation[input.key]!);
      return true;
    }

    if (this.readOnly || modifier || input.altKey) return false;

    if (cursor.column === "hex" && /^[0-9a-f]$/i.test(input.key)) {
      const nibble = Number.parseInt(input.key, 16);
      // In insert mode the first nibble opens a new byte; the second completes it.
      if (this.state.editMode === "insert" && cursor.nibble === 0) {
        this.insertBytes(Uint8Array.of(nibble << 4), current, true);
        this.patch({ cursor: { ...this.state.cursor, offset: current, column: "hex", nibble: 1 } });
        return true;
      }
      const previous = this.source.peek(current, 1)?.[0];
      if (previous === undefined) return true;
      const next = cursor.nibble === 0 ? (nibble << 4) | (previous & 0x0f) : (previous & 0xf0) | nibble;
      this.writeByte(current, next);
      if (cursor.nibble === 0) this.patch({ cursor: { ...cursor, nibble: 1 } });
      else this.moveCursor(current + 1, "hex", 0);
      return true;
    }

    if (cursor.column === "ascii" && input.key.length === 1) {
      const byte = input.key.charCodeAt(0) & 0xff;
      if (this.state.editMode === "insert") this.insertBytes(Uint8Array.of(byte), current, true);
      else {
        this.writeByte(current, byte);
        this.moveCursor(current + 1, "ascii", 0);
      }
      return true;
    }

    return false;
  }

  // --- rendering ----------------------------------------------------------

  /**
   * Paints the visible rows onto a canvas, and asks the source for the window it drew —
   * a paged source repaints when those bytes arrive.
   */
  render(canvas: HTMLCanvasElement): void {
    if (this.state.viewportWidth === 0 || this.state.viewportHeight === 0 || this.source.length === 0) return;
    const rows = this.visibleRows;
    // Ask for the window being drawn; a paged source repaints once it arrives.
    // Asked for as one range, which a plan with gaps still describes: the first
    // row's offset to the last row's end.
    const first = this.cachedPlan.at(rows.first).offset;
    const lastRow = this.cachedPlan.at(Math.max(rows.first, rows.last - 1));
    const through = Math.max(0, lastRow.offset + lastRow.length - first);
    void this.source.ensure(first, Math.min(this.source.length - first, through));
    this.renderer.render(canvas, {
      source: this.source,
      layout: this.cachedLayout,
      rowHeight: this.rowHeight,
      scrollTop: this.logicalScrollTop,
      scrollLeft: this.state.scrollLeft,
      visibleRows: rows,
      plan: this.cachedPlan,
      cursor: this.state.cursor,
      selection: this.state.selection,
      // Asked per row, so it has to be something that can answer without a full
      // pass — the store's index, plus whatever kinds the host answers itself.
      decorations: this.decorationQuery,
      theme: this.effectiveTheme,
      // The encoding and the default tint are engine options, so they are put
      // into the request rather than left to whatever the host passed as
      // `display` — which is where they would otherwise have to be repeated.
      display: { ...this.display, printableChars: this.printableChars },
    });
  }

  /** Detaches from the source. Call when the host view goes away. */
  destroy(): void {
    this.scanAborter?.abort();
    this.unsubscribeSource();
    this.listeners.clear();
    if (this.repaintHandle === undefined) return;
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.repaintHandle);
    else clearTimeout(this.repaintHandle);
    this.repaintScheduled = false;
  }
}

function toByteSource(source: ByteSource | BinaryBuffer): ByteSource {
  return isByteSource(source) ? source : fromBinaryBuffer(source);
}

/** A provider's complaint, or a stand-in when it threw something that is not an error. */
function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/** Sorted, with touching or overlapping ranges joined into one. */
function merge(ranges: ByteSelection[]): ByteSelection[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  const merged: ByteSelection[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/**
 * A source's ranges belong to the kind it was registered under. Copied rather
 * than written to, because they are the host's objects and it may hold them.
 */
function stampKind(item: DecorationInput, kind: string): DecorationInput {
  return item.kind === kind ? item : { ...item, kind };
}

const noMessage = { replaceMessage: undefined, replaceFailed: false } as const;

/**
 * Overlapping hits cannot all be replaced — `findAll` steps one byte at a time, so
 * "AA" matches twice in "AAA" — and a change set with overlapping ranges is not a
 * well-defined edit. The earlier hit wins, which is the order they were found in.
 */
function nonOverlapping(matches: readonly Decoration[]): Decoration[] {
  const kept: Decoration[] = [];
  let reached = -1;
  for (const match of matches) {
    if (match.start < reached) continue;
    kept.push(match);
    reached = match.end;
  }
  return kept;
}

/** An insertion may sit one past the last byte; a cursor may not. */
function clampInsertPoint(offset: number, length: number): number {
  return Math.max(0, Math.min(offset, length));
}
