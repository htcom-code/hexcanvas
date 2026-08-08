import { throwIfAborted, type ByteSource } from "./byte-source.js";
import { diffDeleteKind, diffInsertKind, diffReplaceKind } from "./decorations.js";
import type { ByteSelection } from "./model.js";

/**
 * What one entry of a comparison is. `replace` is the same offsets holding
 * different bytes; `insert` is bytes only the right document has; `delete` is
 * bytes only the left one has.
 */
export type DiffKind = "replace" | "insert" | "delete";

/**
 * One difference, as a pair of ranges rather than as bytes.
 *
 * Deliberately not a `Change`: that carries the inserted bytes, which for a
 * comparison of two 100 MB files would mean materialising most of one of them.
 * A difference names where to look in each document and nothing else — the
 * bytes are still in the sources, and either side can be read from there.
 *
 * The side a difference is absent from is an empty range at the point it would
 * have been, so `start` is always meaningful: an insertion at offset 40 of the
 * left document is `left: { start: 40, end: 40 }`.
 */
export interface HexDifference {
  left: ByteSelection;
  right: ByteSelection;
  kind: DiffKind;
}

/** The decoration kind each difference is painted as. */
export const diffKinds: Readonly<Record<DiffKind, string>> = {
  replace: diffReplaceKind,
  insert: diffInsertKind,
  delete: diffDeleteKind,
};

/**
 * How many differences are collected at once, and the reason there is a cap at
 * all: two unrelated files of any size differ in nearly every run, and a list
 * of those is neither drawable nor useful. Ten times the search's cap, because
 * a comparison is denser than a query — but a cap all the same, reported rather
 * than hidden.
 */
export const diffLimit = 10_000;

/**
 * The window a comparison reads at a time. The same size the search uses, for
 * the same reason: large enough that a paged source fetches several pages per
 * `ensure`, small enough that a few windows in flight stay inside a modest
 * residency budget — and here there are two sources in flight, not one.
 */
const defaultChunkSize = 256 * 1024;

/** Windows requested ahead of the one being compared, per source. */
const defaultReadAhead = 3;

/** Shared by every provider: the cap, the read window, and the signal that stops it. */
export interface DiffOptions {
  /** Stop after this many differences. Defaults to `diffLimit`. */
  limit?: number;
  signal?: AbortSignal;
  chunkSize?: number;
  readAhead?: number;
}

/**
 * Where differences come from. The library's own provider compares byte for
 * byte at equal offsets, but a host can answer with anything — an edit script,
 * a format-aware comparison that ignores a timestamp field, a server that
 * already diffed the two.
 *
 * The result is an array rather than a stream so it matches `SearchProvider`,
 * whose `findAll` a host has already had to write against. Truncation is read
 * from the length against `limit`, exactly as a search reads it.
 */
export interface DiffProvider {
  compare(
    left: ByteSource,
    right: ByteSource,
    options: { limit: number; signal?: AbortSignal },
  ): Promise<HexDifference[]>;
}

/**
 * The library's own provider, over `compareAligned`. The coordinator goes
 * through this rather than calling the function directly, so the internal path
 * and a host's are the same path.
 */
export function createAlignedDiffProvider(options: Omit<DiffOptions, "limit" | "signal"> = {}): DiffProvider {
  return {
    compare: (left, right, request) => compareAligned(left, right, { ...options, ...request }),
  };
}

/**
 * Compares the two documents offset for offset, streaming both in step.
 *
 * This is the comparison that works at any size: cost is one pass over the
 * shorter document and memory is two windows, so a pair of 100 MB files is the
 * same shape of work as a pair of 100 KB ones. What it cannot do is recognise a
 * shift — insert one byte at the front of a file and every offset after it
 * differs, which this reports as one very long run. Recognising that is an edit
 * script, which is a different algorithm with a different cost.
 *
 * Differing bytes are collected as **runs**, not one entry per byte. A byte is
 * not a unit anybody reads a difference in, and a megabyte of differing bytes
 * would otherwise be a million entries against a cap of ten thousand.
 */
export async function compareAligned(
  left: ByteSource,
  right: ByteSource,
  options: DiffOptions = {},
): Promise<HexDifference[]> {
  const limit = options.limit ?? diffLimit;
  const chunkSize = Math.max(1, options.chunkSize ?? defaultChunkSize);
  const readAhead = Math.max(0, options.readAhead ?? defaultReadAhead);
  const shared = Math.min(left.length, right.length);
  const differences: HexDifference[] = [];
  if (limit <= 0) return differences;

  const leftReader = new AheadReader(left, chunkSize, readAhead, options.signal);
  const rightReader = new AheadReader(right, chunkSize, readAhead, options.signal);
  /** Where the run being accumulated began, or undefined between runs. */
  let runStart: number | undefined;

  for (let at = 0; at < shared; at += chunkSize) {
    throwIfAborted(options.signal, "The comparison was aborted.");
    const take = Math.min(chunkSize, shared - at);
    // Both reads issued before either is awaited, so the two sources fetch
    // concurrently. Awaiting one and then starting the other would halve the
    // throughput of a comparison of two slow-backed documents.
    const [before, after] = await Promise.all([leftReader.read(at, take), rightReader.read(at, take)]);
    for (let index = 0; index < take; index++) {
      if (before[index] !== after[index]) {
        runStart ??= at + index;
        continue;
      }
      if (runStart === undefined) continue;
      differences.push(replacement(runStart, at + index));
      runStart = undefined;
      // Returned from inside the loop rather than checked at the top: the run
      // that is still open would otherwise be emitted past the cap.
      if (differences.length >= limit) return differences;
    }
  }

  if (runStart !== undefined) {
    differences.push(replacement(runStart, shared));
    if (differences.length >= limit) return differences;
  }

  // Whatever hangs off the end of the longer document. One entry, because the
  // tail is one contiguous thing: aligned comparison has no basis for splitting
  // it, and calling it a difference per byte would be noise.
  if (left.length > shared) {
    differences.push({ left: { start: shared, end: left.length }, right: { start: shared, end: shared }, kind: "delete" });
  } else if (right.length > shared) {
    differences.push({ left: { start: shared, end: shared }, right: { start: shared, end: right.length }, kind: "insert" });
  }
  return differences;
}

const replacement = (start: number, end: number): HexDifference => ({
  left: { start, end },
  right: { start, end },
  kind: "replace",
});

/**
 * A forward window reader with the next few windows already requested.
 *
 * Deliberately not `search.ts`'s `Reader`, which overlaps its windows by the
 * query length and can walk backwards — neither of which a comparison has any
 * use for. What is shared is the finding behind both: reading is thousands of
 * times slower than comparing, so the point is to have the next reads already
 * in flight rather than to start one and wait.
 *
 * The difference that matters here is the miss handling. A search that cannot
 * read a window reports no match, which is merely wrong; a comparison that
 * cannot read a window would report the bytes as *equal*, which is wrong in the
 * direction nobody checks. So a read that cannot be satisfied throws.
 */
class AheadReader {
  private readonly requested = new Map<number, Promise<void>>();
  /**
   * One buffer for the whole scan. A source that has to assemble bytes — a
   * paged reader, or a piece table over one — otherwise allocates and copies a
   * fresh window per read.
   */
  private readonly buffer: Uint8Array;

  constructor(
    private readonly source: ByteSource,
    private readonly window: number,
    private readonly readAhead: number,
    /** Handed to every read, so giving up stops the fetches and not just the wait. */
    private readonly signal: AbortSignal | undefined,
  ) {
    this.buffer = new Uint8Array(window);
  }

  async read(start: number, length: number): Promise<Uint8Array> {
    this.request(start, length);
    for (let index = 1; index <= this.readAhead; index++) {
      const at = start + index * this.window;
      this.request(at, Math.min(this.window, this.source.length - at));
    }
    const resident = this.source.peek(start, length, this.buffer);
    if (resident) {
      this.requested.delete(start);
      return resident;
    }
    await this.requested.get(start);
    this.requested.delete(start);
    const arrived = this.source.peek(start, length, this.buffer);
    if (arrived) return arrived;
    // Evicted between the fetch and the read, which a source under its own
    // residency budget is entitled to do. Ask once more before giving up.
    await this.source.ensure(start, length, this.signal);
    const retried = this.source.peek(start, length, this.buffer);
    if (retried) return retried;
    throw new Error(`Bytes [${start}, ${start + length}) could not be read for comparison.`);
  }

  private request(at: number, length: number): void {
    if (at < 0 || length <= 0 || at >= this.source.length || this.requested.has(at)) return;
    // The rejection is handled where the window is awaited. Attached here as
    // well, because a read-ahead window nobody reaches — the scan ended, or was
    // cancelled — would otherwise reject with no one listening.
    const request = this.source.ensure(at, length, this.signal);
    this.requested.set(at, request.catch(() => undefined));
  }
}
