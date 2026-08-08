import { beforeAll, describe, expect, it } from "vitest";
import {
  HexEngine,
  MemoryByteSource,
  PagedByteSource,
  type AddressRadix,
  type ByteGroupSize,
  type HexEngineOptions,
} from "@hexcanvas/core";
import { Painted, black, blue, bytes, canvasFixture, carets, expectNear, green, probeTheme, red } from "./harness";

const viewport = { width: 640, height: 240 };
const rowHeight = 22;

const setup = (options: Partial<HexEngineOptions> = {}, length = 256) => {
  const canvas = canvasFixture(viewport.width, viewport.height);
  const engine = new HexEngine({ source: new MemoryByteSource(bytes(length)), rowHeight, theme: probeTheme, ...options });
  engine.setViewportSize(canvas.clientWidth, canvas.clientHeight);
  const paint = (): Painted => {
    engine.render(canvas);
    return new Painted(canvas);
  };
  return { engine, canvas, paint };
};

/** Vertical middle of a row, in the same coordinates `hitTest` takes. */
const middleOf = (row: number, scrollTop = 0) => row * rowHeight - scrollTop + rowHeight / 2;

beforeAll(() => {
  // A grid narrower than the canvas is a precondition of every coordinate
  // assertion here; horizontal scrolling is covered by its own suite.
  const { engine } = setup();
  expect(engine.layout.width).toBeLessThan(viewport.width);
});

describe("painted coordinates and hit testing", () => {
  const combinations: { byteGroup: ByteGroupSize; addressRadix: AddressRadix }[] = [
    { byteGroup: 1, addressRadix: "hex" },
    { byteGroup: 2, addressRadix: "hex" },
    { byteGroup: 4, addressRadix: "decimal" },
    { byteGroup: 8, addressRadix: "hex" },
  ];

  for (const combination of combinations) {
    it(`agrees where byte columns are with byteGroup ${combination.byteGroup} and ${combination.addressRadix} addresses`, () => {
      const { engine, paint } = setup(combination);
      const y = middleOf(2);
      for (const index of [0, 1, 7, 8, 15]) {
        const offset = 2 * 16 + index;
        engine.moveCursor(offset, "hex");
        // The caret is the renderer's own statement about where the byte is, so
        // hit-testing its painted centre is what ties the two together.
        const caret = paint().spanWhere(carets, y, engine.layout.hexStart - 4, engine.layout.asciiStart);
        expect(caret, `no caret painted for byte ${index}`).toBeDefined();
        const centre = (caret!.first + caret!.last) / 2;
        const hit = engine.hitTest(centre, y);
        expect(hit, `byte ${index} at x=${centre}`).toEqual({ offset, column: "hex", region: "hex" });
      }
    });
  }

  it("puts the ascii caret over the ascii cell of the same byte", () => {
    const { engine, paint } = setup();
    const y = middleOf(3);
    for (const index of [0, 9, 15]) {
      const offset = 3 * 16 + index;
      engine.moveCursor(offset, "ascii");
      const caret = paint().spanWhere(carets, y, engine.layout.asciiStart - 8, engine.layout.width);
      expect(caret, `no caret painted for ascii cell ${index}`).toBeDefined();
      const hit = engine.hitTest((caret!.first + caret!.last) / 2, y);
      expect(hit).toEqual({ offset, column: "ascii", region: "ascii" });
    }
  });

  it("marks the active nibble under the digit it will replace", () => {
    const { engine, paint } = setup();
    engine.moveCursor(0, "hex");
    const layout = engine.layout;
    const underlineY = rowHeight - 4;
    const high = layout.nibbleX(0, 0) + layout.charWidth / 2;
    const low = layout.nibbleX(0, 1) + layout.charWidth / 2;

    const before = paint();
    expect(carets(before.at(high, underlineY))).toBe(true);
    expect(carets(before.at(low, underlineY))).toBe(false);

    engine.handleKey({ key: "a" }); // writes the high nibble and steps to the low one
    const after = paint();
    expect(carets(after.at(low, underlineY))).toBe(true);
    expect(carets(after.at(high, underlineY))).toBe(false);
  });
});

describe("bands", () => {
  for (const byteGroup of [1, 4] as ByteGroupSize[]) {
    it(`paints a selection as one unbroken band with byteGroup ${byteGroup}`, () => {
      const { engine, paint } = setup({ byteGroup });
      engine.select(32, 48);
      const layout = engine.layout;
      const y = middleOf(2);
      const from = layout.byteX(0) - 2;
      const to = layout.byteX(15) + layout.charWidth * 2 + 2;
      const painted = paint();
      // Group gaps sit inside the band, so a per-byte fill would read as stripes.
      expect(painted.longestRunOff(black, y, from - 6, to + 6)).toBeGreaterThanOrEqual(Math.round(to - from) - 2);
      expectNear(painted.at(layout.byteX(3) + layout.charWidth * 2.5, y), blue);
    });
  }

  it("stops the band at the ends of the selection", () => {
    const { engine, paint } = setup();
    engine.select(34, 38);
    const layout = engine.layout;
    const y = middleOf(2);
    const painted = paint();
    expectNear(painted.at(layout.byteX(0) + layout.charWidth * 2.5, y), black, 12);
    expectNear(painted.at(layout.byteX(3) + layout.charWidth * 2.5, y), blue);
    expectNear(painted.at(layout.byteX(6) + layout.charWidth * 2.5, y), black, 12);
  });

  it("keeps a nested decoration visible over the range that contains it", () => {
    const { engine, paint } = setup();
    engine.addDecoration({ start: 32, end: 48, color: "#00ff00", opacity: 1 });
    engine.addDecoration({ start: 37, end: 39, color: "#0000ff", opacity: 1 });
    const layout = engine.layout;
    const y = middleOf(2);
    const painted = paint();
    expectNear(painted.at(layout.byteX(1) + layout.charWidth * 2.5, y), green);
    expectNear(painted.at(layout.byteX(5) + layout.charWidth * 2.5, y), blue);
  });

  it("keeps a decorated range legible under the selection", () => {
    const { engine, paint } = setup();
    // Two fields, one nested in the other, then both selected — which is what a
    // structure viewer does when a record is picked.
    engine.addDecoration({ start: 32, end: 48, color: "#00ff00", opacity: 1 });
    engine.addDecoration({ start: 37, end: 39, color: "#ff0000", opacity: 1 });
    engine.select(32, 48);
    const layout = engine.layout;
    const painted = paint();
    const gap = (index: number) => layout.byteX(index) + layout.charWidth * 2.5;
    // The band itself is the selection colour: the fills still stack as before.
    expectNear(painted.at(gap(1), middleOf(2)), blue);
    // The bottom edge of each cell carries the range's own colour back, so the
    // outer field and the inner one are still told apart inside the selection.
    const edge = 3 * rowHeight - 3;
    expectNear(painted.at(gap(1), edge), green);
    expectNear(painted.at(gap(5), edge), red);
  });

  it("leaves an unselected document exactly as it was", () => {
    const { engine, paint } = setup();
    // The default alpha, so the tint is a blend rather than the colour itself.
    // An edge drawn regardless of the selection would show the pure colour at the
    // bottom of the cell, which is what makes this able to tell the two apart.
    engine.addDecoration({ start: 32, end: 48, color: "#00ff00" });
    const layout = engine.layout;
    const x = layout.byteX(1) + layout.charWidth * 2.5;
    const painted = paint();
    const edge = painted.at(x, 3 * rowHeight - 3);
    expect(edge).toEqual(painted.at(x, middleOf(2)));
    expect(edge.g, "the tint is blended, not the pure colour").toBeLessThan(200);
  });

  it("carries a decoration across an insert instead of leaving it behind", () => {
    const { engine } = setup();
    const mark = engine.addDecoration({ start: 32, end: 34, kind: "field" });
    engine.setEditMode("insert");
    engine.insertBytes(Uint8Array.of(0xff), 0);
    expect(engine.decorations.find((item) => item.id === mark.id)).toMatchObject({ start: 33, end: 35 });
    // The lookup has to find it at its new home; a stale index would not.
    expect(engine.decorationsAt(33, "field").map((item) => item.id)).toEqual([mark.id]);
  });
});

describe("pending bytes", () => {
  it("draws a range that has not arrived dimmer than resident bytes", () => {
    const layout = setup().engine.layout;
    const band = { x: layout.hexStart, y: 2, width: layout.charWidth * 16 * 3, height: rowHeight * 4 };

    const resident = setup().paint();
    const pending = setup({
      // Never resolves, so every visible row stays unfetched for the whole test.
      source: new PagedByteSource({ length: 256, fetch: () => new Promise<Uint8Array>(() => {}) }),
    }).paint();

    const residentBrightness = resident.brightness(band.x, band.y, band.width, band.height);
    const pendingBrightness = pending.brightness(band.x, band.y, band.width, band.height);
    expect(pendingBrightness).toBeGreaterThan(0);
    expect(pendingBrightness).toBeLessThan(residentBrightness * 0.8);
  });
});

describe("a host-owned structure layer", () => {
  it("paints ranges the host answers per window, without being handed all of them", () => {
    const { engine, paint } = setup();
    const asked: number[] = [];
    // What a parser that owns the file does: answer the window it is asked about.
    engine.setDecorationSource("structure", {
      between(from, to) {
        asked.push(to - from);
        return from < 48 && to > 32 ? [{ id: "field", start: 32, end: 48, color: "#00ff00", opacity: 1 }] : [];
      },
    });

    const layout = engine.layout;
    const painted = paint();
    expectNear(painted.at(layout.byteX(3) + layout.charWidth * 2.5, middleOf(2)), green);
    expectNear(painted.at(layout.byteX(3) + layout.charWidth * 2.5, middleOf(4)), black, 12);
    // A row at a time, not the document.
    expect(Math.max(...asked)).toBeLessThanOrEqual(16);
    expect(engine.decorationsAt(33, "structure").map((item) => item.kind)).toEqual(["structure"]);
  });

  it("repaints with what the host learned after being told to", () => {
    const { engine, paint } = setup();
    let known: { id: string; start: number; end: number; color: string; opacity: number }[] = [];
    engine.setDecorationSource("structure", {
      between: (from, to) => known.filter((item) => item.start < to && item.end > from),
    });
    const at = () => paint().at(engine.layout.byteX(3) + engine.layout.charWidth * 2.5, middleOf(2));
    expectNear(at(), black, 12);

    // The parser read further and now knows about this range.
    known = [{ id: "late", start: 32, end: 48, color: "#00ff00", opacity: 1 }];
    engine.invalidateDecorations("structure");
    expectNear(at(), green);
  });
});

describe("partly resident pages", () => {
  it("draws the rows it has and marks only the rest as pending", async () => {
    // One 64-byte page arrives; the rest never does. The whole visible window is
    // therefore unreadable in one go, which is the case the per-row fallback is for.
    const resident = bytes(64);
    const source = new PagedByteSource({
      length: 4096,
      pageSize: 64,
      fetch: (offset) => (offset === 0 ? Promise.resolve(resident) : new Promise<Uint8Array>(() => {})),
    });
    await source.ensure(0, 64);

    const { engine, paint } = setup({ source });
    const painted = paint();
    const layout = engine.layout;
    const band = { x: layout.hexStart, width: layout.charWidth * 16 * 3 };

    const arrived = painted.brightness(band.x, 2, band.width, rowHeight * 4 - 4);
    const missing = painted.brightness(band.x, rowHeight * 5 + 2, band.width, rowHeight * 4 - 4);
    expect(arrived).toBeGreaterThan(missing * 1.3);
    expect(missing).toBeGreaterThan(0); // placeholders, not blank
  });
});

describe("scrolling to the end", () => {
  // 17 rows of 16, the last holding four bytes: the case a row-snapped scroll
  // offset used to hide.
  const length = 16 * 16 + 4;

  it("shows the last row once scrolled to the bottom", () => {
    const { engine, paint } = setup({}, length);
    const maximum = engine.scrollHeight - viewport.height;
    engine.setScrollTop(maximum);
    const painted = paint();
    const layout = engine.layout;

    expect(engine.visibleRows.last).toBe(17);
    // At the very bottom the document ends exactly at the viewport's bottom edge.
    // Snapping the offset to whole rows leaves the remainder below the fold, which
    // is little enough that only the arithmetic shows it.
    const documentBottom = engine.totalRows * rowHeight - engine.logicalScrollTop;
    expect(documentBottom).toBeLessThanOrEqual(viewport.height + 0.5);
    expect(documentBottom).toBeGreaterThan(viewport.height - 0.5);

    const bottom = viewport.height - 3;
    expect(engine.hitTest(layout.byteX(0), bottom).offset).toBeGreaterThanOrEqual(16 * 16);
    // Painted, not merely reachable: the address of the last row has to be there.
    expect(painted.brightness(layout.addressX, viewport.height - rowHeight + 4, layout.addressWidth - 20, rowHeight - 8)).toBeGreaterThan(2);
  });

  it("keeps the bottom reachable when the scroll height is scaled down", () => {
    // Past the browser's height ceiling one DOM pixel is many document pixels,
    // so a snapped offset loses a whole row rather than a couple of pixels.
    const { engine } = setup({ source: new PagedByteSource({ length: 2 ** 32, fetch: async () => new Uint8Array(0) }) });
    engine.setScrollTop(engine.scrollHeight - viewport.height);
    const documentBottom = engine.totalRows * rowHeight - engine.logicalScrollTop;
    expect(documentBottom).toBeLessThanOrEqual(viewport.height + 1);
    expect(documentBottom).toBeGreaterThan(viewport.height - 1);
  });

  it("scrolls far enough to reveal the last row when the cursor moves there", () => {
    const { engine } = setup({}, length);
    engine.moveCursor(length - 1);
    const state = engine.getState();
    expect(state.scrollTop).toBeCloseTo(engine.scrollHeight - viewport.height, 1);
  });
});

/**
 * The fast path and the slow one have to be the same picture.
 *
 * A row is normally drawn as one string per column, which is about four times
 * cheaper than a call per byte but only correct while every glyph advances by
 * exactly `charWidth` and a byte is exactly three characters wide. Anything
 * that recolours part of a row falls back to the per-byte loop, so the two are
 * both live at all times and a drift between them would be a grid that changes
 * appearance depending on whether a decoration happens to be on screen.
 */
describe("drawing a row as one run", () => {
  /**
   * The byte columns only. A decoration is what forces the other path, and a
   * decorated row also gets a marker in the address gutter — comparing the whole
   * canvas would be comparing that marker, not the glyphs.
   */
  const glyphs = (canvas: HTMLCanvasElement, fromCssX: number): Uint8ClampedArray => {
    const ratio = canvas.width / canvas.clientWidth;
    const from = Math.floor(fromCssX * ratio);
    return canvas.getContext("2d")!.getImageData(from, 0, canvas.width - from, canvas.height).data;
  };

  const differences = (left: Uint8ClampedArray, right: Uint8ClampedArray): number => {
    let count = 0;
    for (let at = 0; at < left.length; at += 4) {
      if (left[at] !== right[at] || left[at + 1] !== right[at + 1] || left[at + 2] !== right[at + 2]) count++;
    }
    return count;
  };

  /** A range that recolours the glyphs to the colour they already are. */
  const forcePerByte = { start: 0, end: 256, textColor: probeTheme.foreground, opacity: 0 };

  it("paints what the per-byte loop paints", () => {
    const batched = setup();
    batched.engine.render(batched.canvas);
    const perByte = setup();
    perByte.engine.setDecorations([forcePerByte], "force-per-byte");
    perByte.engine.render(perByte.canvas);
    const from = batched.engine.layout.hexStart;
    expect(differences(glyphs(batched.canvas, from), glyphs(perByte.canvas, from))).toBe(0);
  });

  it("paints what the per-byte loop paints for a row that has not arrived", () => {
    const paged = () => new PagedByteSource({
      length: 256,
      pageSize: 64,
      fetch: async (offset, length) => bytes(256).subarray(offset, offset + length),
    });
    const batched = setup({ source: paged() });
    const perByte = setup({ source: paged() });
    perByte.engine.setDecorations([forcePerByte], "force-per-byte");
    // Nothing is resident yet, so both draw the placeholder for every byte.
    batched.engine.render(batched.canvas);
    perByte.engine.render(perByte.canvas);
    const from = batched.engine.layout.hexStart;
    expect(differences(glyphs(batched.canvas, from), glyphs(perByte.canvas, from))).toBe(0);
  });
});

/**
 * A comparison that has recognised a shift lays its rows out so corresponding
 * bytes share a line, which means one side leaving a gap where the other has
 * something extra. The renderer takes the plan rather than working rows out.
 */
describe("a row plan with gaps", () => {
  it("draws a gap row as nothing at all", () => {
    const { engine, canvas } = setup({}, 256);
    const bytesPerRow = engine.layout.bytesPerRow;
    engine.setRowPlan({
      rows: 3,
      // Row 0 is a gap; the document starts on row 1.
      at: (row) => (row === 0 ? { offset: 0, length: 0 } : { offset: (row - 1) * bytesPerRow, length: bytesPerRow }),
      rowOf: (offset) => Math.floor(offset / bytesPerRow) + 1,
      indexOf: (offset) => offset % bytesPerRow,
    });
    engine.render(canvas);
    const painted = new Painted(canvas);
    const layout = engine.layout;
    // Nothing on the gap row — no bytes, and no address either, which would
    // otherwise repeat the address of the row below it.
    const gap = middleOf(0);
    expect(painted.longestRunOff(black, gap, 0, layout.width)).toBe(0);
    // And the first byte of the document is on row 1.
    expect(painted.longestRunOff(black, middleOf(1), layout.addressX, layout.width)).toBeGreaterThan(0);
  });

  it("counts its rows from the plan, not from the byte length", () => {
    const { engine } = setup({}, 256);
    expect(engine.totalRows).toBe(16);
    engine.setRowPlan({
      rows: 20,
      at: (row) => ({ offset: row * 16, length: 16 }),
      rowOf: (offset) => Math.floor(offset / 16),
      indexOf: (offset) => offset % 16,
    });
    expect(engine.totalRows).toBe(20);
    engine.setRowPlan(undefined);
    expect(engine.totalRows).toBe(16);
  });

  it("hit-tests through the plan", () => {
    const { engine } = setup({}, 256);
    const bytesPerRow = engine.layout.bytesPerRow;
    engine.setRowPlan({
      rows: 17,
      at: (row) => (row === 0 ? { offset: 0, length: 0 } : { offset: (row - 1) * bytesPerRow, length: bytesPerRow }),
      rowOf: (offset) => Math.floor(offset / bytesPerRow) + 1,
      indexOf: (offset) => offset % bytesPerRow,
    });
    // Row 1 is the document's first row now, so a click there is byte 0.
    expect(engine.hitTest(engine.layout.byteX(0) + 2, middleOf(1)).offset).toBe(0);
  });
});
