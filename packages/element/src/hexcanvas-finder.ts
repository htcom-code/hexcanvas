import type { CommandId, HexEngine, HexText, SearchMode } from "@hexcanvas/core";

/**
 * One panel, not three. Find, replace and go-to were separate floating forms
 * stacked by the overlay, which read as three windows for what is one task; here
 * they are rows of a single box that grows and shrinks.
 *
 * Rows stay separate `<form>`s inside it. Enter in the find field means "find
 * next" and Enter in the replace field means "replace", and one form would have
 * to recover that from `SubmitEvent.submitter` — implicit submission is subtle
 * enough without adding a demultiplexer to it.
 */
const styles = `
:host {
  display: block;
  box-sizing: border-box;
  padding: var(--hexcanvas-finder-padding, 8px 10px);
  background: var(--hexcanvas-panel-bg, #1f2937);
  color: var(--hexcanvas-panel-fg, #d1d5db);
  border-bottom: 1px solid var(--hexcanvas-border, #4b5563);
}
:host([hidden]) { display: none; }
.rows { display: flex; flex-direction: column; gap: 6px; }
.row { display: flex; gap: 6px; align-items: center; }
.row[hidden] { display: none; }
input, select {
  color: var(--hexcanvas-panel-fg, #f9fafb);
  border: 1px solid var(--hexcanvas-border, #4b5563);
  border-radius: var(--hexcanvas-radius, 4px);
  background: var(--hexcanvas-field-bg, #111827);
  font: var(--hexcanvas-panel-font, 12px ui-monospace, monospace);
}
input { width: var(--hexcanvas-input-width, 200px); min-width: 0; padding: 5px 7px; }
select { padding: 4px 6px; }
button {
  border: 0; background: transparent; cursor: pointer; padding: 0 4px;
  color: var(--hexcanvas-panel-fg, #d1d5db);
  font: var(--hexcanvas-button-font, 13px system-ui);
}
/* One message for the whole panel. Two rows with an absolutely positioned
   message each had the find complaint land on top of the replace row. */
.message { font-size: 11px; min-height: 1.2em; white-space: nowrap; color: var(--hexcanvas-danger, #fca5a5); }
.message[data-tone="info"] { color: var(--hexcanvas-panel-fg, #d1d5db); }
.message:empty { display: none; }
.label { font-size: 12px; }
.count { font-size: 12px; min-width: 4ch; text-align: right; opacity: 0.75; font-variant-numeric: tabular-nums; }
/* Reachable by a screen reader, invisible to everyone else — the same trick the
   editor's live region uses. "2/205" is right for four characters of chrome and
   wrong out loud, so the strip carries both and hides one from each audience. */
.spoken {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0;
}
`;

/** Part names forwarded past the editor's shadow root; see `exportParts`. */
const partNames = [
  "find-row",
  "replace-row",
  "goto-row",
  "find-input",
  "replace-input",
  "goto-input",
  "select",
  "button",
  "count",
  "message",
  "label",
] as const;

/** `exportparts` value for a host that nests this inside its own shadow root. */
export const exportParts = partNames.join(",");

/**
 * The find/replace/go-to chrome as its own element, bound to an engine by
 * property.
 *
 * Separate from the editor so it can be placed rather than only styled. The
 * editor puts one in its own top region; a host that would rather have it in a
 * layer, a toolbar or a side panel builds one itself and assigns `engine`. The
 * engine already supports more than one view — `subscribe` and `getState` are
 * all this needs — so both are the same arrangement.
 */
export class HexCanvasFinder extends HTMLElement {
  private readonly root: ShadowRoot;
  private readonly findRow: HTMLFormElement;
  private readonly modeSelect: HTMLSelectElement;
  private readonly findInput: HTMLInputElement;
  /** The visible "2/205", hidden from the accessibility tree. */
  private readonly count: HTMLSpanElement;
  /** The same fact as a sentence, and the only one of the two announced. */
  private readonly countSpoken: HTMLSpanElement;
  private readonly replaceRow: HTMLFormElement;
  private readonly replaceInput: HTMLInputElement;
  private readonly gotoRow: HTMLFormElement;
  private readonly gotoInput: HTMLInputElement;
  private readonly replaceLabel: HTMLSpanElement;
  private readonly gotoLabel: HTMLSpanElement;
  private readonly message: HTMLSpanElement;
  private readonly cleanups: (() => void)[] = [];
  private held: HexEngine | undefined;
  private unsubscribe: (() => void) | undefined;
  /** Rebuilt when the engine offers a different set, not on every repaint. */
  private renderedModes: readonly SearchMode[] = [];

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = styles;

    this.modeSelect = select();
    this.findInput = input("find-input");
    this.count = document.createElement("span");
    this.count.className = "count";
    this.count.setAttribute("part", "count");
    // Not a live region itself: what it holds is "2/205", which is four
    // characters of chrome and two numbers with a slash between them out loud.
    // The sentence lives in its own node beside it, and that one is announced.
    this.count.setAttribute("aria-hidden", "true");
    this.countSpoken = document.createElement("span");
    this.countSpoken.className = "spoken";
    this.countSpoken.setAttribute("role", "status");
    this.findRow = row("find-row", [
      this.modeSelect,
      this.findInput,
      this.count,
      this.countSpoken,
      button("↑", "find-previous"),
      button("↓", "find-next", "submit"),
      button("⇄", "toggle-replace"),
      button("×", "close-search"),
    ]);

    // A landmark rather than three unnamed forms. Opening the panel moves focus
    // straight into a field, and a field announced by its own label says what to
    // type without saying what appeared — the row it is in has to be a named
    // region for "something opened, and it is find" to be heard at all.
    this.findRow.setAttribute("role", "search");

    this.replaceInput = input("replace-input");
    this.replaceLabel = label();
    this.replaceLabel.id = "replace-label";
    this.replaceRow = row("replace-row", [
      this.replaceLabel,
      this.replaceInput,
      button("", "replace", "submit"),
      button("", "replace-all"),
      button("×", "close-replace"),
    ]);

    this.gotoInput = input("goto-input");
    this.gotoLabel = label();
    this.gotoLabel.id = "goto-label";
    this.gotoRow = row("goto-row", [
      this.gotoLabel,
      this.gotoInput,
      button("→", "goto", "submit"),
      button("×", "close-goto"),
    ]);
    // Named from the caption already beside them, so a host that translates the
    // text bag translates the landmark too and there is nothing to keep in step.
    // A form with a name is a landmark; without one it is nothing at all, which
    // is what these two were.
    this.replaceRow.setAttribute("aria-labelledby", this.replaceLabel.id);
    this.gotoRow.setAttribute("aria-labelledby", this.gotoLabel.id);

    this.message = document.createElement("span");
    this.message.className = "message";
    this.message.setAttribute("part", "message");
    this.message.setAttribute("role", "status");
    // Referenced by whichever field the complaint is about. Both live in this
    // shadow root, which is where an IDREF has to resolve.
    this.message.id = "message";

    const rows = document.createElement("div");
    rows.className = "rows";
    rows.append(this.findRow, this.replaceRow, this.gotoRow, this.message);
    this.root.append(style, rows);
  }

  /** The editor's engine. Re-assigning moves this view to the new one. */
  get engine(): HexEngine | undefined {
    return this.held;
  }

  set engine(engine: HexEngine | undefined) {
    if (this.held === engine) return;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.held = engine;
    if (!engine) return;
    this.unsubscribe = engine.subscribe(() => this.sync());
    this.sync();
  }

  connectedCallback(): void {
    if (!this.hasAttribute("part")) this.setAttribute("part", "finder");

    this.listen(this.findRow, "submit", (event) => { event.preventDefault(); void this.held?.runSearch(); });
    this.listen(this.modeSelect, "change", () => this.held?.setSearchMode(this.modeSelect.value));
    this.listen(this.findInput, "input", () => this.held?.setSearchQuery(this.findInput.value));
    this.listen(this.replaceRow, "submit", (event) => { event.preventDefault(); void this.held?.replace(); });
    this.listen(this.replaceInput, "input", () => this.held?.setReplaceQuery(this.replaceInput.value));
    this.listen(this.gotoRow, "submit", (event) => { event.preventDefault(); this.held?.runGoto(); this.dismiss(); });
    this.listen(this.gotoInput, "input", () => this.held?.setGotoQuery(this.gotoInput.value));
    for (const field of [this.findInput, this.replaceInput, this.gotoInput]) {
      this.listen(field, "keydown", (event) => this.onFieldKey(event as KeyboardEvent, field));
    }
    for (const element of this.root.querySelectorAll("button")) {
      this.listen(element, "click", () => this.act(element.dataset.action ?? ""));
    }
    if (this.held) this.sync();
  }

  disconnectedCallback(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /**
   * Actions are keyed by `data-action`, not by the accessible label. The label
   * used to be the key, which meant translating the buttons broke them.
   */
  private act(action: string): void {
    const engine = this.held;
    if (!engine) return;
    switch (action) {
      case "find-previous": void engine.runSearch("previous"); break;
      case "toggle-replace":
        if (engine.getState().replaceOpen) engine.closeReplace();
        else engine.openReplace();
        break;
      case "replace-all": void engine.replaceAll(); break;
      case "close-replace": engine.closeReplace(); this.dismiss(); break;
      case "close-search": engine.closeSearch(); this.dismiss(); break;
      case "close-goto": engine.closeGoto(); this.dismiss(); break;
      // "find-next", "replace" and "goto" are submit buttons; their form handles them.
      default: break;
    }
  }

  private onFieldKey(event: KeyboardEvent, field: HTMLInputElement): void {
    // The editor listens for keydown on itself and these bubble through its
    // shadow root, so without this typing in a field would also edit bytes.
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      if (field === this.gotoInput) this.held?.closeGoto();
      else this.held?.closeSearch();
      this.dismiss();
    }
    if (event.key === "Enter" && event.shiftKey && field === this.findInput) {
      event.preventDefault();
      void this.held?.runSearch("previous");
    }
  }

  /**
   * Points one field at the message and clears the other two, so only the field
   * the complaint is about carries it.
   */
  private blame(field: HTMLInputElement | undefined, failed: boolean): void {
    for (const candidate of [this.findInput, this.replaceInput, this.gotoInput]) {
      const blamed = candidate === field;
      set(candidate, "aria-describedby", blamed ? "message" : null);
      // Only a failure is invalid. A replace that succeeded also leaves a
      // message, and saying the field is wrong when it worked is a lie.
      set(candidate, "aria-invalid", blamed && failed ? "true" : null);
    }
  }

  /** Asks whoever placed this to take focus back — usually the grid. */
  private dismiss(): void {
    this.dispatchEvent(new CustomEvent("dismiss", { bubbles: true, composed: true }));
  }

  private listen(target: EventTarget, type: string, handler: (event: Event) => void): void {
    target.addEventListener(type, handler);
    this.cleanups.push(() => target.removeEventListener(type, handler));
  }

  private sync(): void {
    const engine = this.held;
    if (!engine) return;
    const state = engine.getState();
    const searchable = state.searchFeature !== "off";
    // Hidden as a whole when there is nothing open, so the region it sits in
    // takes no height rather than showing an empty bar.
    const visible = (searchable && state.searchOpen) || (state.gotoFeature !== "off" && state.gotoOpen);
    if (this.hidden === visible) this.hidden = !visible;
    toggle(this.findRow, searchable && state.searchOpen);
    toggle(this.replaceRow, state.replaceFeature !== "off" && state.searchOpen && state.replaceOpen);
    toggle(this.gotoRow, state.gotoOpen);

    this.syncModes(state.searchModes);
    this.syncText(engine.text, state.searchMode);
    if (this.modeSelect.value !== state.searchMode) this.modeSelect.value = state.searchMode;
    if (this.findInput.value !== state.searchQuery) this.findInput.value = state.searchQuery;
    if (this.replaceInput.value !== state.replaceQuery) this.replaceInput.value = state.replaceQuery;
    if (this.gotoInput.value !== state.gotoQuery) this.gotoInput.value = state.gotoQuery;

    // Position first, total second, and a plus sign when the scan hit its cap.
    const total = `${state.searchMatchCount}${state.searchTruncated ? "+" : ""}`;
    const glyph = state.searchMatchCount === 0
      ? ""
      : state.searchMatchIndex > 0 ? `${state.searchMatchIndex}/${total}` : total;
    const spoken = state.searchMatchCount === 0
      ? ""
      : state.searchMatchIndex > 0
        ? engine.text.searchPosition(state.searchMatchIndex, state.searchMatchCount, state.searchTruncated)
        : engine.text.searchTotal(state.searchMatchCount, state.searchTruncated);
    if (this.count.textContent !== glyph) this.count.textContent = glyph;
    // Guarded, because writing a live region the same text again announces it
    // again: every state patch would repeat the count the user already heard.
    if (this.countSpoken.textContent !== spoken) this.countSpoken.textContent = spoken;

    // Whichever row the message belongs to, shown in one place. Go-to first
    // because it is the row that was opened last. The field it belongs to comes
    // along with it, so the complaint can be tied to what is wrong.
    const complaint = state.gotoOpen && state.gotoError
      ? { text: state.gotoError, failed: true, field: this.gotoInput }
      : state.replaceOpen && state.replaceMessage !== undefined
        ? { text: state.replaceMessage, failed: state.replaceFailed, field: this.replaceInput }
        : state.searchError !== undefined
          ? { text: state.searchError, failed: true, field: this.findInput }
          : { text: "", failed: true, field: undefined };
    if (this.message.textContent !== complaint.text) this.message.textContent = complaint.text;
    this.message.dataset.tone = complaint.failed ? "error" : "info";
    // A live region is announced once and then it is gone. Pointing the field at
    // the message leaves it re-readable for anyone who missed it, and marks the
    // field itself as the thing that is wrong rather than leaving a complaint
    // floating in the strip with nothing to attach it to.
    this.blame(complaint.text === "" ? undefined : complaint.field, complaint.failed);

    this.focusOpenRow(state.gotoOpen, searchable && state.searchOpen);
  }

  /**
   * Names every field and button from the text bag, and puts the key that
   * actually runs each button in its tooltip.
   *
   * Both are asked of the engine rather than written here. The keys differ by
   * platform and a host can rebind them, so a hardcoded hint would be wrong on
   * some machine; the names can be replaced, so a hardcoded label would be
   * English on a screen that is not.
   */
  private syncText(text: HexText, mode: SearchMode): void {
    const engine = this.held;
    if (!engine) return;
    const hex = mode === "hex";
    set(this.findRow, "aria-label", text.searchPanel);
    set(this.modeSelect, "aria-label", text.searchModeField);
    set(this.findInput, "aria-label", hex ? text.findHexField : text.findTextField);
    const placeholder = hex ? text.findHexPlaceholder : text.findTextPlaceholder;
    if (this.findInput.placeholder !== placeholder) this.findInput.placeholder = placeholder;
    set(this.replaceInput, "aria-label", text.replaceField);
    if (this.replaceInput.placeholder !== text.replacePlaceholder) this.replaceInput.placeholder = text.replacePlaceholder;
    set(this.gotoInput, "aria-label", text.gotoField);
    if (this.gotoInput.placeholder !== text.gotoPlaceholder) this.gotoInput.placeholder = text.gotoPlaceholder;
    if (this.replaceLabel.textContent !== text.replaceRow) this.replaceLabel.textContent = text.replaceRow;
    if (this.gotoLabel.textContent !== text.gotoRow) this.gotoLabel.textContent = text.gotoRow;

    for (const [action, name, command] of buttons) {
      const button = this.root.querySelector<HTMLButtonElement>(`button[data-action="${action}"]`);
      if (!button) continue;
      const label = text[name];
      set(button, "aria-label", label);
      // The arrows and crosses are glyphs and mean the same in every language, so
      // only the buttons captioned with a word take the text as their caption too.
      if (wordCaptioned.has(action) && button.textContent !== label) button.textContent = label;
      const key = command && engine.keyFor(command);
      const title = key ? `${label} (${key})` : label;
      if (button.title !== title) button.title = title;
    }
  }

  /** A provider can offer modes of its own, so the options come from the engine. */
  private syncModes(modes: readonly SearchMode[]): void {
    if (modes.length === this.renderedModes.length && modes.every((mode, at) => mode === this.renderedModes[at])) return;
    this.renderedModes = modes;
    this.modeSelect.replaceChildren(...modes.map((mode) => {
      const option = document.createElement("option");
      option.value = mode;
      option.textContent = mode;
      return option;
    }));
  }

  private focusOpenRow(gotoOpen: boolean, searchOpen: boolean): void {
    const active = this.root.activeElement;
    if (gotoOpen) {
      if (active !== this.gotoInput) this.gotoInput.focus({ preventScroll: true });
      return;
    }
    // Left alone once focus is anywhere in the panel, so tabbing to the replace
    // field is not undone on the next repaint.
    if (searchOpen && active !== this.findInput && active !== this.replaceInput && !(active instanceof HTMLButtonElement)) {
      this.findInput.focus({ preventScroll: true });
    }
  }
}

/**
 * Every button: its `data-action`, where its name lives in the text bag, and the
 * command whose key belongs in its tooltip — the four that have one.
 */
const buttons: readonly (readonly [action: string, name: ButtonName, command?: CommandId])[] = [
  ["find-previous", "findPreviousButton", "findPrevious"],
  ["find-next", "findNextButton", "findNext"],
  ["toggle-replace", "toggleReplaceButton", "replace"],
  ["close-search", "closeSearchButton"],
  ["replace", "replaceButton"],
  ["replace-all", "replaceAllButton"],
  ["close-replace", "closeReplaceButton"],
  ["goto", "gotoButton", "goto"],
  ["close-goto", "closeGotoButton"],
];

/** Buttons whose visible caption is a word rather than a glyph. */
const wordCaptioned = new Set(["replace", "replace-all"]);

/** The text keys that name a button, so the table above cannot point at prose. */
type ButtonName = {
  [K in keyof HexText]: HexText[K] extends string ? (K extends `${string}Button` ? K : never) : never;
}[keyof HexText];

/**
 * Set only when it changed; a repaint should not churn attributes. `null`
 * removes it, which is not the same as setting it empty — `aria-invalid=""`
 * still reads as invalid.
 */
const set = (element: Element, attribute: string, value: string | null): void => {
  if (element.getAttribute(attribute) === value) return;
  if (value === null) element.removeAttribute(attribute);
  else element.setAttribute(attribute, value);
};

const row = (part: string, children: Node[]): HTMLFormElement => {
  const element = document.createElement("form");
  element.className = "row";
  element.setAttribute("part", part);
  element.hidden = true;
  element.append(...children);
  return element;
};

/**
 * The fields and buttons are built without their names. Accessible names come
 * from the engine's text bag, which does not exist until one is assigned, so
 * `sync` is where they are set — and a host that changes the text later gets the
 * new names for free rather than a stale DOM.
 */
const input = (part: string): HTMLInputElement => {
  const element = document.createElement("input");
  element.setAttribute("part", `input ${part}`);
  return element;
};

const select = (): HTMLSelectElement => {
  const element = document.createElement("select");
  element.setAttribute("part", "select");
  return element;
};

const button = (glyph: string, action: string, type: "button" | "submit" = "button"): HTMLButtonElement => {
  const element = document.createElement("button");
  element.setAttribute("part", "button");
  element.dataset.action = action;
  element.type = type;
  element.textContent = glyph;
  return element;
};

const label = (): HTMLSpanElement => {
  const element = document.createElement("span");
  element.className = "label";
  element.setAttribute("part", "label");
  return element;
};

const toggle = (element: HTMLElement, visible: boolean): void => {
  if (element.hidden === visible) element.hidden = !visible;
};

/** Idempotent, so importing from more than one place is safe. */
export function defineHexCanvasFinder(tag = "hexcanvas-finder"): void {
  if (typeof customElements === "undefined" || customElements.get(tag)) return;
  customElements.define(tag, HexCanvasFinder);
}
