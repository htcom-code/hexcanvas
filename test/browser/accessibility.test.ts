import { describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import {
  HexEngine,
  MemoryByteSource,
  asciiPrintable,
  cp437Printable,
  latin1Printable,
  type HexEngineOptions,
} from "@hexcanvas/core";
import { defineHexCanvasCompare, defineHexCanvasElement, type HexCanvasCompare, type HexCanvasElement } from "@hexcanvas/element";
import { Painted, bytes, canvasFixture, frames, hasPainted, probeProperties, probeTheme, themedFixture, waitFor } from "./harness";

/**
 * What a screen reader is actually handed.
 *
 * The grid is a canvas, so none of what it shows is in the accessibility tree:
 * a live region and a handful of names are the entire non-visual surface, and
 * until this file existed none of it had been checked by anything but a person
 * reading the source. Every case here is one that was wrong when it was written.
 */

/** The one node a screen reader reads the grid through. */
const announcement = (editor: HexCanvasElement) =>
  editor.shadowRoot!.querySelector(".announcement")!;

async function mountEditor(width = 640) {
  defineHexCanvasElement();
  const host = themedFixture(width, 240);
  const editor = document.createElement("hexcanvas-editor") as HexCanvasElement;
  for (const [property, value] of Object.entries({ ...probeProperties, "--hexcanvas-height": "240px" })) {
    editor.style.setProperty(property, value);
  }
  host.append(editor);
  editor.source = new MemoryByteSource(bytes(256));
  const canvas = editor.shadowRoot!.querySelector("canvas")!;
  await waitFor(() => hasPainted(canvas), "the grid to paint");
  return { editor, host };
}

const press = (target: HTMLElement, key: string, init: KeyboardEventInit = {}) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true, ...init }));

describe("the live region", () => {
  it("describes where the cursor is, because nothing else can", async () => {
    const { editor } = await mountEditor();
    editor.engine.moveCursor(0x11);
    await frames();
    // Address, byte, column: the three things the painted cursor conveys.
    expect(announcement(editor).textContent).toContain("00000011");
    expect(announcement(editor).textContent).toContain("hex column");
  });

  it("says how much is selected", async () => {
    const { editor } = await mountEditor();
    editor.engine.select(4, 12);
    await frames();
    expect(announcement(editor).textContent).toContain("8 bytes selected");
  });
});

/**
 * The cursor description is what the grid says as you move through it. This is
 * what it says when asked: a row, or whatever the cursor is inside. Everything
 * a sighted reader takes from the grid by looking at it arrives here or not at
 * all.
 */
describe("reading on demand", () => {
  /** `⌥R` types "®", so the binding matches on `code`; see the keymap. */
  const readRow = (editor: HexCanvasElement, shift = false) =>
    press(editor, "®", { code: "KeyR", altKey: true, shiftKey: shift });

  it("puts a whole row in the live region", async () => {
    const { editor } = await mountEditor();
    // Bytes that are their own offsets, so the row 0x40-0x4F is "@" and then the
    // alphabet — a row where both halves of the sentence are worth reading.
    editor.source = new MemoryByteSource(Uint8Array.from({ length: 256 }, (_, at) => at));
    editor.engine.moveCursor(0x41);
    await frames();
    readRow(editor);
    await frames();
    const said = announcement(editor).textContent!;
    expect(said).toContain("row 00000040");
    expect(said).toContain("40 41 42");
    expect(said).toContain("@ABCDEFGHIJKLMNO");
  });

  it("says it again when asked again", async () => {
    const { editor } = await mountEditor();
    editor.engine.moveCursor(0x41);
    await frames();
    readRow(editor);
    await frames();
    // A live region speaks when it is written, so a second press that changed
    // no text has to write anyway — otherwise the answer is silence.
    let writes = 0;
    const observer = new MutationObserver(() => { writes++; });
    observer.observe(announcement(editor), { childList: true, characterData: true, subtree: true });
    readRow(editor);
    await frames();
    observer.disconnect();
    expect(writes, "the second press wrote nothing, so nothing was said").toBeGreaterThan(0);
    expect(announcement(editor).textContent).toContain("row 00000040");
  });

  it("reads what the cursor is inside rather than where it is", async () => {
    const { editor } = await mountEditor();
    editor.engine.addDecoration({ start: 0x40, end: 0x50, label: "ELF header" });
    editor.engine.moveCursor(0x41);
    await frames();
    readRow(editor, true);
    await frames();
    expect(announcement(editor).textContent).toBe("ELF header, 00000040 to 0000004F");
  });

  it("goes back to describing the cursor on the next move", async () => {
    const { editor } = await mountEditor();
    editor.engine.moveCursor(0x41);
    await frames();
    readRow(editor);
    await frames();
    editor.engine.moveCursor(0x42);
    await frames();
    // The answer is not sticky: it was said once, and the region is the
    // cursor's again.
    expect(announcement(editor).textContent).toContain("00000042");
    expect(announcement(editor).textContent).not.toContain("row 00000040");
  });
});

/**
 * Tab is bound to `switchColumn`, so tabbing forward out of the grid used to be
 * impossible — it cycled hex, text, hex, text, and only Shift+Tab left. Escape
 * arms the next Tab to move focus instead.
 */
describe("leaving the editor with the keyboard", () => {
  it("still switches column on a plain Tab", async () => {
    const { editor } = await mountEditor();
    editor.focus();
    expect(editor.engine.getState().cursor.column).toBe("hex");
    // Handled, so the browser never sees it and focus stays put.
    expect(press(editor, "Tab")).toBe(false);
    expect(editor.engine.getState().cursor.column).toBe("ascii");
  });

  it("lets the next Tab through once Escape has armed it", async () => {
    const { editor } = await mountEditor();
    editor.focus();
    press(editor, "Escape");
    const column = editor.engine.getState().cursor.column;
    // Not consumed: the browser moves focus, and the column is left alone
    // rather than switched on the way out.
    expect(press(editor, "Tab")).toBe(true);
    expect(editor.engine.getState().cursor.column).toBe(column);
  });

  it("has nothing inside it for that Tab to land on", async () => {
    const { editor, host } = await mountEditor();
    // Somewhere for focus to go, so "it left" is distinguishable from "there
    // was nowhere to go".
    const after = document.createElement("button");
    after.textContent = "after";
    host.after(after);
    editor.focus();

    // A real Tab, not a synthesised one: what is being tested is the browser's
    // own focus order, which a dispatched event does not move.
    await userEvent.keyboard("{Escape}");
    await userEvent.keyboard("{Tab}");

    // Chrome makes a scrollable box focusable so it can be scrolled from the
    // keyboard, which put the shadow viewport in the tab order: the hatch let
    // the user out of the grid and straight onto an unnamed div still inside
    // it. `document.activeElement` reports the host either way, so the question
    // has to be asked of the shadow root.
    //
    // Read before anything else moves focus — including the probe below, which
    // is why this is captured rather than asserted in place.
    const landed = document.activeElement;
    const insideShadow = editor.shadowRoot!.activeElement;

    // That half is the library's, and it holds on any engine.
    expect(insideShadow?.className ?? null).toBeNull();

    // The other half is the platform's, and the platforms disagree. WebKit only
    // tabs between links and form controls unless Full Keyboard Access is on, so
    // a `tabindex="0"` element — which is what a painted grid has to be — does
    // not hand focus to the next button; it goes to the body. Measured on a bare
    // div with no library involved, so this asks the engine what it does rather
    // than assuming, and asserts the editor matches it.
    if (await tabMovesBetweenTabindexElements()) expect(landed).toBe(after);
    else expect(insideShadow).toBeNull();
  });

  /**
   * Whether this engine's sequential focus navigation includes elements that are
   * focusable only through `tabindex`. Chrome: yes. WebKit: no, by default.
   */
  async function tabMovesBetweenTabindexElements(): Promise<boolean> {
    const probe = document.createElement("div");
    probe.tabIndex = 0;
    const next = document.createElement("button");
    document.body.append(probe, next);
    try {
      probe.focus();
      await userEvent.keyboard("{Tab}");
      return document.activeElement === next;
    } finally {
      probe.remove();
      next.remove();
    }
  }

  it("says so, because a way out nobody is told about is not one", async () => {
    const { editor } = await mountEditor();
    editor.focus();
    press(editor, "Escape");
    expect(announcement(editor).textContent).toBe("Press Tab to leave the editor");
  });

  it("disarms on any other key, so the hatch is open for one keystroke", async () => {
    const { editor } = await mountEditor();
    editor.focus();
    press(editor, "Escape");
    press(editor, "ArrowRight");
    expect(press(editor, "Tab")).toBe(false);
    expect(editor.engine.getState().cursor.column).toBe("ascii");
  });
});

describe("the finder's count", () => {
  const finderOf = (editor: HexCanvasElement) =>
    editor.shadowRoot!.querySelector("hexcanvas-finder")!.shadowRoot!;

  /** Opens the panel and types, the way the search suite does. */
  async function searching(query: string) {
    const { editor } = await mountEditor();
    editor.setAttribute("search", "native");
    await frames();
    editor.focus();
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
    await frames();
    const finder = finderOf(editor);
    const field = finder.querySelector<HTMLInputElement>("input")!;
    field.value = query;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    return { editor, finder, field };
  }

  it("shows a glyph and says a sentence", async () => {
    const { editor, finder } = await searching("03");
    await editor.engine.runSearch();
    await waitFor(() => finder.querySelector(".count")!.textContent !== "", "a count");
    // "2/205" is four characters of chrome and two numbers with a slash between
    // them out loud, so the two audiences get different nodes.
    expect(finder.querySelector(".count")!.textContent).toMatch(/^\d+(\/\d+\+?)?$/);
    expect(finder.querySelector(".count")!.getAttribute("aria-hidden")).toBe("true");
    const spoken = finder.querySelector(".spoken")!;
    expect(spoken.getAttribute("role")).toBe("status");
    expect(spoken.textContent).toMatch(/match(es)?/);
  });

  it("drops the count when the next query matches nothing", async () => {
    const { editor, finder, field } = await searching("03");
    await editor.engine.runSearch();
    // Settled, not merely started. The whole-document scan runs detached and
    // reads the query as it is when it lands, so a scan still in flight when
    // the second query arrives clears the count by itself — and then this
    // passes whether or not the thing it is about works.
    await waitFor(() => editor.engine.getState().searchMatchCount > 0, "the scan to finish");
    await frames(2);
    field.value = "de ad be ef ca fe ba be";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await editor.engine.runSearch();
    await frames();
    // It used to keep the old one: "2/205" beside "No matching bytes", in the
    // same strip, contradicting each other.
    expect(finder.querySelector(".count")!.textContent).toBe("");
    expect(finder.querySelector(".message")!.textContent).toBe("No matching bytes");
  });

  it("is a named region, so opening it is heard as more than a field", async () => {
    const { finder } = await searching("03");
    const find = finder.querySelector("[part~=find-row]")!;
    // Focus lands in the query field, and a field announced by its own label
    // says what to type without saying what appeared.
    expect(find.getAttribute("role")).toBe("search");
    expect(find.getAttribute("aria-label")).toBe("Find");
    // The other two rows take the caption already beside them, so translating
    // the text bag translates the landmark with it.
    for (const [part, caption] of [["replace-row", "Replace"], ["goto-row", "Go to"]] as const) {
      const row = finder.querySelector(`[part~=${part}]`)!;
      const named = finder.getElementById(row.getAttribute("aria-labelledby")!)!;
      expect(named.textContent).toBe(caption);
    }
  });

  it("points the field at the complaint rather than leaving it floating", async () => {
    const { editor, finder, field } = await searching("de ad be ef ca fe ba be");
    await editor.engine.runSearch();
    await frames();
    expect(field.getAttribute("aria-invalid")).toBe("true");
    // Resolved within this shadow root, which is where an IDREF has to point.
    const described = field.getAttribute("aria-describedby");
    expect(described).toBe("message");
    expect(finder.getElementById(described!)!.textContent).toBe("No matching bytes");
  });
});

describe("a comparison", () => {
  async function mountCompare() {
    defineHexCanvasCompare();
    const host = themedFixture(1600, 240);
    const element = document.createElement("hexcanvas-compare") as HexCanvasCompare;
    for (const [property, value] of Object.entries({ ...probeProperties, "--hexcanvas-height": "240px" })) {
      element.style.setProperty(property, value);
    }
    host.append(element);
    element.left = new MemoryByteSource(bytes(256));
    element.right = new MemoryByteSource(bytes(264));
    const panes = [...element.shadowRoot!.querySelectorAll("hexcanvas-editor")] as HexCanvasElement[];
    await waitFor(
      () => panes.every((pane) => hasPainted(pane.shadowRoot!.querySelector("canvas")!)),
      "both panes to paint",
    );
    return { element, panes: panes as [HexCanvasElement, HexCanvasElement] };
  }

  it("gives the two panes names that tell them apart", async () => {
    const { panes } = await mountCompare();
    const [left, right] = panes.map((pane) => pane.getAttribute("aria-label"));
    // Both were "Hex editor": true of each, and useless for saying which held
    // the original.
    expect(left).toBe("Left document");
    expect(right).toBe("Right document");
    expect(left).not.toBe(right);
  });

  it("lets the host name them after the documents themselves", async () => {
    const { element, panes } = await mountCompare();
    element.paneLabels = { left: "firmware-1.2.bin", right: "firmware-1.3.bin" };
    await frames();
    expect(panes[0].getAttribute("aria-label")).toBe("firmware-1.2.bin");
    expect(panes[1].getAttribute("aria-label")).toBe("firmware-1.3.bin");
  });

  it("does not say the count again when it has not changed", async () => {
    const { element } = await mountCompare();
    await element.compare();
    const count = element.shadowRoot!.querySelector(".count")!;
    await waitFor(() => count.textContent !== "", "a difference count");
    // Writing a live region the same text again announces it again, and `sync`
    // runs on every engine notification — one action makes several.
    let writes = 0;
    const observer = new MutationObserver(() => { writes++; });
    observer.observe(count, { childList: true, characterData: true, subtree: true });
    const before = count.textContent;
    for (let move = 0; move < 5; move++) element.activeEditor.engine.moveCursor(move * 4);
    await frames(3);
    observer.disconnect();
    expect(count.textContent).toBe(before);
    expect(writes, "the count was rewritten with text it already held").toBe(0);
  });

  it("says out loud that its result is out of date", async () => {
    const { element } = await mountCompare();
    await element.compare();
    const message = element.shadowRoot!.querySelector(".message")!;
    // The count is a live region and this was not, so "run it again" was painted
    // into the strip and said nowhere — leaving a difference list quietly
    // describing the documents as they were before the edit.
    expect(message.getAttribute("role")).toBe("status");
    element.leftEditor.engine.writeByte(0, 0xff);
    await frames();
    expect(message.textContent).toBe("Edited since the comparison; run it again");
  });

  it("says what the divider's number counts", async () => {
    const { element } = await mountCompare();
    const divider = element.shadowRoot!.querySelector("[role=separator]")!;
    divider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    await frames();
    // A bare "49" says nothing about what it is 49 of.
    expect(divider.getAttribute("aria-valuetext")).toBe(`${divider.getAttribute("aria-valuenow")}%`);
  });
});

/**
 * The two options that only exist on screen, checked on a real canvas rather
 * than by reading back the value that was set.
 */
describe("what the grid actually paints", () => {
  const rowHeight = 22;

  const setup = (options: Partial<HexEngineOptions>, source: Uint8Array) => {
    const canvas = canvasFixture(640, 240);
    const engine = new HexEngine({ source: new MemoryByteSource(source), rowHeight, theme: probeTheme, ...options });
    engine.setViewportSize(canvas.clientWidth, canvas.clientHeight);
    engine.render(canvas);
    return { engine, painted: new Painted(canvas) };
  };

  /** Ink per cell of the first row's plain-text column, for a run of bytes. */
  const textColumn = (options: Partial<HexEngineOptions>, from: number) => {
    const { engine, painted } = setup(options, Uint8Array.from({ length: 16 }, (_, at) => from + at));
    const { charWidth } = engine.layout;
    return Array.from({ length: 16 }, (_, cell) =>
      Math.round(painted.brightness(engine.layout.asciiX(cell), 2, Math.max(1, Math.floor(charWidth)), rowHeight - 4)));
  };

  // Summed rather than compared cell by cell: a dot lands on a different
  // subpixel in each cell because `charWidth` is fractional, so even sixteen
  // identical glyphs do not paint sixteen identical numbers.
  const ink = (cells: number[]) => cells.reduce((total, cell) => total + cell, 0);

  it("draws a different plain-text column per encoding", () => {
    // 0xC0: accented capitals in Latin-1, box-drawing in CP437, nothing in
    // ASCII — one row where all three genuinely disagree.
    const ascii = ink(textColumn({ printable: asciiPrintable }, 0xc0));
    const cp437 = ink(textColumn({ printable: cp437Printable }, 0xc0));
    const latin1 = ink(textColumn({ printable: latin1Printable }, 0xc0));

    // ASCII has no glyph up here at all, so the row is dots — far less ink than
    // sixteen letters or box-drawing characters.
    expect(ascii).toBeLessThan(cp437 / 2);
    expect(ascii).toBeLessThan(latin1 / 2);
    expect(latin1).not.toBe(cp437);
  });

  it("agrees with ASCII exactly where the encoding has nothing either", () => {
    // 0x80-0x8F are C1 controls, which Latin-1 declines to draw for the same
    // reason ASCII does. An encoding is not obliged to differ everywhere, and a
    // test that demanded it would be testing the wrong thing.
    expect(ink(textColumn({ printable: latin1Printable }, 0x80)))
      .toBe(ink(textColumn({ printable: asciiPrintable }, 0x80)));
  });

  it("dims a decoration by the default it was given", () => {
    const ink = (decorationOpacity?: number) => {
      const { engine, painted } = setup({ display: { decorationOpacity } }, bytes(256));
      // No `opacity` of its own, which is the case the default is for. A parser
      // marking a thousand fields should not repeat the house style on each.
      engine.setDecorations([{ start: 0, end: 16 }], "probe");
      engine.render((painted as unknown as { canvas: HTMLCanvasElement }).canvas);
      return new Painted((painted as unknown as { canvas: HTMLCanvasElement }).canvas)
        .brightness(engine.layout.byteX(0), 2, Math.round(engine.layout.charWidth * 20), rowHeight - 4);
    };
    const faint = ink(0.05);
    const standard = ink(undefined);
    const strong = ink(0.95);
    expect(faint).toBeLessThan(standard);
    expect(standard).toBeLessThan(strong);
  });
});
