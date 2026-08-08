/** Anything with a half-open byte range. */
export interface Interval {
  start: number;
  end: number;
}

interface Node<T extends Interval> {
  /** Split point. Everything here overlaps it; children hold what does not. */
  center: number;
  /** Ranges covering `center`, ascending by start. */
  byStart: T[];
  /** The same ranges, descending by end. */
  byEnd: T[];
  left: Node<T> | undefined;
  right: Node<T> | undefined;
}

/**
 * Centred interval tree over byte ranges: a query costs the depth of the tree
 * plus what it returns, instead of a pass over every range.
 *
 * The store does not use this — it keeps columns and indexes them with
 * `IntervalColumns`, because a node per range costs too much at parse scale. This
 * stays for a host implementing `DecorationQuery` over its own objects, where the
 * counts are modest and objects are what it already has.
 *
 * A sorted array with a running maximum end would have been less code and is the
 * usual first answer, but it degrades to a full scan in exactly the case this
 * exists for. One range covering the whole document — the outer record of a
 * parsed structure — keeps that maximum above every query, so nothing is ever
 * pruned. A centred tree puts that range at the root and stops there.
 *
 * Rebuilt whole rather than mutated: decorations arrive in bulk and are queried
 * once per row per frame, so the cost belongs on the write.
 */
export class IntervalIndex<T extends Interval> {
  private readonly root: Node<T> | undefined;

  constructor(items: readonly T[]) {
    this.root = build([...items]);
  }

  /** Ranges overlapping `[from, to)`, in no particular order. */
  overlapping(from: number, to: number): T[] {
    const found: T[] = [];
    if (to > from) collect(this.root, from, to, found);
    return found;
  }

  /** Ranges covering a single byte. */
  covering(offset: number): T[] {
    return this.overlapping(offset, offset + 1);
  }
}

function build<T extends Interval>(items: T[]): Node<T> | undefined {
  if (items.length === 0) return undefined;
  // The median of the midpoints, so a run of ranges in one place does not tip
  // every level to one side.
  const midpoints = items.map((item) => (item.start + item.end) / 2).sort((left, right) => left - right);
  const center = midpoints[midpoints.length >> 1]!;
  const left: T[] = [];
  const right: T[] = [];
  const here: T[] = [];
  for (const item of items) {
    if (item.end <= center) left.push(item);
    else if (item.start > center) right.push(item);
    else here.push(item);
  }
  // A centre every range covers would recurse for ever on the same list.
  if (here.length === items.length) {
    return { center, byStart: sortByStart(here), byEnd: sortByEnd(here), left: undefined, right: undefined };
  }
  return {
    center,
    byStart: sortByStart(here),
    byEnd: sortByEnd(here),
    left: build(left),
    right: build(right),
  };
}

const sortByStart = <T extends Interval>(items: T[]): T[] => [...items].sort((left, right) => left.start - right.start);
const sortByEnd = <T extends Interval>(items: T[]): T[] => [...items].sort((left, right) => right.end - left.end);

function collect<T extends Interval>(node: Node<T> | undefined, from: number, to: number, found: T[]): void {
  if (!node) return;
  if (to <= node.center) {
    // Everything here ends past the centre, so ending after `from` is given; only
    // starting before `to` has to be checked, and the list is sorted for it.
    for (const item of node.byStart) {
      if (item.start >= to) break;
      found.push(item);
    }
    collect(node.left, from, to, found);
    return;
  }
  if (from > node.center) {
    // Mirror image: starting before `to` is given, ending after `from` is not.
    for (const item of node.byEnd) {
      if (item.end <= from) break;
      found.push(item);
    }
    collect(node.right, from, to, found);
    return;
  }
  // The query spans the centre, so every range that covers it overlaps.
  found.push(...node.byStart);
  collect(node.left, from, to, found);
  collect(node.right, from, to, found);
}
