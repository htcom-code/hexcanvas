/**
 * What a byte looks like in the plain-text column.
 *
 * The grid painted `byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : "."`
 * and so did the cursor description and the text copy, each writing it out
 * again. That fixed every embedding to ASCII: a hex editor over a DOS-era file,
 * an IBM code page or a Latin-1 dump could not show what its bytes actually
 * mean, which is most of what a plain-text column is for.
 *
 * A function rather than a list of encodings the library knows. There are
 * hundreds of code pages and any list would be missing the one somebody needs,
 * while a table of 256 strings is a thing a host can write in a few lines — and
 * `latin1` and `cp437` here are exactly that, offered as the two that come up
 * most rather than as the set on offer.
 *
 * ## What it may return
 *
 * **One character, always.** The column is a grid: the layout gives each byte
 * one character cell and hit-testing divides the column by that width. A
 * two-character return draws over its neighbour, and an empty one leaves the
 * rest of the row shifted. Anything that is not a single UTF-16 code unit is
 * replaced with the substitute, so a host cannot silently break the grid — a
 * combining mark, an astral emoji and `""` all come out as `.`.
 *
 * That rules out a view where one glyph stands for two bytes, which is what a
 * UTF-16 or Shift-JIS column would need. Those are a different feature: they
 * need the column to disagree with the hex one about where a cell begins.
 */

/** Substitutes for a byte that has no glyph in the chosen encoding. */
export const substituteChar = ".";

/**
 * A byte to the single character standing for it.
 *
 * Called once per byte per encoding, not per frame — the result is baked into a
 * 256-entry table, so an expensive one costs nothing after the first call.
 */
export type PrintableChar = (byte: number) => string;

/** ASCII, the default: 0x20 to 0x7E as themselves and everything else a dot. */
export const asciiPrintable: PrintableChar = (byte) =>
  byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : substituteChar;

/**
 * ISO-8859-1, where every byte is the code point of the same number.
 *
 * Three ranges are held back. C0 and C1 (0x00–0x1F, 0x80–0x9F) and DEL are
 * control characters with no glyph, which is the obvious part. **0xAD is the
 * soft hyphen**, which is the part that is not: it is a perfectly ordinary
 * character to a string API and draws nothing at all, advancing zero pixels —
 * so a row containing one came out a character short and every cell after it in
 * that row was drawn in the wrong place. A grid of fixed cells cannot hold a
 * character that takes no room.
 */
export const latin1Printable: PrintableChar = (byte) =>
  byte >= 0x20 && byte !== 0x7f && byte !== 0xad && !(byte >= 0x80 && byte <= 0x9f)
    ? String.fromCharCode(byte)
    : substituteChar;

/**
 * IBM code page 437 — the original PC character set, and the reason a hex
 * editor over a DOS binary is worth looking at. Every byte has a glyph here,
 * including the control range, which is what the box-drawing and card-suit
 * characters are.
 */
const cp437High = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒ"
  + "áíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐"
  + "└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀"
  + "αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";
const cp437Low = " ☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼";

/** Code page 437 — the box-drawing characters a DOS-era dump is read with. */
export const cp437Printable: PrintableChar = (byte) =>
  byte < 0x20 ? cp437Low[byte]!
    : byte === 0x7f ? "⌂"
    : byte < 0x7f ? String.fromCharCode(byte)
    : cp437High[byte - 0x80]!;

/**
 * The 256 glyphs an encoding draws, worked out once.
 *
 * The renderer asks for a character per byte per frame — about six hundred
 * times for a full viewport — so the function is called 256 times here instead.
 * This is also where the one-character rule is enforced, in one place, rather
 * than trusted of every host and every one of the three callers.
 */
export function printableTable(printable: PrintableChar = asciiPrintable): readonly string[] {
  return Array.from({ length: 256 }, (_, byte) => {
    const character = printable(byte);
    // `.length` counts UTF-16 code units, which is the right measure: it is
    // what the canvas advances by and what the layout assumed.
    return typeof character === "string" && character.length === 1 ? character : substituteChar;
  });
}
