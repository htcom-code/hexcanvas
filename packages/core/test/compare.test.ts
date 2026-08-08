import { describe, expect, it } from "vitest";
import { ChangeSet, MemoryByteSource } from "../src/byte-source";
import { HexCompare } from "../src/compare";
import { bookmarkKind, diffDeleteKind, diffInsertKind, diffReplaceKind } from "../src/decorations";
import type { DiffProvider, HexDifference } from "../src/diff";
import { HexEngine } from "../src/engine";

const bytes = (length: number, at: (index: number) => number) => Uint8Array.from({ length }, (_, index) => at(index));

/**
 * Two engines over two documents, sized so ten of sixteen rows are visible —
 * the same viewport the engine's own tests use, so "off screen" means the same
 * thing here as it does there.
 */
const setup = (left: Uint8Array, right: Uint8Array, options: { syncScroll?: boolean; provider?: DiffProvider; limit?: number } = {}) => {
  const leftSource = new MemoryByteSource(left);
  const rightSource = new MemoryByteSource(right);
  const engines = {
    left: new HexEngine({ source: leftSource, platform: "mac" }),
    right: new HexEngine({ source: rightSource, platform: "mac" }),
  };
  engines.left.setViewportSize(800, 220);
  engines.right.setViewportSize(800, 220);
  const compare = new HexCompare({ ...engines, ...options });
  return { ...engines, leftSource, rightSource, compare };
};

const kinds = (engine: HexEngine) => [diffReplaceKind, diffInsertKind, diffDeleteKind]
  .flatMap((kind) => engine.decorationsBetween(0, Number.MAX_SAFE_INTEGER, kind).map((item) => [kind, item.start, item.end]));

describe("HexCompare", () => {
  it("reports no differences and paints nothing for identical documents", async () => {
    const { compare, left } = setup(bytes(64, (index) => index), bytes(64, (index) => index));
    expect(await compare.compare()).toBe(0);
    expect(compare.getState().differenceCount).toBe(0);
    // `compared` is what tells a count of zero apart from not having run yet.
    expect(compare.getState().compared).toBe(true);
    expect(kinds(left)).toEqual([]);
  });

  it("paints a replaced run on both sides", async () => {
    const { compare, left, right } = setup(bytes(64, () => 0), bytes(64, (index) => (index >= 10 && index < 14 ? 1 : 0)));
    await compare.compare();
    expect(kinds(left)).toEqual([[diffReplaceKind, 10, 14]]);
    expect(kinds(right)).toEqual([[diffReplaceKind, 10, 14]]);
  });

  it("paints an insertion on the right only, and a deletion on the left only", async () => {
    const grown = setup(bytes(16, () => 0), bytes(24, () => 0));
    await grown.compare.compare();
    expect(kinds(grown.left)).toEqual([]);
    expect(kinds(grown.right)).toEqual([[diffInsertKind, 16, 24]]);

    const shrunk = setup(bytes(24, () => 0), bytes(16, () => 0));
    await shrunk.compare.compare();
    expect(kinds(shrunk.left)).toEqual([[diffDeleteKind, 16, 24]]);
    expect(kinds(shrunk.right)).toEqual([]);
  });

  it("leaves the host's own decorations alone", async () => {
    const { compare, left } = setup(bytes(64, () => 0), bytes(64, (index) => (index === 5 ? 1 : 0)));
    left.toggleBookmark(32);
    await compare.compare();
    expect(left.decorationCount(bookmarkKind)).toBe(1);
    compare.clear();
    expect(left.decorationCount(bookmarkKind)).toBe(1);
    expect(kinds(left)).toEqual([]);
  });

  it("labels each difference so the gutter has something to draw", async () => {
    const { compare, left, right } = setup(bytes(64, () => 0), bytes(72, (index) => (index >= 10 && index < 14 ? 1 : 0)));
    await compare.compare();
    expect(left.decorationsBetween(0, 64, diffReplaceKind).map((item) => item.label)).toEqual(["4 B changed"]);
    expect(right.decorationsBetween(0, 72, diffInsertKind).map((item) => item.label)).toEqual(["8 B added"]);

    const shrunk = setup(bytes(72, () => 0), bytes(64, () => 0));
    await shrunk.compare.compare();
    expect(shrunk.left.decorationsBetween(0, 72, diffDeleteKind).map((item) => item.label)).toEqual(["8 B removed"]);
  });

  it("leaves the label to the host's display option rather than forcing it on", async () => {
    const { compare, left } = setup(bytes(64, () => 0), bytes(64, (index) => (index === 5 ? 1 : 0)));
    await compare.compare();
    // Unset, not true: `labelVisible` would override `decorationLabels`, so a
    // comparison would print labels on a host that turned them off.
    expect(left.decorationsBetween(0, 64, diffReplaceKind)[0]!.labelVisible).toBeUndefined();
  });

  it("takes the label wording from each pane's own text bag", async () => {
    const leftSource = new MemoryByteSource(bytes(64, () => 0));
    const rightSource = new MemoryByteSource(bytes(64, (index) => (index === 5 ? 1 : 0)));
    const left = new HexEngine({ source: leftSource, platform: "mac", text: { replacedLabel: (count) => `${count}바이트 변경` } });
    const right = new HexEngine({ source: rightSource, platform: "mac" });
    const compare = new HexCompare({ left, right });
    await compare.compare();
    expect(left.decorationsBetween(0, 64, diffReplaceKind)[0]!.label).toBe("1바이트 변경");
    expect(right.decorationsBetween(0, 64, diffReplaceKind)[0]!.label).toBe("1 B changed");
  });

  it("reports the cap as truncation rather than as a total", async () => {
    const { compare } = setup(bytes(100, () => 0), bytes(100, (index) => index % 2), { limit: 3 });
    expect(await compare.compare()).toBe(3);
    expect(compare.getState().differenceTruncated).toBe(true);
  });

  describe("walking", () => {
    const walkable = () => setup(
      bytes(256, () => 0),
      bytes(256, (index) => ([10, 100, 200].some((start) => index >= start && index < start + 2) ? 1 : 0)),
    );

    it("moves to the next difference and selects it on both sides", async () => {
      const { compare, left, right } = walkable();
      await compare.compare();
      expect(compare.nextDifference()).toBe(true);
      expect(left.getState().selection).toEqual({ start: 10, end: 12 });
      expect(right.getState().selection).toEqual({ start: 10, end: 12 });
      compare.nextDifference();
      expect(left.getState().selection).toEqual({ start: 100, end: 102 });
    });

    it("wraps at both ends rather than dead-ending", async () => {
      const { compare, left } = walkable();
      await compare.compare();
      left.moveCursor(240);
      compare.nextDifference();
      expect(left.getState().selection).toEqual({ start: 10, end: 12 });
      compare.previousDifference();
      expect(left.getState().selection).toEqual({ start: 200, end: 202 });
    });

    it("declines when there is nothing to walk", () => {
      const { compare } = walkable();
      expect(compare.nextDifference()).toBe(false);
      expect(compare.previousDifference()).toBe(false);
    });

    it("counts the difference it walked to, even where the left side is empty", async () => {
      // An insertion has no left range, so the left cursor cannot be inside it.
      // Asking the cursor would answer with the previous one.
      const { compare } = setup(bytes(64, () => 0), bytes(80, (index) => (index === 5 ? 1 : 0)));
      await compare.compare();
      expect(compare.differences.map((difference) => difference.kind)).toEqual(["replace", "insert"]);
      compare.nextDifference();
      expect(compare.getState().differenceIndex).toBe(1);
      compare.nextDifference();
      expect(compare.getState().differenceIndex).toBe(2);
    });

    it("answers which difference the left cursor is inside, counting from one", async () => {
      const { compare, left } = walkable();
      await compare.compare();
      left.moveCursor(101);
      expect(compare.getState().differenceIndex).toBe(2);
      left.moveCursor(150);
      expect(compare.getState().differenceIndex).toBe(0);
    });

    it("runs from the F4 keys through the engine", async () => {
      const { compare, left } = walkable();
      await compare.compare();
      expect(left.handleKey({ key: "F4" })).toBe(true);
      expect(left.getState().selection).toEqual({ start: 10, end: 12 });
      expect(left.handleKey({ key: "F4", shiftKey: true })).toBe(true);
      // Wrapped backwards past the first, which is the last one.
      expect(left.getState().selection).toEqual({ start: 200, end: 202 });
    });

    it("gives the keys back once the comparison is destroyed", async () => {
      const { compare, left } = walkable();
      await compare.compare();
      compare.destroy();
      expect(left.handleKey({ key: "F4" })).toBe(false);
    });
  });

  describe("scroll", () => {
    it("mirrors the other side onto the same offset", () => {
      const { left, right } = setup(bytes(16 * 400, () => 0), bytes(16 * 400, () => 0));
      left.setScrollTop(50 * 22); // row 50
      expect(right.visibleRows.first).toBe(50);
    });

    it("mirrors both ways without the echo fighting the original", () => {
      const { left, right } = setup(bytes(16 * 400, () => 0), bytes(16 * 400, () => 0));
      right.setScrollTop(80 * 22);
      expect(left.visibleRows.first).toBe(80);
      left.setScrollTop(10 * 22);
      expect(right.visibleRows.first).toBe(10);
    });

    it("keeps the shorter document at its own end rather than past it", () => {
      const { left, right } = setup(bytes(16 * 400, () => 0), bytes(16 * 20, () => 0));
      left.setScrollTop(300 * 22);
      // Twenty rows, ten of them visible: the furthest it can go is row 10, which
      // puts its last row against the bottom edge. Asked for row 300, it clamps
      // there rather than scrolling into blank space.
      expect(right.visibleRows).toEqual({ first: 10, last: 20, total: 20 });
    });

    it("leaves the other side alone when the sync is off", () => {
      const { left, right } = setup(bytes(16 * 400, () => 0), bytes(16 * 400, () => 0), { syncScroll: false });
      left.setScrollTop(50 * 22);
      expect(right.visibleRows.first).toBe(0);
    });

    /**
     * Where the mirror stops being able to go through an offset. Once the panes
     * are laid out together, the two documents deliberately hold different
     * offsets on the same line, so mirroring by offset lands the other side a
     * shift away — the alignment undone at the last step.
     */
    describe("once the panes are laid out together", () => {
      const insertion = (at: number, count: number): HexDifference =>
        ({ left: { start: at, end: at }, right: { start: at, end: at + count }, kind: "insert" });
      const deletion = (at: number, count: number): HexDifference =>
        ({ left: { start: at, end: at + count }, right: { start: at, end: at }, kind: "delete" });

      /** A pair one shift apart, compared, so an aligned plan is in force. */
      const laidOut = async (difference: HexDifference) => {
        const provider: DiffProvider = { compare: async () => [difference] };
        const grown = (difference.right.end - difference.right.start) - (difference.left.end - difference.left.start);
        const parts = setup(bytes(16 * 400, () => 0), bytes(16 * 400 + grown, () => 0), { provider });
        await parts.compare.compare();
        return parts;
      };

      /**
       * Five rows deleted a hundred rows in, so past the gap the left keeps the
       * usual arithmetic and the right is the shifted one. Mirroring through an
       * offset would read the left's row as `row * bytesPerRow` and hand the
       * right a number that is five rows further on in its document.
       */
      it("mirrors by row, so the same line stays the same line", async () => {
        const { left, right } = await laidOut(deletion(16 * 100, 16 * 5));
        left.setScrollTop(150 * 22);
        expect(right.visibleRows.first).toBe(150);
        // The two offsets on that line, five rows apart: the same byte.
        expect(left.plan.at(150).offset).toBe(16 * 150);
        expect(right.plan.at(150).offset).toBe(16 * 145);
      });

      /** The same, with the shift on the other side and the scroll on the other pane. */
      it("mirrors by row the other way too", async () => {
        const { left, right } = await laidOut(insertion(16 * 100, 16 * 5));
        right.setScrollTop(150 * 22);
        expect(left.visibleRows.first).toBe(150);
        expect(left.plan.at(150).offset).toBe(16 * 145);
        expect(right.plan.at(150).offset).toBe(16 * 150);
      });

      /**
       * The side an insertion is absent from has gap rows opposite the bytes,
       * and a gap holds no offset — so scrolling it to the difference's own
       * offset answers with the row after the gap.
       */
      it("reveals a difference on the same line on both sides", async () => {
        const { compare, left, right } = await laidOut(insertion(16 * 100, 16 * 5));
        expect(compare.nextDifference()).toBe(true);
        expect(left.visibleRows.first).toBe(right.visibleRows.first);
        // Row 100 is where the inserted bytes are: the right's first row of
        // them, and a gap on the left. Both panes have to be showing it —
        // before, the left stopped past the gap, five rows further on.
        expect(right.plan.at(100).offset).toBe(16 * 100);
        expect(left.plan.at(100).length).toBe(0);
        expect(left.visibleRows.first).toBeLessThanOrEqual(100);
        expect(left.visibleRows.last).toBeGreaterThan(100);
      });
    });
  });

  describe("staleness", () => {
    it("marks the result stale when either document is edited", async () => {
      const { compare, leftSource } = setup(bytes(64, () => 0), bytes(64, (index) => (index === 5 ? 1 : 0)));
      await compare.compare();
      expect(compare.getState().stale).toBe(false);
      leftSource.apply(ChangeSet.replace(0, 1, Uint8Array.of(9)));
      expect(compare.getState().stale).toBe(true);
    });

    it("does not mark it stale when bytes merely become resident", async () => {
      const { compare, leftSource } = setup(bytes(64, () => 0), bytes(64, (index) => (index === 5 ? 1 : 0)));
      await compare.compare();
      // What a paged source announces once a page lands: a change set with
      // nothing in it. Treating that as an edit would call every comparison of
      // a large file stale before it finished being read.
      leftSource.apply(ChangeSet.empty());
      expect(compare.getState().stale).toBe(false);
    });

    it("notices a source swapped in behind the engine", async () => {
      const { compare, left } = setup(bytes(64, () => 0), bytes(64, (index) => (index === 5 ? 1 : 0)));
      await compare.compare();
      left.setSource(new MemoryByteSource(bytes(64, () => 7)));
      expect(compare.getState().stale).toBe(true);
    });

    it("clears the flag when the comparison is run again", async () => {
      const { compare, leftSource } = setup(bytes(64, () => 0), bytes(64, (index) => (index === 5 ? 1 : 0)));
      await compare.compare();
      leftSource.apply(ChangeSet.replace(0, 1, Uint8Array.of(9)));
      await compare.compare(true);
      expect(compare.getState().stale).toBe(false);
    });
  });

  describe("running it", () => {
    it("hands a second caller the comparison already in flight", async () => {
      let calls = 0;
      const provider: DiffProvider = {
        compare: async () => {
          calls++;
          return [];
        },
      };
      const { compare } = setup(bytes(64, () => 0), bytes(64, () => 1), { provider });
      await Promise.all([compare.compare(), compare.compare()]);
      expect(calls).toBe(1);
    });

    it("discards a superseded run rather than letting it land", async () => {
      const releases: ((value: never[]) => void)[] = [];
      const provider: DiffProvider = {
        compare: () => new Promise<never[]>((resolve) => releases.push(resolve)),
      };
      const { compare } = setup(bytes(64, () => 0), bytes(64, () => 1), { provider });
      const first = compare.compare();
      const second = compare.compare(true);
      // The slow first one lands after the second has already answered.
      releases[1]!([]);
      await second;
      releases[0]!([]);
      await first;
      expect(compare.getState().error).toBeUndefined();
      expect(compare.getState().comparing).toBe(false);
    });

    it("reports a provider's complaint without wedging the state", async () => {
      const provider: DiffProvider = { compare: () => Promise.reject(new Error("cannot read it")) };
      const { compare } = setup(bytes(64, () => 0), bytes(64, () => 1), { provider });
      await compare.compare();
      expect(compare.getState().error).toBe("cannot read it");
      expect(compare.getState().comparing).toBe(false);
    });

    it("does not report a cancellation as a failure", async () => {
      const provider: DiffProvider = {
        compare: (_left, _right, options) => new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
      };
      const { compare } = setup(bytes(64, () => 0), bytes(64, () => 1), { provider });
      const running = compare.compare();
      compare.clear();
      await running;
      expect(compare.getState().error).toBeUndefined();
    });

    it("forgets everything on clear", async () => {
      const { compare, left } = setup(bytes(64, () => 0), bytes(64, (index) => (index === 5 ? 1 : 0)));
      await compare.compare();
      compare.clear();
      expect(compare.differences).toEqual([]);
      expect(compare.getState().compared).toBe(false);
      expect(kinds(left)).toEqual([]);
    });
  });
});
