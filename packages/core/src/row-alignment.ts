import type { HexDifference } from "./diff.js";
import type { RowPlan, RowSpan } from "./viewport.js";

/**
 * Row plans that put corresponding bytes on the same line.
 *
 * Once an edit script has recognised that a byte was inserted, the two
 * documents' matching bytes sit at different offsets — everything after the
 * insertion is one further along on one side. Read side by side against the
 * usual arithmetic, that puts unrelated bytes level with each other, which is
 * the one thing a comparison must not do. So the shorter side leaves a gap.
 *
 * Rows are broken only where the skew changes, not at every difference. A
 * replacement of the same length on both sides moves nothing, and breaking
 * there would turn a clean grid into ragged rows for no gain — which is what
 * the aligned comparison's output is almost entirely made of.
 */
export function alignedRowPlans(
  differences: readonly HexDifference[],
  leftLength: number,
  rightLength: number,
  bytesPerRow: number,
): { left: RowPlan; right: RowPlan } | undefined {
  // Only a difference of unequal length moves anything after it. With none, the
  // two documents already line up and the usual arithmetic is the right answer.
  const shifting = differences.filter((difference) =>
    difference.left.end - difference.left.start !== difference.right.end - difference.right.start);
  if (shifting.length === 0) return undefined;

  const left: RowSpan[] = [];
  const right: RowSpan[] = [];

  /**
   * One stretch of each document laid out together. Both get their own rows,
   * and whichever needs fewer is padded to the other's height with gaps.
   */
  const region = (leftStart: number, leftSize: number, rightStart: number, rightSize: number): void => {
    const leftRows = Math.ceil(leftSize / bytesPerRow);
    const rightRows = Math.ceil(rightSize / bytesPerRow);
    const height = Math.max(leftRows, rightRows);
    for (let row = 0; row < height; row++) {
      const at = row * bytesPerRow;
      left.push(row < leftRows
        ? { offset: leftStart + at, length: Math.min(bytesPerRow, leftSize - at) }
        : { offset: leftStart + leftSize, length: 0 });
      right.push(row < rightRows
        ? { offset: rightStart + at, length: Math.min(bytesPerRow, rightSize - at) }
        : { offset: rightStart + rightSize, length: 0 });
    }
  };

  let leftAt = 0;
  let rightAt = 0;
  for (const difference of shifting) {
    // What the two agree about between the last shift and this one. Equal in
    // length by construction — only a shifting difference changes the skew, and
    // every one of them ends a region — but taken as the larger of the two so a
    // provider that broke that promise loses bytes off the end of a row rather
    // than dropping them.
    region(
      leftAt,
      Math.max(difference.left.start - leftAt, difference.right.start - rightAt),
      rightAt,
      Math.max(difference.left.start - leftAt, difference.right.start - rightAt),
    );
    region(
      difference.left.start,
      difference.left.end - difference.left.start,
      difference.right.start,
      difference.right.end - difference.right.start,
    );
    leftAt = difference.left.end;
    rightAt = difference.right.end;
  }
  region(leftAt, leftLength - leftAt, rightAt, rightLength - rightAt);

  return { left: planOf(left), right: planOf(right) };
}

/** A plan over rows already laid out, with the lookups a viewport needs. */
function planOf(rows: readonly RowSpan[]): RowPlan {
  // Only the rows that hold something, for the offset lookup. A gap holds no
  // byte, so no offset is ever inside one.
  const starts: number[] = [];
  const indexes: number[] = [];
  for (let row = 0; row < rows.length; row++) {
    if (rows[row]!.length === 0) continue;
    starts.push(rows[row]!.offset);
    indexes.push(row);
  }
  const empty: RowSpan = { offset: 0, length: 0 };

  /** The last filled row starting at or before `offset`. */
  const search = (offset: number): number => {
    let low = 0;
    let high = starts.length - 1;
    let found = 0;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (starts[middle]! <= offset) {
        found = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    return found;
  };

  return {
    rows: rows.length,
    at: (row) => rows[row] ?? empty,
    rowOf: (offset) => (starts.length === 0 ? 0 : indexes[search(offset)]!),
    indexOf: (offset) => {
      if (starts.length === 0) return 0;
      const at = search(offset);
      return Math.max(0, offset - starts[at]!);
    },
  };
}
