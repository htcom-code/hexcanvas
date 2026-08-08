/**
 * Where the caret is: the byte, which column holds focus, and which nibble of that
 * byte the next hex digit would replace.
 */
export interface Cursor {
  /** Byte offset in the buffer. */
  offset: number;
  /** Which hex digit is active when editing the hex column. */
  nibble: 0 | 1;
  column: "hex" | "ascii";
}

/** A half-open byte range: `start` included, `end` not. */
export interface ByteSelection {
  /** Inclusive start byte. */
  start: number;
  /** Exclusive end byte. */
  end: number;
}

/** Holds an offset inside the document. */
export const clampOffset = (offset: number, length: number): number => Math.max(0, Math.min(offset, Math.max(0, length - 1)));

/** A selection from an anchor and a head, in either order. */
export const normalizedSelection = (anchor: number, head: number): ByteSelection => ({
  start: Math.min(anchor, head),
  end: Math.max(anchor, head) + 1,
});
