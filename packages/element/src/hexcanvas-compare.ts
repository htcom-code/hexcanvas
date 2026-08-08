import {
  HexCompare,
  type BinaryBuffer,
  type ByteSource,
  type DiffProvider,
  type HexSpacing,
  type HexText,
  type HexTextOverrides,
  type HexTheme,
  type Keymap,
  type SearchMode,
  type PrintableChar,
  type SearchProvider,
} from "@hexcanvas/core";
import { defineHexCanvasElement, HexCanvasElement } from "./hexcanvas-element.js";

/**
 * Two editors side by side rather than one editor that knows about two
 * documents.
 *
 * The whole feature is arranged around that: each pane is a complete
 * `<hexcanvas-editor>`, so the grid, the geometry, the hit-testing, the cursor
 * and editing all keep working per pane with no changes at all. What this adds
 * is the box around them, the bar above them, and a `HexCompare` holding the
 * two engines together.
 */
const styles = `
:host {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  height: var(--hexcanvas-height, 24rem);
  min-height: var(--hexcanvas-min-height, 160px);
  background: var(--hexcanvas-bg, #111827);
}
:host([hidden]) { display: none; }
.chrome {
  flex: none;
  display: flex; gap: 8px; align-items: center;
  box-sizing: border-box;
  padding: var(--hexcanvas-finder-padding, 8px 10px);
  background: var(--hexcanvas-panel-bg, #1f2937);
  color: var(--hexcanvas-panel-fg, #d1d5db);
  border-bottom: 1px solid var(--hexcanvas-border, #4b5563);
}
button {
  border: 0; background: transparent; cursor: pointer; padding: 0 4px;
  color: var(--hexcanvas-panel-fg, #d1d5db);
  font: var(--hexcanvas-button-font, 13px system-ui);
}
button[disabled] { opacity: 0.4; cursor: default; }
.count { font-size: 12px; font-variant-numeric: tabular-nums; }
.message { font-size: 11px; margin-left: auto; color: var(--hexcanvas-panel-fg, #d1d5db); }
.message[data-tone="error"] { color: var(--hexcanvas-danger, #fca5a5); }
.message:empty { display: none; }
/* min-height on the row and min-width on each pane, because a flex item's
   automatic minimum size is its content — without them a grid wider or taller
   than the box pushes the box open instead of scrolling inside it. */
.panes { flex: 1 1 auto; display: flex; min-height: 0; }
.panes > hexcanvas-editor { flex: 1 1 0; min-width: 0; --hexcanvas-height: 100%; }
/* A hairline to look at and something wider to grab. The padding is the hit
   area and the content-box clip keeps the paint to the 1px middle, so the
   divider reads as it did while being seven pixels easier to catch. */
.divider {
  flex: none;
  box-sizing: border-box;
  width: var(--hexcanvas-divider-width, 7px);
  padding: 0 3px;
  background: var(--hexcanvas-border, #4b5563);
  background-clip: content-box;
  cursor: col-resize;
  /* Without this a touch drag scrolls the pane instead of moving the divider. */
  touch-action: none;
}
.divider:focus-visible { outline: 2px solid var(--hexcanvas-caret, #f8fafc); outline-offset: -1px; }
`;

/**
 * Forwarded to both panes rather than set on each. Two views of a comparison
 * have to agree on their geometry — a pane at 16 bytes a row beside one at 24
 * puts different bytes on the same line, which is the one thing a comparison
 * must not do — so the attributes that decide it are the box's, not the panes'.
 */
const forwarded = [
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

/** Which of the two panes. Spelled the same as `HexCompare`'s own sides. */
export type ComparePane = "left" | "right";

type Side = ComparePane;

const partNames = ["chrome", "button", "count", "message", "divider", "pane", "left", "right"] as const;

/**
 * `exportparts` value for a host nesting this inside its own shadow root. Named
 * apart from the finder's because both are re-exported from one entry point.
 */
export const compareExportParts = partNames.join(",");

export class HexCanvasCompare extends HTMLElement {
  static readonly observedAttributes = forwarded;

  readonly leftEditor: HexCanvasElement;
  /** The right-hand pane. */
  readonly rightEditor: HexCanvasElement;
  /** The comparison driving both panes: run it, walk the differences, or read them. */
  readonly comparison: HexCompare;
  private readonly root: ShadowRoot;
  private readonly count: HTMLSpanElement;
  private readonly message: HTMLSpanElement;
  private readonly panes: HTMLDivElement;
  private readonly divider: HTMLDivElement;
  private readonly cleanups: (() => void)[] = [];
  private unsubscribe: (() => void) | undefined;
  /** Which pane the reader is in; see `activePane`. */
  private active: Side = "left";
  /** Host-supplied pane names; see `paneLabels`. */
  private names: { left?: string; right?: string } = {};
  /**
   * Left pane width in pixels where the host dragged the divider, or undefined
   * for an even split. Undefined rather than "half of the current width" so a
   * comparison nobody has resized stays even as the window changes.
   */
  private split: number | undefined;
  /** Where a drag started: the pointer, and the width it began from. */
  private from: { x: number; width: number } | undefined;
  private observer: ResizeObserver | undefined;
  /** Last value written, so a re-apply that changes nothing writes no style. */
  private applied = "";
  /** Row width the split was last measured against; see `sync`. */
  private measuredRow = -1;
  /** Looked up once. `sync` runs on every engine notification. */
  private readonly buttons = new Map<string, HTMLButtonElement>();

  constructor() {
    super();
    // Before the panes are made, so `createElement` upgrades them straight away
    // rather than handing back two inert boxes that gain an engine later.
    defineHexCanvasElement();
    this.root = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = styles;

    this.leftEditor = pane("left");
    this.rightEditor = pane("right");
    this.panes = document.createElement("div");
    this.panes.className = "panes";
    this.divider = document.createElement("div");
    this.divider.className = "divider";
    this.divider.setAttribute("part", "divider");
    // A separator rather than a plain box: it is operable, so it has to be
    // reachable and reportable without a pointer.
    this.divider.setAttribute("role", "separator");
    this.divider.setAttribute("aria-orientation", "vertical");
    this.divider.tabIndex = 0;
    this.panes.append(this.leftEditor, this.divider, this.rightEditor);

    this.count = document.createElement("span");
    this.count.className = "count";
    this.count.setAttribute("part", "count");
    this.count.setAttribute("role", "status");
    this.message = document.createElement("span");
    this.message.className = "message";
    this.message.setAttribute("part", "message");
    this.message.setAttribute("role", "status");

    const chrome = document.createElement("div");
    chrome.className = "chrome";
    chrome.setAttribute("part", "chrome");
    chrome.append(
      button("◀", "previous-difference"),
      this.count,
      button("▶", "next-difference"),
      button("⟳", "compare"),
      button("×", "close"),
      this.message,
    );

    this.root.append(style, chrome, this.panes);

    this.comparison = new HexCompare({ left: this.leftEditor.engine, right: this.rightEditor.engine });
  }

  /** The left document. Assigning either side does not start a comparison. */
  get left(): ByteSource | BinaryBuffer | undefined {
    return this.leftEditor.source;
  }

  set left(source: ByteSource | BinaryBuffer | undefined) {
    this.leftEditor.source = source;
  }

  /**
   * The right-hand document. The left one is `source`, the same property a single
   * editor takes.
   */
  get right(): ByteSource | BinaryBuffer | undefined {
    return this.rightEditor.source;
  }

  set right(source: ByteSource | BinaryBuffer | undefined) {
    this.rightEditor.source = source;
  }

  /**
   * Replaces the comparison itself; see `DiffProvider`. Named apart from
   * `searchProvider`, which the panes also take and which is a different thing
   * entirely — a plain `provider` here was a name waiting to be assigned wrong.
   */
  set diffProvider(provider: DiffProvider | undefined) {
    this.rebuild({ provider });
  }

  /**
   * Options the editor takes as a property rather than an attribute, forwarded
   * to both panes.
   *
   * These are the ones an attribute cannot carry — an object, a function, a
   * table of keys — and every one of them is a setting for the comparison, not
   * for a pane. A host has one box, so it has to be able to say each of them
   * once; without that it reaches past this element to one engine and configures
   * half the screen, which is what happened to the theme.
   */
  set theme(theme: HexTheme | undefined) {
    for (const editor of this.panels) editor.theme = theme;
  }

  /** The gaps between the columns. Both panes, or the grids stop lining up. */
  set spacing(spacing: HexSpacing | undefined) {
    for (const editor of this.panels) editor.spacing = spacing;
  }

  /** Forwarded to both panes. */
  set text(text: HexTextOverrides | undefined) {
    for (const editor of this.panels) editor.text = text;
  }

  /** Forwarded to both panes. */
  set keymap(keymap: Keymap | undefined) {
    for (const editor of this.panels) editor.keymap = keymap;
  }

  /** Forwarded to both panes. */
  set searchProvider(provider: SearchProvider | undefined) {
    for (const editor of this.panels) editor.searchProvider = provider;
  }

  /** Forwarded to both panes. */
  set searchModes(modes: readonly SearchMode[] | undefined) {
    for (const editor of this.panels) editor.searchModes = modes;
  }

  /** Forwarded to both panes. */
  set copyHandler(handler: ((text: string) => void) | undefined) {
    for (const editor of this.panels) editor.copyHandler = handler;
  }

  /**
   * Most repaints a second, per pane. A comparison is two canvases, so this is
   * the setting that matters most here — and it has to reach both, or capping it
   * would halve one pane's work and leave the other painting at full rate.
   */
  set maxFps(value: number | undefined) {
    for (const editor of this.panels) editor.maxFps = value;
  }

  /** A host's own encoding, to both panes; the attribute names one instead. */
  set printable(printable: PrintableChar | undefined) {
    for (const editor of this.panels) editor.printable = printable;
  }

  /**
   * What to call each pane out loud.
   *
   * Both panes were named "Hex editor", which is true of each and useless for
   * telling them apart: a screen reader read a comparison as two identical
   * applications side by side, with nothing saying which held the original. The
   * text bag's "Left document" and "Right document" are the fallback; a host
   * that knows it is comparing `firmware-1.2.bin` against `firmware-1.3.bin`
   * should say so, because that is the distinction the reader actually wants.
   */
  set paneLabels(labels: { left?: string; right?: string } | undefined) {
    this.names = labels ?? {};
    this.syncText(this.leftEditor.engine.text);
  }

  /**
   * Re-reads the `--hexcanvas-*` properties into both panes.
   *
   * Nothing watches the cascade, so a host that changes those at runtime has to
   * say so — and it has one box, not two. Without this a host calls the method
   * on whichever engine it happens to hold and repaints half the comparison,
   * which is what the demo did.
   */
  refreshTheme(): void {
    for (const editor of this.panels) editor.refreshTheme();
  }

  /**
   * The pane the reader is in — the one last focused, or last clicked into.
   *
   * A comparison has two of everything a single editor has one of, so anything
   * that acts on "the document" has to name which. Find is the case that forced
   * it: a query belongs to the pane being read, not to the left one by
   * convention. Defaults to the left, because something has to be true before
   * anything has been focused.
   */
  get activePane(): Side {
    return this.active;
  }

  /** Whichever pane holds the cursor — what the panels and the status line act on. */
  get activeEditor(): HexCanvasElement {
    return this.active === "left" ? this.leftEditor : this.rightEditor;
  }

  /** The two panes, for the settings that have to reach both of them. */
  private get panels(): readonly HexCanvasElement[] {
    return [this.leftEditor, this.rightEditor];
  }

  /** Runs it. Resolves with how many differences were found. */
  compare(force = false): Promise<number> {
    return this.comparison.compare(force);
  }

  /** Drops the differences and their highlights. Both documents stay. */
  clear(): void {
    this.comparison.clear();
  }

  connectedCallback(): void {
    if (!this.hasAttribute("part")) this.setAttribute("part", "compare");
    for (const element of this.root.querySelectorAll("button")) {
      this.buttons.set(element.dataset.action ?? "", element);
      this.listen(element, "click", () => this.act(element.dataset.action ?? ""));
    }
    this.unsubscribe = this.comparison.subscribe(() => this.sync());
    this.listenSplit();
    this.listenPanes();
    // The clamp is measured against the box, so a resized window has to re-run
    // it — otherwise a split set while wide leaves one pane past the edge.
    if (typeof ResizeObserver === "function") {
      this.observer = new ResizeObserver(() => this.applySplit());
      this.observer.observe(this.panes);
      this.cleanups.push(() => this.observer?.disconnect());
    }
    // The panes report their own state changes; the bar's disabled buttons and
    // the stale note follow the engines as much as the comparison.
    for (const editor of this.panels) {
      this.cleanups.push(editor.engine.subscribe(() => this.sync()));
    }
    for (const name of forwarded) {
      const value = this.getAttribute(name);
      if (value !== null) this.forward(name, value);
    }
    this.sync();
  }

  disconnectedCallback(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
    this.forward(name, value);
  }

  private forward(name: string, value: string | null): void {
    for (const editor of this.panels) {
      if (value === null) editor.removeAttribute(name);
      else editor.setAttribute(name, value);
    }
  }

  private act(action: string): void {
    switch (action) {
      case "previous-difference": this.comparison.previousDifference(); break;
      case "next-difference": this.comparison.nextDifference(); break;
      case "compare": void this.comparison.compare(true); break;
      // Closing is the host's decision — this box does not know whether it
      // should be hidden, removed, or replaced by a single editor.
      case "close":
        this.comparison.clear();
        this.dispatchEvent(new CustomEvent("close", { bubbles: true, composed: true }));
        break;
      default: break;
    }
  }

  // --- which pane the reader is in ------------------------------------------

  private listenPanes(): void {
    for (const side of ["left", "right"] as const) {
      const editor = side === "left" ? this.leftEditor : this.rightEditor;
      // `focusin` rather than `focus`: the editor takes focus itself on a click,
      // but so can the find panel inside it, and both mean the same pane.
      this.listen(editor, "focusin", () => this.activate(side));
      // A pointer down that does not move focus — a drag on the grid with focus
      // already inside the element — still says which pane is being read.
      this.listen(editor, "pointerdown", () => this.activate(side));
      /**
       * The pane's own events do not cross its shadow root: the editor
       * dispatches them on itself without `composed`, so a host listening on
       * this element would never see them. Re-emitted with the side attached,
       * which is the part a host with two panes actually needs.
       */
      this.listen(editor, "searchrequest", (event) => {
        this.activate(side);
        const request = (event as CustomEvent).detail;
        this.dispatchEvent(new CustomEvent("searchrequest", { detail: { ...request, side } }));
      });
    }
  }

  private activate(side: Side): void {
    if (this.active === side) return;
    this.active = side;
    this.dispatchEvent(new CustomEvent("activepanechange", { detail: { side } }));
  }

  // --- the divider ----------------------------------------------------------

  private listenSplit(): void {
    // Pointer events rather than mouse, so a trackpad and a pen drag it too.
    this.listen(this.divider, "pointerdown", (event) => {
      const pointer = event as PointerEvent;
      if (pointer.button !== 0) return;
      // Text selection across the panes would otherwise start under the drag.
      pointer.preventDefault();
      this.from = { x: pointer.clientX, width: this.leftEditor.getBoundingClientRect().width };
      // Capture keeps the drag alive once the pointer leaves the seven pixels
      // it started in, which is most of a drag. It is an improvement to it
      // rather than a requirement, and it throws for a pointer that is no
      // longer down, so losing it must not take the drag with it.
      try {
        this.divider.setPointerCapture(pointer.pointerId);
      } catch {
        // Left to the divider's own pointermove, which still tracks inside it.
      }
    });
    this.listen(this.divider, "pointermove", (event) => {
      if (!this.from) return;
      this.split = this.from.width + ((event as PointerEvent).clientX - this.from.x);
      this.applySplit();
    });
    for (const type of ["pointerup", "pointercancel"]) {
      this.listen(this.divider, type, () => { this.from = undefined; });
    }
    // Back to even, which is the one position that is otherwise unreachable
    // once it has been dragged.
    this.listen(this.divider, "dblclick", () => {
      this.split = undefined;
      this.applySplit();
    });
    this.listen(this.divider, "keydown", (event) => {
      const key = (event as KeyboardEvent).key;
      const step = key === "ArrowLeft" ? -16 : key === "ArrowRight" ? 16 : 0;
      if (step === 0 && key !== "Home") return;
      event.preventDefault();
      this.split = key === "Home" ? undefined : this.leftEditor.getBoundingClientRect().width + step;
      this.applySplit();
    });
  }

  /**
   * The narrowest a pane may be: one whole row of the grid.
   *
   * A divider that can be dragged past this does not merely make a pane small,
   * it makes it wrong — the bytes it is there to show start needing horizontal
   * scrolling to read, and comparing two documents you have to scroll sideways
   * in is not comparing them. Taken from whichever pane needs more, since both
   * are answering the same geometry.
   */
  private minimumPaneWidth(): number {
    return Math.max(this.leftEditor.engine.scrollWidth, this.rightEditor.engine.scrollWidth);
  }

  private applySplit(): void {
    const total = this.panes.clientWidth - this.divider.offsetWidth;
    if (total <= 0) return;
    const even = total / 2;
    const minimum = this.minimumPaneWidth();
    // Where two whole rows do not fit at all, an even split is the fairest
    // thing left; honouring a floor neither pane can meet would pin the divider
    // to one end and look broken.
    const width = this.split === undefined || minimum * 2 > total
      ? even
      : Math.min(Math.max(this.split, minimum), total - minimum);
    // Undragged, the inline width comes off and the stylesheet's `flex: 1 1 0`
    // keeps the two even by itself — better than pinning a pixel count that
    // every resize would have to chase.
    const next = this.split === undefined ? "" : `0 0 ${width}px`;
    if (next !== this.applied) {
      this.leftEditor.style.flex = next;
      this.applied = next;
    }
    const percent = String(Math.round((width / total) * 100));
    if (this.divider.getAttribute("aria-valuenow") !== percent) {
      this.divider.setAttribute("aria-valuenow", percent);
      // A bare "49" says nothing about what it counts. The unit belongs in
      // `aria-valuetext`, which is what a screen reader reads in its place.
      this.divider.setAttribute("aria-valuetext", `${percent}%`);
    }
  }

  private listen(target: EventTarget, type: string, handler: (event: Event) => void): void {
    target.addEventListener(type, handler);
    this.cleanups.push(() => target.removeEventListener(type, handler));
  }

  private sync(): void {
    const state = this.comparison.getState();
    const text = this.leftEditor.engine.text;
    const walkable = state.differenceCount > 0;
    for (const [action, enabled] of [
      ["previous-difference", walkable],
      ["next-difference", walkable],
      ["compare", !state.comparing],
    ] as const) {
      const element = this.buttons.get(action);
      if (element && element.disabled === enabled) element.disabled = !enabled;
    }

    // Guarded, because this is a live region: writing it the same text again
    // announces it again. `sync` runs on every engine notification, and one
    // action makes several, so an unguarded write said "1 difference" six times
    // for a comparison that had not changed.
    const counted = state.comparing ? text.comparing
      : !state.compared ? ""
      : state.differenceCount === 0 ? text.identical
      : text.differencePosition(state.differenceIndex, state.differenceCount, state.differenceTruncated);
    if (this.count.textContent !== counted) this.count.textContent = counted;

    // The complaint outranks the note: a comparison that failed is not merely
    // out of date.
    const complaint = state.error !== undefined ? { text: state.error, tone: "error" }
      : state.stale ? { text: text.comparisonStale, tone: "info" }
      : { text: "", tone: "info" };
    // Guarded for the same reason the count is, and announced for a reason the
    // count cannot cover: "run it again" and a comparison that failed outright
    // were painted into the strip and said nowhere. A reader who cannot see the
    // strip was left with a difference list quietly describing the documents as
    // they were several edits ago.
    if (this.message.textContent !== complaint.text) this.message.textContent = complaint.text;
    this.message.dataset.tone = complaint.tone;
    this.syncText(text);
    // The floor is one row wide, so a change to the geometry moves it — a pane
    // legal at 16 bytes a row is too narrow at 32. Compared first, because
    // `applySplit` reads `clientWidth` and that forces a layout: running it on
    // every notification put a synchronous reflow in the path of every cursor
    // move. The row width is a number the engine already holds, so asking it
    // costs nothing, and the box's own changes come from the ResizeObserver.
    const row = this.minimumPaneWidth();
    if (row === this.measuredRow) return;
    this.measuredRow = row;
    this.applySplit();
  }

  /**
   * Names the buttons from the text bag and puts the key that runs each in its
   * tooltip, for the reason the finder does: both are replaceable, so writing
   * either one here would be wrong on some machine or in some language.
   */
  private syncText(text: HexText): void {
    const engine = this.leftEditor.engine;
    if (this.divider.getAttribute("aria-label") !== text.splitHandle) {
      this.divider.setAttribute("aria-label", text.splitHandle);
    }
    // Set here rather than left to each pane's own default, which is the same
    // string for both; see `paneLabels`.
    for (const [editor, label] of [
      [this.leftEditor, this.names.left ?? text.leftPane],
      [this.rightEditor, this.names.right ?? text.rightPane],
    ] as const) {
      if (editor.getAttribute("aria-label") !== label) editor.setAttribute("aria-label", label);
    }
    const named = [
      ["previous-difference", text.previousDifferenceButton, "previousDifference"],
      ["next-difference", text.nextDifferenceButton, "nextDifference"],
      ["compare", text.compareButton, undefined],
      ["close", text.closeCompareButton, undefined],
    ] as const;
    for (const [action, label, command] of named) {
      const element = this.buttons.get(action);
      if (!element) continue;
      if (element.getAttribute("aria-label") !== label) element.setAttribute("aria-label", label);
      const key = command === undefined ? undefined : engine.keyFor(command);
      const title = key ? `${label} (${key})` : label;
      if (element.title !== title) element.title = title;
    }
  }

  /** A new coordinator over the same two engines, for a replaced provider. */
  private rebuild(options: { provider?: DiffProvider }): void {
    this.comparison.destroy();
    const next = new HexCompare({ left: this.leftEditor.engine, right: this.rightEditor.engine, ...options });
    (this as { comparison: HexCompare }).comparison = next;
    this.unsubscribe?.();
    this.unsubscribe = this.isConnected ? next.subscribe(() => this.sync()) : undefined;
    if (this.isConnected) this.sync();
  }
}

const pane = (side: "left" | "right"): HexCanvasElement => {
  const editor = document.createElement("hexcanvas-editor") as HexCanvasElement;
  editor.setAttribute("part", `pane ${side}`);
  return editor;
};

const button = (glyph: string, action: string): HTMLButtonElement => {
  const element = document.createElement("button");
  element.setAttribute("part", "button");
  element.dataset.action = action;
  element.type = "button";
  element.textContent = glyph;
  return element;
};

/** Idempotent, so importing from more than one place is safe. */
export function defineHexCanvasCompare(tag = "hexcanvas-compare"): void {
  if (typeof customElements === "undefined" || customElements.get(tag)) return;
  defineHexCanvasElement();
  customElements.define(tag, HexCanvasCompare);
}
