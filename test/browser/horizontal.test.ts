import { describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { HexEngine, MemoryByteSource } from "@hexcanvas/core";
import { Painted, black, bytes, canvasFixture, carets, expectNear, green, mountEditor, near, probeTheme, waitFor } from "./harness";

// Narrow enough that sixteen bytes cannot fit, which is the whole point.
const viewport = { width: 300, height: 240 };
const rowHeight = 22;

const setup = () => {
  const canvas = canvasFixture(viewport.width, viewport.height);
  const engine = new HexEngine({ source: new MemoryByteSource(bytes(256)), rowHeight, theme: probeTheme });
  engine.setViewportSize(canvas.clientWidth, canvas.clientHeight);
  return {
    engine,
    canvas,
    paint: (): Painted => {
      engine.render(canvas);
      return new Painted(canvas);
    },
  };
};

/**
 * Screen x of the first gap between two bytes that falls right of `edge`. Gaps are
 * where a band is unobstructed by glyphs, and going through the layout keeps the
 * probe correct whatever the font measures.
 */
const firstGapAfter = (engine: HexEngine, edge: number): number => {
  const layout = engine.layout;
  const scrollLeft = engine.getState().scrollLeft;
  for (let index = 0; index < layout.bytesPerRow - 1; index++) {
    const x = layout.byteX(index) + layout.charWidth * 2.5 - scrollLeft;
    if (x > edge) return x;
  }
  throw new Error(`no byte gap right of ${edge}`);
};

describe("a grid wider than the viewport", () => {
  it("has more to scroll through than it can show", () => {
    const { engine } = setup();
    expect(engine.scrollWidth).toBeGreaterThan(viewport.width);
    expect(engine.maxScrollLeft).toBeCloseTo(engine.scrollWidth - viewport.width, 5);
  });

  it("agrees where a byte is after scrolling right", () => {
    const { engine, paint } = setup();
    const y = rowHeight * 2 + rowHeight / 2;
    for (const index of [0, 6, 12, 15]) {
      const offset = 2 * 16 + index;
      engine.moveCursor(offset, "hex");
      // Reaching the byte is part of what is being tested: a cursor moved past
      // the right edge has to bring the view with it.
      const caret = paint().spanWhere(carets, y, 0, viewport.width);
      expect(caret, `no caret painted for byte ${index}`).toBeDefined();
      const centre = (caret!.first + caret!.last) / 2;
      expect(engine.hitTest(centre, y), `byte ${index} at x=${centre}`).toEqual({ offset, column: "hex", region: "hex" });
    }
  });

  it("never parks a byte under the pinned address column", () => {
    const { engine } = setup();
    engine.moveCursor(16 * 2 + 15, "hex");
    const layout = engine.layout;
    // The address column covers the left edge, so the byte has to clear it.
    expect(layout.byteX(15) - engine.getState().scrollLeft).toBeGreaterThanOrEqual(layout.addressWidth);
  });

  it("keeps the addresses readable with the grid scrolled under them", () => {
    const { engine, paint } = setup();
    engine.addDecoration({ start: 32, end: 48, color: "#00ff00", opacity: 1 });
    const y = rowHeight * 2 + rowHeight / 2;
    const layout = engine.layout;

    engine.setScrollLeft(200);
    expect(engine.getState().scrollLeft).toBe(200);
    const painted = paint();

    // The band would otherwise show through the column it scrolled behind. This
    // point is inside the column's right-hand padding, which is a fixed width.
    expect(near(painted.at(layout.addressWidth - 4, y), green, 60)).toBe(false);
    // Where the band shows has to be asked of the layout rather than guessed at a
    // fixed offset: CI resolves a different monospace face, so the character width
    // — and every column position with it — is not the one this machine measures.
    expectNear(painted.at(firstGapAfter(engine, layout.addressWidth + 2), y), green);
    // Addresses are still painted where they were before the scroll.
    expect(painted.brightness(layout.addressX, y - 6, layout.addressWidth - 28, 12)).toBeGreaterThan(2);
    expect(engine.hitTest(4, y).region).toBe("address");
  });

  it("scrolls back to the address column when the cursor returns to the first byte", () => {
    const { engine } = setup();
    engine.moveCursor(15, "hex");
    expect(engine.getState().scrollLeft).toBeGreaterThan(0);
    engine.moveCursor(0, "hex");
    expect(engine.getState().scrollLeft).toBe(0);
  });

  it("clamps a host scroll offset to the last column", () => {
    const { engine } = setup();
    engine.setScrollLeft(10_000);
    expect(engine.getState().scrollLeft).toBeCloseTo(engine.maxScrollLeft, 5);
    engine.setScrollLeft(-50);
    expect(engine.getState().scrollLeft).toBe(0);
  });

  it("gives the offset back when the viewport grows past the grid", () => {
    const { engine } = setup();
    engine.setScrollLeft(engine.maxScrollLeft);
    expect(engine.getState().scrollLeft).toBeGreaterThan(0);
    engine.setViewportSize(1200, viewport.height);
    expect(engine.getState().scrollLeft).toBe(0);
  });

  it("paints nothing but background past the end of the last column", () => {
    const { engine, paint } = setup();
    engine.setScrollLeft(engine.maxScrollLeft);
    const painted = paint();
    const y = rowHeight * 2 + rowHeight / 2;
    const past = engine.layout.width - engine.getState().scrollLeft - 2;
    expectNear(painted.at(past, y), black, 12);
  });
});

describe("<hexcanvas-editor> horizontally", () => {
  it("does not scroll sideways when the grid fits", async () => {
    const { element } = await mountEditor({ width: 900, height: viewport.height, attributes: { "bytes-per-row": "8" } });
    expect(element.scrollWidth).toBe(element.clientWidth);
  });

  it("offers a horizontal scrollbar and keeps the canvas pinned to the left edge", async () => {
    const { element, canvas, engine } = await mountEditor({ width: viewport.width, height: viewport.height });
    expect(element.scrollWidth).toBeGreaterThan(element.clientWidth);
    const before = canvas.getBoundingClientRect().left;

    element.scrollLeft = 120;
    await waitFor(() => engine.getState().scrollLeft === 120, "the engine to follow the scroller");
    // Sticky only works in a direction its containing block is longer than the
    // scrollport in, so this is the assertion that the wrapper carries the width.
    expect(canvas.getBoundingClientRect().left).toBeCloseTo(before, 0);
    expect(Math.round(canvas.getBoundingClientRect().width)).toBe(element.clientWidth);
  });

  it("follows the engine when the cursor moves out to the right", async () => {
    const { element, engine } = await mountEditor({ width: viewport.width, height: viewport.height });
    engine.moveCursor(15, "hex");
    await waitFor(() => element.scrollLeft > 0, "the scroller to follow the engine");
    expect(element.scrollLeft).toBeCloseTo(engine.getState().scrollLeft, 0);
  });

  it("hit-tests a click on the scrolled grid, not on the document", async () => {
    const { element, canvas, engine } = await mountEditor({ width: viewport.width, height: viewport.height });
    element.scrollLeft = 150;
    await waitFor(() => engine.getState().scrollLeft === 150, "the engine to follow the scroller");

    // A real click, not a synthetic event: the element captures the pointer, which
    // an untrusted event has no id for.
    await userEvent.click(canvas, {
      position: { x: engine.layout.byteX(9) - 150 + engine.layout.charWidth, y: rowHeight / 2 },
    });
    expect(engine.getState().cursor.offset).toBe(9);
  });
});
