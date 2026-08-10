/**
 * An interval index over columns of offsets, answering with **indices** and
 * costing one number per node — no objects at all.
 *
 * Two structures were measured before this one, and both were rejected by the same
 * data. A sorted array with a running maximum end degrades to a full pass when one
 * range covers the whole document, which is precisely the outer record of a parse.
 * A centred interval tree handles that, but a parse result is mostly *siblings that
 * do not overlap*, and then every node holds exactly one range: half a million
 * ranges became half a million nodes with two typed arrays each, about 120 MB of
 * pure structure.
 *
 * So: a segment tree over the sorted positions, holding the largest end in each
 * subtree, laid out in one `Float64Array`. A subtree whose largest end is at or
 * before the query is skipped whole, which is the pruning the running maximum
 * cannot do, and a range covering everything costs one path down rather than a
 * scan. Requires the columns to be sorted by start, which is what the store keeps.
 */
export class IntervalColumns {
  /** `maxEnd` of every subtree, as an implicit binary tree: children of i are 2i, 2i+1. */
  private readonly tree: Float64Array;
  private readonly leaves: number;

  constructor(
    private readonly starts: Float64Array,
    private readonly ends: Float64Array,
    private readonly count: number,
  ) {
    this.leaves = Math.max(1, nextPowerOfTwo(count));
    this.tree = new Float64Array(this.leaves * 2).fill(Number.NEGATIVE_INFINITY);
    for (let at = 0; at < count; at++) this.tree[this.leaves + at] = ends[at]!;
    for (let node = this.leaves - 1; node >= 1; node--) {
      this.tree[node] = Math.max(this.tree[node * 2]!, this.tree[node * 2 + 1]!);
    }
  }

  /** Indices of the ranges overlapping `[from, to)`, ascending. */
  overlapping(from: number, to: number, out: number[]): number[] {
    out.length = 0;
    if (to <= from || this.count === 0) return out;
    // Sorted by start, so everything that can overlap sits before here.
    const limit = this.firstStartAtOrAfter(to);
    if (limit > 0) this.collect(1, 0, this.leaves, from, limit, out);
    return out;
  }

  covering(offset: number, out: number[]): number[] {
    return this.overlapping(offset, offset + 1, out);
  }

  /** Walks only the subtrees that can still hold a range ending after `from`. */
  private collect(node: number, low: number, high: number, from: number, limit: number, out: number[]): void {
    if (low >= limit || this.tree[node]! <= from) return;
    if (high - low === 1) {
      // A range covering no byte overlaps nothing, but the two bounds this walk checks
      // are met when the query contains it — `start` before `to`, `end` after `from` —
      // so it has to be excluded here rather than left to them.
      if (this.ends[low]! > this.starts[low]!) out.push(low);
      return;
    }
    const middle = (low + high) >> 1;
    this.collect(node * 2, low, middle, from, limit, out);
    this.collect(node * 2 + 1, middle, high, from, limit, out);
  }

  private firstStartAtOrAfter(offset: number): number {
    let low = 0;
    let high = this.count;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.starts[middle]! >= offset) high = middle;
      else low = middle + 1;
    }
    return low;
  }
}

function nextPowerOfTwo(value: number): number {
  let size = 1;
  while (size < value) size *= 2;
  return size;
}
