import { describe, expect, it } from "vitest";
import { ChangeSet } from "../src/byte-source";
import { DecorationStore, byPaintOrder } from "../src/decorations";

const labels = (decorations: readonly { label?: string }[]) => decorations.map((item) => item.label);

describe("DecorationStore", () => {
  const nested = () => {
    const store = new DecorationStore();
    store.addAll([
      { start: 0, end: 48, label: "record" },
      { start: 4, end: 13, label: "name" },
      { start: 0, end: 4, label: "magic" },
    ]);
    return store;
  };

  it("keeps ranges sorted by start", () => {
    expect(nested().all.map((item) => item.start)).toEqual([0, 0, 4]);
  });

  it("paints wider ranges first so the inner one stays visible", () => {
    expect(labels([...nested().all].sort(byPaintOrder))).toEqual(["record", "name", "magic"]);
  });

  it("lets priority override the width rule", () => {
    const store = new DecorationStore();
    store.addAll([{ start: 0, end: 4, label: "narrow" }, { start: 0, end: 32, label: "wide", priority: 10 }]);
    expect(labels([...store.all].sort(byPaintOrder))).toEqual(["narrow", "wide"]);
  });

  it("reports every range covering an offset, innermost first", () => {
    expect(labels(nested().allAt(6))).toEqual(["name", "record"]);
    expect(labels(nested().allAt(2))).toEqual(["magic", "record"]);
    expect(labels(nested().allAt(40))).toEqual(["record"]);
    expect(nested().allAt(100)).toEqual([]);
  });

  it("treats the end offset as exclusive", () => {
    const store = new DecorationStore();
    store.add({ start: 4, end: 8, label: "field" });
    expect(labels(store.allAt(7))).toEqual(["field"]);
    expect(store.allAt(8)).toEqual([]);
  });

  it("finds the ranges overlapping a row", () => {
    expect(labels(nested().between(0, 16))).toEqual(["record", "magic", "name"]);
    expect(labels(nested().between(20, 32))).toEqual(["record"]);
  });

  it("filters by kind", () => {
    const store = new DecorationStore();
    store.addAll([{ start: 0, end: 1, kind: "bookmark" }, { start: 0, end: 8, kind: "structure" }]);
    expect(store.allAt(0, "bookmark")).toHaveLength(1);
    expect(store.at(0, "structure")?.end).toBe(8);
  });

  it("replaces one kind and leaves the others alone", () => {
    const store = new DecorationStore();
    store.addAll([{ start: 0, end: 1, kind: "bookmark" }, { start: 8, end: 9, kind: "structure" }]);
    store.replace([{ start: 16, end: 20, kind: "structure" }], "structure");
    expect(store.all.map((item) => [item.kind, item.start])).toEqual([["bookmark", 0], ["structure", 16]]);
  });

  it("stamps the kind onto entries that omit it", () => {
    const store = new DecorationStore();
    store.replace([{ start: 24, end: 28 }], "structure");
    expect(store.allAt(25, "structure")).toHaveLength(1);
  });

  it("clears everything when no kind is given", () => {
    const store = nested();
    store.clear();
    expect(store.all).toEqual([]);
  });

  describe("mapping across an edit", () => {
    it("moves ranges that sit after an insert", () => {
      const store = new DecorationStore();
      store.addAll([{ start: 10, end: 11 }, { start: 20, end: 24 }]);
      store.map(ChangeSet.insert(5, Uint8Array.of(1, 2, 3)));
      expect(store.all.map((item) => [item.start, item.end])).toEqual([[13, 14], [23, 27]]);
    });

    it("moves ranges that sit after a delete", () => {
      const store = new DecorationStore();
      store.add({ start: 10, end: 12 });
      store.map(ChangeSet.remove(0, 3));
      expect(store.all.map((item) => [item.start, item.end])).toEqual([[7, 9]]);
    });

    it("does not stretch a range when bytes are inserted right after it", () => {
      const store = new DecorationStore();
      store.add({ start: 10, end: 11 });
      store.map(ChangeSet.insert(11, Uint8Array.of(9)));
      expect(store.all.map((item) => [item.start, item.end])).toEqual([[10, 11]]);
    });

    it("drops a range whose bytes were deleted", () => {
      const store = new DecorationStore();
      store.addAll([{ start: 10, end: 11, label: "gone" }, { start: 20, end: 24, label: "kept" }]);
      store.map(ChangeSet.remove(10, 11));
      expect(labels(store.all)).toEqual(["kept"]);
    });

    it("shrinks a range that a delete partly covers", () => {
      const store = new DecorationStore();
      store.add({ start: 4, end: 12 });
      store.map(ChangeSet.remove(8, 16));
      expect(store.all.map((item) => [item.start, item.end])).toEqual([[4, 8]]);
    });

    it("reports whether anything moved", () => {
      const store = new DecorationStore();
      store.add({ start: 10, end: 11 });
      expect(store.map(ChangeSet.empty())).toBe(false);
      expect(store.map(ChangeSet.insert(30, Uint8Array.of(1)))).toBe(false);
      expect(store.map(ChangeSet.insert(0, Uint8Array.of(1)))).toBe(true);
    });
  });
});

describe("DecorationStore as columns", () => {
  it("keeps document order however ranges arrive", () => {
    const store = new DecorationStore();
    store.add({ start: 40, end: 48, label: "third" });
    store.add({ start: 0, end: 8, label: "first" });
    store.add({ start: 16, end: 24, label: "second" });
    expect(store.all.map((item) => item.label)).toEqual(["first", "second", "third"]);
    expect(store.size).toBe(3);
  });

  it("hands back the range it was given, not whichever row it landed on", () => {
    const store = new DecorationStore();
    store.add({ start: 40, end: 48, label: "late" });
    const early = store.add({ start: 0, end: 8, label: "early" });
    // Inserting before an existing row moves it; the returned range must still be
    // the one that was passed in.
    expect(early).toMatchObject({ start: 0, end: 8, label: "early" });
    expect(store.at(2)?.label).toBe("early");
  });

  it("counts a kind without building it", () => {
    const store = new DecorationStore();
    store.addAll([{ start: 0, end: 4, kind: "a" }, { start: 8, end: 12, kind: "b" }, { start: 16, end: 20, kind: "a" }]);
    expect(store.countOfKind("a")).toBe(2);
    expect(store.countOfKind("b")).toBe(1);
    expect(store.countOfKind("missing")).toBe(0);
  });

  it("reports which of a kind covers an offset", () => {
    const store = new DecorationStore();
    store.addAll([
      { start: 0, end: 4, kind: "hit" },
      { start: 2, end: 6, kind: "other" },
      { start: 8, end: 12, kind: "hit" },
      { start: 20, end: 24, kind: "hit" },
    ]);
    expect(store.ordinalOfKindAt("hit", 1)).toBe(1);
    expect(store.ordinalOfKindAt("hit", 9)).toBe(2);
    expect(store.ordinalOfKindAt("hit", 21)).toBe(3);
    // Between hits, and inside a range of another kind, is not a position.
    expect(store.ordinalOfKindAt("hit", 5)).toBe(0);
  });

  it("gives a range only the id it was given", () => {
    const store = new DecorationStore();
    store.addAll([{ start: 0, end: 4, id: "mine" }, { start: 8, end: 12 }]);
    expect(store.remove("mine")).toBe(true);
    expect(store.size).toBe(1);
    // The other one still gets an id when something asks for it.
    const [remaining] = store.all;
    expect(remaining!.id).toMatch(/^decoration-/);
    expect(store.remove(remaining!.id)).toBe(true);
    expect(store.size).toBe(0);
  });

  it("keeps ids attached to their range through a reorder", () => {
    const store = new DecorationStore();
    store.add({ start: 40, end: 48, id: "high" });
    store.add({ start: 0, end: 8, id: "low" });
    store.add({ start: 20, end: 28, id: "mid" });
    expect(store.all.map((item) => item.id)).toEqual(["low", "mid", "high"]);
    expect(store.remove("mid")).toBe(true);
    expect(store.all.map((item) => item.id)).toEqual(["low", "high"]);
    expect(store.at(41)?.id).toBe("high");
  });

  it("keeps ids attached when another kind is cleared out from under them", () => {
    const store = new DecorationStore();
    store.addAll([
      { start: 0, end: 4, id: "keep-a", kind: "keep" },
      { start: 8, end: 12, id: "drop", kind: "drop" },
      { start: 16, end: 20, id: "keep-b", kind: "keep" },
    ]);
    store.clear("drop");
    expect(store.all.map((item) => item.id)).toEqual(["keep-a", "keep-b"]);
    expect(store.remove("keep-b")).toBe(true);
    expect(store.all.map((item) => item.start)).toEqual([0]);
    // A dropped id must not still resolve to a row.
    expect(store.remove("drop")).toBe(false);
  });

  it("keeps ids attached across an edit that reorders nothing and one that drops a range", () => {
    const store = new DecorationStore();
    store.addAll([
      { start: 0, end: 4, id: "first" },
      { start: 8, end: 12, id: "doomed" },
      { start: 16, end: 20, id: "last" },
    ]);
    // Removing exactly the second range's bytes takes it with them.
    store.map(ChangeSet.remove(8, 12));
    expect(store.all.map((item) => item.id)).toEqual(["first", "last"]);
    expect(store.at(13)?.id).toBe("last");
    expect(store.remove("doomed")).toBe(false);
    expect(store.remove("last")).toBe(true);
  });

  it("interns the values that repeat instead of holding one each", () => {
    const store = new DecorationStore();
    store.addAll(Array.from({ length: 100 }, (_, index) => ({
      start: index * 8,
      end: index * 8 + 4,
      color: "#0ea5e9",
      kind: "structure",
      label: `field ${index}`,
    })));
    // Observable part: what comes back is what went in.
    const [first] = store.between(0, 8);
    expect(first).toMatchObject({ start: 0, end: 4, color: "#0ea5e9", kind: "structure", label: "field 0" });
    expect(store.between(792, 800)[0]).toMatchObject({ label: "field 99" });
  });

  it("leaves out what was never set rather than inventing defaults", () => {
    const store = new DecorationStore();
    store.addAll([{ start: 0, end: 4 }]);
    const [item] = store.between(0, 4);
    expect(item).toEqual({ id: item!.id, start: 0, end: 4 });
    expect("opacity" in item!).toBe(false);
    expect("priority" in item!).toBe(false);
    expect("label" in item!).toBe(false);
  });

  it("keeps an opacity of zero, which is not the same as unset", () => {
    const store = new DecorationStore();
    store.addAll([{ start: 0, end: 4, opacity: 0 }]);
    expect(store.between(0, 4)[0]!.opacity).toBe(0);
  });

  it("holds offsets past the 32-bit range", () => {
    const store = new DecorationStore();
    const at = 3_000_000_000;
    store.addAll([{ start: at, end: at + 16, label: "far" }]);
    expect(store.between(at, at + 1)[0]).toMatchObject({ start: at, end: at + 16, label: "far" });
    expect(store.allAt(at + 8).map((item) => item.label)).toEqual(["far"]);
  });
});
