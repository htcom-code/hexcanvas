import { describe, expect, it } from "vitest";
import type { HexDifference } from "../src/diff";
import { alignedRowPlans } from "../src/row-alignment";
import { linearRowPlan, type RowPlan } from "../src/viewport";

const insert = (leftAt: number, rightFrom: number, rightTo: number): HexDifference => ({
  left: { start: leftAt, end: leftAt }, right: { start: rightFrom, end: rightTo }, kind: "insert",
});
const remove = (leftFrom: number, leftTo: number, rightAt: number): HexDifference => ({
  left: { start: leftFrom, end: leftTo }, right: { start: rightAt, end: rightAt }, kind: "delete",
});
const replace = (from: number, to: number): HexDifference => ({
  left: { start: from, end: to }, right: { start: from, end: to }, kind: "replace",
});

/** The rows a plan lays out, as `offset+length` pairs, for reading in a failure. */
const laidOut = (plan: RowPlan) =>
  Array.from({ length: plan.rows }, (_, row) => {
    const span = plan.at(row);
    return span.length === 0 ? "gap" : `${span.offset}+${span.length}`;
  });

describe("alignedRowPlans", () => {
  // The point of the whole thing: the same byte on the same line.
  const sameLine = (plans: { left: RowPlan; right: RowPlan }, leftOffset: number, rightOffset: number) => {
    expect(plans.left.rowOf(leftOffset)).toBe(plans.right.rowOf(rightOffset));
  };

  it("leaves the usual arithmetic alone when nothing shifted", () => {
    // Replacements of equal length move nothing after them, and breaking rows
    // around them would fragment the grid for no gain.
    expect(alignedRowPlans([replace(4, 8), replace(40, 44)], 128, 128, 16)).toBeUndefined();
    expect(alignedRowPlans([], 128, 128, 16)).toBeUndefined();
  });

  it("keeps the two level after a byte is inserted at the front", () => {
    const plans = alignedRowPlans([insert(0, 0, 1)], 64, 65, 16)!;
    expect(plans).toBeDefined();
    // Left byte 0 and right byte 1 are the same byte, so they share a line.
    sameLine(plans, 0, 1);
    sameLine(plans, 16, 17);
    sameLine(plans, 63, 64);
    // And the inserted byte is on a line of its own, against a gap.
    const insertedRow = plans.right.rowOf(0);
    expect(plans.right.at(insertedRow)).toEqual({ offset: 0, length: 1 });
    expect(plans.left.at(insertedRow).length).toBe(0);
  });

  it("keeps them level after a byte is removed", () => {
    const plans = alignedRowPlans([remove(0, 1, 0)], 65, 64, 16)!;
    sameLine(plans, 1, 0);
    sameLine(plans, 17, 16);
    const removedRow = plans.left.rowOf(0);
    expect(plans.left.at(removedRow)).toEqual({ offset: 0, length: 1 });
    expect(plans.right.at(removedRow).length).toBe(0);
  });

  it("gives both sides the same number of rows", () => {
    const plans = alignedRowPlans([insert(32, 32, 40)], 128, 136, 16)!;
    expect(plans.left.rows).toBe(plans.right.rows);
  });

  it("pads the shorter side of a lopsided change with gaps", () => {
    // Two bytes on the left become forty on the right: three rows for the right,
    // and the left has to wait through them.
    const plans = alignedRowPlans(
      [{ left: { start: 16, end: 18 }, right: { start: 16, end: 56 }, kind: "replace" }],
      64, 102, 16,
    )!;
    const changeRow = plans.right.rowOf(16);
    const rightSpan = plans.right.at(changeRow);
    expect(rightSpan).toEqual({ offset: 16, length: 16 });
    // The left's two bytes sit on the first of those rows and it is empty after.
    expect(plans.left.at(changeRow)).toEqual({ offset: 16, length: 2 });
    expect(plans.left.at(changeRow + 1).length).toBe(0);
    expect(plans.left.at(changeRow + 2).length).toBe(0);
    expect(plans.left.rows).toBe(plans.right.rows);
  });

  it("still covers every byte of both documents", () => {
    const plans = alignedRowPlans([insert(10, 10, 13), remove(40, 44, 43)], 64, 63, 16)!;
    for (const [plan, length] of [[plans.left, 64], [plans.right, 63]] as const) {
      const seen = new Set<number>();
      for (let row = 0; row < plan.rows; row++) {
        const span = plan.at(row);
        for (let at = span.offset; at < span.offset + span.length; at++) seen.add(at);
      }
      expect(seen.size, laidOut(plan).join(" ")).toBe(length);
      expect(Math.min(...seen)).toBe(0);
      expect(Math.max(...seen)).toBe(length - 1);
    }
  });

  it("answers rowOf and indexOf consistently with what it laid out", () => {
    const plans = alignedRowPlans([insert(20, 20, 27)], 100, 107, 16)!;
    for (const [plan, length] of [[plans.left, 100], [plans.right, 107]] as const) {
      for (let offset = 0; offset < length; offset++) {
        const row = plan.rowOf(offset);
        const span = plan.at(row);
        expect(offset, `offset ${offset} is not inside row ${row}`).toBeGreaterThanOrEqual(span.offset);
        expect(offset).toBeLessThan(span.offset + span.length);
        expect(plan.indexOf(offset)).toBe(offset - span.offset);
      }
    }
  });

  it("handles a document that is entirely one insertion", () => {
    const plans = alignedRowPlans([insert(0, 0, 32)], 0, 32, 16)!;
    expect(plans.left.rows).toBe(plans.right.rows);
    expect(Array.from({ length: plans.left.rows }, (_, row) => plans.left.at(row).length)).toEqual([0, 0]);
  });
});

describe("linearRowPlan", () => {
  it("is the arithmetic it replaced", () => {
    const plan = linearRowPlan(100, 16);
    expect(plan.rows).toBe(7);
    expect(plan.at(0)).toEqual({ offset: 0, length: 16 });
    expect(plan.at(6)).toEqual({ offset: 96, length: 4 });
    expect(plan.rowOf(20)).toBe(1);
    expect(plan.indexOf(20)).toBe(4);
  });
});
