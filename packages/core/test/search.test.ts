import { describe, expect, it } from "vitest";
import { MemoryByteSource, type ByteSource } from "../src/byte-source";
import { findAll, findNext, findPrevious, parseHexQuery } from "../src/search";

const source = (...values: number[]) => new MemoryByteSource(Uint8Array.of(...values));

describe("parseHexQuery", () => {
  it("accepts spaced and unspaced digits", () => {
    expect([...parseHexQuery("DE AD BE EF")]).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect([...parseHexQuery("deadbeef")]).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it("rejects anything that is not whole bytes", () => {
    expect(() => parseHexQuery("abc")).toThrow();
    expect(() => parseHexQuery("zz")).toThrow();
    expect(() => parseHexQuery("")).toThrow();
  });
});

describe("findNext", () => {
  it("finds the first match at or after the start offset", async () => {
    const bytes = source(0x48, 0x65, 0x48, 0x65);
    expect(await findNext(bytes, parseHexQuery("48"))).toEqual({ start: 0, end: 1 });
    expect(await findNext(bytes, parseHexQuery("48"), 1)).toEqual({ start: 2, end: 3 });
  });

  it("stops at the end rather than wrapping", async () => {
    expect(await findNext(source(1, 2, 3), Uint8Array.of(1), 1)).toBeUndefined();
  });

  it("ignores a query longer than the document", async () => {
    expect(await findNext(source(1), Uint8Array.of(1, 2))).toBeUndefined();
  });

  it("finds a match that straddles a chunk boundary", async () => {
    const bytes = new MemoryByteSource(Uint8Array.from({ length: 300 }, (_, index) => (index === 127 ? 0xde : index === 128 ? 0xad : 0)));
    expect(await findNext(bytes, Uint8Array.of(0xde, 0xad), 0, 128)).toEqual({ start: 127, end: 129 });
  });

  it("finds a match at the very end of the document", async () => {
    expect(await findNext(source(1, 2, 3), Uint8Array.of(3))).toEqual({ start: 2, end: 3 });
  });

  it("pulls pages it has not read yet", async () => {
    const lazy = new MemoryByteSource(Uint8Array.from({ length: 5000 }, (_, index) => (index === 4096 ? 0x7f : 0)));
    expect(await findNext(lazy, Uint8Array.of(0x7f), 0, 1024)).toEqual({ start: 4096, end: 4097 });
  });
});

describe("findPrevious", () => {
  it("finds the last match before the given offset", async () => {
    const bytes = source(0x65, 0x48, 0x65, 0x48);
    expect(await findPrevious(bytes, parseHexQuery("65"))).toEqual({ start: 2, end: 3 });
    expect(await findPrevious(bytes, parseHexQuery("65"), 2)).toEqual({ start: 0, end: 1 });
  });

  it("treats the boundary as exclusive", async () => {
    expect(await findPrevious(source(1, 2, 3), Uint8Array.of(1), 0)).toBeUndefined();
  });

  it("finds a match that straddles a chunk boundary", async () => {
    const bytes = new MemoryByteSource(Uint8Array.from({ length: 300 }, (_, index) => (index === 127 ? 0xde : index === 128 ? 0xad : 0)));
    expect(await findPrevious(bytes, Uint8Array.of(0xde, 0xad), 300, 128)).toEqual({ start: 127, end: 129 });
  });
});

describe("findAll", () => {
  it("returns every match, overlapping ones included", async () => {
    expect(await findAll(source(1, 1, 1), Uint8Array.of(1, 1))).toEqual([
      { start: 0, end: 2 },
      { start: 1, end: 3 },
    ]);
  });

  it("honours the limit", async () => {
    expect(await findAll(source(1, 1, 1, 1), Uint8Array.of(1), 2)).toHaveLength(2);
  });
});

describe("reading ahead", () => {
  const size = 1 << 20;
  const pageSize = 64 * 1024;

  /** Records how many reads are outstanding at once, and how many were asked for. */
  const watched = () => {
    const data = new Uint8Array(size);
    data.set(Uint8Array.of(0xde, 0xad, 0xbe, 0xef), size - 300);
    const ready = new Set<number>();
    const stats = { calls: 0, peak: 0, inFlight: 0 };
    const pagesOf = (offset: number, length: number) => {
      const first = Math.floor(offset / pageSize);
      const last = Math.floor((offset + length - 1) / pageSize);
      return Array.from({ length: last - first + 1 }, (_, index) => first + index);
    };
    const source: ByteSource = {
      length: size,
      version: 0,
      peek: (offset, length) => (pagesOf(offset, length).every((page) => ready.has(page)) ? data.subarray(offset, offset + length) : undefined),
      async ensure(offset, length) {
        stats.calls++;
        stats.inFlight++;
        stats.peak = Math.max(stats.peak, stats.inFlight);
        // A macrotask, so several requests can be outstanding together.
        await new Promise((resolve) => setTimeout(resolve, 0));
        for (const page of pagesOf(offset, length)) ready.add(page);
        stats.inFlight--;
      },
      subscribe: () => () => {},
    };
    return { source, stats };
  };

  it("has the next windows in flight while matching the current one", async () => {
    const { source, stats } = watched();
    const match = await findNext(source, Uint8Array.of(0xde, 0xad, 0xbe, 0xef), 0, { chunkSize: 64 * 1024, readAhead: 3 });
    expect(match).toEqual({ start: size - 300, end: size - 296 });
    // Serial reading would never have more than one outstanding.
    expect(stats.peak).toBeGreaterThan(1);
  });

  it("reads ahead without being asked to", async () => {
    const { source, stats } = watched();
    // No options at all: the defaults are what a host actually gets.
    const match = await findNext(source, Uint8Array.of(0xde, 0xad, 0xbe, 0xef));
    expect(match).toEqual({ start: size - 300, end: size - 296 });
    expect(stats.peak).toBeGreaterThan(1);
  });

  it("asks for each window once", async () => {
    const { source, stats } = watched();
    const chunkSize = 64 * 1024;
    await findNext(source, Uint8Array.of(0xde, 0xad, 0xbe, 0xef), 0, { chunkSize, readAhead: 3 });
    const windows = Math.ceil(size / (chunkSize - 3));
    expect(stats.calls).toBeLessThanOrEqual(windows + 3);
  });

  it("still finds everything with reading ahead turned off", async () => {
    const { source, stats } = watched();
    const match = await findNext(source, Uint8Array.of(0xde, 0xad, 0xbe, 0xef), 0, { chunkSize: 64 * 1024, readAhead: 0 });
    expect(match).toEqual({ start: size - 300, end: size - 296 });
    expect(stats.peak).toBe(1);
  });

  it("reads backwards ahead of itself too", async () => {
    const { source, stats } = watched();
    const match = await findPrevious(source, Uint8Array.of(0xde, 0xad, 0xbe, 0xef), size, { chunkSize: 64 * 1024, readAhead: 3 });
    expect(match).toEqual({ start: size - 300, end: size - 296 });
    expect(stats.peak).toBeGreaterThan(1);
  });
});

describe("candidate scanning", () => {
  it("finds a match whose first byte repeats before it", async () => {
    // Skipping to candidates on the first byte has to keep testing the rest.
    const bytes = source(0xaa, 0xaa, 0xaa, 0xbb, 0xaa, 0xaa);
    expect(await findNext(bytes, Uint8Array.of(0xaa, 0xbb))).toEqual({ start: 2, end: 4 });
    expect(await findPrevious(bytes, Uint8Array.of(0xaa, 0xaa))).toEqual({ start: 4, end: 6 });
    expect(await findPrevious(bytes, Uint8Array.of(0xaa, 0xbb))).toEqual({ start: 2, end: 4 });
  });

  it("handles a query of one byte in both directions", async () => {
    const bytes = source(1, 2, 1, 2, 1);
    expect(await findNext(bytes, Uint8Array.of(1), 1)).toEqual({ start: 2, end: 3 });
    expect(await findPrevious(bytes, Uint8Array.of(1), 4)).toEqual({ start: 2, end: 3 });
    expect(await findPrevious(bytes, Uint8Array.of(2), 1)).toBeUndefined();
  });

  it("finds a match at the very first and very last position", async () => {
    const bytes = source(9, 0, 0, 9);
    expect(await findNext(bytes, Uint8Array.of(9))).toEqual({ start: 0, end: 1 });
    expect(await findPrevious(bytes, Uint8Array.of(9))).toEqual({ start: 3, end: 4 });
  });
});
