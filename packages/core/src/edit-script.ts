import { throwIfAborted, type ByteSource } from "./byte-source.js";
import { compareAnchored } from "./anchored-diff.js";
import { diffLimit, type DiffProvider, type HexDifference, type DiffOptions } from "./diff.js";

/**
 * The comparison that can see a shift.
 *
 * Aligned comparison reads offset against offset, so a byte inserted at the
 * front makes every offset after it differ — one insertion reported as a very
 * long run, or as hundreds of short ones where the bytes happen to line up
 * again. An edit script says what a person would: one insertion.
 *
 * What it costs is why the aligned one exists. Myers is O(ND) in the length of
 * the documents and the distance between them, and it walks diagonals, which is
 * random access to both. So this reads them into memory and refuses pairs it
 * cannot hold — `PagedByteSource` keeps 64 pages under eviction and a diagonal
 * walk would thrash it. Anchoring the large case is the other half, and is not
 * in this yet; past the bounds below it falls back to the aligned answer, which
 * is coarser and correct rather than absent.
 */

/**
 * Most bytes to hold in memory, per document. Two of these plus the trace is
 * what the comparison costs, and 8 MiB a side is the size at which reading the
 * whole thing is still obviously cheaper than the alternative.
 */
const defaultMaxBytes = 8 * 1024 * 1024;

/**
 * Most edits to describe. The trace Myers keeps to reconstruct the script is
 * about `(D + 1)²` entries, so this is a memory bound as much as a time one:
 * 1,024 is roughly 4 MB, and two documents a thousand edits apart are already
 * past the point where a list of them reads as an explanation.
 */
const defaultMaxDistance = 1024;

/**
 * Where the exact script gives up: `maxBytes` a side, and `maxDistance` edits. Past
 * either it hands back rather than reporting something it cannot support.
 */
export interface EditScriptOptions extends DiffOptions {
  /** Per document. Beyond it, the aligned comparison answers instead. */
  maxBytes?: number;
  /** Most edits to describe before giving up on describing them. */
  maxDistance?: number;
}

/**
 * One step of the script, in both documents' coordinates. `equal` runs are kept
 * rather than dropped because the conversion to differences needs to know where
 * a change stops, not only where it starts.
 */
interface Step {
  kind: "equal" | "delete" | "insert";
  left: number;
  right: number;
  length: number;
}

/**
 * The edit script between two documents, or the aligned comparison where one is
 * too large to hold or too different to describe.
 */
export async function compareEditScript(
  left: ByteSource,
  right: ByteSource,
  options: EditScriptOptions = {},
): Promise<HexDifference[]> {
  const limit = options.limit ?? diffLimit;
  const maxBytes = options.maxBytes ?? defaultMaxBytes;
  const maxDistance = options.maxDistance ?? defaultMaxDistance;
  throwIfAborted(options.signal, "The comparison was aborted.");
  // Too large to hold both. Anchoring finds the places they still agree without
  // reading either whole, and asks Myers only about the stretches between —
  // which is a better answer than the aligned scan this used to fall back to,
  // because it can still see a shift.
  if (left.length > maxBytes || right.length > maxBytes) {
    return compareAnchored(left, right, {
      limit: options.limit,
      signal: options.signal,
      maxDistance: options.maxDistance,
    });
  }

  const [before, after] = await Promise.all([
    readWhole(left, options.signal),
    readWhole(right, options.signal),
  ]);
  throwIfAborted(options.signal, "The comparison was aborted.");

  return scriptFor(before, after, { limit, maxDistance, signal: options.signal });
}

/** Where a pair of ranges sits in the documents they were taken from. */
export interface ScriptPlacement {
  limit?: number;
  maxDistance?: number;
  signal?: AbortSignal;
  /** Added to every offset, for a script over a slice of a larger document. */
  leftOffset?: number;
  rightOffset?: number;
}

/**
 * The script between two ranges already in memory.
 *
 * Separate from reading them because anchoring calls it per gap: the whole
 * documents never fit, but the stretch between two places they agree does.
 */
export function scriptFor(before: Uint8Array, after: Uint8Array, options: ScriptPlacement = {}): HexDifference[] {
  const limit = options.limit ?? diffLimit;
  const maxDistance = options.maxDistance ?? defaultMaxDistance;
  const leftOffset = options.leftOffset ?? 0;
  const rightOffset = options.rightOffset ?? 0;

  // What the two already agree on at each end.
  //
  // Not a shortcut to the answer — the edit distance is the same either way, and
  // Myers' first snake would find the common prefix on its own. What it takes
  // down is the *length* every later snake has to walk: without it, each new
  // diagonal re-walks from the change to the end of the file. Measured on a
  // 1 MiB pair one byte apart, 3.60ms to 1.30ms.
  const head = commonPrefix(before, after);
  const tail = commonSuffix(before, after, head);
  const leftMiddle = before.subarray(head, before.length - tail);
  const rightMiddle = after.subarray(head, after.length - tail);
  if (leftMiddle.length === 0 && rightMiddle.length === 0) return [];

  const steps = myers(leftMiddle, rightMiddle, maxDistance, options.signal);
  if (!steps) {
    // Too far apart to describe as edits. One replacement of the middle is the
    // honest answer: it says where they stop agreeing and nothing it cannot
    // support. Said this way rather than by falling back to the aligned scan,
    // which would disagree with the prefix and suffix already established.
    return [{
      left: { start: leftOffset + head, end: leftOffset + before.length - tail },
      right: { start: rightOffset + head, end: rightOffset + after.length - tail },
      kind: "replace",
    }];
  }
  return toDifferences(steps, leftOffset + head, rightOffset + head, limit);
}

/** The provider form, for `HexCompare`. */
export function createEditScriptDiffProvider(options: Omit<EditScriptOptions, "limit" | "signal"> = {}): DiffProvider {
  return {
    compare: (left, right, request) => compareEditScript(left, right, { ...options, ...request }),
  };
}

/**
 * A whole document, resident. Read in one call rather than per page: the caller
 * has already decided it fits, and asking once lets a paged source fetch the
 * pages together.
 */
export async function readWhole(source: ByteSource, signal: AbortSignal | undefined): Promise<Uint8Array> {
  if (source.length === 0) return new Uint8Array(0);
  const buffer = new Uint8Array(source.length);
  const resident = source.peek(0, source.length, buffer);
  if (resident) return resident;
  await source.ensure(0, source.length, signal);
  return source.peek(0, source.length, buffer) ?? new Uint8Array(source.length);
}

function commonPrefix(left: Uint8Array, right: Uint8Array): number {
  const limit = Math.min(left.length, right.length);
  let at = 0;
  while (at < limit && left[at] === right[at]) at++;
  return at;
}

/** Counted back from the end, and never overlapping the prefix already taken. */
function commonSuffix(left: Uint8Array, right: Uint8Array, prefix: number): number {
  const limit = Math.min(left.length, right.length) - prefix;
  let at = 0;
  while (at < limit && left[left.length - 1 - at] === right[right.length - 1 - at]) at++;
  return at;
}

/**
 * Myers' greedy algorithm, with the trace kept so the script can be walked back
 * out of it.
 *
 * Returns undefined past `maxDistance` rather than searching on. The trace is
 * about `(D + 1)²` numbers, so an uncapped search over two unrelated documents
 * would be the memory blow-up before it was the slow one — and a script of a
 * hundred thousand edits is not a description of anything.
 */
function myers(left: Uint8Array, right: Uint8Array, maxDistance: number, signal: AbortSignal | undefined): Step[] | undefined {
  const n = left.length;
  const m = right.length;
  const max = Math.min(maxDistance, n + m);
  // Indexed by diagonal k, offset so -max lands at 0.
  const v = new Int32Array(2 * max + 2);
  /** One slice per distance, holding only the diagonals that distance reaches. */
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max; d++) {
    // Checked per distance rather than per diagonal: the inner loop is a few
    // array reads and a byte comparison, and testing a signal in it would cost
    // more than the work it guards.
    throwIfAborted(signal, "The comparison was aborted.");
    for (let k = -d; k <= d; k += 2) {
      const at = k + max;
      // Down is an insertion from the right document, right is a deletion from
      // the left. Take whichever reaches further, and the edges have no choice.
      const down = k === -d || (k !== d && v[at - 1]! < v[at + 1]!);
      let x = down ? v[at + 1]! : v[at - 1]! + 1;
      let y = x - k;
      // The free part: everything the two agree on from here costs nothing.
      while (x < n && y < m && left[x] === right[y]) { x++; y++; }
      v[at] = x;
      if (x >= n && y >= m) {
        trace.push(v.slice(max - d, max + d + 1));
        return backtrack(trace, left, right, max, d);
      }
    }
    trace.push(v.slice(max - d, max + d + 1));
  }
  return undefined;
}

/**
 * Walks the trace back from the end, turning each distance into the one move
 * that reached it. Produced back to front and reversed, because the trace only
 * says where each distance got to, not how.
 */
function backtrack(trace: readonly Int32Array[], left: Uint8Array, right: Uint8Array, max: number, distance: number): Step[] {
  const steps: Step[] = [];
  let x = left.length;
  let y = right.length;
  for (let d = distance; d > 0; d--) {
    const row = trace[d]!;
    const previous = trace[d - 1]!;
    const k = x - y;
    // The same choice the forward pass made, read out of the previous distance.
    const atPrevious = (diagonal: number) => previous[diagonal + d - 1];
    const down = k === -d || (k !== d && (atPrevious(k - 1) ?? -1) < (atPrevious(k + 1) ?? -1));
    const previousK = down ? k + 1 : k - 1;
    const previousX = atPrevious(previousK)!;
    const previousY = previousX - previousK;
    // Everything after the move on this diagonal was free.
    const free = x - (down ? previousX : previousX + 1);
    if (free > 0) steps.push({ kind: "equal", left: x - free, right: y - free, length: free });
    if (down) steps.push({ kind: "insert", left: previousX, right: previousY, length: 1 });
    else steps.push({ kind: "delete", left: previousX, right: previousY, length: 1 });
    x = previousX;
    y = previousY;
    void row;
  }
  if (x > 0) steps.push({ kind: "equal", left: 0, right: 0, length: x });
  return steps.reverse();
}

/**
 * The script as differences: one entry per change rather than one per byte.
 *
 * A byte swapped for another is a deletion and an insertion at the same place,
 * and reporting those separately would turn "three bytes changed" into six
 * entries that a reader has to pair up again. Adjacent ones become a single
 * `replace`, and runs of one kind become a single `insert` or `delete`.
 */
function toDifferences(steps: readonly Step[], leftOffset: number, rightOffset: number, limit: number): HexDifference[] {
  const differences: HexDifference[] = [];
  let index = 0;
  while (index < steps.length && differences.length < limit) {
    const step = steps[index]!;
    if (step.kind === "equal") {
      index++;
      continue;
    }
    // Everything up to the next agreement is one change, whatever mix of
    // deletions and insertions it was made of.
    const leftStart = step.left;
    const rightStart = step.right;
    let deleted = 0;
    let inserted = 0;
    while (index < steps.length && steps[index]!.kind !== "equal") {
      const run = steps[index]!;
      if (run.kind === "delete") deleted += run.length;
      else inserted += run.length;
      index++;
    }
    differences.push({
      left: { start: leftOffset + leftStart, end: leftOffset + leftStart + deleted },
      right: { start: rightOffset + rightStart, end: rightOffset + rightStart + inserted },
      kind: deleted === 0 ? "insert" : inserted === 0 ? "delete" : "replace",
    });
  }
  return differences;
}
