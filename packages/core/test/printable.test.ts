import { describe, expect, it } from "vitest";
import { MemoryByteSource } from "../src/byte-source";
import { HexEngine } from "../src/engine";
import { hasUniformAdvance } from "../src/layout";
import {
  asciiPrintable,
  cp437Printable,
  latin1Printable,
  printableTable,
  substituteChar,
} from "../src/printable";

const everyByte = Array.from({ length: 256 }, (_, byte) => byte);

/**
 * The plain-text column is a grid, and the layout gives each byte exactly one
 * character cell. An encoding that returns anything else does not merely look
 * odd — it draws over its neighbour or leaves the row short, and the hit test
 * that divides the column by a character width stops agreeing with what is on
 * screen. So the table is the place the rule is kept, once, rather than trusted
 * of every host.
 */
describe("printableTable", () => {
  it("is 256 entries of exactly one character, whatever it was given", () => {
    for (const printable of [asciiPrintable, latin1Printable, cp437Printable]) {
      const table = printableTable(printable);
      expect(table).toHaveLength(256);
      for (const [byte, glyph] of table.entries()) {
        expect(glyph.length, `byte ${byte} drew ${JSON.stringify(glyph)}`).toBe(1);
      }
    }
  });

  it("substitutes for anything that is not one character", () => {
    // Every way a host can get it wrong: too long, empty, an astral pair, and
    // a value that is not a string at all.
    const wrong = printableTable((byte) => (
      byte === 1 ? "ab"
        : byte === 2 ? ""
        : byte === 3 ? "😀"
        : byte === 4 ? (undefined as unknown as string)
        : "x"
    ));
    expect(wrong[1]).toBe(substituteChar);
    expect(wrong[2]).toBe(substituteChar);
    // Astral: two UTF-16 code units, so one cell cannot hold it.
    expect(wrong[3]).toBe(substituteChar);
    expect(wrong[4]).toBe(substituteChar);
    expect(wrong[5]).toBe("x");
  });

  it("walks the encoding once rather than per lookup", () => {
    let calls = 0;
    const table = printableTable((byte) => { calls++; return String.fromCharCode(65 + (byte % 26)); });
    expect(calls).toBe(256);
    for (let round = 0; round < 100; round++) void table[round];
    expect(calls).toBe(256);
  });
});

describe("the encodings that come with the library", () => {
  it("ascii is the test it replaced", () => {
    const table = printableTable(asciiPrintable);
    for (const byte of everyByte) {
      expect(table[byte]).toBe(byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : substituteChar);
    }
  });

  it("latin1 draws the high range and refuses the control blocks", () => {
    const table = printableTable(latin1Printable);
    expect(table[0xe9]).toBe("é");
    expect(table[0xdf]).toBe("ß");
    expect(table[0xa9]).toBe("©");
    // C0, DEL and C1 have no glyph.
    expect(table[0x00]).toBe(substituteChar);
    expect(table[0x1f]).toBe(substituteChar);
    expect(table[0x7f]).toBe(substituteChar);
    expect(table[0x80]).toBe(substituteChar);
    expect(table[0x9f]).toBe(substituteChar);
    expect(table[0xa0]).toBe(" ");
  });

  /** Spot-checked against the published code page, one per region. */
  /**
   * Found by looking at the painted grid, not by reading the code page. 0xAD is
   * the soft hyphen: an ordinary character to every string API, and zero pixels
   * wide when drawn. The row containing one came out a character short and
   * every cell after it in that row was painted one place to the left.
   */
  it("refuses the soft hyphen, which is a character that takes no room", () => {
    expect(latin1Printable(0xad)).toBe(substituteChar);
    // Its neighbours are ordinary printable characters, so this is one code
    // point held back rather than a range.
    expect(latin1Printable(0xac)).toBe("\u00ac");
    expect(latin1Printable(0xae)).toBe("\u00ae");
  });

  it("cp437 gives every byte a glyph, including the control range", () => {
    const table = printableTable(cp437Printable);
    // Every byte has one, so the only "." in the table is the actual full stop
    // at 0x2E. Nothing here is standing in for a byte it could not draw — which
    // is the whole reason to look at a DOS binary in this encoding.
    const dots = table.flatMap((glyph, byte) => (glyph === substituteChar ? [byte] : []));
    expect(dots).toEqual([0x2e]);
    for (const [byte, want] of [
      [0x00, " "], [0x01, "☺"], [0x0e, "♫"], [0x1f, "▼"],
      [0x41, "A"], [0x7e, "~"], [0x7f, "⌂"],
      [0x80, "Ç"], [0x9b, "¢"], [0xb0, "░"], [0xc5, "┼"], [0xdb, "█"],
      [0xe1, "ß"], [0xfe, "■"], [0xff, " "],
    ] as const) {
      expect(table[byte], `byte 0x${byte.toString(16)}`).toBe(want);
    }
  });
});

/**
 * The point of putting this on the engine rather than the renderer: the ASCII
 * test was written out in three places, and a host changing one of them got a
 * grid that disagreed with what it copied and what it announced.
 */
describe("an engine's encoding reaches everything that shows a character", () => {
  const engineOver = (bytes: number[], printable = cp437Printable) => new HexEngine({
    source: new MemoryByteSource(Uint8Array.from(bytes)),
    printable,
  });

  it("reaches the cursor description a screen reader reads", () => {
    const engine = engineOver([0xdb]);
    expect(engine.describeCursor()).toContain("character █");
  });

  it("still says nothing about a byte with no glyph", () => {
    // Latin-1 has no C1 glyphs, so 0x90 is a substitute and there is no
    // character to announce — as opposed to announcing a dot.
    const engine = engineOver([0x90], latin1Printable);
    expect(engine.describeCursor()).not.toContain("character");
  });

  it("reaches a copy as text", () => {
    const engine = engineOver([0xc9, 0xcd, 0xbb]);
    engine.select(0, 3);
    expect(engine.selectionText("text")).toBe("╔═╗");
  });

  it("is ASCII when nothing asked for anything else", () => {
    const engine = new HexEngine({ source: new MemoryByteSource(Uint8Array.of(0xdb, 0x41)) });
    engine.select(0, 2);
    expect(engine.selectionText("text")).toBe(".A");
  });

  it("changes with the option rather than being fixed at construction", () => {
    const engine = engineOver([0xdb], asciiPrintable);
    engine.select(0, 1);
    expect(engine.selectionText("text")).toBe(substituteChar);
    // `setOptions` takes everything but the source; the document does not
    // change because the encoding did.
    engine.setOptions({ printable: cp437Printable });
    engine.select(0, 1);
    expect(engine.selectionText("text")).toBe("█");
  });
});

/**
 * The other three values the same audit found. Each was a module constant a
 * host could read and not set — which is the shape that looks configurable in
 * the API docs and is not.
 */
describe("the search caps a host can now set", () => {
  const repeated = (length: number) => new MemoryByteSource(new Uint8Array(length));

  const searching = (options: { searchMatchLimit?: number; searchPriority?: number }) => {
    const engine = new HexEngine({ source: repeated(400), search: "native", ...options });
    engine.openSearch();
    engine.setSearchQuery("00");
    return engine;
  };

  it("stops at the limit it was given, and says it stopped", async () => {
    const engine = searching({ searchMatchLimit: 10 });
    await engine.findAllMatches();
    expect(engine.getState().searchMatchCount).toBe(10);
    expect(engine.getState().searchTruncated).toBe(true);
  });

  it("keeps the thousand-hit default when nothing asked", async () => {
    const engine = searching({});
    await engine.findAllMatches();
    // 400 bytes of zeroes is well under the default, so nothing is truncated —
    // the point being that the cap did not become the option's `undefined`.
    expect(engine.getState().searchMatchCount).toBe(400);
    expect(engine.getState().searchTruncated).toBe(false);
  });

  it("paints hits at the priority it was given", async () => {
    const engine = searching({ searchPriority: 99 });
    await engine.findAllMatches();
    // A host whose own overlays sit at 5 or above could not lift a hit over
    // them, because only its own side of the comparison was adjustable.
    expect(engine.matches[0]?.priority).toBe(99);
  });

  it("keeps 5 by default, above structure overlays", async () => {
    const engine = searching({});
    await engine.findAllMatches();
    expect(engine.matches[0]?.priority).toBe(5);
  });
});

/**
 * The row-batching fast path draws a whole row as one `fillText`, which is only
 * right if every glyph advances by the same width. That was checked against a
 * fixed sample of hex digits and a dot — true of the ASCII column by accident,
 * and no longer true of anything once a host can choose the glyphs.
 */
describe("hasUniformAdvance over a host's encoding", () => {
  /** A face where everything is 10 wide except the characters named. */
  const face = (odd: Record<string, number> = {}) =>
    (text: string) => Array.from(text).reduce((total, char) => total + (odd[char] ?? 10), 0);

  it("passes a face that is uniform over the glyphs actually in use", () => {
    const table = printableTable(cp437Printable);
    expect(hasUniformAdvance(face(), "uniform-face", 10, table)).toBe(true);
  });

  it("fails when one of those glyphs takes no room at all", () => {
    // The soft-hyphen shape: a single ordinary-looking character that measures
    // zero. Batched, it shifts every cell after it in its row.
    const table = printableTable((byte) => (byte === 0x41 ? "­" : "x"));
    expect(hasUniformAdvance(face({ "­": 0 }), "zero-width-face", 10, table)).toBe(false);
  });

  it("fails when one of them is merely wider", () => {
    const table = printableTable((byte) => (byte === 0x41 ? "—" : "x"));
    expect(hasUniformAdvance(face({ "—": 19 }), "wide-face", 10, table)).toBe(false);
  });

  it("answers per encoding, not per face", () => {
    // Same font, two encodings, different answers — so the cache cannot be
    // keyed on the face alone, which is what it used to be.
    const measure = face({ "­": 0 });
    const good = printableTable(() => "x");
    const bad = printableTable((byte) => (byte === 0x41 ? "­" : "x"));
    expect(hasUniformAdvance(measure, "shared-face", 10, good)).toBe(true);
    expect(hasUniformAdvance(measure, "shared-face", 10, bad)).toBe(false);
  });
});
