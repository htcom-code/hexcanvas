import { bench, describe } from "vitest";
import { MemoryByteSource, PagedByteSource, type ByteSource } from "../src/byte-source";
import { findNext } from "../src/search";

const size = 16 * 1024 * 1024;
const data = new Uint8Array(size);
// Varied enough that the first query byte is neither absent nor everywhere: a
// scan that skips to candidates has to have candidates to skip past.
for (let index = 0; index < size; index++) data[index] = (index * 31 + (index >> 11)) & 0xff;
const needle = Uint8Array.of(0x6b, 0x6f, 0x6c, 0x79);
data.set(needle, size - 512);

/**
 * A page read that costs 1ms, which is the shape reading a real file has: reading
 * is thousands of times slower than matching, so what the scan must not do is
 * wait for one window at a time. The number to watch is how far this sits above
 * the resident case, not the absolute figure.
 */
const delayed = (pageSize: number): ByteSource => new PagedByteSource({
  length: size,
  pageSize,
  fetch: (offset, length) => new Promise((resolve) => {
    setTimeout(() => resolve(data.subarray(offset, offset + length)), 1);
  }),
});

describe("scanning to the end of 16 MB", () => {
  const resident = new MemoryByteSource(data);

  // The ceiling: no reads to wait for, so this is the matching loop alone.
  bench("resident", async () => {
    await findNext(resident, needle, 0);
  });

  bench("64 KiB pages, 1ms each", async () => {
    await findNext(delayed(64 * 1024), needle, 0);
  });

  // What it cost before reading ahead: one window requested, then awaited.
  bench("64 KiB pages, 1ms each, no read-ahead", async () => {
    await findNext(delayed(64 * 1024), needle, 0, { chunkSize: 64 * 1024, readAhead: 0 });
  });
});
