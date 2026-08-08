import { describe, expect, it } from "vitest";
import { MemoryByteSource, type HexEngine } from "@hexcanvas/core";
import { defineHexCanvasCompare, type HexCanvasCompare } from "@hexcanvas/element";
import { Painted, bytes, expectNear, frames, hasPainted, probeProperties, probeTheme, themedFixture, waitFor, type Rgb } from "./harness";

const rgb = (hex: string): Rgb => ({
  r: Number.parseInt(hex.slice(1, 3), 16),
  g: Number.parseInt(hex.slice(3, 5), 16),
  b: Number.parseInt(hex.slice(5, 7), 16),
});

/**
 * Two documents that differ in one run in the middle and by eight bytes at the
 * end, so one mount exercises a replacement and an insertion at once.
 */
const pair = (length = 256) => {
  const left = bytes(length);
  const right = new Uint8Array(length + 8);
  right.set(left);
  for (let at = 32; at < 40; at++) right[at] = left[at]! ^ 0xff;
  return { left: new MemoryByteSource(left), right: new MemoryByteSource(right) };
};

/**
 * Wide by default, because the divider's floor is a whole row per pane and two
 * of those are about 1,260px — a narrower box has nowhere legal to drag to, and
 * every test here would be testing the clamp rather than the thing it names.
 */
async function mount(options: { length?: number; width?: number } = {}) {
  defineHexCanvasCompare();
  const host = themedFixture(options.width ?? 1600, 240);
  const element = document.createElement("hexcanvas-compare") as HexCanvasCompare;
  for (const [property, value] of Object.entries({ ...probeProperties, "--hexcanvas-height": "240px" })) {
    element.style.setProperty(property, value);
  }
  host.append(element);
  const sources = pair(options.length ?? 256);
  element.left = sources.left;
  element.right = sources.right;
  const canvases = [...element.shadowRoot!.querySelectorAll("hexcanvas-editor")]
    .map((editor) => editor.shadowRoot!.querySelector("canvas")!);
  await waitFor(() => canvases.every((canvas) => hasPainted(canvas)), "both panes to paint");
  return { element, host, canvases: canvases as [HTMLCanvasElement, HTMLCanvasElement] };
}

describe("<hexcanvas-compare>", () => {
  it("puts two grids side by side inside the height it was given", async () => {
    const { element, canvases } = await mount();
    expect(canvases).toHaveLength(2);
    expect(Math.round(element.getBoundingClientRect().height)).toBe(240);
    const [left, right] = canvases.map((canvas) => canvas.getBoundingClientRect());
    // Side by side, not stacked: same top, and the left one ends before the
    // right one starts.
    expect(Math.round(left!.top)).toBe(Math.round(right!.top));
    expect(left!.right).toBeLessThanOrEqual(Math.ceil(right!.left));
  });

  it("paints a replaced run in the comparison colour, through the cascade", async () => {
    const { element, canvases } = await mount();
    expect(await element.compare()).toBe(2);
    await frames(2);
    const engine = element.leftEditor.engine;
    // Row 2 holds bytes 32..47, so the first eight cells of it are the run.
    const y = rowCentre(engine, 2);
    const painted = new Painted(canvases[0]);
    expectNear(painted.at(gapAfter(engine, 2), y), blend(rgb(probeTheme.diffReplace)));
    // Byte 12 of the same row is past the run and must be untinted.
    expectNear(painted.at(gapAfter(engine, 12), y), { r: 0, g: 0, b: 0 }, 60);
  });

  it("paints the appended bytes on the right pane only", async () => {
    const { element, canvases } = await mount();
    await element.compare();
    const right = element.rightEditor.engine;
    const left = element.leftEditor.engine;
    // Row 16 is offsets 256..263, which only the right document has.
    right.scrollToOffset(256);
    await frames(2);
    expectNear(
      new Painted(canvases[1]).at(gapAfter(right, 1), rowCentre(right, 16)),
      blend(rgb(probeTheme.diffInsert)),
    );
    // The left document ends at 256, so its own last row carries no tint: the
    // insertion belongs to the right and must not be painted on both.
    expectNear(
      new Painted(canvases[0]).at(gapAfter(left, 1), rowCentre(left, left.visibleRows.total - 1)),
      { r: 0, g: 0, b: 0 },
      60,
    );
  });

  it("keeps the two panes on the same offset as one scrolls", async () => {
    const { element } = await mount({ length: 16 * 400 });
    const [left, right] = [element.leftEditor.engine, element.rightEditor.engine];
    left.setScrollTop(40 * 22);
    expect(right.visibleRows.first).toBe(40);
  });

  it("walks the differences from the bar", async () => {
    const { element } = await mount();
    await element.compare();
    const next = element.shadowRoot!.querySelector<HTMLButtonElement>('button[data-action="next-difference"]')!;
    next.click();
    expect(element.leftEditor.engine.getState().selection).toEqual({ start: 32, end: 40 });
    const count = element.shadowRoot!.querySelector<HTMLElement>(".count")!;
    expect(count.textContent).toContain("2");
  });

  it("forwards a geometry attribute to both panes, so the grids cannot disagree", async () => {
    const { element } = await mount();
    element.setAttribute("bytes-per-row", "8");
    await waitFor(() => element.leftEditor.engine.layout.bytesPerRow === 8, "the left pane to follow");
    expect(element.rightEditor.engine.layout.bytesPerRow).toBe(8);
  });

  // An absent attribute means "keep the default", and three of the display
  // flags default to on. Turning one off has to be written, not removed.
  it("turns a display flag off when it is forwarded as false", async () => {
    const { element } = await mount();
    expect(element.leftEditor.engine.layout.asciiColumn).toBe(true);
    element.setAttribute("ascii-column", "false");
    await waitFor(() => !element.leftEditor.engine.layout.asciiColumn, "the left pane to drop the column");
    expect(element.rightEditor.engine.layout.asciiColumn).toBe(false);
    element.removeAttribute("ascii-column");
    await waitFor(() => element.leftEditor.engine.layout.asciiColumn, "the default to come back");
  });

  // The bug this rules out repainted half the comparison: a host holding one
  // engine refreshed that pane and left the other on the previous palette.
  it("re-reads the custom properties into both panes", async () => {
    const { element, canvases } = await mount();
    // On the element, where `mount` put the probe palette: an inline property
    // outranks the one it inherits from the fixture.
    element.style.setProperty("--hexcanvas-bg", "#0000ff");
    element.refreshTheme();
    await frames(2);
    for (const canvas of canvases) {
      // The gutter between the columns holds no glyphs, so it is pure background.
      expectNear(new Painted(canvas).at(element.leftEditor.engine.layout.asciiStart - 14, 11), { r: 0, g: 0, b: 255 });
    }
  });

  // Every setting the editor takes as a property rather than an attribute.
  // Each of these was a way to configure half the comparison.
  describe("the settings an attribute cannot carry", () => {
    it("hands the column gaps to both panes", async () => {
      const { element } = await mount();
      element.spacing = { columnGutter: 44 };
      await frames(2);
      expect(element.leftEditor.engine.layout.spacing.columnGutter).toBe(44);
      expect(element.rightEditor.engine.layout.spacing.columnGutter).toBe(44);
    });

    it("hands the strings to both panes", async () => {
      const { element } = await mount();
      element.text = { findHexField: "찾기" };
      await frames(2);
      expect(element.leftEditor.engine.text.findHexField).toBe("찾기");
      expect(element.rightEditor.engine.text.findHexField).toBe("찾기");
    });

    it("hands the key map to both panes", async () => {
      const { element } = await mount();
      element.keymap = { nextBookmark: "F7" };
      await frames(2);
      for (const editor of [element.leftEditor, element.rightEditor]) {
        expect(editor.engine.keyFor("nextBookmark")).toBe("F7");
      }
    });

    it("hands the search modes to both panes", async () => {
      const { element } = await mount();
      element.searchModes = ["hex", "text", "regex"];
      await frames(2);
      for (const editor of [element.leftEditor, element.rightEditor]) {
        expect(editor.engine.getState().searchModes).toEqual(["hex", "text", "regex"]);
      }
    });
  });

  /**
   * A rebuild is `createLayout` plus a repaint, per pane. A framework hands over
   * a freshly built object on every render unless told not to, so without these
   * guards the playground was rebuilding both panes about three times a frame
   * while merely scrolling. The layout object's identity is the tell: it is
   * replaced whenever the options are applied.
   */
  describe("assigning a setting it already has", () => {
    const rebuildsOn = async (element: HexCanvasCompare, assign: () => void) => {
      assign();
      await frames(1);
      const before = element.leftEditor.engine.layout;
      assign();
      await frames(1);
      return element.leftEditor.engine.layout !== before;
    };

    it("does not rebuild for the same spacing, strings or key map", async () => {
      const { element } = await mount();
      const spacing = { columnGutter: 40 };
      const text = { findHexField: "x" };
      const keymap = { nextBookmark: "F7" };
      expect(await rebuildsOn(element, () => { element.spacing = spacing; })).toBe(false);
      expect(await rebuildsOn(element, () => { element.text = text; })).toBe(false);
      expect(await rebuildsOn(element, () => { element.keymap = keymap; })).toBe(false);
    });

    it("still rebuilds when the value actually changes", async () => {
      const { element } = await mount();
      element.spacing = { columnGutter: 40 };
      await frames(1);
      const before = element.leftEditor.engine.layout;
      element.spacing = { columnGutter: 41 };
      await frames(1);
      expect(element.leftEditor.engine.layout).not.toBe(before);
      expect(element.leftEditor.engine.layout.spacing.columnGutter).toBe(41);
    });
  });

  describe("which pane the reader is in", () => {
    it("starts on the left and follows focus", async () => {
      const { element } = await mount();
      expect(element.activePane).toBe("left");
      element.rightEditor.focus();
      expect(element.activePane).toBe("right");
      expect(element.activeEditor).toBe(element.rightEditor);
      element.leftEditor.focus();
      expect(element.activePane).toBe("left");
    });

    it("announces the change once, not on every focus event", async () => {
      const { element } = await mount();
      let announced = 0;
      element.addEventListener("activepanechange", () => { announced++; });
      element.rightEditor.focus();
      element.rightEditor.focus();
      expect(announced).toBe(1);
    });

    // The pane's own event does not cross its shadow root, so without the
    // re-emit a host asking for a custom find panel never hears about it.
    it("re-emits a pane's search request with the side attached", async () => {
      const { element } = await mount();
      element.setAttribute("search", "custom");
      await waitFor(() => element.rightEditor.engine.getState().searchFeature === "custom", "custom find");
      const seen: unknown[] = [];
      element.addEventListener("searchrequest", (event) => seen.push((event as CustomEvent).detail));
      element.rightEditor.focus();
      element.rightEditor.engine.runCommand("find");
      expect(seen).toEqual([{ kind: "search", side: "right" }]);
    });
  });

  describe("the divider", () => {
    const widthOf = (element: HexCanvasCompare, side: "leftEditor" | "rightEditor") =>
      element[side].getBoundingClientRect().width;

    const drag = (element: HexCanvasCompare, by: number) => {
      const divider = element.shadowRoot!.querySelector<HTMLElement>(".divider")!;
      const from = divider.getBoundingClientRect().left;
      const options = (x: number) => ({ bubbles: true, cancelable: true, clientX: x, button: 0, buttons: 1, pointerId: 1, isPrimary: true });
      divider.dispatchEvent(new PointerEvent("pointerdown", options(from)));
      divider.dispatchEvent(new PointerEvent("pointermove", options(from + by)));
      divider.dispatchEvent(new PointerEvent("pointerup", options(from + by)));
    };

    it("starts even and moves the boundary when dragged", async () => {
      const { element } = await mount();
      expectSameWidth(widthOf(element, "leftEditor"), widthOf(element, "rightEditor"));
      const before = widthOf(element, "leftEditor");
      drag(element, 60);
      expect(widthOf(element, "leftEditor")).toBeCloseTo(before + 60, 0);
    });

    // The floor the whole feature turns on: dragged hard left, the pane stops
    // where a row stops fitting, so it never has to be scrolled sideways to be
    // read against the other one.
    it("will not be dragged past a whole row of the left pane", async () => {
      const { element } = await mount();
      drag(element, -5000);
      expect(widthOf(element, "leftEditor")).toBeCloseTo(element.leftEditor.engine.scrollWidth, 0);
    });

    it("holds the same floor on the right, so neither pane can be crushed", async () => {
      const { element } = await mount();
      drag(element, 5000);
      expect(widthOf(element, "rightEditor")).toBeCloseTo(element.rightEditor.engine.scrollWidth, 0);
    });

    it("shares evenly when two whole rows cannot fit at all", async () => {
      // Half of 700px is well under one row, so there is no legal position and
      // pinning the divider to one end would read as broken.
      const { element } = await mount({ width: 700 });
      drag(element, -5000);
      expectSameWidth(widthOf(element, "leftEditor"), widthOf(element, "rightEditor"));
    });

    it("goes back to even on a double click", async () => {
      const { element } = await mount();
      drag(element, 80);
      element.shadowRoot!.querySelector<HTMLElement>(".divider")!
        .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      expectSameWidth(widthOf(element, "leftEditor"), widthOf(element, "rightEditor"));
    });

    it("moves from the keyboard and reports where it is", async () => {
      const { element } = await mount();
      const divider = element.shadowRoot!.querySelector<HTMLElement>(".divider")!;
      const before = widthOf(element, "leftEditor");
      divider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      expect(widthOf(element, "leftEditor")).toBeCloseTo(before + 16, 0);
      expect(Number(divider.getAttribute("aria-valuenow"))).toBeGreaterThan(50);
      divider.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
      expectSameWidth(widthOf(element, "leftEditor"), widthOf(element, "rightEditor"));
    });
  });
});

/** Two widths that should be the same, within a pixel of rounding. */
const expectSameWidth = (left: number, right: number): void => {
  expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
};

/**
 * The vertical middle of a row, worked out the way the renderer works it out.
 * A scroll offset clamped to the end of a short document is not a multiple of
 * the row height, so `row * rowHeight + half` lands in the wrong row.
 */
const rowCentre = (engine: HexEngine, row: number): number => row * 22 - engine.logicalScrollTop + 11;

/**
 * The gap after a byte's two digits. Sampling a byte cell itself hits a glyph
 * as often as not, and a glyph is the foreground colour whatever is painted
 * behind it — the tint only shows where no digit was drawn.
 */
const gapAfter = (engine: HexEngine, index: number): number =>
  engine.layout.byteX(index) + engine.layout.charWidth * 2.5;

/**
 * A tint is painted at 0.45 alpha over the background, and `probeTheme`'s
 * background is black, so what lands on the canvas is 45% of the colour asked
 * for. Comparing against the raw value would fail on every pixel.
 */
const blend = (colour: Rgb, alpha = 0.45): Rgb => ({
  r: Math.round(colour.r * alpha),
  g: Math.round(colour.g * alpha),
  b: Math.round(colour.b * alpha),
});

