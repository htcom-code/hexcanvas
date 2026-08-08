import { describe, expect, it } from "vitest";
import { MemoryByteSource, PagedByteSource } from "../src/byte-source";
import { compareEditScript, createEditScriptDiffProvider } from "../src/edit-script";
import type { HexDifference } from "../src/diff";

const source = (bytes: ArrayLike<number>) => new MemoryByteSource(Uint8Array.from(bytes));

/**
 * Rebuilds the right document out of the left one and the script.
 *
 * This is the whole verification, and it is deliberately not a check of what
 * Myers did — it is a check of what the script *means*. Between differences the
 * two are claimed to agree, so those bytes are copied from the **left**; inside
 * one, the right's bytes are taken. If what comes out is the right document,
 * every claim the script made was true. A backtracking bug cannot survive it.
 */
function rebuild(left: Uint8Array, right: Uint8Array, differences: readonly HexDifference[]): Uint8Array {
  const out: number[] = [];
  let at = 0;
  let mirror = 0;
  for (const difference of differences) {
    out.push(...left.subarray(at, difference.left.start));
    mirror += difference.left.start - at;
    out.push(...right.subarray(difference.right.start, difference.right.end));
    mirror = difference.right.end;
    at = difference.left.end;
  }
  out.push(...left.subarray(at));
  void mirror;
  return Uint8Array.from(out);
}

const check = async (leftBytes: ArrayLike<number>, rightBytes: ArrayLike<number>) => {
  const left = Uint8Array.from(leftBytes);
  const right = Uint8Array.from(rightBytes);
  const differences = await compareEditScript(source(left), source(right));
  expect(rebuild(left, right, differences), `script does not rebuild the right document`).toEqual(right);
  // In order, and never overlapping: a reader walks them, and a renderer paints
  // them, both of which assume it.
  let leftEnd = -1;
  let rightEnd = -1;
  for (const difference of differences) {
    expect(difference.left.start).toBeGreaterThanOrEqual(leftEnd);
    expect(difference.right.start).toBeGreaterThanOrEqual(rightEnd);
    expect(difference.left.end).toBeGreaterThanOrEqual(difference.left.start);
    expect(difference.right.end).toBeGreaterThanOrEqual(difference.right.start);
    leftEnd = difference.left.end;
    rightEnd = difference.right.end;
  }
  return differences;
};

/** Deterministic, so a failure is reproducible from the seed alone. */
function makeNoise(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("compareEditScript", () => {
  it("reports nothing for two identical documents", async () => {
    expect(await check([1, 2, 3, 4], [1, 2, 3, 4])).toEqual([]);
  });

  // The case the aligned comparison cannot describe, and the reason this exists.
  it("calls a byte inserted at the front one insertion", async () => {
    const differences = await check([1, 2, 3, 4, 5], [9, 1, 2, 3, 4, 5]);
    expect(differences).toEqual([
      { left: { start: 0, end: 0 }, right: { start: 0, end: 1 }, kind: "insert" },
    ]);
  });

  it("calls a byte removed from the front one deletion", async () => {
    const differences = await check([9, 1, 2, 3, 4], [1, 2, 3, 4]);
    expect(differences).toEqual([
      { left: { start: 0, end: 1 }, right: { start: 0, end: 0 }, kind: "delete" },
    ]);
  });

  // Swapped bytes are a deletion and an insertion in the same place. Reported
  // separately they would be two entries a reader has to pair up again.
  it("calls a changed run one replacement", async () => {
    const differences = await check([1, 2, 3, 4, 5], [1, 7, 7, 7, 5]);
    expect(differences).toEqual([
      { left: { start: 1, end: 4 }, right: { start: 1, end: 4 }, kind: "replace" },
    ]);
  });

  it("finds several changes spread through a document", async () => {
    const differences = await check([1, 2, 3, 4, 5, 6, 7, 8], [1, 9, 3, 4, 5, 6, 9, 8]);
    expect(differences.map((difference) => difference.kind)).toEqual(["replace", "replace"]);
    expect(differences[0]!.left).toEqual({ start: 1, end: 2 });
    expect(differences[1]!.left).toEqual({ start: 6, end: 7 });
  });

  it("handles an empty document on either side", async () => {
    expect(await check([], [])).toEqual([]);
    expect(await check([], [1, 2, 3])).toEqual([
      { left: { start: 0, end: 0 }, right: { start: 0, end: 3 }, kind: "insert" },
    ]);
    expect(await check([1, 2, 3], [])).toEqual([
      { left: { start: 0, end: 3 }, right: { start: 0, end: 0 }, kind: "delete" },
    ]);
  });

  it("handles one document being a prefix of the other", async () => {
    await check([1, 2, 3], [1, 2, 3, 4, 5]);
    await check([1, 2, 3, 4, 5], [1, 2, 3]);
  });

  /**
   * The part that catches a backtracking bug. Every one of these is verified by
   * rebuilding the right document rather than by comparing against an expected
   * script, so a wrong-but-plausible answer fails.
   */
  it("rebuilds the right document for a hundred random pairs", async () => {
    const random = makeNoise(0x5eed);
    for (let round = 0; round < 100; round++) {
      const length = 1 + Math.floor(random() * 40);
      const left = Array.from({ length }, () => Math.floor(random() * 4));
      const right = [...left];
      // A handful of edits of every kind, so the script has to mix them.
      const edits = Math.floor(random() * 6);
      for (let edit = 0; edit < edits; edit++) {
        const at = Math.floor(random() * Math.max(1, right.length));
        const what = random();
        if (what < 0.34) right.splice(at, 0, Math.floor(random() * 4));
        else if (what < 0.67 && right.length > 0) right.splice(at, 1);
        else if (right.length > 0) right[at] = Math.floor(random() * 4);
      }
      await check(left, right);
    }
  });

  it("rebuilds it for pairs with almost nothing in common", async () => {
    const random = makeNoise(0xfeed);
    for (let round = 0; round < 20; round++) {
      const left = Array.from({ length: 30 }, () => Math.floor(random() * 256));
      const right = Array.from({ length: 30 }, () => Math.floor(random() * 256));
      await check(left, right);
    }
  });

  describe("the bounds it refuses past", () => {
    it("answers with one replacement when the two are further apart than the cap", async () => {
      const left = Array.from({ length: 200 }, (_, at) => at & 0xff);
      const right = Array.from({ length: 200 }, (_, at) => (at + 128) & 0xff);
      const differences = await compareEditScript(source(left), source(right), { maxDistance: 4 });
      // Honest rather than absent: it says where they stop agreeing and claims
      // nothing about how, which a script it could not compute would have.
      expect(differences).toHaveLength(1);
      expect(differences[0]!.kind).toBe("replace");
      expect(rebuild(Uint8Array.from(left), Uint8Array.from(right), differences)).toEqual(Uint8Array.from(right));
    });

    it("hands a document it cannot hold to anchoring, which can still see a shift", async () => {
      // Deliberately a shift, because that is what tells the two answers apart:
      // anchoring calls it one insertion, and the aligned scan this used to fall
      // back to would have called it a changed run reaching the end.
      const random = makeNoise(0xb10c);
      const left = Uint8Array.from({ length: 4096 }, () => Math.floor(random() * 256));
      const right = Uint8Array.from([0x42, ...left]);
      const differences = await compareEditScript(
        new MemoryByteSource(left), new MemoryByteSource(right),
        { maxBytes: 1024 },
      );
      expect(differences).toEqual([
        { left: { start: 0, end: 0 }, right: { start: 0, end: 1 }, kind: "insert" },
      ]);
    });

    it("stops at the limit like the aligned one does", async () => {
      const left = Array.from({ length: 100 }, () => 0);
      const right = Array.from({ length: 100 }, (_, at) => at % 2);
      const differences = await compareEditScript(source(left), source(right), { limit: 3 });
      expect(differences).toHaveLength(3);
    });
  });

  it("reads a paged source rather than assuming it is resident", async () => {
    const bytes = Uint8Array.from({ length: 512 }, (_, at) => at & 0xff);
    const changed = Uint8Array.from([...bytes.subarray(0, 100), 0xff, ...bytes.subarray(100)]);
    const paged = (data: Uint8Array) => new PagedByteSource({
      length: data.length,
      pageSize: 64,
      fetch: async (offset, length) => data.subarray(offset, offset + length),
    });
    const differences = await compareEditScript(paged(bytes), paged(changed));
    expect(differences).toEqual([
      { left: { start: 100, end: 100 }, right: { start: 100, end: 101 }, kind: "insert" },
    ]);
  });

  it("gives up when the signal fires", async () => {
    const aborter = new AbortController();
    aborter.abort();
    await expect(compareEditScript(source([1]), source([2]), { signal: aborter.signal })).rejects.toThrow(/aborted/i);
  });
});

describe("createEditScriptDiffProvider", () => {
  it("answers the DiffProvider contract", async () => {
    const provider = createEditScriptDiffProvider();
    const differences = await provider.compare(source([1, 2, 3]), source([0, 1, 2, 3]), { limit: 100 });
    expect(differences).toEqual([
      { left: { start: 0, end: 0 }, right: { start: 0, end: 1 }, kind: "insert" },
    ]);
  });
});
