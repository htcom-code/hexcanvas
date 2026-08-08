import { bench, describe } from "vitest";
import { DecorationStore, type DecorationInput } from "../src/decorations";
import { IntervalIndex } from "../src/interval-index";

/**
 * What a parsed structure looks like: one range over the whole document, a header
 * over its start, then a record per 64 bytes with fields inside it. The outer
 * range is the point — it is what makes a running-maximum index degrade to a full
 * pass, and what a frame then pays for on every visible row.
 */
function structure(records: number): DecorationInput[] {
  const length = records * 64;
  const items: DecorationInput[] = [{ start: 0, end: length, kind: "structure", label: "file" }];
  for (let record = 0; record < records; record++) {
    const base = record * 64;
    items.push({ start: base, end: base + 64, kind: "structure" });
    items.push({ start: base, end: base + 4, kind: "structure" });
    items.push({ start: base + 4, end: base + 12, kind: "structure" });
    items.push({ start: base + 16, end: base + 48, kind: "structure" });
    items.push({ start: base + 20, end: base + 24, kind: "structure" });
  }
  return items;
}

/** One repaint of a 40-row viewport: the query the renderer makes per row. */
function frame(query: { between(from: number, to: number): unknown[] }, top: number): number {
  let seen = 0;
  for (let row = 0; row < 40; row++) {
    const offset = top + row * 16;
    seen += query.between(offset, offset + 16).length;
  }
  return seen;
}

/** The pass this replaced, kept as the yardstick rather than described in a comment. */
const linear = (items: readonly { start: number; end: number }[]) => ({
  between: (from: number, to: number) => items.filter((item) => item.start < to && item.end > from),
});

for (const records of [64, 1_024, 8_192]) {
  describe(`a frame over ${records * 5 + 1} ranges`, () => {
    const items = structure(records);
    const store = new DecorationStore();
    store.addAll(items);
    const scan = linear(store.all);
    const middle = (records / 2) * 64;

    bench("indexed", () => {
      frame(store, middle);
    });

    bench("full pass", () => {
      frame(scan, middle);
    });
  });
}

describe("taking a parse result in", () => {
  const items = structure(8_192); // 40,961 ranges

  // What a whole-file parser's result costs to hand over. Columns rather than an
  // object each is what makes this worth doing at all: as objects a range cost
  // about 350 bytes, so a few million were out of reach.
  bench("40,961 ranges, one call", () => {
    const store = new DecorationStore();
    store.replace(items, "structure");
    store.between(0, 16);
  });

  bench("40,961 ranges, then a frame", () => {
    const store = new DecorationStore();
    store.replace(items, "structure");
    frame(store, 0);
  });
});

describe("building the index", () => {
  const items = structure(8_192).map((item, index) => ({ ...item, id: `d${index}` }));

  // Paid once per write, which is where the cost belongs: decorations arrive in
  // bulk and are read once per row per frame.
  bench("index 40,961 ranges", () => {
    new IntervalIndex(items as { start: number; end: number }[]);
  });

  bench("store them and query once", () => {
    const store = new DecorationStore();
    store.addAll(items);
    store.between(0, 16);
  });
});
