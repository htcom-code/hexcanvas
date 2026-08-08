import { bench, describe } from "vitest";
import { MemoryByteSource } from "../src/byte-source";
import { compareAligned } from "../src/diff";
import { compareAnchored } from "../src/anchored-diff";
import { compareEditScript } from "../src/edit-script";

const size = 1024 * 1024;
const original = new Uint8Array(size);
for (let at = 0; at < size; at++) original[at] = (at * 7) & 0xff;

const changed = original.slice();
changed[size / 2] = changed[size / 2]! ^ 0xff;

/** The case aligned comparison cannot describe: everything after byte 0 moves. */
const shifted = new Uint8Array(size + 1);
shifted[0] = 0x99;
shifted.set(original, 1);

const left = new MemoryByteSource(original);
const oneByteApart = new MemoryByteSource(changed);
const shiftedByOne = new MemoryByteSource(shifted);

describe("1 MiB, one byte changed", () => {
  bench("edit script", async () => { await compareEditScript(left, oneByteApart); });
  bench("aligned", async () => { await compareAligned(left, oneByteApart); });
});

/**
 * The comparison the two disagree about. Aligned reports hundreds of runs for
 * what the edit script calls one insertion, so this is not a like-for-like race
 * — it is what the extra cost buys.
 */
describe("1 MiB, one byte inserted at the front", () => {
  bench("edit script", async () => { await compareEditScript(left, shiftedByOne); });
  bench("aligned", async () => { await compareAligned(left, shiftedByOne); });
});

/**
 * The pair neither of the others is for: too large to hold, and shifted. The
 * aligned comparison answers it wrongly-but-fast; anchoring answers it.
 */
describe("8 MiB, one byte inserted at the front", () => {
  const big = new Uint8Array(8 * 1024 * 1024);
  for (let at = 0; at < big.length; at++) big[at] = (at * 31) & 0xff;
  const grown = new Uint8Array(big.length + 1);
  grown[0] = 0x99;
  grown.set(big, 1);
  const from = new MemoryByteSource(big);
  const to = new MemoryByteSource(grown);

  bench("anchored", async () => { await compareAnchored(from, to); });
  bench("aligned", async () => { await compareAligned(from, to); });
});
