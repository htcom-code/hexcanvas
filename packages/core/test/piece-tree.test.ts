import { describe, expect, it } from "vitest";
import { PieceTree, type Piece } from "../src/piece-tree";

const original = Uint8Array.from({ length: 64 }, (_, index) => index);

/** The bytes the tree currently describes, read through its own segments. */
const read = (tree: PieceTree, added: number[]): number[] => {
  const bytes: number[] = [];
  for (const segment of tree.segments(0, tree.bytes)) {
    const store = segment.origin === "original" ? [...original] : added;
    bytes.push(...store.slice(segment.offset, segment.offset + segment.length));
  }
  return bytes;
};

const whole = (): PieceTree => new PieceTree([{ origin: "original", offset: 0, length: original.length }]);

describe("PieceTree", () => {
  it("starts as one piece covering the document", () => {
    const tree = whole();
    expect(tree.bytes).toBe(64);
    expect(tree.pieceCount).toBe(1);
    expect(read(tree, [])).toEqual([...original]);
  });

  it("clips a read to the range asked for", () => {
    const tree = whole();
    expect([...tree.segments(10, 4)]).toEqual([{ origin: "original", offset: 10, length: 4 }]);
    expect([...tree.segments(0, 0)]).toEqual([]);
    // Past the end yields what exists rather than inventing bytes.
    expect([...tree.segments(60, 100)]).toEqual([{ origin: "original", offset: 60, length: 4 }]);
  });

  it("splits the straddled piece on an insert", () => {
    const tree = whole();
    tree.insert(10, { origin: "added", offset: 0, length: 2 });
    expect(tree.bytes).toBe(66);
    expect(tree.pieceCount).toBe(3);
    expect(read(tree, [200, 201])).toEqual([...original.slice(0, 10), 200, 201, ...original.slice(10)]);
  });

  it("inserts at either edge without splitting anything", () => {
    const tree = whole();
    tree.insert(0, { origin: "added", offset: 0, length: 1 });
    tree.insert(tree.bytes, { origin: "added", offset: 1, length: 1 });
    expect(tree.pieceCount).toBe(3);
    expect(read(tree, [200, 201])).toEqual([200, ...original, 201]);
  });

  it("removes a range from the middle", () => {
    const tree = whole();
    tree.remove(8, 16);
    expect(tree.bytes).toBe(56);
    expect(read(tree, [])).toEqual([...original.slice(0, 8), ...original.slice(16)]);
  });

  it("removes across piece boundaries", () => {
    const tree = whole();
    tree.insert(10, { origin: "added", offset: 0, length: 4 });
    // Removes two original bytes, all four inserted ones, then six more original.
    tree.remove(8, 20);
    expect(read(tree, [200, 201, 202, 203])).toEqual([...original.slice(0, 8), ...original.slice(16)]);
  });

  it("empties out and refills", () => {
    const tree = whole();
    tree.remove(0, tree.bytes);
    expect(tree.bytes).toBe(0);
    expect(tree.pieceCount).toBe(0);
    expect([...tree.segments(0, 10)]).toEqual([]);
    tree.insert(0, { origin: "added", offset: 0, length: 2 });
    expect(read(tree, [7, 8])).toEqual([7, 8]);
  });

  it("ignores an empty insert or removal", () => {
    const tree = whole();
    tree.insert(4, { origin: "added", offset: 0, length: 0 });
    tree.remove(4, 4);
    expect(tree.pieceCount).toBe(1);
  });

  it("grows the last piece instead of adding one when typing", () => {
    const tree = whole();
    // A run of one-byte inserts, each right after the last, out of one buffer:
    // what typing looks like, and what used to leave a piece per keystroke.
    for (let step = 0; step < 500; step++) tree.insert(20 + step, { origin: "added", offset: step, length: 1 });
    expect(tree.bytes).toBe(564);
    expect(tree.pieceCount).toBe(3);
    expect(tree.toArray()).toEqual([
      { origin: "original", offset: 0, length: 20 },
      { origin: "added", offset: 0, length: 500 },
      { origin: "original", offset: 20, length: 44 },
    ]);
  });

  it("only merges pieces that are the same run of bytes", () => {
    const tree = whole();
    tree.insert(20, { origin: "added", offset: 0, length: 1 });
    // Adjacent and the same store, but not the next bytes in it.
    tree.insert(21, { origin: "added", offset: 8, length: 1 });
    // Adjacent and contiguous, but a different store.
    tree.insert(22, { origin: "original", offset: 9, length: 1 });
    expect(tree.pieceCount).toBe(5);
    expect(read(tree, [111, 0, 0, 0, 0, 0, 0, 0, 222])).toEqual([
      ...original.slice(0, 20), 111, 222, 9, ...original.slice(20),
    ]);
  });

  it("does not merge across a gap left by a removal", () => {
    const tree = whole();
    tree.insert(20, { origin: "added", offset: 0, length: 2 });
    tree.remove(21, 22); // takes the second inserted byte back out
    tree.insert(21, { origin: "added", offset: 4, length: 1 });
    expect(tree.pieceCount).toBe(4);
    expect(tree.toArray()[1]).toEqual({ origin: "added", offset: 0, length: 1 });
  });

  it("matches a plain array over a long run of edits", () => {
    // The point of the tree is that these stay cheap; the point of this test is
    // that they stay correct while the document fragments.
    const tree = whole();
    const added: number[] = [];
    let model = [...original];
    let seed = 12345;
    const next = (bound: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % bound;
    };

    for (let step = 0; step < 400; step++) {
      if (step % 3 === 2 && model.length > 4) {
        const from = next(model.length - 1);
        const to = Math.min(model.length, from + 1 + next(6));
        tree.remove(from, to);
        model = [...model.slice(0, from), ...model.slice(to)];
      } else {
        const at = next(model.length + 1);
        const length = 1 + next(3);
        const offset = added.length;
        for (let index = 0; index < length; index++) added.push(128 + (step % 100));
        tree.insert(at, { origin: "added", offset, length });
        model = [...model.slice(0, at), ...added.slice(offset, offset + length), ...model.slice(at)];
      }
      expect(tree.bytes, `byte count after step ${step}`).toBe(model.length);
    }
    expect(read(tree, added)).toEqual(model);
    expect(tree.pieceCount).toBeGreaterThan(100);
  });

  it("keeps reads independent of where the pieces are", () => {
    const tree = whole();
    const added: number[] = [];
    for (let step = 0; step < 200; step++) {
      added.push(step & 0xff);
      tree.insert(step * 2, { origin: "added", offset: step, length: 1 });
    }
    const model = read(tree, added);
    // Every window, read one at a time, has to agree with the whole.
    for (let offset = 0; offset + 8 <= tree.bytes; offset += 8) {
      const window: Piece[] = [...tree.segments(offset, 8)];
      const bytes = window.flatMap((segment) => {
        const store = segment.origin === "original" ? [...original] : added;
        return store.slice(segment.offset, segment.offset + segment.length);
      });
      expect(bytes, `window at ${offset}`).toEqual(model.slice(offset, offset + 8));
    }
  });
});
