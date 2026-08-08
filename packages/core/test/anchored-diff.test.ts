import { describe, expect, it } from "vitest";
import { MemoryByteSource, PagedByteSource } from "../src/byte-source";
import { compareAnchored, createAnchoredDiffProvider, rollingHashInternals } from "../src/anchored-diff";
import type { HexDifference } from "../src/diff";

const { weakHash, roll } = rollingHashInternals;

/** Deterministic, so a failure is reproducible from the seed alone. */
function makeNoise(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const noisy = (length: number, seed: number) => {
  const random = makeNoise(seed);
  return Uint8Array.from({ length }, () => Math.floor(random() * 256));
};

/**
 * For the two tests whose gate is a count of reads rather than a duration. They
 * do seconds of real work by design, so vitest's 5s default would decide them on
 * runner speed — which is the thing those tests were rewritten to stop doing.
 * Generous on purpose: this bound exists to be irrelevant, and a run that
 * actually reaches it has gone quadratic and would fail on the count first.
 */
const slowGate = 30_000;

/**
 * The same verification the edit script uses: applying the differences to the
 * left document has to produce the right one. Anchoring reports whole stretches
 * as unchanged without looking at them again, so this is the only thing that
 * proves those claims were true.
 */
function rebuild(left: Uint8Array, right: Uint8Array, differences: readonly HexDifference[]): Uint8Array {
  // Copied rather than spread. `push(...subarray)` over a few hundred thousand
  // bytes is seconds of work, which once made a test of this file's speed a test
  // of this function's instead.
  const out = new Uint8Array(left.length + right.length);
  let written = 0;
  let at = 0;
  const take = (from: Uint8Array, start: number, end: number) => {
    out.set(from.subarray(start, end), written);
    written += end - start;
  };
  for (const difference of differences) {
    take(left, at, difference.left.start);
    take(right, difference.right.start, difference.right.end);
    at = difference.left.end;
  }
  take(left, at, left.length);
  return out.subarray(0, written);
}

const check = async (left: Uint8Array, right: Uint8Array, blockSize = 64) => {
  const differences = await compareAnchored(
    new MemoryByteSource(left),
    new MemoryByteSource(right),
    { blockSize },
  );
  expect(rebuild(left, right, differences), "the script does not rebuild the right document").toEqual(right);
  let leftEnd = 0;
  let rightEnd = 0;
  for (const difference of differences) {
    expect(difference.left.start).toBeGreaterThanOrEqual(leftEnd);
    expect(difference.right.start).toBeGreaterThanOrEqual(rightEnd);
    leftEnd = difference.left.end;
    rightEnd = difference.right.end;
  }
  return differences;
};

/**
 * The roll is the thing that makes anchoring one pass instead of one comparison
 * per offset per block. Wrong, it finds nothing and reports the whole document
 * as changed — which is not an error, just a comparison quietly doing no good.
 */
describe("the rolling hash", () => {
  it("matches recomputing the window from scratch, at every offset", () => {
    const bytes = noisy(600, 0x51ded);
    const width = 64;
    let rolled = weakHash(bytes, 0, width);
    for (let at = 0; at + width < bytes.length; at++) {
      expect(rolled, `rolled hash diverged at offset ${at}`).toBe(weakHash(bytes, at, width));
      rolled = roll(rolled, bytes[at]!, bytes[at + width]!, width);
    }
  });

  it("separates windows that are rearrangements of each other", () => {
    // A sum alone would call these the same, which is why the second running
    // total is weighted by position.
    expect(weakHash(Uint8Array.of(1, 2, 3, 4), 0, 4)).not.toBe(weakHash(Uint8Array.of(4, 3, 2, 1), 0, 4));
  });
});

describe("compareAnchored", () => {
  it("reports nothing for two identical documents", async () => {
    const bytes = noisy(1024, 1);
    expect(await check(bytes, bytes)).toEqual([]);
  });

  // What the whole thing is for: a shift, in a pair too big to hold at once.
  it("calls a byte inserted at the front one insertion", async () => {
    const left = noisy(4096, 2);
    const right = Uint8Array.from([0x99, ...left]);
    const differences = await check(left, right);
    expect(differences).toEqual([
      { left: { start: 0, end: 0 }, right: { start: 0, end: 1 }, kind: "insert" },
    ]);
  });

  it("finds a change in the middle without describing the rest", async () => {
    const left = noisy(4096, 3);
    const right = Uint8Array.from(left);
    right.set([1, 2, 3, 4], 2000);
    const differences = await check(left, right);
    expect(differences.length).toBeLessThanOrEqual(2);
    expect(differences[0]!.left.start).toBeGreaterThan(1900);
    expect(differences[0]!.left.start).toBeLessThan(2100);
  });

  it("handles a run inserted in the middle", async () => {
    const left = noisy(4096, 4);
    const inserted = noisy(300, 5);
    const right = Uint8Array.from([...left.subarray(0, 2048), ...inserted, ...left.subarray(2048)]);
    const differences = await check(left, right);
    expect(differences.some((difference) => difference.kind === "insert")).toBe(true);
  });

  it("handles a run removed from the middle", async () => {
    const left = noisy(4096, 6);
    const right = Uint8Array.from([...left.subarray(0, 1000), ...left.subarray(1400)]);
    await check(left, right);
  });

  it("rebuilds the right document for forty random mutations", async () => {
    const random = makeNoise(0xa11c);
    for (let round = 0; round < 40; round++) {
      const left = noisy(1500 + Math.floor(random() * 1500), round);
      const right = [...left];
      const edits = 1 + Math.floor(random() * 4);
      for (let edit = 0; edit < edits; edit++) {
        const at = Math.floor(random() * right.length);
        const what = random();
        if (what < 0.34) right.splice(at, 0, ...noisy(1 + Math.floor(random() * 50), round * 31 + edit));
        else if (what < 0.67) right.splice(at, Math.floor(random() * 50));
        else for (let byte = 0; byte < 10 && at + byte < right.length; byte++) right[at + byte] = Math.floor(random() * 256);
      }
      await check(left, Uint8Array.from(right));
    }
  });

  /**
   * A document of one repeated byte puts every block in one hash bucket, which
   * is the shape that goes quadratic if the candidates are not capped.
   *
   * Counted, not timed. This assertion used to be a clock, and it failed on a CI
   * runner at 4,051ms against a 4,000ms bound — measuring the machine rather than
   * the code, and measuring the test's own verifier at that.
   *
   * Converting the assertion left one clock behind: vitest's own 5s default, which
   * this then failed at 5,067ms on the same kind of runner. The work here is
   * genuinely seconds — 200 KiB indexed in 64-byte blocks, then rebuilt by the
   * verifier — so the timeout is raised out of the way rather than the work cut
   * down. The read ceiling is the gate; the clock must not be a second one.
   */
  it("stays bounded on a document with no variety at all", async () => {
    const size = 200 * 1024;
    const left = new Uint8Array(size);
    const right = new Uint8Array(size);
    right[size / 2] = 1;

    // The indexing pass reads every block once — 3,200 of them — and the anchors
    // account for a few hundred more. Ten times that is generous and still far
    // below every block against every offset.
    const ceiling = 40_000;
    let reads = 0;
    const counted = new MemoryByteSource(left);
    const peek = counted.peek.bind(counted);
    counted.peek = (offset, length, out) => {
      if (++reads > ceiling) throw new Error(`gone quadratic: over ${ceiling} reads of the left document`);
      return peek(offset, length, out);
    };

    const differences = await compareAnchored(counted, new MemoryByteSource(right), { blockSize: 64 });
    expect(rebuild(left, right, differences)).toEqual(right);
  }, slowGate);

  /**
   * The case the candidate cap exists for, and the only shape that provokes it:
   * every left block lands in one hash bucket and nothing in it ever matches, so
   * no anchor is taken and the floor that would otherwise skip candidates never
   * rises. Three 64-byte blocks collide by construction — ones at (0,5), (1,4)
   * and (2,3), whose position-weighted sums are all 123 — so the left is built
   * from two of them and the right from the third.
   *
   * Counted rather than timed, and made to fail the moment it goes over. Without
   * the cap this is every block against every offset, which does not merely take
   * longer — it takes long enough to hold the runner rather than fail it, and a
   * test that hangs is worse than one that is slow.
   */
  it("stays bounded when every block collides and none of them match", async () => {
    const block = (first: number, second: number) => {
      const bytes = new Uint8Array(64);
      bytes[first] = 1;
      bytes[second] = 1;
      return bytes;
    };
    const [a, b, c] = [block(0, 5), block(1, 4), block(2, 3)];
    expect(weakHash(a, 0, 64)).toBe(weakHash(b, 0, 64));
    expect(weakHash(a, 0, 64)).toBe(weakHash(c, 0, 64));

    const blocks = 1600;
    const left = new Uint8Array(blocks * 64);
    for (let at = 0; at < blocks; at++) left.set(at % 2 === 0 ? a : b, at * 64);
    const right = new Uint8Array(blocks * 64);
    for (let at = 0; at < blocks; at++) right.set(c, at * 64);

    // Four candidates at each of 1,600 aligned stops, plus the indexing pass:
    // about eight thousand. Uncapped it is 1,600 by 1,600.
    const ceiling = 100_000;
    let reads = 0;
    const counted = new MemoryByteSource(left);
    const peek = counted.peek.bind(counted);
    counted.peek = (offset, length, out) => {
      if (++reads > ceiling) throw new Error(`gone quadratic: over ${ceiling} reads of the left document`);
      return peek(offset, length, out);
    };

    const differences = await compareAnchored(counted, new MemoryByteSource(right), { blockSize: 64 });
    expect(rebuild(left, right, differences)).toEqual(right);
  }, slowGate);

  it("reports one replacement for a gap too large to hand to Myers", async () => {
    const left = noisy(4096, 7);
    const right = noisy(4096, 8);
    const differences = await compareAnchored(
      new MemoryByteSource(left), new MemoryByteSource(right),
      { blockSize: 64, maxGap: 128 },
    );
    expect(differences).toHaveLength(1);
    expect(differences[0]!.kind).toBe("replace");
    expect(rebuild(left, right, differences)).toEqual(right);
  });

  it("reads a paged source rather than assuming it is resident", async () => {
    const bytes = noisy(4096, 9);
    const shifted = Uint8Array.from([0x11, ...bytes]);
    const paged = (data: Uint8Array) => new PagedByteSource({
      length: data.length,
      pageSize: 128,
      fetch: async (offset, length) => data.subarray(offset, offset + length),
    });
    const differences = await compareAnchored(paged(bytes), paged(shifted), { blockSize: 64 });
    expect(differences).toEqual([
      { left: { start: 0, end: 0 }, right: { start: 0, end: 1 }, kind: "insert" },
    ]);
  });

  it("gives up when the signal fires", async () => {
    const aborter = new AbortController();
    aborter.abort();
    await expect(compareAnchored(
      new MemoryByteSource(noisy(1024, 10)),
      new MemoryByteSource(noisy(1024, 11)),
      { signal: aborter.signal },
    )).rejects.toThrow(/aborted/i);
  });
});

describe("createAnchoredDiffProvider", () => {
  it("answers the DiffProvider contract", async () => {
    const left = noisy(2048, 12);
    const right = Uint8Array.from([0x77, ...left]);
    const provider = createAnchoredDiffProvider({ blockSize: 64 });
    const differences = await provider.compare(new MemoryByteSource(left), new MemoryByteSource(right), { limit: 100 });
    expect(differences).toEqual([
      { left: { start: 0, end: 0 }, right: { start: 0, end: 1 }, kind: "insert" },
    ]);
  });
});
