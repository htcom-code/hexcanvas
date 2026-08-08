import { describe, expect, it } from "vitest";
import { isAbortError, MemoryByteSource, PagedByteSource } from "../src/byte-source";
import { compareAligned, createAlignedDiffProvider, diffLimit } from "../src/diff";

const source = (...values: number[]) => new MemoryByteSource(Uint8Array.of(...values));

const filled = (length: number, at: (index: number) => number) =>
  new MemoryByteSource(Uint8Array.from({ length }, (_, index) => at(index)));

/** The shape a test asserts on, without repeating `{ start, end }` six times. */
const shape = (differences: Awaited<ReturnType<typeof compareAligned>>) =>
  differences.map((difference) => [difference.kind, difference.left.start, difference.left.end, difference.right.start, difference.right.end]);

describe("compareAligned", () => {
  it("reports nothing for two identical documents", async () => {
    expect(await compareAligned(source(1, 2, 3), source(1, 2, 3))).toEqual([]);
  });

  it("reports nothing for two empty documents", async () => {
    expect(await compareAligned(source(), source())).toEqual([]);
  });

  it("collects consecutive differing bytes as one run, not one entry each", async () => {
    const differences = await compareAligned(source(1, 2, 3, 4, 5), source(1, 9, 9, 9, 5));
    expect(shape(differences)).toEqual([["replace", 1, 4, 1, 4]]);
  });

  it("separates runs that are broken by a matching byte", async () => {
    const differences = await compareAligned(source(1, 2, 3, 4, 5), source(9, 2, 9, 4, 9));
    expect(shape(differences)).toEqual([
      ["replace", 0, 1, 0, 1],
      ["replace", 2, 3, 2, 3],
      ["replace", 4, 5, 4, 5],
    ]);
  });

  it("closes a run that reaches the end of the shorter document", async () => {
    const differences = await compareAligned(source(1, 2, 3), source(1, 9, 9));
    expect(shape(differences)).toEqual([["replace", 1, 3, 1, 3]]);
  });

  it("reports a longer right document as one insertion at the end", async () => {
    const differences = await compareAligned(source(1, 2), source(1, 2, 3, 4));
    expect(shape(differences)).toEqual([["insert", 2, 2, 2, 4]]);
  });

  it("reports a longer left document as one deletion at the end", async () => {
    const differences = await compareAligned(source(1, 2, 3, 4), source(1, 2));
    expect(shape(differences)).toEqual([["delete", 2, 4, 2, 2]]);
  });

  it("reports a trailing run and the length difference separately", async () => {
    const differences = await compareAligned(source(1, 9, 9), source(1, 2, 2, 7, 7));
    expect(shape(differences)).toEqual([
      ["replace", 1, 3, 1, 3],
      ["insert", 3, 3, 3, 5],
    ]);
  });

  it("treats an empty document against a full one as one insertion", async () => {
    expect(shape(await compareAligned(source(), source(1, 2)))).toEqual([["insert", 0, 0, 0, 2]]);
  });

  // The bug this rules out is silent: a run split across two reads reported as
  // two adjacent differences reads almost right, and hides that they are one.
  it("carries a run across a chunk boundary", async () => {
    const left = filled(300, () => 0);
    const right = filled(300, (index) => (index >= 120 && index < 140 ? 1 : 0));
    const differences = await compareAligned(left, right, { chunkSize: 128 });
    expect(shape(differences)).toEqual([["replace", 120, 140, 120, 140]]);
  });

  it("stops at the limit and leaves no partial run behind", async () => {
    // Alternating bytes, so every other offset opens and closes a run.
    const left = filled(100, () => 0);
    const right = filled(100, (index) => index % 2);
    const differences = await compareAligned(left, right, { limit: 3 });
    expect(shape(differences)).toEqual([
      ["replace", 1, 2, 1, 2],
      ["replace", 3, 4, 3, 4],
      ["replace", 5, 6, 5, 6],
    ]);
  });

  it("does not append the tail once the limit is reached", async () => {
    const left = filled(10, (index) => index);
    const right = filled(20, () => 0xff);
    expect(await compareAligned(left, right, { limit: 1 })).toHaveLength(1);
  });

  it("answers nothing for a limit of zero rather than scanning", async () => {
    expect(await compareAligned(source(1), source(2), { limit: 0 })).toEqual([]);
  });

  it("reads a paged source, which never has the bytes on the first ask", async () => {
    const bytes = Uint8Array.from({ length: 1024 }, (_, index) => index & 0xff);
    const changed = bytes.slice();
    changed[500] = 0;
    const paged = (data: Uint8Array) => new PagedByteSource({
      length: data.length,
      pageSize: 64,
      fetch: async (offset, length) => data.subarray(offset, offset + length),
    });
    const differences = await compareAligned(paged(bytes), paged(changed), { chunkSize: 128 });
    expect(shape(differences)).toEqual([["replace", 500, 501, 500, 501]]);
  });

  it("throws rather than reporting the bytes as equal when a read cannot be satisfied", async () => {
    const broken = new PagedByteSource({
      length: 64,
      pageSize: 64,
      fetch: () => Promise.reject(new Error("no")),
    });
    await expect(compareAligned(broken, filled(64, () => 0))).rejects.toThrow();
  });

  it("aborts before reading when the signal is already set", async () => {
    const aborter = new AbortController();
    aborter.abort();
    const failure = await compareAligned(source(1), source(2), { signal: aborter.signal }).catch((error: unknown) => error);
    expect(isAbortError(failure)).toBe(true);
  });

  it("stops part-way when the signal fires during the scan", async () => {
    const aborter = new AbortController();
    const left = filled(4096, () => 0);
    const right = new PagedByteSource({
      length: 4096,
      pageSize: 256,
      // Aborted once the first window has been served, so the second one is
      // where the check has to bite.
      fetch: async (offset, length) => {
        if (offset > 0) aborter.abort();
        return new Uint8Array(length);
      },
    });
    const failure = await compareAligned(left, right, { chunkSize: 256, readAhead: 0, signal: aborter.signal })
      .catch((error: unknown) => error);
    expect(isAbortError(failure)).toBe(true);
  });
});

describe("createAlignedDiffProvider", () => {
  it("passes the caller's limit through to the scan", async () => {
    const provider = createAlignedDiffProvider();
    const left = filled(100, () => 0);
    const right = filled(100, (index) => index % 2);
    expect(await provider.compare(left, right, { limit: 2 })).toHaveLength(2);
  });

  it("keeps the window size it was built with", async () => {
    const provider = createAlignedDiffProvider({ chunkSize: 4 });
    const left = filled(64, () => 0);
    const right = filled(64, (index) => (index >= 6 && index < 12 ? 1 : 0));
    const differences = await provider.compare(left, right, { limit: diffLimit });
    expect(shape(differences)).toEqual([["replace", 6, 12, 6, 12]]);
  });
});
