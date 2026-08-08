import { describe, expect, it } from "vitest";
import { ChangeSet, PagedByteSource } from "../src/byte-source";
import { PieceTableSource } from "../src/piece-table";

const bytes = (...values: number[]) => Uint8Array.of(...values);
const all = (table: PieceTableSource) => [...(table.peek(0, table.length) ?? [])];

describe("PieceTableSource", () => {
  it("starts as one piece over the original", () => {
    const table = new PieceTableSource(bytes(1, 2, 3));
    expect(table.pieceCount).toBe(1);
    expect(table.hasEdits).toBe(false);
  });

  it("inserts without disturbing the surrounding bytes", () => {
    const table = new PieceTableSource(bytes(1, 2, 3, 4));
    table.apply(ChangeSet.insert(2, bytes(9, 9)));
    expect(all(table)).toEqual([1, 2, 9, 9, 3, 4]);
    expect(table.length).toBe(6);
    expect(table.hasEdits).toBe(true);
  });

  it("deletes a range", () => {
    const table = new PieceTableSource(bytes(1, 2, 3, 4, 5));
    table.apply(ChangeSet.remove(1, 3));
    expect(all(table)).toEqual([1, 4, 5]);
  });

  it("overwrites in place", () => {
    const table = new PieceTableSource(bytes(1, 2, 3));
    table.apply(ChangeSet.replace(1, 2, bytes(8)));
    expect(all(table)).toEqual([1, 8, 3]);
    expect(table.length).toBe(3);
  });

  it("reads across a piece boundary", () => {
    const table = new PieceTableSource(bytes(1, 2, 3, 4));
    table.apply(ChangeSet.insert(2, bytes(9)));
    expect([...table.peek(1, 3)!]).toEqual([2, 9, 3]);
  });

  it("deletes a range that spans several pieces", () => {
    const table = new PieceTableSource(bytes(1, 2, 3, 4));
    table.apply(ChangeSet.insert(1, bytes(7)));
    table.apply(ChangeSet.insert(3, bytes(8)));
    expect(all(table)).toEqual([1, 7, 2, 8, 3, 4]);
    table.apply(ChangeSet.remove(1, 5));
    expect(all(table)).toEqual([1, 4]);
  });

  it("stays correct once heavily fragmented", () => {
    const table = new PieceTableSource(new Uint8Array(200));
    for (let index = 0; index < 100; index++) table.apply(ChangeSet.insert(index * 2, bytes(index + 1)));
    expect(table.length).toBe(300);
    expect(table.pieceCount).toBeGreaterThan(100);
    expect([...table.peek(0, 6)!]).toEqual([1, 0, 2, 0, 3, 0]);
    expect([...table.peek(196, 4)!]).toEqual([99, 0, 100, 0]);
  });

  it("streams the edited document for saving", async () => {
    const table = new PieceTableSource(bytes(1, 2, 3));
    table.apply(ChangeSet.insert(0, bytes(9)));
    const chunks: number[] = [];
    for await (const chunk of table.save()) chunks.push(...chunk);
    expect(chunks).toEqual([9, 1, 2, 3]);
  });

  it("saves in chunks without losing bytes at the seams", async () => {
    const table = new PieceTableSource(Uint8Array.from({ length: 300 }, (_, index) => index & 0xff));
    const chunks: number[] = [];
    for await (const chunk of table.save(64)) chunks.push(...chunk);
    expect(chunks).toHaveLength(300);
    expect(chunks[63]).toBe(63);
    expect(chunks[64]).toBe(64);
  });

  describe("over a lazily paged original", () => {
    const lazy = () => new PieceTableSource(new PagedByteSource({
      length: 2048,
      pageSize: 1024,
      fetch: (offset, length) => Promise.resolve(Uint8Array.from({ length }, (_, index) => (offset + index) & 0xff)),
    }));

    it("serves inserted bytes without fetching anything", () => {
      const table = lazy();
      table.apply(ChangeSet.insert(0, bytes(0xff)));
      expect([...table.peek(0, 1)!]).toEqual([0xff]);
    });

    it("misses when the read reaches the original", async () => {
      const table = lazy();
      table.apply(ChangeSet.insert(0, bytes(0xff)));
      expect(table.peek(0, 4)).toBeUndefined();
      await table.ensure(0, 4);
      expect([...table.peek(0, 4)!]).toEqual([0xff, 0, 1, 2]);
    });

    it("does not need the original to report its length", () => {
      const table = lazy();
      table.apply(ChangeSet.insert(0, bytes(0xff)));
      expect(table.length).toBe(2049);
    });
  });
});
