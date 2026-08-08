/** Base the address column is printed in. */
export type AddressRadix = "hex" | "decimal";

/** Bytes between the extra gaps, or 1 for none. */
export type ByteGroupSize = 1 | 2 | 4 | 8;

/**
 * Width of the decoration-label gutter, in characters. Characters rather than
 * pixels because `charWidth` is measured from the font, so "room for 16" keeps
 * its meaning when the face changes.
 */
export type LabelWidth = 16 | 32 | 64;

/** Grid font when none is given. Column widths are measured from whatever it resolves to. */
export const defaultFont = "13px ui-monospace, SFMono-Regular, Menlo, monospace";

/** Region a horizontal coordinate falls into, with the byte index inside the row. */
export interface HexHit {
  region: "address" | "hex" | "ascii";
  index: number;
}

/**
 * The gaps between the columns. One group rather than six loose options, because
 * they are only meaningful together — widening the address column without moving
 * the bytes is not a thing anyone wants.
 *
 * Pixels where the value was a pixel constant, so the defaults are the appearance
 * that shipped. Characters where the quantity is inherently counted in them, and
 * those scale with the measured font rather than staying put when it changes.
 */
export interface HexSpacing {
  /** Left of the address digits, in pixels. Defaults to 12. */
  addressPaddingLeft?: number;
  /** Between the address digits and the first byte, in pixels. Defaults to 16. */
  addressPaddingRight?: number;
  /** Between the hex column and the plain-text one, in pixels. Defaults to 28. */
  columnGutter?: number;
  /** Before a decoration label, in pixels. Defaults to 16. */
  labelGutter?: number;
  /**
   * Between one byte's digits and the next, in character widths. Defaults to 1,
   * which is what makes a byte three characters wide: two digits and a gap.
   */
  byteGap?: number;
  /**
   * Fewest address digits to show. Defaults to 8, so a short file's addresses are
   * the width a long one's would be and the column does not jump as it grows.
   */
  minimumAddressDigits?: number;
}

/** Every gap resolved, for a host drawing its own overlay against the grid. */
export type ResolvedSpacing = Required<HexSpacing>;

/** What `createLayout` measures a grid from. */
export interface LayoutOptions {
  bytesPerRow: number;
  /** Total buffer length; decides how many address digits the column needs. */
  byteLength: number;
  byteGroup?: ByteGroupSize;
  addressRadix?: AddressRadix;
  font?: string;
  /** Overrides measurement, for environments without a canvas. */
  charWidth?: number;
  /** Draw the plain-text column beside the hex one. Defaults to true. */
  asciiColumn?: boolean;
  /**
   * Reserve the label gutter. Off by default, and the reason it is separate from
   * `labelWidth`: an unreserved gutter is not merely narrow, it is outside
   * `width`, so nothing can scroll to it.
   */
  labelGutter?: boolean;
  /** How much to reserve when `labelGutter` is set. Defaults to 16 characters. */
  labelWidth?: LabelWidth;
  /** The gaps between the columns. Anything omitted keeps its default. */
  spacing?: HexSpacing;
}

/**
 * Column geometry shared by the renderer and by pointer hit-testing. Both must
 * agree on every coordinate, so neither may hardcode its own metrics.
 */
export interface HexLayout {
  /**
   * The resolved font. Column widths come from measuring it, not from assuming a
   * monospace width.
   */
  readonly font: string;
  /**
   * Width of one character in the resolved font. Every horizontal figure below is a
   * multiple of it.
   */
  readonly charWidth: number;
  /** Bytes each row shows. */
  readonly bytesPerRow: number;
  /** Bytes between the extra gaps, or 1 for none. */
  readonly byteGroup: ByteGroupSize;
  /** Base `formatAddress` prints in. */
  readonly addressRadix: AddressRadix;
  /**
   * Digits an address is padded to — from the document's length, so the column does
   * not change width as it scrolls.
   */
  readonly addressDigits: number;
  /** Left edge of the address column, in grid pixels. */
  readonly addressX: number;
  /** Width of the address column, gutter included. */
  readonly addressWidth: number;
  /**
   * Where the hex column begins. Everything left of this hit-tests as the address
   * gutter, which is what makes clicking it toggle a bookmark.
   */
  readonly hexStart: number;
  /** Where the plain-text column begins, or the end of the hex one when it is off. */
  readonly asciiStart: number;
  /** Whether the plain-text column is drawn. Both painting and hit-testing read it. */
  readonly asciiColumn: boolean;
  /**
   * Where a decoration label starts. Owned here rather than worked out by the
   * renderer, because a label placed past `width` cannot be scrolled to.
   */
  readonly labelStart: number;
  /** Reserved label width in pixels, or 0 when the gutter is not reserved. */
  readonly labelWidth: number;
  /** Content width of one row, including trailing padding. */
  readonly width: number;
  /** The gaps in force, defaults merged with whatever the host asked for. */
  readonly spacing: ResolvedSpacing;
  /**
   * Left edge of the byte at `index` in its row, in grid pixels. Grid pixels are
   * unscrolled: subtract `scrollLeft` to place something on screen.
   */
  byteX(index: number): number;
  /** Left edge of one nibble of a byte — where the caret's underline goes. */
  nibbleX(index: number, nibble: 0 | 1): number;
  /** Left edge of the character at `index` in the plain-text column. */
  asciiX(index: number): number;
  /**
   * An offset as the address column writes it: padded to `addressDigits`, in
   * `addressRadix`, upper case for hex.
   */
  formatAddress(offset: number): string;
  /**
   * The inverse of the three above: which region and which byte an x lands on. The
   * renderer and the pointer handling must share one layout instance, or what is
   * drawn and what is clicked drift apart.
   */
  hitTest(x: number): HexHit;
}

/**
 * `labelGutter` is the value the renderer used before the gutter was reserved, so
 * turning labels on does not also shift where they sit.
 */
const defaultSpacing: ResolvedSpacing = {
  addressPaddingLeft: 12,
  addressPaddingRight: 16,
  columnGutter: 28,
  labelGutter: 16,
  byteGap: 1,
  minimumAddressDigits: 8,
};

const defaultLabelWidth: LabelWidth = 16;

/**
 * Clamped rather than validated: a negative gap has no meaning and throwing over
 * one would be a hard failure for a slider that went one step too far. Digits are
 * floored at one, since a column of no digits is not an address column.
 */
function resolveSpacing(spacing: HexSpacing = {}): ResolvedSpacing {
  const at = (value: number | undefined, fallback: number, least = 0) =>
    value === undefined || !Number.isFinite(value) ? fallback : Math.max(least, value);
  return {
    addressPaddingLeft: at(spacing.addressPaddingLeft, defaultSpacing.addressPaddingLeft),
    addressPaddingRight: at(spacing.addressPaddingRight, defaultSpacing.addressPaddingRight),
    columnGutter: at(spacing.columnGutter, defaultSpacing.columnGutter),
    labelGutter: at(spacing.labelGutter, defaultSpacing.labelGutter),
    byteGap: at(spacing.byteGap, defaultSpacing.byteGap),
    minimumAddressDigits: at(spacing.minimumAddressDigits, defaultSpacing.minimumAddressDigits, 1),
  };
}

const charWidthCache = new Map<string, number>();

/** Average advance width of the font, measured once per font string. */
export function measureCharWidth(font: string): number {
  const cached = charWidthCache.get(font);
  if (cached !== undefined) return cached;
  if (typeof document === "undefined") return 9;
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return 9;
  context.font = font;
  const sample = "0123456789ABCDEF";
  const width = context.measureText(sample).width / sample.length;
  const measured = width > 0 ? width : 9;
  charWidthCache.set(font, measured);
  return measured;
}

const uniformCache = new Map<string, boolean>();

/**
 * Whether every character the grid draws advances by exactly `charWidth`.
 *
 * This is what lets the renderer draw a row as one string instead of one call
 * per byte. `charWidth` is an average, so on a proportional face the glyphs of
 * a single run would drift away from the columns the layout promised — by the
 * sixteenth byte, badly. Measured over a run as long as a row rather than a
 * character or two, because the error that matters is the accumulated one.
 */
export function hasUniformAdvance(
  measure: (text: string) => number,
  font: string,
  charWidth: number,
  /**
   * The plain-text column's glyphs. Part of the key as well as the sample:
   * a host can change the encoding without changing the face, and the answer
   * is about the pair.
   */
  printableChars?: readonly string[],
): boolean {
  // Distinct glyphs, sorted, so two encodings that draw the same set share an
  // answer and the key does not depend on byte order.
  const glyphs = printableChars ? [...new Set(printableChars)].sort().join("") : "";
  const key = `${font}\u0000${glyphs}`;
  const cached = uniformCache.get(key);
  if (cached !== undefined) return cached;
  // Everything the grid can draw: hex digits, the separator, the stand-in for
  // a byte that is not resident — and the encoding's own glyphs, which is the
  // part that used to be missing. While the column was always ASCII the sample
  // covered it by accident; a host's code page can contain a character that is
  // a different width, or none at all, and drawing a row as one string then
  // puts every cell after it in the wrong place.
  const sample = "0123456789ABCDEF ·".repeat(4) + glyphs;
  const drift = Math.abs(measure(sample) - sample.length * charWidth);
  // A quarter of a pixel over 72 characters. Anything looser lets a face that
  // is nearly monospaced through, and "nearly" is what produces a column that
  // is right at the left edge and wrong at the right.
  // Scaled with the sample: the tolerance is a quarter pixel over the
  // seventy-two characters it was written for, not a fixed budget that an
  // encoding's extra glyphs would have to fit inside as well.
  const uniform = drift <= 0.25 * (sample.length / 72);
  uniformCache.set(key, uniform);
  return uniform;
}

/**
 * Drops measurements so the next layout re-measures. A web font that finishes
 * loading after the first measurement would otherwise leave the columns sized
 * for the fallback face for the rest of the session.
 */
export function invalidateFontMetrics(font?: string): void {
  if (font === undefined) {
    charWidthCache.clear();
    uniformCache.clear();
    return;
  }
  charWidthCache.delete(font);
  // One face, one entry per encoding it has been asked about.
  for (const key of [...uniformCache.keys()]) {
    if (key === font || key.startsWith(`${font}\u0000`)) uniformCache.delete(key);
  }
}

/** Digits an address column needs for a document of this size. */
export function addressDigitsFor(byteLength: number, radix: AddressRadix, minimum = defaultSpacing.minimumAddressDigits): number {
  const last = Math.max(0, byteLength - 1);
  const digits = radix === "hex" ? last.toString(16).length : last.toString(10).length;
  return Math.max(minimum, digits);
}

/**
 * Every horizontal coordinate of the grid, and the inverse mapping the hit test uses.
 * One instance is shared by the renderer and the input handling so the two cannot drift.
 */
export function createLayout(options: LayoutOptions): HexLayout {
  const font = options.font ?? defaultFont;
  const charWidth = options.charWidth ?? measureCharWidth(font);
  const bytesPerRow = options.bytesPerRow;
  const byteGroup = options.byteGroup ?? 1;
  const addressRadix = options.addressRadix ?? "hex";
  const spacing = resolveSpacing(options.spacing);
  const addressDigits = addressDigitsFor(options.byteLength, addressRadix, spacing.minimumAddressDigits);
  const addressWidth = spacing.addressPaddingLeft + addressDigits * charWidth + spacing.addressPaddingRight;
  const hexStart = addressWidth;
  // Two digits and the gap after them.
  const byteWidth = charWidth * (2 + spacing.byteGap);
  const groupGap = byteGroup > 1 ? charWidth : 0;
  const gapsBefore = (index: number) => (groupGap === 0 ? 0 : Math.floor(index / byteGroup) * groupGap);
  const byteX = (index: number) => hexStart + index * byteWidth + gapsBefore(index);
  const hexWidth = bytesPerRow * byteWidth + gapsBefore(bytesPerRow - 1);
  const asciiColumn = options.asciiColumn ?? true;
  // Without the column there is no gutter either, so an accidental `asciiX` lands
  // at the end of the hex column rather than in blank space past the row.
  const asciiStart = asciiColumn ? hexStart + hexWidth + spacing.columnGutter : hexStart + hexWidth;
  const rowEnd = asciiColumn ? asciiStart + bytesPerRow * charWidth : asciiStart;
  const labelStart = rowEnd + spacing.labelGutter;
  const labelWidth = options.labelGutter ? (options.labelWidth ?? defaultLabelWidth) * charWidth : 0;
  const clampIndex = (index: number) => Math.max(0, Math.min(bytesPerRow - 1, index));

  return {
    font,
    charWidth,
    bytesPerRow,
    byteGroup,
    addressRadix,
    addressDigits,
    addressX: spacing.addressPaddingLeft,
    addressWidth,
    hexStart,
    asciiStart,
    asciiColumn,
    labelStart,
    labelWidth,
    spacing,
    width: (labelWidth > 0 ? labelStart + labelWidth : rowEnd) + spacing.addressPaddingLeft,
    byteX,
    nibbleX: (index, nibble) => byteX(index) + nibble * charWidth,
    asciiX: (index) => asciiStart + index * charWidth,
    formatAddress: (offset) => (addressRadix === "hex"
      ? offset.toString(16).padStart(addressDigits, "0").toUpperCase()
      : offset.toString(10).padStart(addressDigits, "0")),
    hitTest(x) {
      if (x < hexStart) return { region: "address", index: 0 };
      // Never answers "ascii" while the column is off, which is what keeps the
      // cursor out of a column that is not there.
      if (asciiColumn && x >= asciiStart - spacing.columnGutter / 2) return { region: "ascii", index: clampIndex(Math.floor((x - asciiStart) / charWidth)) };
      const groupWidth = byteGroup * byteWidth + groupGap;
      const group = Math.floor((x - hexStart) / groupWidth);
      const withinGroup = x - hexStart - group * groupWidth;
      const offsetInGroup = Math.min(byteGroup - 1, Math.floor(withinGroup / byteWidth));
      return { region: "hex", index: clampIndex(group * byteGroup + offsetInGroup) };
    },
  };
}
