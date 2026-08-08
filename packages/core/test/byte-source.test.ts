import { describe, expect, it, vi } from "vitest";
import { ChangeSet, MemoryByteSource, PagedByteSource, fromBinaryBuffer, isAbortError, type ByteSource } from "../src/byte-source";
import { MemoryBinaryBuffer } from "../src/binary-buffer";
import { PieceTableSource } from "../src/piece-table";

const bytes = (...values: number[]) => Uint8Array.of(...values);
const read = (source: { peek: (offset: number, length: number) => Uint8Array | undefined }, length: number) => [...(source.peek(0, length) ?? [])];

describe("ChangeSet", () => {
  it("reports how much the document grows or shrinks", () => {
    expect(ChangeSet.insert(0, bytes(1, 2)).lengthDelta).toBe(2);
    expect(ChangeSet.remove(0, 3).lengthDelta).toBe(-3);
    expect(ChangeSet.replace(0, 2, bytes(9, 9)).lengthDelta).toBe(0);
  });

  it("leaves offsets before a change alone and shifts the ones after", () => {
    const insertion = ChangeSet.insert(2, bytes(9, 9));
    expect(insertion.mapPos(1)).toBe(1);
    expect(insertion.mapPos(3)).toBe(5);
  });

  it("collapses an offset inside a deleted range onto its start", () => {
    const removal = ChangeSet.remove(2, 6);
    expect(removal.mapPos(4)).toBe(2);
    expect(removal.mapPos(7)).toBe(3);
  });

  it("puts an offset at an insertion point on the side asked for", () => {
    const insertion = ChangeSet.insert(4, bytes(1, 2, 3));
    expect(insertion.mapPos(4, -1)).toBe(4);
    expect(insertion.mapPos(4, 1)).toBe(7);
  });

  it("accumulates across several changes", () => {
    const changes = new ChangeSet([
      { from: 0, to: 2, insert: bytes(1) },
      { from: 8, to: 8, insert: bytes(2, 2) },
    ]);
    expect(changes.mapPos(6)).toBe(5);
    expect(changes.mapPos(10)).toBe(11);
  });
});

describe("MemoryByteSource", () => {
  it("reports a miss for a range outside the document", () => {
    const source = new MemoryByteSource(bytes(1, 2, 3));
    expect(source.peek(2, 4)).toBeUndefined();
    expect(source.peek(-1, 1)).toBeUndefined();
  });

  it("fills a caller-provided buffer instead of allocating", () => {
    const source = new MemoryByteSource(bytes(1, 2, 3, 4));
    const out = new Uint8Array(8);
    const result = source.peek(1, 2, out);
    expect([...result!]).toEqual([2, 3]);
    expect(result!.buffer).toBe(out.buffer);
  });

  it("applies insert, delete and overwrite", () => {
    const source = new MemoryByteSource(bytes(1, 2, 3, 4));
    source.apply(ChangeSet.insert(2, bytes(9, 9)));
    expect(read(source, source.length)).toEqual([1, 2, 9, 9, 3, 4]);
    source.apply(ChangeSet.remove(0, 2));
    expect(read(source, source.length)).toEqual([9, 9, 3, 4]);
    source.apply(ChangeSet.replace(1, 2, bytes(7)));
    expect(read(source, source.length)).toEqual([9, 7, 3, 4]);
  });

  it("tells subscribers what changed and bumps the version", () => {
    const source = new MemoryByteSource(bytes(1, 2));
    const listener = vi.fn();
    const unsubscribe = source.subscribe(listener);
    const changes = ChangeSet.replace(0, 1, bytes(5));
    source.apply(changes);
    expect(listener).toHaveBeenCalledWith(changes);
    expect(source.version).toBe(1);
    unsubscribe();
    source.apply(ChangeSet.replace(0, 1, bytes(6)));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("streams the document for saving", async () => {
    const source = new MemoryByteSource(bytes(1, 2, 3));
    const chunks: number[] = [];
    for await (const chunk of source.save()) chunks.push(...chunk);
    expect(chunks).toEqual([1, 2, 3]);
  });

  it("copies its input so the caller cannot mutate it behind the source", () => {
    const input = bytes(1, 2, 3);
    const source = new MemoryByteSource(input);
    input[0] = 99;
    expect(read(source, 3)).toEqual([1, 2, 3]);
  });
});

describe("PagedByteSource", () => {
  const paged = (onFetch = () => {}) => new PagedByteSource({
    length: 4096,
    pageSize: 1024,
    fetch: (offset, length) => {
      onFetch();
      return Promise.resolve(Uint8Array.from({ length }, (_, index) => (offset + index) & 0xff));
    },
  });

  it("misses until the range is fetched", async () => {
    const source = paged();
    expect(source.peek(0, 16)).toBeUndefined();
    await source.ensure(0, 16);
    expect(read(source, 4)).toEqual([0, 1, 2, 3]);
  });

  it("fetches only the pages the range touches, once each", async () => {
    const fetches = vi.fn();
    const source = paged(fetches);
    await source.ensure(0, 16);
    await source.ensure(0, 16);
    expect(fetches).toHaveBeenCalledTimes(1);
    expect(source.residentPages).toBe(1);
    await source.ensure(1000, 100);
    expect(fetches).toHaveBeenCalledTimes(2);
    expect(source.residentPages).toBe(2);
  });

  it("joins bytes that straddle a page boundary", async () => {
    const source = paged();
    await source.ensure(1020, 8);
    expect([...source.peek(1020, 8)!]).toEqual([252, 253, 254, 255, 0, 1, 2, 3]);
  });

  it("coalesces concurrent requests for the same page", async () => {
    const fetches = vi.fn();
    const source = paged(fetches);
    await Promise.all([source.ensure(0, 8), source.ensure(8, 8)]);
    expect(fetches).toHaveBeenCalledTimes(1);
  });

  it("drops the least recently used page past the budget", async () => {
    const source = new PagedByteSource({
      length: 4096,
      pageSize: 1024,
      maxPages: 2,
      fetch: (_, length) => Promise.resolve(new Uint8Array(length)),
    });
    await source.ensure(0, 1);
    await source.ensure(1024, 1);
    await source.ensure(2048, 1);
    expect(source.residentPages).toBe(2);
    expect(source.peek(0, 1)).toBeUndefined();
  });

  it("has no apply, which marks it read-only", () => {
    // The absence is the contract: a source without apply cannot be edited.
    const source: ByteSource = paged();
    expect(source.apply).toBeUndefined();
  });
});

describe("fromBinaryBuffer", () => {
  it("adapts the older synchronous contract", () => {
    const source = fromBinaryBuffer(new MemoryBinaryBuffer(bytes(1, 2, 3)));
    expect(read(source, 3)).toEqual([1, 2, 3]);
    source.apply?.(ChangeSet.replace(1, 2, bytes(8)));
    expect(read(source, 3)).toEqual([1, 8, 3]);
  });

  it("refuses a change that would alter the length", () => {
    const source = fromBinaryBuffer(new MemoryBinaryBuffer(bytes(1, 2, 3)));
    expect(() => source.apply?.(ChangeSet.insert(1, bytes(9)))).toThrow(RangeError);
  });
});

/**
 * Cancelling used to mean "stop waiting". The reads carried on, which on a scan
 * over a large file is the cost that matters — and a comparison is minutes of
 * it. These pin the two halves: nothing new is started, and what is in flight is
 * told, but only once nobody is left who wants it.
 */
describe("PagedByteSource cancellation", () => {
  /** A backend that hands back control over when each page arrives. */
  const controllable = (length = 4096, pageSize = 64) => {
    const asked: { offset: number; signal: AbortSignal | undefined; settle: () => void }[] = [];
    const source = new PagedByteSource({
      length,
      pageSize,
      fetch: (offset, size, signal) => new Promise<Uint8Array>((resolve) => {
        asked.push({ offset, signal, settle: () => resolve(new Uint8Array(size)) });
      }),
    });
    return { source, asked };
  };

  it("rejects with an AbortError rather than waiting", async () => {
    const { source } = controllable();
    const aborter = new AbortController();
    const waiting = source.ensure(0, 64, aborter.signal);
    aborter.abort();
    await expect(waiting).rejects.toThrow(/aborted/i);
    await waiting.catch((error: unknown) => expect(isAbortError(error)).toBe(true));
  });

  it("starts nothing once the signal is already set", async () => {
    const { source, asked } = controllable();
    const aborter = new AbortController();
    aborter.abort();
    await expect(source.ensure(0, 64, aborter.signal)).rejects.toThrow();
    expect(asked).toHaveLength(0);
  });

  // The half that was missing: the fetch itself is told.
  it("tells the backend to stop when the only caller gives up", async () => {
    const { source, asked } = controllable();
    const aborter = new AbortController();
    void source.ensure(0, 64, aborter.signal).catch(() => undefined);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.signal?.aborted).toBe(false);
    aborter.abort();
    expect(asked[0]!.signal?.aborted).toBe(true);
  });

  /**
   * Loads are shared, so one caller giving up must not take the page away from
   * another still waiting for it — the reason this is ref-counted rather than a
   * signal handed straight through.
   */
  it("keeps fetching while anyone is still waiting", async () => {
    const { source, asked } = controllable();
    const first = new AbortController();
    const second = new AbortController();
    void source.ensure(0, 64, first.signal).catch(() => undefined);
    const staying = source.ensure(0, 64, second.signal);
    expect(asked).toHaveLength(1);

    first.abort();
    expect(asked[0]!.signal?.aborted).toBe(false);

    asked[0]!.settle();
    await staying;
    expect(source.peek(0, 64)).toBeDefined();
  });

  it("never abandons a page someone asked for without a signal", async () => {
    const { source, asked } = controllable();
    const aborter = new AbortController();
    const unstoppable = source.ensure(0, 64);
    void source.ensure(0, 64, aborter.signal).catch(() => undefined);
    aborter.abort();
    // No controller is made at all when the caller that started the load cannot
    // stop, so there is nothing for a later one to abort.
    expect(asked[0]!.signal).toBeUndefined();
    asked[0]!.settle();
    await unstoppable;
    expect(source.peek(0, 64)).toBeDefined();
  });

  // The same, in the order that does make a controller: the abortable caller
  // started the load, and one that cannot stop joined it afterwards.
  it("keeps the page when an unstoppable caller joined an abortable one", async () => {
    const { source, asked } = controllable();
    const aborter = new AbortController();
    void source.ensure(0, 64, aborter.signal).catch(() => undefined);
    const unstoppable = source.ensure(0, 64);
    aborter.abort();
    expect(asked[0]!.signal?.aborted).toBe(false);
    asked[0]!.settle();
    await unstoppable;
    expect(source.peek(0, 64)).toBeDefined();
  });

  it("carries the signal down through a piece table to the original", async () => {
    const { source, asked } = controllable();
    const table = new PieceTableSource(source);
    const aborter = new AbortController();
    void table.ensure(0, 64, aborter.signal).catch(() => undefined);
    expect(asked).toHaveLength(1);
    aborter.abort();
    expect(asked[0]!.signal?.aborted).toBe(true);
  });
});
