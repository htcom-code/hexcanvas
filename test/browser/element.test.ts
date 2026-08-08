import { describe, expect, it } from "vitest";
import { MemoryByteSource } from "@hexcanvas/core";
import { Painted, blue, bytes, expectNear, finderRoot, frames, mountEditor as mount, onCleanup, waitFor } from "./harness";

describe("<hexcanvas-editor>", () => {
  it("paints inside its shadow root and stays the height the host gave it", async () => {
    const { element, canvas } = await mount({ length: 64 * 1024 });
    expect(Math.round(element.getBoundingClientRect().height)).toBe(240);
    // The spacer is document-tall on purpose; the element must not grow to it.
    expect(element.scrollHeight).toBeGreaterThan(4000);
    expect(Math.round(canvas.getBoundingClientRect().height)).toBe(240);
  });

  it("takes its canvas colours from custom properties", async () => {
    const { canvas, engine } = await mount({ style: { "--hexcanvas-bg": "#0000ff" } });
    const painted = new Painted(canvas);
    // The gutter between the columns holds no glyphs, so it is pure background.
    expectNear(painted.at(engine.layout.asciiStart - 14, 11), blue);
  });

  it("measures the grid from the font custom property", async () => {
    const normal = await mount();
    const large = await mount({ style: { "--hexcanvas-font": "24px ui-monospace, monospace" } });
    expect(large.engine.layout.charWidth).toBeGreaterThan(normal.engine.layout.charWidth * 1.4);
  });

  it("lets a host reach the canvas through ::part()", async () => {
    const style = document.createElement("style");
    style.textContent = "hexcanvas-editor::part(canvas) { outline: 3px solid rgb(0, 128, 0); }";
    document.head.append(style);
    onCleanup(() => style.remove());
    const { canvas } = await mount();
    expect(getComputedStyle(canvas).outlineColor).toBe("rgb(0, 128, 0)");
    expect(getComputedStyle(canvas).outlineWidth).toBe("3px");
  });

  it("moves the cursor from the keyboard", async () => {
    const { element, engine } = await mount();
    element.focus();
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(engine.getState().cursor.offset).toBe(1);
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(engine.getState().cursor.offset).toBe(17);
  });

  it("undoes a typed byte in one step rather than one per nibble", async () => {
    const { element, engine } = await mount({ attributes: { "edit-mode": "overwrite" } });
    element.focus();
    const original = engine.selectionText();
    for (const key of ["a", "b"]) element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    engine.moveCursor(0);
    expect(engine.selectionText()).toBe("AB");
    expect(engine.undo()).toBe(true);
    engine.moveCursor(0);
    expect(engine.selectionText()).toBe(original);
    expect(engine.getState().canUndo).toBe(false);
  });

  it("undoes a run of inserted bytes as one step", async () => {
    const source = new MemoryByteSource(bytes(256));
    const { element } = await mount({ source, attributes: { "edit-mode": "insert" } });
    element.focus();
    for (const key of ["a", "b", "c", "d"]) element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    expect(source.length).toBe(258);
    expect(element.engine.undo()).toBe(true);
    expect(source.length).toBe(256);
  });

  it("reports edits and selections as DOM events", async () => {
    const { element, engine } = await mount({ attributes: { "edit-mode": "overwrite" } });
    const changes: unknown[] = [];
    const selections: unknown[] = [];
    element.addEventListener("change", (event) => changes.push((event as CustomEvent).detail));
    element.addEventListener("selectionchange", (event) => selections.push((event as CustomEvent).detail));
    engine.select(4, 8);
    engine.moveCursor(0);
    engine.writeByte(0, 0x5a);
    expect(changes).toHaveLength(1);
    expect(selections[0]).toEqual({ start: 4, end: 8 });
  });

  it("has no find panel, and leaves the shortcut alone, unless asked for one", async () => {
    const { element } = await mount();
    element.focus();
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
    expect(element.shadowRoot!.querySelector("hexcanvas-finder")).toBeNull();
    expect(element.engine.getState().searchOpen).toBe(false);
    // Nothing above the grid, so the region it would sit in costs no height.
    expect(element.shadowRoot!.querySelector("[part='chrome']")!.getBoundingClientRect().height).toBe(0);
  });

  it("opens the search panel on the find shortcut and closes it on escape", async () => {
    const { element } = await mount({ attributes: { search: "native", platform: "windows" } });
    element.focus();
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
    const root = finderRoot(element);
    const input = root.querySelector<HTMLInputElement>("input[aria-label='Find hexadecimal bytes']")!;
    expect(input.closest("form")!.hidden).toBe(false);
    await waitFor(() => root.activeElement === input, "the query field to take focus");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(input.closest("form")!.hidden).toBe(true);
  });

  it("takes the panel's height out of the one the host declared", async () => {
    const { element } = await mount({ attributes: { search: "native", platform: "windows" } });
    const viewport = element.shadowRoot!.querySelector("[part='viewport']")!;
    const before = viewport.getBoundingClientRect().height;
    element.focus();
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
    await waitFor(() => viewport.getBoundingClientRect().height < before, "the grid to make room");
    // The element itself does not grow: `height` means the whole editor.
    expect(Math.round(element.getBoundingClientRect().height)).toBe(240);
  });

  it("takes the platform's own keys, and the panel says which they are", async () => {
    const { element } = await mount({ attributes: { search: "native", platform: "mac" } });
    element.focus();
    // ⌘F, not Ctrl+F: on macOS those are different keys, and only one is bound.
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
    expect(element.engine.getState().searchOpen).toBe(false);
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true }));
    expect(element.engine.getState().searchOpen).toBe(true);

    const hint = (label: string) => finderRoot(element).querySelector<HTMLButtonElement>(`button[aria-label='${label}']`)!.title;
    await waitFor(() => hint("Find next") === "Find next (⌘G)", `the tooltip to quote the key, not "${hint("Find next")}"`);
    expect(hint("Find previous")).toBe("Find previous (⇧⌘G)");
    expect(hint("Toggle replace")).toBe("Toggle replace (⌥⌘F)");
  });

  it("lets a host rebind a command, and says so in the tooltip", async () => {
    const { element } = await mount({ attributes: { search: "native", platform: "windows" } });
    element.keymap = { find: "Ctrl+Shift+K" };
    element.focus();
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
    expect(element.engine.getState().searchOpen).toBe(false);
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, shiftKey: true, bubbles: true }));
    expect(element.engine.getState().searchOpen).toBe(true);
    expect(element.engine.keyFor("find")).toBe("Ctrl+Shift+K");
  });

  it("names the panel from the strings a host supplied", async () => {
    const { element } = await mount({ attributes: { search: "native", platform: "windows" } });
    element.text = {
      findHexField: "16진 바이트 찾기",
      findHexPlaceholder: "DE AD",
      findNextButton: "다음 찾기",
      replaceRow: "바꾸기",
    };
    element.focus();
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
    const root = finderRoot(element);
    await waitFor(
      () => root.querySelector("input[aria-label='16진 바이트 찾기']") !== null,
      "the field to take the supplied name",
    );
    const field = root.querySelector<HTMLInputElement>("input[aria-label='16진 바이트 찾기']")!;
    expect(field.placeholder).toBe("DE AD");
    // The key hint is appended to whatever the host called the button.
    expect(root.querySelector<HTMLButtonElement>("button[data-action='find-next']")!.title).toBe("다음 찾기 (F3)");
    expect(root.querySelector("[part='replace-row'] [part='label']")!.textContent).toBe("바꾸기");
    // Anything unnamed keeps its default rather than going blank.
    expect(root.querySelector("button[data-action='close-search']")!.getAttribute("aria-label")).toBe("Close search");
  });

  it("follows the strings when they change after mounting", async () => {
    const { element } = await mount({ attributes: { search: "native", platform: "windows" } });
    element.focus();
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
    const root = finderRoot(element);
    expect(root.querySelector("input[aria-label='Find hexadecimal bytes']")).not.toBeNull();
    element.text = { findHexField: "찾기" };
    await waitFor(() => root.querySelector("input[aria-label='찾기']") !== null, "the name to be replaced in place");
  });

  it("refuses a keymap that would take a key the platform owns", async () => {
    const { element } = await mount({ attributes: { search: "native" } });
    expect(() => { element.keymap = { find: "Mod+C" }; }).toThrow();
  });

  it("forwards the panel's parts past its own shadow root", async () => {
    const style = document.createElement("style");
    style.textContent = "hexcanvas-editor::part(find-row) { outline: 2px solid rgb(0, 0, 128); }";
    document.head.append(style);
    onCleanup(() => style.remove());
    const { element } = await mount({ attributes: { search: "native", platform: "windows" } });
    const row = finderRoot(element).querySelector("[part='find-row']")!;
    expect(getComputedStyle(row).outlineColor).toBe("rgb(0, 0, 128)");
  });

  it("gives a screen reader something to read, since the grid is pixels", async () => {
    const { element, engine } = await mount();
    expect(element.getAttribute("role")).toBe("application");
    expect(element.getAttribute("aria-roledescription")).toBe("hex editor");
    expect(element.getAttribute("aria-label")).toBe("Hex editor");

    const live = element.shadowRoot!.querySelector("[part='announcement']")!;
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.textContent).toBe(engine.describeCursor());

    engine.moveCursor(8); // 0x3B in the sample document, which is a printable ";"
    await waitFor(() => live.textContent === "00000008, byte 3B, character ;, hex column", `the region to follow, not ${live.textContent}`);
    // Hidden from sight, present in the tree: zero-size rather than display: none.
    expect(live.getBoundingClientRect().height).toBeLessThan(2);
    expect(getComputedStyle(live).display).not.toBe("none");
  });

  it("leaves aria attributes the host set alone", async () => {
    const { element } = await mount({ attributes: { role: "img", "aria-label": "firmware image" } });
    expect(element.getAttribute("role")).toBe("img");
    expect(element.getAttribute("aria-label")).toBe("firmware image");
  });

  it("announces a mode change once, then goes back to describing the cursor", async () => {
    const { element, engine } = await mount();
    const live = element.shadowRoot!.querySelector("[part='announcement']")!;
    engine.setEditMode("insert");
    await waitFor(() => (live.textContent ?? "").startsWith("insert mode,"), "the mode to be announced");
    engine.moveCursor(2);
    await waitFor(() => !(live.textContent ?? "").includes("mode,"), "the mode not to be repeated");
  });

  it("takes the cursor and the selection as properties", async () => {
    const { element, engine } = await mount();
    const moves: number[] = [];
    element.addEventListener("cursorchange", (event) => moves.push((event as CustomEvent<{ offset: number }>).detail.offset));

    element.cursor = { offset: 0x20, column: "ascii" };
    expect(engine.getState().cursor).toEqual({ offset: 0x20, column: "ascii", nibble: 0 });
    // Assigning what it already holds must not echo, or a controlled host loops.
    element.cursor = { offset: 0x20, column: "ascii" };
    expect(moves).toEqual([0x20]);

    element.selection = { start: 4, end: 12 };
    expect(engine.getState().selection).toEqual({ start: 4, end: 12 });
    element.selection = null;
    expect(engine.getState().selection).toBeUndefined();
    expect(element.cursor.offset).toBe(11);
  });
});

/**
 * The engine notifies on every state patch and one action makes several, so
 * painting straight from the notification paid for all of them and showed only
 * the last. These pin the two guarantees that replaced it: at most one paint a
 * frame, and never fewer than the one that carries the final state.
 */
describe("when the canvas is painted", () => {
  /** Counts paints by standing in front of the engine's own render. */
  const counting = (engine: { render: (canvas: HTMLCanvasElement) => void }) => {
    const original = engine.render.bind(engine);
    const seen = { paints: 0 };
    engine.render = (canvas) => { seen.paints++; return original(canvas); };
    onCleanup(() => { engine.render = original; });
    return seen;
  };

  it("paints once for a frame that changed several things", async () => {
    const { engine } = await mount({ length: 64 * 1024 });
    const seen = counting(engine);
    engine.moveCursor(9000);      // moves the cursor and scrolls to it
    engine.select(9000, 9016);
    engine.setScrollTop(400);
    await frames(2);
    expect(seen.paints).toBe(1);
  });

  // A paste or a replace-all is one change set per hit, all inside one frame.
  it("paints once for a burst of edits, not once per edit", async () => {
    const { engine } = await mount({ length: 1024, attributes: { "edit-mode": "overwrite" } });
    const seen = counting(engine);
    for (let at = 0; at < 20; at++) engine.writeByte(at, 0x42);
    await frames(2);
    expect(seen.paints).toBe(1);
  });

  it("shows the last state rather than the one it painted", async () => {
    const { engine, canvas } = await mount({ length: 64 * 1024 });
    engine.moveCursor(0);
    await frames(2);
    // Scroll far away, then read the address column: it has to be the row the
    // engine ended on, not the one the first of these patches asked for.
    engine.setScrollTop(100 * 22);
    engine.setScrollTop(300 * 22);
    await frames(2);
    const painted = new Painted(canvas);
    const layout = engine.layout;
    // Row 300 begins at 0x12C0; something is drawn where its address goes.
    expect(painted.longestRunOff(painted.at(1, 1), 11, layout.addressX, layout.addressWidth)).toBeGreaterThan(0);
    expect(engine.visibleRows.first).toBe(300);
  });

  it("does not paint after the element is taken out of the document", async () => {
    const { element, engine } = await mount({ length: 64 * 1024 });
    await frames(2);
    const seen = counting(engine);
    element.remove();
    engine.setScrollTop(2000);
    await frames(3);
    expect(seen.paints).toBe(0);
  });

  describe("max-fps", () => {
    /** Drives a change every frame for `ms`, and reports what it cost. */
    const scrollFor = async (engine: { setScrollTop: (value: number) => void }, ms: number) => {
      let at = 0;
      const start = performance.now();
      while (performance.now() - start < ms) {
        at += 22;
        engine.setScrollTop(at);
        await frames(1);
      }
    };

    /**
     * Both rates measured in the same run, and compared against each other.
     *
     * An absolute count would be measuring the machine: how many frames fit in
     * 400ms is the runner's business, not this code's. The claim worth pinning
     * is the ratio — capping at ten a second paints far less than following the
     * display, whatever the display happens to be.
     */
    it("paints far less often when a rate is asked for", async () => {
      const uncapped = await mount({ length: 64 * 1024 });
      const free = counting(uncapped.engine);
      await scrollFor(uncapped.engine, 400);

      const capped = await mount({ length: 64 * 1024, attributes: { "max-fps": "10" } });
      expect(capped.element.maxFps).toBe(10);
      const held = counting(capped.engine);
      await scrollFor(capped.engine, 400);

      expect(free.paints, "the uncapped editor painted nothing; the driver is broken")
        .toBeGreaterThan(4);
      expect(held.paints, "the cap painted as often as no cap")
        .toBeLessThan(free.paints / 2);
    });

    it("still lands the final state after the last change", async () => {
      const { engine } = await mount({ length: 64 * 1024, attributes: { "max-fps": "5" } });
      await frames(2);
      const seen = counting(engine);
      engine.setScrollTop(500 * 22);
      // Longer than the 200ms interval: the skipped frames must have rescheduled
      // rather than dropped the change.
      await waitFor(() => seen.paints > 0, "the trailing paint", 1500);
      expect(engine.visibleRows.first).toBe(500);
    });

    it("takes the property over the attribute, and undefined puts it back", async () => {
      const { element } = await mount({ attributes: { "max-fps": "10" } });
      element.maxFps = 30;
      expect(element.maxFps).toBe(30);
      element.maxFps = undefined;
      expect(element.maxFps).toBe(10);
    });

    it("clamps a value that means nothing rather than throwing", async () => {
      const { element } = await mount();
      element.maxFps = 0;
      expect(element.maxFps).toBeUndefined();
      element.maxFps = -5;
      expect(element.maxFps).toBeUndefined();
      element.maxFps = 0.2;
      expect(element.maxFps).toBe(1);
    });
  });
});
