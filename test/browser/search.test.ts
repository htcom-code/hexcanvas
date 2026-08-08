import { describe, expect, it } from "vitest";
import { MemoryByteSource, PieceTableSource } from "@hexcanvas/core";
import type { HexCanvasElement } from "@hexcanvas/element";
import { Painted, black, expectNear, finderRoot, mountEditor, near, waitFor } from "./harness";
import type { MountOptions } from "./harness";

const encode = (text: string) => new TextEncoder().encode(text);
const rowHeight = 22;

// "MVP" at 3, 19 and 35: one per row, so each hit is on its own scan line.
const document16 = "abcMVP".padEnd(16, ".") + "aboMVP".padEnd(16, ".") + "abcMVP".padEnd(16, ".");

/**
 * Find is off unless asked for, so every test here asks. The platform is pinned
 * too: the default keys differ by it, so a test that dispatched Ctrl and let the
 * machine decide would pass on Windows and fail on a Mac.
 */
const withSearch = (options: MountOptions = {}): MountOptions => ({
  ...options,
  attributes: { search: "native", platform: "windows", ...options.attributes },
});

const panels = (element: HexCanvasElement) => {
  const root = finderRoot(element);
  return {
    search: root.querySelector<HTMLInputElement>("input[aria-label='Find hexadecimal bytes'], input[aria-label='Find text']")!,
    replace: root.querySelector<HTMLInputElement>("input[aria-label='Replace with']")!,
    count: root.querySelector<HTMLSpanElement>("[part='count']")!,
    message: root.querySelector<HTMLSpanElement>("[part='message']")!,
    mode: root.querySelector<HTMLSelectElement>("select[aria-label='Search mode']")!,
    press: (label: string) => root.querySelector<HTMLButtonElement>(`button[aria-label='${label}']`)!.click(),
  };
};

const openSearch = async (element: HexCanvasElement, query: string, mode: "hex" | "text" = "text") => {
  const parts = panels(element);
  element.focus();
  element.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
  parts.mode.value = mode;
  parts.mode.dispatchEvent(new Event("change", { bubbles: true }));
  const field = panels(element).search;
  field.value = query;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  return panels(element);
};

describe("find all", () => {
  it("counts the hits and says which one the cursor is on", async () => {
    const { element, engine } = await mountEditor(withSearch({ source: new MemoryByteSource(encode(document16)) }));
    const parts = await openSearch(element, "MVP");

    await engine.runSearch();
    await waitFor(() => parts.count.textContent === "1/3", `the count to read 1/3, not ${parts.count.textContent}`);
    await engine.runSearch();
    await waitFor(() => panels(element).count.textContent === "2/3", "the count to advance");
    expect(engine.getState().cursor.offset).toBe(19);
  });

  it("paints every hit, not only the one it moved to", async () => {
    const { element, canvas, engine } = await mountEditor(withSearch({ source: new MemoryByteSource(encode(document16)) }));
    await openSearch(element, "MVP");
    await engine.runSearch();
    await waitFor(() => engine.getState().searchMatchCount === 3, "the scan to finish");
    await waitFor(() => {
      const painted = new Painted(canvas);
      const layout = engine.layout;
      // Row two holds a hit the search did not jump to; it must still be tinted.
      const untouched = painted.at(layout.byteX(4) + layout.charWidth, rowHeight * 2 + rowHeight / 2);
      return !near(untouched, black, 20);
    }, "the third hit to be tinted");
  });

  it("stops highlighting when the panel closes", async () => {
    const { element, engine } = await mountEditor(withSearch({ source: new MemoryByteSource(encode(document16)) }));
    await openSearch(element, "MVP");
    await engine.runSearch();
    await engine.findAllMatches(); // the highlights land after the jump
    expect(engine.matches).toHaveLength(3);
    panels(element).press("Close search");
    expect(engine.matches).toHaveLength(0);
    expect(panels(element).count.textContent).toBe("");
  });
});

describe("replace", () => {
  const editable = () => new PieceTableSource(encode(document16));
  const read = (source: PieceTableSource) => new TextDecoder().decode(source.peek(0, source.length)!);

  it("opens the replace row on its own shortcut", async () => {
    const { element, engine } = await mountEditor(withSearch({ source: editable() }));
    element.focus();
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "h", ctrlKey: true, bubbles: true }));
    expect(engine.getState().searchOpen).toBe(true);
    expect(engine.getState().replaceOpen).toBe(true);
    expect(panels(element).replace.closest("form")!.hidden).toBe(false);
  });

  it("replaces one hit from the panel and moves to the next", async () => {
    const source = editable();
    const { element, engine } = await mountEditor(withSearch({ source }));
    const parts = await openSearch(element, "MVP");
    parts.press("Toggle replace");
    const field = panels(element).replace;
    field.value = "___";
    field.dispatchEvent(new Event("input", { bubbles: true }));

    await engine.runSearch();
    await engine.replace();
    expect(read(source).slice(3, 6)).toBe("___");
    expect(engine.getState().cursor.offset).toBe(19);
  });

  it("replaces all of them from the panel in one undo step", async () => {
    const source = editable();
    const { element, engine } = await mountEditor(withSearch({ source }));
    const parts = await openSearch(element, "MVP");
    parts.press("Toggle replace");
    const field = panels(element).replace;
    field.value = "!";
    field.dispatchEvent(new Event("input", { bubbles: true }));

    panels(element).press("Replace all");
    await waitFor(() => read(source).includes("abc!"), "the sweep to land");
    expect(read(source)).not.toContain("MVP");
    expect(engine.undo()).toBe(true);
    expect(read(source)).toBe(document16);
  });

  it("shows what it did", async () => {
    const source = editable();
    const { element, engine } = await mountEditor(withSearch({ source }));
    const parts = await openSearch(element, "MVP");
    parts.press("Toggle replace");
    panels(element).press("Replace all");
    await waitFor(
      () => panels(element).message.textContent === "Replaced 3",
      "the panel to report the sweep",
    );
    expect(engine.getState().replaceMessage).toBe("Replaced 3");
  });

  it("tints hits differently from bookmarks", async () => {
    const { element, canvas, engine } = await mountEditor(withSearch({
      source: new MemoryByteSource(encode(document16)),
      style: { "--hexcanvas-search": "#0000ff", "--hexcanvas-decoration": "#00ff00" },
    }));
    await openSearch(element, "MVP");
    engine.toggleBookmark(0);
    await engine.runSearch();
    await waitFor(() => engine.getState().searchMatchCount === 3, "the scan to finish");

    const layout = engine.layout;
    await waitFor(() => {
      const painted = new Painted(canvas);
      const hit = painted.at(layout.byteX(4) + layout.charWidth, rowHeight * 2 + rowHeight / 2);
      return hit.b > hit.g && hit.b > 40;
    }, "the hit to read as the search colour");
    // The gutter marker of the bookmarked row keeps the decoration colour.
    expectNear(new Painted(canvas).at(3, rowHeight / 2), { r: 0, g: 255, b: 0 }, 60);
  });
});
