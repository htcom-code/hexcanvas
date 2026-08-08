import { describe, expect, it } from "vitest";
import { IntervalColumns } from "../src/interval-columns";
import { IntervalIndex, type Interval } from "../src/interval-index";

const range = (start: number, end: number): Interval => ({ start, end });
const starts = (found: Interval[]) => found.map((item) => item.start).sort((left, right) => left - right);

/** The answer a full pass would give, which the index has to match exactly. */
const byScan = (items: Interval[], from: number, to: number) =>
  starts(items.filter((item) => item.start < to && item.end > from));

describe("IntervalIndex", () => {
  it("finds what overlaps a range and nothing else", () => {
    const items = [range(0, 4), range(4, 8), range(6, 12), range(20, 24)];
    const index = new IntervalIndex(items);
    expect(starts(index.overlapping(4, 8))).toEqual([4, 6]);
    expect(starts(index.overlapping(0, 1))).toEqual([0]);
    expect(starts(index.overlapping(12, 20))).toEqual([]);
    expect(starts(index.overlapping(0, 100))).toEqual([0, 4, 6, 20]);
  });

  it("treats the end offset as exclusive", () => {
    const index = new IntervalIndex([range(4, 8)]);
    expect(index.covering(7)).toHaveLength(1);
    expect(index.covering(8)).toHaveLength(0);
    expect(index.overlapping(8, 12)).toHaveLength(0);
  });

  it("answers an empty set and an empty query", () => {
    expect(new IntervalIndex([]).overlapping(0, 10)).toEqual([]);
    expect(new IntervalIndex([range(0, 10)]).overlapping(5, 5)).toEqual([]);
  });

  it("handles ranges that all cover the same point", () => {
    // Nothing can be split off to either side, so the build has to stop rather
    // than recurse on the same list for ever.
    const items = [range(0, 100), range(10, 90), range(40, 60), range(49, 51)];
    const index = new IntervalIndex(items);
    expect(starts(index.covering(50))).toEqual([0, 10, 40, 49]);
    expect(starts(index.covering(95))).toEqual([0]);
  });

  it("agrees with a full pass over awkward data", () => {
    // A document-spanning outer range plus clusters, which is what a parsed
    // structure looks like and what the naive index gets wrong.
    const items: Interval[] = [range(0, 4096)];
    for (let cluster = 0; cluster < 40; cluster++) {
      const base = cluster * 100;
      items.push(range(base, base + 64), range(base + 8, base + 16), range(base + 8, base + 9));
    }
    const index = new IntervalIndex(items);
    for (let from = 0; from < 4200; from += 7) {
      const to = from + (from % 3 === 0 ? 1 : 16);
      expect(starts(index.overlapping(from, to)), `overlapping(${from}, ${to})`).toEqual(byScan(items, from, to));
    }
  });

  it("reports a range only once", () => {
    const items = [range(0, 1000), range(400, 600)];
    const index = new IntervalIndex(items);
    expect(index.overlapping(0, 1000)).toHaveLength(2);
    expect(index.covering(500)).toHaveLength(2);
  });
});

describe("IntervalColumns", () => {
  /** Sorted by start, which is what the columnar store keeps. */
  const columns = (items: Interval[]) => {
    const sorted = [...items].sort((left, right) => left.start - right.start);
    const starts = Float64Array.from(sorted, (item) => item.start);
    const ends = Float64Array.from(sorted, (item) => item.end);
    return { index: new IntervalColumns(starts, ends, sorted.length), sorted };
  };
  const found = (items: Interval[], from: number, to: number) => {
    const { index, sorted } = columns(items);
    return index.overlapping(from, to, []).map((at) => sorted[at]!.start).sort((a, b) => a - b);
  };

  it("agrees with a full pass over awkward data", () => {
    // A document-spanning outer range, clusters, and plain non-overlapping siblings
    // — the three shapes a parse result mixes, each of which broke a previous index.
    const items: Interval[] = [range(0, 4096)];
    for (let cluster = 0; cluster < 40; cluster++) {
      const base = cluster * 100;
      items.push(range(base, base + 64), range(base + 8, base + 16), range(base + 8, base + 9));
    }
    for (let sibling = 0; sibling < 200; sibling++) items.push(range(5000 + sibling * 16, 5000 + sibling * 16 + 12));

    for (let from = 0; from < 8400; from += 13) {
      const to = from + (from % 3 === 0 ? 1 : 16);
      const expected = starts(items.filter((item) => item.start < to && item.end > from));
      expect(found(items, from, to), `overlapping(${from}, ${to})`).toEqual(expected);
    }
  });

  it("treats the end offset as exclusive and an empty query as empty", () => {
    const items = [range(4, 8)];
    expect(found(items, 8, 12)).toEqual([]);
    expect(found(items, 7, 8)).toEqual([4]);
    expect(found(items, 5, 5)).toEqual([]);
    expect(new IntervalColumns(new Float64Array(0), new Float64Array(0), 0).overlapping(0, 10, [])).toEqual([]);
  });

  it("reports a covering range once, not once per level", () => {
    const items = [range(0, 1000), range(400, 600)];
    expect(found(items, 500, 501)).toEqual([0, 400]);
    expect(found(items, 0, 1000)).toEqual([0, 400]);
  });

  it("reuses the array it is handed", () => {
    const { index } = columns([range(0, 4), range(8, 12)]);
    const out: number[] = [];
    expect(index.covering(1, out)).toBe(out);
    expect(out).toEqual([0]);
    index.covering(9, out);
    expect(out).toEqual([1]);
  });
});
