import { bench, describe } from "vitest";
import { ChangeSet } from "../src/byte-source";
import { PieceTableSource } from "../src/piece-table";

function document(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) bytes[index] = index & 0xff;
  return bytes;
}

/** Scattered, so each insert splits a different piece rather than extending one. */
function fragment(source: PieceTableSource, edits: number): void {
  const byte = Uint8Array.of(0x5a);
  for (let index = 0; index < edits; index++) {
    source.apply(ChangeSet.insert((index * 7919) % Math.max(1, source.length), byte));
  }
}

/** Typing: each byte right after the last, which is the case worth being fast. */
function typed(source: PieceTableSource, edits: number, at = 4096): void {
  for (let index = 0; index < edits; index++) {
    source.apply(ChangeSet.insert(at + index, Uint8Array.of(0x41 + (index % 26))));
  }
}

/**
 * The claim being measured is that editing cost no longer grows with how broken
 * up the document is. Reads were already logarithmic; a mutation used to rewrite
 * the whole offset index, so the ten-thousandth insert cost far more than the
 * first. So each case pre-fragments outside the timed region and then times one
 * insert, and the interesting result is that the three rates are close to each
 * other rather than any single number.
 *
 * Iterations are capped and warmup turned off because the work mutates the
 * subject: left to run to a time budget, the smallest case would fragment itself
 * into the largest one and measure nothing.
 */
const bounded = { iterations: 200, time: 0, warmupIterations: 0, warmupTime: 0 } as const;

for (const pieces of [1_000, 10_000, 50_000]) {
  describe(`one insert into ~${pieces} pieces`, () => {
    const source = new PieceTableSource(document(1 << 20));
    fragment(source, pieces);
    const byte = Uint8Array.of(0x2a);
    let step = 0;

    bench("insert", () => {
      step += 7919;
      source.apply(ChangeSet.insert(step % source.length, byte));
    }, bounded);
  });
}

describe("reading a viewport", () => {
  const fresh = new PieceTableSource(document(1 << 20));
  const written = new PieceTableSource(document(1 << 20));
  typed(written, 20_000);
  const broken = new PieceTableSource(document(1 << 20));
  fragment(broken, 20_000);
  const row = new Uint8Array(16);
  const readFrame = (source: PieceTableSource) => {
    for (let index = 0; index < 40; index++) source.peek(index * 16, 16, row);
  };

  // What the renderer does every frame, and the reason `collect` is a plain
  // function: as a recursive generator this cost the depth of the tree per row,
  // which made the scattered case ten times the unedited one.
  bench("40 rows, one piece", () => readFrame(fresh));
  bench(`40 rows after typing 20,000 bytes, ${written.pieceCount} pieces`, () => readFrame(written));
  bench(`40 rows, ${broken.pieceCount} pieces`, () => readFrame(broken));
});

describe("one call for the viewport instead of forty", () => {
  const broken = new PieceTableSource(document(1 << 20));
  fragment(broken, 20_000);
  const row = new Uint8Array(16);
  const window = new Uint8Array(640);

  // Why the renderer reads the whole window: the per-call overhead outweighs the
  // walk. This is the same 640 bytes both ways, over the same document.
  bench("40 x peek(16)", () => {
    for (let index = 0; index < 40; index++) broken.peek(index * 16, 16, row);
  });
  bench("1 x peek(640)", () => {
    broken.peek(0, 640, window);
  });
});

describe("typing a run of bytes", () => {
  // Coalescing is what keeps this from leaving a piece per keystroke.
  bench("2,000 keystrokes", () => {
    const source = new PieceTableSource(document(1 << 16));
    typed(source, 2_000);
    if (source.pieceCount > 8) throw new Error(`typing left ${source.pieceCount} pieces`);
  });
});

describe("overwriting in place", () => {
  const source = new PieceTableSource(document(1 << 20));
  let at = 0;

  // The common edit: same length, so it splits nothing and joins nothing.
  bench("one byte", () => {
    at = (at + 4099) % (source.length - 1);
    source.apply(ChangeSet.replace(at, at + 1, Uint8Array.of(0x33)));
  });
});
