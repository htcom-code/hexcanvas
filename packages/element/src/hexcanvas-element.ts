import {
  HexEngine,
  asciiPrintable,
  cp437Printable,
  latin1Printable,
  type AddressRadix,
  type BinaryBuffer,
  type ByteGroupSize,
  type ByteSelection,
  type ByteSource,
  type Cursor,
  type EditMode,
  type FeatureMode,
  type HexSpacing,
  type HexTextOverrides,
  type HexTheme,
  type Keymap,
  type LabelWidth,
  type Platform,
  type PrintableChar,
  type SearchMode,
  type SearchProvider,
} from "@hexcanvas/core";
import { defineHexCanvasFinder, exportParts, HexCanvasFinder } from "./hexcanvas-finder.js";

/**
 * Styles live inside the shadow root, so a consumer imports nothing and
 * nothing leaks either way. Custom properties still cross the boundary, which
 * is why theming works the same here as in the framework bindings.
 */
const styles = `
:host {
  display: flex;
  flex-direction: column;
  /* The scrollport is the inner viewport, not this box, so that the chrome above
     it does not scroll with the grid. See the note on \`scrollTop\`. */
  overflow: hidden;
  outline: none;
  /* The scroll spacer is as tall as the document, so without a bounded height
     the element grows to fit it and the viewport swallows the whole file. A
     default box breaks that loop; the host overrides it with its own height. */
  height: var(--hexcanvas-height, 24rem);
  min-height: var(--hexcanvas-min-height, 160px);
  background: var(--hexcanvas-bg, #111827);
}
:host([hidden]) { display: none; }
/* The chrome is a sibling of the grid rather than a floating layer over it. As
   an overlay it lived inside the wrapper that carries the row width, so it had
   to be pinned back with sticky, zero height and a width set from script — four
   corrections for being in the wrong place. It takes its height out of the
   declared one, which is what \`height\` means. */
.chrome { flex: none; }
.viewport { flex: 1 1 auto; position: relative; overflow: auto; }
/* Sticky positions an element within its containing block, so the canvas can only
   stay put in a direction that block is longer than the scrollport in. Vertically
   the spacer already does that. Horizontally nothing did: a block box is as wide
   as its own containing block however far its children overflow, which is why the
   grid needs a wrapper carrying the row width. */
.content { position: relative; }
/* Reachable by a screen reader, invisible to everyone else. Hiding it with
   display or visibility would take it out of the accessibility tree too. */
.announcement {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0;
}
canvas { position: sticky; z-index: 1; left: 0; top: 0; display: block; width: 100%; cursor: text; }
.spacer { pointer-events: none; width: 1px; }
`;

const attributeNames = [
  "bytes-per-row",
  "row-height",
  "address-radix",
  "byte-group",
  "edit-mode",
  "font",
  "highlight-cursor-address",
  "highlight-cursor-ascii",
  "ascii-column",
  "decoration-labels",
  "label-width",
  "text-encoding",
  "decoration-opacity",
  "search-match-limit",
  "search-priority",
  "search",
  "replace",
  "goto",
  "platform",
  "max-fps",
] as const;

const featureModes: readonly FeatureMode[] = ["off", "native", "custom"];
const platforms: readonly Platform[] = ["mac", "windows", "linux"];

/**
 * What `text-encoding` may name. Three rather than a registry: these are the
 * ones a hex editor is asked for, and anything else is a `printable` function.
 * An unrecognised value falls through to the engine default rather than
 * throwing, because an attribute is markup and markup gets typos.
 */
const namedEncodings: Record<string, PrintableChar | undefined> = {
  ascii: asciiPrintable,
  cp437: cp437Printable,
  latin1: latin1Printable,
};

const writeToClipboard = (text: string): void => void navigator.clipboard?.writeText(text);

/**
 * The framework-agnostic surface. Vue, Svelte, Angular and plain HTML use this
 * directly; only React has its own binding, because it predates this one.
 */
export class HexCanvasElement extends HTMLElement {
  static readonly observedAttributes = attributeNames;

  /**
   * The engine behind this element, for driving search, history, decorations or the
   * cursor from outside the markup.
   */
  readonly engine: HexEngine;
  private readonly root: ShadowRoot;
  private readonly canvas: HTMLCanvasElement;
  /** Carries the row width, so the canvas has room to stay put horizontally. */
  private readonly content: HTMLDivElement;
  private readonly spacer: HTMLDivElement;
  /** The scrollport. `:host` used to be it; see the note on `scrollTop`. */
  private readonly viewport: HTMLDivElement;
  /** Region above the grid. Empty, and so zero-height, until something needs it. */
  private readonly chrome: HTMLDivElement;
  /** Built on demand: find set to `"off"` or `"custom"` never needs one. */
  private finder: HexCanvasFinder | undefined;
  /** Live region: the grid is painted, so this is the only thing announced. */
  private readonly announcement: HTMLDivElement;
  private announcedMode: EditMode | undefined;
  /** Serial of the last on-demand announcement made; see `syncAnnouncement`. */
  private announcedSerial = 0;
  /** Armed by Escape, spent by the next Tab; see `releaseTab`. */
  private tabLeaves = false;
  private readonly cleanups: (() => void)[] = [];
  private observer?: ResizeObserver;
  private pendingSource: ByteSource | BinaryBuffer | undefined;
  /**
   * Property-set options are held rather than pushed once, because connecting
   * and every attribute change rebuild the whole option set — anything not kept
   * here would be dropped the first time an attribute moved.
   */
  private themeOverride: HexTheme | undefined;
  private copy: ((text: string) => void) | undefined;
  private provider: SearchProvider | undefined;
  private modes: readonly SearchMode[] | undefined;
  private keys: Keymap | undefined;
  private strings: HexTextOverrides | undefined;
  private gaps: HexSpacing | undefined;
  /** Set as a property; the `text-encoding` attribute names one of three instead. */
  private printableChar: PrintableChar | undefined;
  /** Paint scheduling; see `schedulePaint`. */
  private paintScheduled = false;
  private paintHandle: number | undefined;
  private painted = 0;
  private fpsOverride: number | undefined;

  constructor() {
    super();
    // Open, not closed: hosts and tests need to reach the internals, and
    // ::part() covers the styling that encapsulation would otherwise block.
    this.root = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = styles;

    this.canvas = document.createElement("canvas");
    this.canvas.setAttribute("part", "canvas");
    this.spacer = document.createElement("div");
    this.spacer.className = "spacer";

    this.announcement = document.createElement("div");
    this.announcement.className = "announcement";
    this.announcement.setAttribute("part", "announcement");
    this.announcement.setAttribute("role", "status");
    this.announcement.setAttribute("aria-live", "polite");

    this.chrome = document.createElement("div");
    this.chrome.className = "chrome";
    this.chrome.setAttribute("part", "chrome");

    this.content = document.createElement("div");
    this.content.className = "content";
    this.content.append(this.announcement, this.canvas, this.spacer);
    this.viewport = document.createElement("div");
    this.viewport.className = "viewport";
    // Chrome makes a scrollable box a tab stop of its own so it can be scrolled
    // from the keyboard. Here the host already is one and already scrolls on the
    // arrow keys, so the only thing that does is put an unnamed div between the
    // grid and whatever comes after it — which is where Tab landed once it was
    // allowed out at all.
    this.viewport.tabIndex = -1;
    this.viewport.setAttribute("part", "viewport");
    this.viewport.append(this.content);
    this.root.append(style, this.chrome, this.viewport);

    this.engine = new HexEngine({
      source: new EmptySource(),
      onChange: (changes) => this.emit("change", changes),
      onSelectionChange: (selection) => this.emit("selectionchange", selection),
      onCursorChange: (cursor) => this.emit("cursorchange", cursor),
      onCopy: (text) => this.onCopied(text),
    });
  }

  /**
   * The grid's scrollport is an inner element now that the chrome sits above it,
   * so the six properties that describe a scroll box forward to that element
   * rather than reporting this one.
   *
   * All six together, not just the two that are assignable: scrolling to the
   * bottom is written `el.scrollTop = el.scrollHeight - el.clientHeight`, and a
   * mix of the outer box's metrics with the inner box's position would put that
   * somewhere meaningless.
   */
  get scrollTop(): number {
    return this.viewport.scrollTop;
  }

  set scrollTop(value: number) {
    this.viewport.scrollTop = value;
  }

  /** Forwards to the inner scrollport; see `scrollTop`. */
  get scrollLeft(): number {
    return this.viewport.scrollLeft;
  }

  set scrollLeft(value: number) {
    this.viewport.scrollLeft = value;
  }

  /** Forwards to the inner scrollport; see `scrollTop`. */
  override get scrollHeight(): number {
    return this.viewport.scrollHeight;
  }

  /** Forwards to the inner scrollport; see `scrollTop`. */
  override get scrollWidth(): number {
    return this.viewport.scrollWidth;
  }

  /** Forwards to the inner scrollport; see `scrollTop`. */
  override get clientHeight(): number {
    return this.viewport.clientHeight;
  }

  /** Forwards to the inner scrollport; see `scrollTop`. */
  override get clientWidth(): number {
    return this.viewport.clientWidth;
  }

  /** Forwards to the inner scrollport; see `scrollTop`. */
  override scrollTo(...args: [ScrollToOptions?] | [number, number]): void {
    (this.viewport.scrollTo as (...rest: unknown[]) => void)(...args);
  }

  /** Forwards to the inner scrollport; see `scrollTop`. */
  override scrollBy(...args: [ScrollToOptions?] | [number, number]): void {
    (this.viewport.scrollBy as (...rest: unknown[]) => void)(...args);
  }

  /** Accepts a `ByteSource` or the older `BinaryBuffer`; set it as a property. */
  get source(): ByteSource | BinaryBuffer | undefined {
    return this.pendingSource;
  }

  set source(source: ByteSource | BinaryBuffer | undefined) {
    this.pendingSource = source;
    if (source) this.engine.setSource(source);
  }

  /**
   * An explicit override; leave it unset to theme through custom properties.
   *
   * Assigning what is already set does nothing, as it does for every option
   * below. `applyOptions` rebuilds the whole option set and the column geometry
   * with it, so a host that hands over a freshly built object on every render —
   * which is what a framework does unless told otherwise — would pay for a
   * layout rebuild and a repaint per frame, per pane. Measured at 2.87 rebuilds
   * a frame in the playground before this.
   *
   * The check is identity, not equality. These are the host's own objects and it
   * may hold and mutate one; comparing their contents would cost more and would
   * still miss a mutation, so an in-place change is the host's to announce.
   */
  get theme(): HexTheme | undefined {
    return this.themeOverride;
  }

  set theme(theme: HexTheme | undefined) {
    if (theme === this.themeOverride) return;
    this.themeOverride = theme;
    this.applyOptions();
  }

  /**
   * Assignable, so a host can hold the cursor as its own state and drive it —
   * the other half of the `cursorchange` event. Setting the position it is
   * already at does nothing, so a host that echoes the event back cannot loop.
   */
  get cursor(): Cursor {
    return this.engine.getState().cursor;
  }

  set cursor(cursor: Partial<Cursor> & { offset: number }) {
    const current = this.engine.getState().cursor;
    const column = cursor.column ?? current.column;
    if (cursor.offset === current.offset && column === current.column) return;
    this.engine.moveCursor(cursor.offset, column, cursor.nibble ?? 0);
  }

  /** What is selected now, or undefined when nothing is. */
  get selection(): ByteSelection | undefined {
    return this.engine.getState().selection;
  }

  set selection(selection: ByteSelection | undefined | null) {
    const current = this.engine.getState().selection;
    if (!selection) {
      this.engine.clearSelection();
      return;
    }
    if (current && current.start === selection.start && current.end === selection.end) return;
    // "keep", so assigning a selection does not overrule a cursor the host set.
    this.engine.select(selection.start, selection.end, "keep");
  }

  /** Redirects copied text; the default writes to the system clipboard. */
  get copyHandler(): ((text: string) => void) | undefined {
    return this.copy;
  }

  set copyHandler(handler: ((text: string) => void) | undefined) {
    this.copy = handler;
  }

  /**
   * Replaces the scan. Independent of the `search` attribute: the editor's own
   * panel over a host's matcher is a valid pairing, and so is a host's panel over
   * the built-in one.
   */
  get searchProvider(): SearchProvider | undefined {
    return this.provider;
  }

  set searchProvider(provider: SearchProvider | undefined) {
    if (provider === this.provider) return;
    this.provider = provider;
    this.applyOptions();
  }

  /** Modes the panel offers, for a provider that understands more than two. */
  get searchModes(): readonly SearchMode[] | undefined {
    return this.modes;
  }

  set searchModes(modes: readonly SearchMode[] | undefined) {
    if (modes === this.modes) return;
    this.modes = modes;
    this.applyOptions();
  }

  /** The gaps between the columns. A property because it is an object. */
  get spacing(): HexSpacing | undefined {
    return this.gaps;
  }

  set spacing(spacing: HexSpacing | undefined) {
    if (spacing === this.gaps) return;
    this.gaps = spacing;
    this.applyOptions();
  }

  /**
   * An encoding of the host's own, which beats the `text-encoding` attribute.
   *
   * The attribute exists so plain HTML can reach the three encodings worth
   * naming; this exists because there are hundreds of code pages and a host
   * with the one that is not here should not be stuck.
   */
  set printable(printable: PrintableChar | undefined) {
    if (printable === this.printableChar) return;
    this.printableChar = printable;
    this.applyOptions();
  }

  /**
   * Replaces the strings the editor and its panel show. A property because it is
   * an object; partial, so what is not named keeps its English default.
   */
  get text(): HexTextOverrides | undefined {
    return this.strings;
  }

  set text(text: HexTextOverrides | undefined) {
    if (text === this.strings) return;
    this.strings = text;
    this.applyOptions();
  }

  /**
   * Overrides the default keys per command. A property because it is an object;
   * throws if it names an unknown command or a key the platform will not give up.
   */
  get keymap(): Keymap | undefined {
    return this.keys;
  }

  set keymap(keymap: Keymap | undefined) {
    if (keymap === this.keys) return;
    this.keys = keymap;
    this.applyOptions();
  }

  connectedCallback(): void {
    if (!this.hasAttribute("tabindex")) this.tabIndex = 0;
    this.setAttribute("part", "editor");
    // Only filled in when the host has not said otherwise. `application` is what
    // lets the editor keep the arrow keys a screen reader would otherwise take.
    if (!this.hasAttribute("role")) this.setAttribute("role", "application");
    if (!this.hasAttribute("aria-roledescription")) this.setAttribute("aria-roledescription", "hex editor");
    if (!this.hasAttribute("aria-label")) this.setAttribute("aria-label", "Hex editor");
    this.applyOptions();
    this.engine.adoptStyles(this);

    this.listen(this, "keydown", (event) => {
      if (this.releaseTab(event as KeyboardEvent)) return;
      if (this.engine.handleKey(event as KeyboardEvent)) event.preventDefault();
    });
    this.listen(this, "paste", (event) => {
      const text = (event as ClipboardEvent).clipboardData?.getData("text");
      if (text && this.engine.paste(text)) event.preventDefault();
    });
    this.listen(this.viewport, "scroll", () => {
      this.engine.setScrollTop(this.viewport.scrollTop);
      this.engine.setScrollLeft(this.viewport.scrollLeft);
    });
    this.listen(this.canvas, "pointerdown", (event) => this.onPointerDown(event as PointerEvent));
    this.listen(this.canvas, "pointermove", (event) => {
      const pointer = event as PointerEvent;
      const point = this.localPoint(pointer);
      this.engine.pointerMove(point.x, point.y, pointer.buttons !== 0);
    });
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) {
      this.listen(this.canvas, name, () => this.engine.pointerUp());
    }

    // The panel asks for focus back rather than reaching for the grid itself.
    this.listen(this.chrome, "dismiss", () => this.focus());

    // The grid's size, not the element's: the chrome above it takes its height
    // out of the same box, so measuring the host would count it twice.
    this.observer = new ResizeObserver(([entry]) => {
      if (entry) this.engine.setViewportSize(entry.contentRect.width, entry.contentRect.height);
    });
    this.observer.observe(this.viewport);

    const scheme = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onScheme = () => this.engine.adoptStyles(this);
    scheme?.addEventListener("change", onScheme);
    this.cleanups.push(() => scheme?.removeEventListener("change", onScheme));
    const onFonts = () => this.engine.adoptStyles(this, { remeasureFont: true });
    document.fonts?.addEventListener("loadingdone", onFonts);
    this.cleanups.push(() => document.fonts?.removeEventListener("loadingdone", onFonts));
    void document.fonts?.ready.then(() => this.isConnected && this.engine.adoptStyles(this, { remeasureFont: true }));

    this.cleanups.push(this.engine.subscribe(() => this.sync()));
    this.sync();
  }

  disconnectedCallback(): void {
    this.observer?.disconnect();
    this.cancelPaint();
    for (const cleanup of this.cleanups.splice(0)) cleanup();
  }

  attributeChangedCallback(): void {
    if (this.isConnected) this.applyOptions();
  }

  /**
   * Most repaints a second, or `undefined` to follow the display.
   *
   * Uncapped by default, because a cap makes the editor worse on hardware that
   * did not need one — this is the setting a host reaches for when it knows
   * something the editor does not, such as sharing a machine with work that
   * matters more. It caps **painting** only: state, events, scrolling and key
   * handling stay immediate, so a capped editor is no slower to type into, it
   * redraws less often.
   *
   * Worth knowing before reaching for it: on a 60Hz display it does nothing,
   * since the display is already the cap. It halves the work on a 120Hz one.
   */
  get maxFps(): number | undefined {
    return this.fps;
  }

  set maxFps(value: number | undefined) {
    // Clamped rather than validated, as the spacing options are: a slider that
    // went one step too far should not be a hard failure.
    const next = value === undefined || !Number.isFinite(value) || value <= 0 ? undefined : Math.max(1, value);
    if (next === this.fps) return;
    this.fps = next;
  }

  /** Resolved from the property or the attribute, the property winning. */
  private get fps(): number | undefined {
    return this.fpsOverride ?? this.attributeFps;
  }

  private set fps(value: number | undefined) {
    this.fpsOverride = value;
  }

  private get attributeFps(): number | undefined {
    const value = this.number("max-fps");
    return value === undefined || value <= 0 ? undefined : Math.max(1, value);
  }

  /** Re-reads the custom properties after the host changes them at runtime. */
  refreshTheme(): void {
    this.engine.refreshTheme();
  }

  private applyOptions(): void {
    const search = this.feature("search");
    this.engine.setOptions({
      bytesPerRow: this.number("bytes-per-row") ?? 16,
      rowHeight: this.number("row-height") ?? 22,
      addressRadix: (this.getAttribute("address-radix") as AddressRadix) ?? "hex",
      byteGroup: (this.number("byte-group") as ByteGroupSize) ?? 1,
      editMode: (this.getAttribute("edit-mode") as EditMode | null) ?? undefined,
      font: this.getAttribute("font") ?? undefined,
      theme: this.themeOverride,
      asciiColumn: this.flag("ascii-column"),
      labelWidth: (this.number("label-width") as LabelWidth | undefined),
      printable: this.printableChar ?? namedEncodings[this.getAttribute("text-encoding") ?? ""],
      searchMatchLimit: this.number("search-match-limit"),
      searchPriority: this.number("search-priority"),
      search,
      replace: this.feature("replace"),
      goto: this.feature("goto"),
      searchProvider: this.provider,
      searchModes: this.modes,
      platform: this.oneOf("platform", platforms),
      keymap: this.keys,
      text: this.strings,
      spacing: this.gaps,
      onSearchRequest: (request) => this.emit("searchrequest", request),
      display: {
        highlightCursorAddress: this.flag("highlight-cursor-address"),
        highlightCursorAscii: this.flag("highlight-cursor-ascii"),
        decorationLabels: this.flag("decoration-labels"),
        decorationOpacity: this.number("decoration-opacity"),
      },
      onChange: (changes) => this.emit("change", changes),
      onSelectionChange: (selection) => this.emit("selectionchange", selection),
      onCursorChange: (cursor) => this.emit("cursorchange", cursor),
      onCopy: (text) => this.onCopied(text),
    });
    this.syncChrome();
  }

  /**
   * The panel exists only where it is the editor's job to draw one. Built here
   * rather than in the constructor so `search="off"` — the default — costs no DOM
   * and no shadow root, and so the chrome region has no height to take.
   */
  private syncChrome(): void {
    const state = this.engine.getState();
    const wanted = state.searchFeature === "native" || state.gotoFeature === "native";
    if (!wanted) {
      this.finder?.remove();
      this.finder = undefined;
      return;
    }
    if (this.finder) return;
    defineHexCanvasFinder();
    const finder = document.createElement("hexcanvas-finder") as HexCanvasFinder;
    finder.setAttribute("part", "finder");
    // `::part()` crosses one boundary, and the panel has a shadow root of its own,
    // so without this a host could not reach the rows inside it.
    finder.setAttribute("exportparts", exportParts);
    finder.engine = this.engine;
    this.chrome.append(finder);
    this.finder = finder;
  }

  private onCopied(text: string): void {
    (this.copy ?? writeToClipboard)(text);
  }

  /**
   * Whether this Tab should leave the editor instead of switching column.
   *
   * Tab is bound to `switchColumn`, which is what a hex editor should do with
   * it and which also means a keyboard user tabbing forward through the page
   * never gets past the grid: Tab cycles hex, text, hex, text. Shift+Tab does
   * leave, so it is not strictly a trap, but a way out that only goes backwards
   * is not one anybody finds.
   *
   * So Escape arms the next Tab to move focus, the way a code editor does with
   * the same collision, and the live region says so — the hint is the half that
   * matters, because an escape hatch nobody is told about is no better than
   * none. Any other key disarms it, so the hatch is only ever open for the
   * keystroke it was opened for.
   */
  private releaseTab(event: KeyboardEvent): boolean {
    if (event.key === "Tab" && this.tabLeaves) {
      this.tabLeaves = false;
      return true;
    }
    // Escape alone. With a modifier it belongs to the platform or the host.
    const arming = event.key === "Escape" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
    this.tabLeaves = arming;
    if (arming) this.announce(this.engine.text.leaveWithTab);
    return false;
  }

  /** Says something that is not the cursor. Overwritten by the next state change. */
  private announce(what: string): void {
    if (this.announcement.textContent !== what) this.announcement.textContent = what;
  }

  private sync(): void {
    const state = this.engine.getState();
    if (this.viewport.scrollTop !== state.scrollTop) this.viewport.scrollTop = state.scrollTop;
    if (this.viewport.scrollLeft !== state.scrollLeft) this.viewport.scrollLeft = state.scrollLeft;
    // Pixel widths, not percentages: inside a wrapper wider than the viewport a
    // percentage would resolve against the wrapper and the canvas would overflow.
    const viewportWidth = state.viewportWidth ? `${state.viewportWidth}px` : "100%";
    this.content.style.width = `${Math.max(this.engine.scrollWidth, state.viewportWidth)}px`;
    this.canvas.style.width = viewportWidth;
    this.canvas.style.height = state.viewportHeight ? `${state.viewportHeight}px` : "100%";
    this.spacer.style.height = `${Math.max(0, this.engine.scrollHeight - state.viewportHeight)}px`;
    this.syncAnnouncement(state);
    this.schedulePaint();
  }

  /**
   * What the live region says: an answer if one was asked for, and where the
   * cursor is otherwise.
   *
   * An asked-for answer is written whether or not the words changed, and is
   * recognised by serial rather than by text. Reading the same row twice is two
   * questions, and a live region only speaks when it is written — the guard the
   * cursor description needs would answer the first press and swallow the
   * second. The cursor keeps its guard for the opposite reason: `sync` runs on
   * every state patch and one action makes several, so an unguarded description
   * would say where you are three times per keystroke.
   */
  private syncAnnouncement(state: ReturnType<HexEngine["getState"]>): void {
    const asked = state.announcement;
    if (asked && asked.serial !== this.announcedSerial) {
      this.announcedSerial = asked.serial;
      this.announcement.textContent = asked.text;
      // The mode prefix is owed to the next cursor description rather than
      // dropped: what was said here was not it.
      return;
    }
    // Mode is prefixed only when it changed, so it is not repeated on every step.
    const described = this.engine.describeCursor();
    const announcement = this.announcedMode !== undefined && this.announcedMode !== state.editMode
      ? this.engine.text.cursorEditMode(state.editMode, described)
      : described;
    if (this.announcement.textContent !== announcement) this.announcement.textContent = announcement;
    this.announcedMode = state.editMode;
  }

  /**
   * Paints at most once a frame, whatever happened in it.
   *
   * The engine notifies on every state patch and one action makes several: a
   * cursor move that scrolls is two, an edit is three, a keystroke measured at
   * 3.95, and twenty writes landing in one frame — a paste, a replace-all — were
   * sixty. Painting straight from the notification meant paying for every one of
   * them, and only the last is on screen.
   *
   * Everything above this line stays synchronous. The scroll position drives the
   * scroller, the sizes drive the layout, and the live region is what a screen
   * reader is waiting for; deferring those would be deferring the editor. It is
   * only the canvas that is expensive, and only the canvas that waits.
   */
  private schedulePaint(): void {
    if (this.paintScheduled) return;
    this.paintScheduled = true;
    // A frame where there is one, a task where there is not, so a headless host
    // still gets the paint rather than never seeing the bytes. The engine's own
    // repaint scheduler makes the same choice for the same reason.
    this.paintHandle = typeof requestAnimationFrame === "function"
      ? requestAnimationFrame((now) => this.paint(now))
      : (setTimeout(() => this.paint(Date.now()), 0) as unknown as number);
  }

  private paint(now: number): void {
    // Below the rate the host asked for: wait for a frame that is not, rather
    // than dropping this one. The last state has to reach the canvas or a scroll
    // ends showing bytes it has already left behind.
    if (this.fps !== undefined && now - this.painted < 1000 / this.fps) {
      this.paintScheduled = false;
      this.schedulePaint();
      return;
    }
    this.paintScheduled = false;
    this.painted = now;
    this.engine.render(this.canvas);
  }

  private cancelPaint(): void {
    if (this.paintHandle === undefined) return;
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.paintHandle);
    else clearTimeout(this.paintHandle);
    this.paintHandle = undefined;
    this.paintScheduled = false;
  }

  private onPointerDown(event: PointerEvent): void {
    this.focus();
    if (event.button !== 0) return;
    this.canvas.setPointerCapture(event.pointerId);
    const point = this.localPoint(event);
    this.engine.pointerDown(point.x, point.y);
  }

  private localPoint(event: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private listen(target: EventTarget, type: string, handler: (event: Event) => void): void {
    target.addEventListener(type, handler);
    this.cleanups.push(() => target.removeEventListener(type, handler));
  }

  private emit(type: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  private number(attribute: string): number | undefined {
    const value = this.getAttribute(attribute);
    if (value === null) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  /**
   * Absent means "leave the default alone", not false, so a host can turn one of
   * these off without having to state the other.
   */
  private flag(attribute: string): boolean | undefined {
    const value = this.getAttribute(attribute);
    if (value === null) return undefined;
    return value !== "false" && value !== "0";
  }

  /**
   * Absent leaves the engine's default, which is `"off"` for find and "follow
   * find" for the other two. An unrecognised value is treated as absent rather
   * than as `"off"`, so a typo does not silently disable the feature it meant to
   * turn on — the engine's default is the same either way, but a host reading the
   * attribute back sees what it wrote.
   */
  private feature(attribute: string): FeatureMode | undefined {
    return this.oneOf(attribute, featureModes);
  }

  /** Absent or unrecognised leaves the engine's default; see `feature`. */
  private oneOf<T extends string>(attribute: string, allowed: readonly T[]): T | undefined {
    const value = this.getAttribute(attribute);
    if (value === null) return undefined;
    return allowed.includes(value as T) ? (value as T) : undefined;
  }
}

/** Placeholder until a source is assigned, so the element can exist empty. */
class EmptySource implements ByteSource {
  readonly length = 0;
  readonly version = 0;
  peek(): Uint8Array | undefined { return undefined; }
  ensure(): Promise<void> { return Promise.resolve(); }
  subscribe(): () => void { return () => {}; }
}

/** Idempotent, so importing from more than one place is safe. */
export function defineHexCanvasElement(tag = "hexcanvas-editor"): void {
  if (typeof customElements === "undefined" || customElements.get(tag)) return;
  customElements.define(tag, HexCanvasElement);
}
