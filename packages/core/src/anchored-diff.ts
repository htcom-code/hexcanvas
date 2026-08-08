import { throwIfAborted, type ByteSource } from "./byte-source.js";
import { diffLimit, type DiffProvider, type HexDifference } from "./diff.js";
import { scriptFor } from "./edit-script.js";

/**
 * An edit script for a pair too large to hold.
 *
 * Myers walks diagonals over both documents at once, so it needs them both in
 * memory; past a few megabytes that is not a thing to ask for. What is possible
 * is finding the places the two still agree — anchors — and asking Myers only
 * about the stretches between them, which on a document and its next build are
 * small even when the document is not.
 *
 * The anchors are found the way rsync finds them: hash the left document in
 * fixed blocks, then roll a window over the right one looking for those hashes.
 * A rolling hash makes that one pass rather than one comparison per offset per
 * block.
 *
 * **Every anchor is verified byte for byte.** A hash says two blocks are
 * probably the same, and an anchor is a claim that they *are* — everything
 * inside one is reported as unchanged without being looked at again. A collision
 * would be a claim that bytes match when they do not, which is the kind of wrong
 * that no one notices. Verifying costs a read of each anchored block, which is a
 * sequential pass over the left document: the same order of work the aligned
 * comparison already does, and worth it for an answer that is true.
 */

/**
 * The unit an anchor is found in. Small enough that a change between two of
 * them leaves a short gap for Myers, large enough that the index over a 100 MB
 * document is tens of thousands of entries rather than millions.
 */
const defaultBlockSize = 2048;

/**
 * Most left blocks kept under one weak hash. A document of one repeated byte
 * hashes every block the same, and without a cap the verification would be
 * every block against every offset.
 */
const maxCandidates = 4;

/** Largest gap handed to Myers. Past it the gap is reported as one replacement. */
const defaultMaxGap = 1 << 20;

/**
 * Anchoring for a pair too large to hold. `blockSize` is what the rolling hash
 * matches on; every anchor it proposes is verified byte for byte regardless.
 */
export interface AnchoredOptions {
  limit?: number;
  signal?: AbortSignal;
  blockSize?: number;
  maxGap?: number;
  maxDistance?: number;
}

/** A stretch the two documents agree on, verified. */
interface Anchor {
  left: number;
  right: number;
  length: number;
}

/**
 * Compares a pair too large for an edit script by finding the blocks the two still
 * share, the way rsync does, and asking Myers only about the stretches between them.
 */
export async function compareAnchored(
  left: ByteSource,
  right: ByteSource,
  options: AnchoredOptions = {},
): Promise<HexDifference[]> {
  const limit = options.limit ?? diffLimit;
  const blockSize = Math.max(64, options.blockSize ?? defaultBlockSize);
  const maxGap = options.maxGap ?? defaultMaxGap;
  const signal = options.signal;

  const index = await indexBlocks(left, blockSize, signal);
  const anchors = await findAnchors(left, right, index, blockSize, signal);

  const differences: HexDifference[] = [];
  let leftAt = 0;
  let rightAt = 0;
  for (const anchor of anchors) {
    if (differences.length >= limit) return differences;
    await describeGap(left, right, leftAt, anchor.left, rightAt, anchor.right, maxGap, options, differences, limit);
    leftAt = anchor.left + anchor.length;
    rightAt = anchor.right + anchor.length;
  }
  if (differences.length < limit) {
    await describeGap(left, right, leftAt, left.length, rightAt, right.length, maxGap, options, differences, limit);
  }
  return differences.slice(0, limit);
}

/** Anchored comparison as a provider, for handing to `HexCompare`. */
export function createAnchoredDiffProvider(options: Omit<AnchoredOptions, "limit" | "signal"> = {}): DiffProvider {
  return {
    compare: (left, right, request) => compareAnchored(left, right, { ...options, ...request }),
  };
}

/**
 * Weak hash to the left blocks carrying it.
 *
 * Weak on purpose: it has to roll, and the strong check is the byte comparison
 * that follows. What it has to be is cheap and spread out enough that a hit is
 * usually real.
 */
type BlockIndex = Map<number, number[]>;

async function indexBlocks(source: ByteSource, blockSize: number, signal: AbortSignal | undefined): Promise<BlockIndex> {
  const index: BlockIndex = new Map();
  const buffer = new Uint8Array(blockSize);
  for (let offset = 0; offset + blockSize <= source.length; offset += blockSize) {
    throwIfAborted(signal, "The comparison was aborted.");
    const block = await readAt(source, offset, blockSize, buffer, signal);
    if (!block) continue;
    const key = weakHash(block, 0, blockSize);
    const found = index.get(key);
    if (found === undefined) index.set(key, [offset]);
    // Capped rather than unbounded: see `maxCandidates`.
    else if (found.length < maxCandidates) found.push(offset);
  }
  return index;
}

/**
 * Anchors in document order, never overlapping and never going backwards.
 *
 * Taken greedily as the roll finds them. A better set exists — the longest
 * increasing sequence of every candidate — but finding it costs more than the
 * Myers passes it would save, and the gaps between greedy anchors are already
 * small on the pair this is for.
 */
async function findAnchors(
  left: ByteSource,
  right: ByteSource,
  index: BlockIndex,
  blockSize: number,
  signal: AbortSignal | undefined,
): Promise<Anchor[]> {
  const anchors: Anchor[] = [];
  if (right.length < blockSize || index.size === 0) return anchors;

  /**
   * How far one read is rolled before the next. The buffer holds the window
   * plus the run, because rolling needs the byte arriving as well as the one
   * leaving — a buffer only as long as the window has nothing to roll into, and
   * the roll would stop on its first step.
   */
  const runSpan = blockSize * 32;
  const window = new Uint8Array(blockSize + runSpan);
  const leftBlock = new Uint8Array(blockSize);
  let leftFloor = 0;
  let at = 0;

  while (at + blockSize <= right.length) {
    throwIfAborted(signal, "The comparison was aborted.");
    const start = at;
    const take = Math.min(window.length, right.length - start);
    if (take < blockSize) break;
    const bytes = await readAt(right, start, take, window, signal);
    if (!bytes) break;
    let hash = weakHash(bytes, 0, blockSize);
    // The last offset whose whole window is inside what was read.
    const lastOffset = start + take - blockSize;
    let matched = false;

    for (let offset = start; offset <= lastOffset; offset++) {
      const candidates = index.get(hash);
      if (candidates) {
        for (const candidate of candidates) {
          if (candidate < leftFloor) continue;
          const block = await readAt(left, candidate, blockSize, leftBlock, signal);
          // The claim is that these bytes are the same, so it is checked.
          if (!block || !sameBytes(block, bytes, offset - start, blockSize)) continue;
          const anchor = await extend(left, right, candidate, offset, blockSize, leftFloor, signal);
          anchors.push(anchor);
          leftFloor = anchor.left + anchor.length;
          at = anchor.right + anchor.length;
          matched = true;
          break;
        }
      }
      if (matched) break;
      if (offset === lastOffset) break;
      hash = roll(hash, bytes[offset - start]!, bytes[offset - start + blockSize]!, blockSize);
    }
    // Nothing here; carry on from the first offset this read could not cover.
    if (!matched) at = lastOffset + 1;
  }
  return anchors;
}

/**
 * Grows an anchor over whatever else matches around it, so a change of one byte
 * in the middle of a block does not cost the whole block.
 */
async function extend(
  left: ByteSource,
  right: ByteSource,
  leftAt: number,
  rightAt: number,
  length: number,
  leftFloor: number,
  signal: AbortSignal | undefined,
): Promise<Anchor> {
  const step = 256;
  const scratchLeft = new Uint8Array(step);
  const scratchRight = new Uint8Array(step);
  let start = 0;
  // Backwards, but never past where the last anchor ended.
  while (leftAt - start > leftFloor && rightAt - start > 0) {
    const take = Math.min(step, leftAt - start - leftFloor, rightAt - start);
    const a = await readAt(left, leftAt - start - take, take, scratchLeft, signal);
    const b = await readAt(right, rightAt - start - take, take, scratchRight, signal);
    if (!a || !b) break;
    let same = 0;
    while (same < take && a[take - 1 - same] === b[take - 1 - same]) same++;
    start += same;
    if (same < take) break;
  }
  let end = length;
  while (leftAt + end < left.length && rightAt + end < right.length) {
    const take = Math.min(step, left.length - leftAt - end, right.length - rightAt - end);
    const a = await readAt(left, leftAt + end, take, scratchLeft, signal);
    const b = await readAt(right, rightAt + end, take, scratchRight, signal);
    if (!a || !b) break;
    let same = 0;
    while (same < take && a[same] === b[same]) same++;
    end += same;
    if (same < take) break;
  }
  return { left: leftAt - start, right: rightAt - start, length: end + start };
}

/**
 * What happened between two anchors. Small gaps get the exact script; one too
 * large to hold is reported as a single replacement, which says where the two
 * differ and claims nothing about how.
 */
async function describeGap(
  left: ByteSource,
  right: ByteSource,
  leftFrom: number,
  leftTo: number,
  rightFrom: number,
  rightTo: number,
  maxGap: number,
  options: AnchoredOptions,
  into: HexDifference[],
  limit: number,
): Promise<void> {
  const leftSize = leftTo - leftFrom;
  const rightSize = rightTo - rightFrom;
  if (leftSize <= 0 && rightSize <= 0) return;
  if (leftSize > maxGap || rightSize > maxGap) {
    into.push({
      left: { start: leftFrom, end: leftTo },
      right: { start: rightFrom, end: rightTo },
      kind: leftSize === 0 ? "insert" : rightSize === 0 ? "delete" : "replace",
    });
    return;
  }
  const [before, after] = await Promise.all([
    slice(left, leftFrom, leftSize, options.signal),
    slice(right, rightFrom, rightSize, options.signal),
  ]);
  for (const difference of scriptFor(before, after, {
    limit: limit - into.length,
    maxDistance: options.maxDistance,
    signal: options.signal,
    leftOffset: leftFrom,
    rightOffset: rightFrom,
  })) {
    into.push(difference);
  }
}

async function slice(source: ByteSource, offset: number, length: number, signal: AbortSignal | undefined): Promise<Uint8Array> {
  if (length <= 0) return new Uint8Array(0);
  const buffer = new Uint8Array(length);
  return (await readAt(source, offset, length, buffer, signal)) ?? new Uint8Array(length);
}

/** Resident bytes, fetching them first where they are not. */
async function readAt(
  source: ByteSource,
  offset: number,
  length: number,
  into: Uint8Array,
  signal: AbortSignal | undefined,
): Promise<Uint8Array | undefined> {
  if (offset < 0 || length <= 0 || offset + length > source.length) return undefined;
  const resident = source.peek(offset, length, into);
  if (resident) return resident;
  await source.ensure(offset, length, signal);
  return source.peek(offset, length, into);
}

function sameBytes(left: Uint8Array, right: Uint8Array, rightFrom: number, length: number): boolean {
  for (let at = 0; at < length; at++) {
    if (left[at] !== right[rightFrom + at]) return false;
  }
  return true;
}

/**
 * The rsync weak checksum: two running sums, one of the bytes and one weighted
 * by position, so a window that is a rearrangement of another does not collide.
 * Chosen because it rolls in constant time, which is the whole point.
 */
function weakHash(bytes: Uint8Array, from: number, length: number): number {
  let a = 0;
  let b = 0;
  for (let at = 0; at < length; at++) {
    a = (a + bytes[from + at]!) & 0xffff;
    b = (b + a) & 0xffff;
  }
  return ((b << 16) | a) >>> 0;
}

function roll(hash: number, leaving: number, arriving: number, length: number): number {
  const a = ((hash & 0xffff) - leaving + arriving) & 0xffff;
  const b = ((hash >>> 16) - length * leaving + a) & 0xffff;
  return ((b << 16) | a) >>> 0;
}

/** Exported for the test that pins the roll against recomputing it. */
export const rollingHashInternals = { weakHash, roll };
