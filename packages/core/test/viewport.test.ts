import { describe, expect, it } from "vitest";
import { createScrollScale, getVisibleRows } from "../src/viewport";

describe("getVisibleRows", () => {
  const rows = (scrollTop: number, height = 100) => getVisibleRows(1024 * 16, { bytesPerRow: 16, rowHeight: 22, height, scrollTop });

  it("starts at the row the scroll offset lands in", () => {
    expect(rows(0).first).toBe(0);
    expect(rows(22).first).toBe(1);
    expect(rows(23).first).toBe(1);
  });

  it("covers a partly visible row at each edge", () => {
    // 100px of viewport spans four whole rows plus a sliver of a fifth.
    const window = rows(11);
    expect(window.last - window.first).toBeGreaterThanOrEqual(6);
  });

  it("never runs past the document", () => {
    expect(rows(22 * 1023).last).toBe(1024);
  });
});

describe("createScrollScale", () => {
  it("reports the natural height for a document that fits", () => {
    expect(createScrollScale(1024, 22).height).toBe(22528);
  });

  it("does not snap the scroll offset to a row boundary", () => {
    const scale = createScrollScale(1024, 22);
    expect(scale.toLogical(21795)).toBe(21795);
    expect(scale.toRow(21795)).toBe(990);
  });

  it("round-trips a document pixel through the scrollbar", () => {
    const scale = createScrollScale(1024, 22);
    expect(scale.fromLogical(scale.toLogical(1234))).toBe(1234);
  });

  it("keeps the last row inside the viewport at maximum scroll", () => {
    const rowHeight = 22;
    const totalRows = 1024;
    const viewportHeight = 733; // deliberately not a multiple of rowHeight
    const scale = createScrollScale(totalRows, rowHeight);
    const top = scale.toLogical(scale.height - viewportHeight);
    const lastRowBottom = totalRows * rowHeight;
    expect(lastRowBottom - top).toBeLessThanOrEqual(viewportHeight);
  });

  it("compresses a document past the browser scroll limit", () => {
    const scale = createScrollScale(100_000_000, 22, { maxScrollHeight: 16_000_000 });
    expect(scale.height).toBe(16_000_000);
    expect(scale.toLogical(16_000_000)).toBeCloseTo(2_200_000_000, 0);
    expect(scale.toRow(scale.toScrollTop(50_000_000))).toBe(50_000_000);
  });

  it("stops at the document's end however far the scroller goes", () => {
    const rowHeight = 22;
    const totalRows = 6_676_175; // a 102 MB file at 16 bytes to the row
    const viewportHeight = 610.5;
    const scale = createScrollScale(totalRows, rowHeight, { viewportHeight, maxScrollHeight: 16_000_000 });
    const documentRange = totalRows * rowHeight - viewportHeight;

    // A browser cannot lay out a spacer of 15,999,389.5px exactly; Chrome rounds
    // up and then lets you scroll about 20px further than the range asked for,
    // which the 9x compression turns into 188px of blank space past the end.
    const beyond = scale.height - viewportHeight + 20.5;
    expect(scale.toLogical(beyond)).toBeCloseTo(documentRange, 5);
    expect(scale.toLogical(scale.height * 2)).toBeCloseTo(documentRange, 5);
    expect(scale.toRow(beyond)).toBe(Math.floor(documentRange / rowHeight));
    expect(scale.toLogical(-10)).toBe(0);
  });

  it("reaches the end of a compressed document at maximum scroll", () => {
    const rowHeight = 22;
    const totalRows = 100_000_000;
    const viewportHeight = 733;
    const scale = createScrollScale(totalRows, rowHeight, { viewportHeight, maxScrollHeight: 16_000_000 });
    // One DOM pixel stands for many document pixels here, so scaling the full
    // heights would put the last thousands of rows past the scrollbar's end.
    const top = scale.toLogical(scale.height - viewportHeight);
    expect(totalRows * rowHeight - top).toBeCloseTo(viewportHeight, 0);
  });
});
