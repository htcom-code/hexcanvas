import { describe, expect, it } from "vitest";
import { addressDigitsFor, createLayout } from "../src/layout";

// charWidth is passed explicitly so the maths is checked without a canvas.
const layout = (options: Partial<Parameters<typeof createLayout>[0]> = {}) =>
  createLayout({ bytesPerRow: 16, byteLength: 4096, charWidth: 10, ...options });

describe("createLayout", () => {
  it("advances one byte by three character widths", () => {
    const grid = layout();
    expect(grid.byteX(1) - grid.byteX(0)).toBe(30);
  });

  it("adds a gap between groups without disturbing bytes inside one", () => {
    const grid = layout({ byteGroup: 4 });
    expect(grid.byteX(1) - grid.byteX(0)).toBe(30);
    expect(grid.byteX(4) - grid.byteX(3)).toBe(40);
  });

  it("round-trips a byte through hit testing", () => {
    for (const byteGroup of [1, 2, 4, 8] as const) {
      const grid = layout({ byteGroup });
      for (let index = 0; index < 16; index++) {
        const hit = grid.hitTest(grid.byteX(index) + 1);
        expect({ byteGroup, index, hit }).toEqual({ byteGroup, index, hit: { region: "hex", index } });
      }
    }
  });

  it("maps the ascii column back to the same byte", () => {
    const grid = layout();
    for (let index = 0; index < 16; index++) {
      expect(grid.hitTest(grid.asciiX(index) + 1)).toEqual({ region: "ascii", index });
    }
  });

  it("treats everything left of the hex column as the address gutter", () => {
    expect(layout().hitTest(4)).toEqual({ region: "address", index: 0 });
  });

  it("clamps a coordinate past the last byte", () => {
    const grid = layout();
    expect(grid.hitTest(grid.asciiX(15) + 500).index).toBe(15);
  });

  it("formats addresses in the requested radix", () => {
    expect(layout().formatAddress(0x1f)).toBe("0000001F");
    expect(layout({ addressRadix: "decimal" }).formatAddress(31)).toBe("00000031");
  });

  it("widens the address column only past eight digits", () => {
    expect(addressDigitsFor(0x1000, "hex")).toBe(8);
    // The last addressable offset is length - 1, so eight digits still fit here.
    expect(addressDigitsFor(0x1_0000_0000, "hex")).toBe(8);
    expect(addressDigitsFor(0x1_0000_0001, "hex")).toBe(9);
  });
});
