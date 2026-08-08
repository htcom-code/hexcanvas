import { throwIfAborted, type ByteSource } from "./byte-source.js";

/** One hit, as a half-open range. */
export interface SearchMatch {
  start: number;
  end: number;
}

/** Parses user-friendly hex such as `DE AD BE EF` or `deadbeef`. */
export function parseHexQuery(value: string): Uint8Array {
  const normalized = value.replace(/\s+/g, "");
  if (!normalized || normalized.length % 2 !== 0 || !/^[\da-f]+$/i.test(normalized)) {
    throw new Error("A hex query must contain an even number of hexadecimal digits.");
  }
  const result = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < result.length; index++) result[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  return result;
}

/**
 * Big enough that a paged source loads several pages per window, since it
 * fetches the pages of one `ensure` together, and small enough that a few
 * windows in flight stay inside a modest resident budget.
 */
const defaultChunkSize = 256 * 1024;

/**
 * Windows requested ahead of the one being matched. Reading is thousands of
 * times slower than matching — a scan of 100 MB spends 130ms comparing bytes and
 * seconds waiting for them — so the point is to have the next reads already in
 * flight rather than to start one and wait.
 */
const defaultReadAhead = 3;

/**
 * Tuning for a scan. The defaults keep about 1 MB in flight, which is what took
 * searching a real file from 14 MB/s to 200.
 */
export interface SearchOptions {
  chunkSize?: number;
  readAhead?: number;
  /**
   * Abandons the scan, and the reads it has already asked for with it. A scan
   * the engine has superseded used to keep reading a large file to the end for
   * a query nobody was waiting on any more.
   */
  signal?: AbortSignal;
}

/**
 * Where matches come from. The default one scans bytes, but a host can answer
 * with anything — a regular expression, a wildcard, a server that already
 * indexed the file.
 *
 * The query arrives as the text the user typed plus the mode it was typed in,
 * not as bytes: a pattern is not expressible as a `Uint8Array`, so parsing has
 * to belong to whoever understands the mode. Reject to complain; the message is
 * what the panel shows.
 */
export interface SearchProvider {
  findNext(source: ByteSource, query: string, mode: string, from: number, signal?: AbortSignal): Promise<SearchMatch | undefined>;
  findPrevious(source: ByteSource, query: string, mode: string, before: number, signal?: AbortSignal): Promise<SearchMatch | undefined>;
  /** Optional; falls back to repeated `findNext`, which is what `findAll` does. */
  findAll?(source: ByteSource, query: string, mode: string, limit: number, signal?: AbortSignal): Promise<SearchMatch[]>;
  /**
   * Bytes to write over a hit. Optional; the fallback reads the replacement in
   * the query's own mode. A pattern provider needs it for back-references, which
   * differ per match.
   */
  replacement?(match: SearchMatch, replacement: string, mode: string): Uint8Array;
}

/** Reads the text as the mode says: bytes for hex, UTF-8 for text. */
export function encodeQuery(query: string, mode: string): Uint8Array {
  return mode === "text" ? new TextEncoder().encode(query) : parseHexQuery(query);
}

/**
 * The library's own provider, over the functions above. The engine goes through
 * this rather than calling them directly, so the internal path and a host's are
 * the same path — one set of behaviour to get right.
 */
export function createByteSearchProvider(options: SearchOptions = {}): SearchProvider {
  return {
    findNext: async (source, query, mode, from, signal) => findNext(source, encodeQuery(query, mode), from, { ...options, signal }),
    findPrevious: async (source, query, mode, before, signal) => findPrevious(source, encodeQuery(query, mode), before, { ...options, signal }),
    findAll: async (source, query, mode, limit, signal) => findAll(source, encodeQuery(query, mode), limit, { ...options, signal }),
    // An empty hex replacement is a deletion, which is a legitimate thing to want,
    // so it is not treated as an unparseable query.
    replacement: (_match, replacement, mode) => mode === "text"
      ? new TextEncoder().encode(replacement)
      : replacement.trim() === "" ? new Uint8Array(0) : parseHexQuery(replacement),
  };
}

/**
 * Scans in windows instead of copying the whole source per call, so cost is
 * proportional to the distance searched rather than to the file size. Windows
 * overlap by `query.length - 1` so a match never falls between them, and the
 * next few are requested before the current one is matched.
 */
export async function findNext(
  source: ByteSource,
  query: Uint8Array,
  from = 0,
  options: SearchOptions | number = {},
): Promise<SearchMatch | undefined> {
  if (query.length === 0 || query.length > source.length) return undefined;
  const { chunkSize, readAhead, signal } = resolve(options);
  const overlap = query.length - 1;
  const window = Math.max(chunkSize, query.length * 2);
  const step = window - overlap;
  const last = source.length - query.length;
  const ahead = new Reader(source, window, step, readAhead, 1, signal);

  for (let start = Math.max(0, from); start <= last; start += step) {
    throwIfAborted(signal, "The search was aborted.");
    const chunk = await ahead.read(start, last);
    const found = scan(chunk, query, chunk.length - query.length);
    if (found >= 0) return { start: start + found, end: start + found + query.length };
    if (chunk.length <= overlap) break;
  }
  return undefined;
}

/** Last match starting strictly before `before`. */
export async function findPrevious(
  source: ByteSource,
  query: Uint8Array,
  before = source.length,
  options: SearchOptions | number = {},
): Promise<SearchMatch | undefined> {
  if (query.length === 0 || query.length > source.length) return undefined;
  const { chunkSize, readAhead, signal } = resolve(options);
  const overlap = query.length - 1;
  const window = Math.max(chunkSize, query.length * 2);
  const step = window - overlap;
  const ahead = new Reader(source, window, step, readAhead, -1, signal);

  let end = Math.min(before + overlap, source.length);
  while (end >= query.length) {
    throwIfAborted(signal, "The search was aborted.");
    const start = Math.max(0, end - window);
    const chunk = await ahead.read(start, source.length - query.length, end - start);
    const found = scanBack(chunk, query, (offset) => start + offset < before);
    if (found >= 0) return { start: start + found, end: start + found + query.length };
    if (start === 0) break;
    end = start + overlap;
  }
  return undefined;
}

/**
 * Every hit, up to `limit`. Streams rather than materialising the document, and
 * stops at the cap instead of building an unbounded list for a query like a single
 * `00` byte over a gigabyte.
 */
export async function findAll(source: ByteSource, query: Uint8Array, limit = 1_000, options: SearchOptions = {}): Promise<SearchMatch[]> {
  const matched: SearchMatch[] = [];
  let from = 0;
  while (matched.length < limit) {
    throwIfAborted(options.signal, "The search was aborted.");
    const match = await findNext(source, query, from, options);
    if (!match) break;
    matched.push(match);
    from = match.start + 1;
  }
  return matched;
}

/** The chunk size used to be the fourth argument; both spellings still work. */
function resolve(options: SearchOptions | number): { chunkSize: number; readAhead: number; signal: AbortSignal | undefined } {
  if (typeof options === "number") return { chunkSize: options, readAhead: defaultReadAhead, signal: undefined };
  return {
    chunkSize: options.chunkSize ?? defaultChunkSize,
    readAhead: options.readAhead ?? defaultReadAhead,
    signal: options.signal,
  };
}

/**
 * Keeps a few windows requested ahead of the one being read. `ensure` is
 * idempotent, so asking early costs nothing beyond the source's own residency
 * budget — and if a window was evicted before it was matched, `read` simply
 * waits for it again.
 */
class Reader {
  private readonly requested = new Map<number, Promise<void>>();
  /**
   * One buffer for every window. Reading without one makes a source that has to
   * assemble bytes — a paged reader, or a piece table over one — allocate and copy
   * a fresh window each time, which was most of the cost of a scan.
   */
  private readonly buffer: Uint8Array;

  constructor(
    private readonly source: ByteSource,
    private readonly window: number,
    private readonly step: number,
    private readonly readAhead: number,
    private readonly direction: 1 | -1 = 1,
    /** Handed to every read, so giving up stops the fetches and not just the wait. */
    private readonly signal: AbortSignal | undefined = undefined,
  ) {
    this.buffer = new Uint8Array(window);
  }

  async read(start: number, last: number, length = Math.min(this.window, this.source.length - start)): Promise<Uint8Array> {
    this.request(start, Math.min(this.window, this.source.length - start), last);
    for (let index = 1; index <= this.readAhead; index++) {
      const at = start + this.direction * index * this.step;
      this.request(at, Math.min(this.window, this.source.length - at), last);
    }
    const resident = this.source.peek(start, length, this.buffer);
    if (resident) {
      this.requested.delete(start);
      return resident;
    }
    await this.requested.get(start);
    this.requested.delete(start);
    return this.source.peek(start, length, this.buffer)
      ?? (await this.source.ensure(start, length, this.signal), this.source.peek(start, length, this.buffer))
      ?? new Uint8Array(0);
  }

  private request(at: number, length: number, last: number): void {
    if (at < 0 || at > last || length <= 0 || this.requested.has(at)) return;
    // The rejection is handled where the window is awaited. Attached here as
    // well, because a read-ahead window nobody reaches — the scan ended, or was
    // cancelled — would otherwise reject with no one listening.
    const request = this.source.ensure(at, length, this.signal);
    this.requested.set(at, request.catch(() => undefined));
  }
}

/**
 * First offset at or before `limit` where the query sits. `indexOf` is native
 * and skips to candidates far faster than testing every position, which matters
 * once the reads stop being the slow part.
 */
function scan(chunk: Uint8Array, query: Uint8Array, limit: number): number {
  const first = query[0]!;
  for (let at = chunk.indexOf(first); at >= 0 && at <= limit; at = chunk.indexOf(first, at + 1)) {
    if (matches(chunk, at, query)) return at;
  }
  return -1;
}

/** The same, from the end of the chunk backwards. */
function scanBack(chunk: Uint8Array, query: Uint8Array, accept: (offset: number) => boolean): number {
  const first = query[0]!;
  let at = chunk.length - query.length;
  while (at >= 0) {
    // A negative `fromIndex` counts from the end, so it has to stop at zero.
    const found = chunk.lastIndexOf(first, at);
    if (found < 0) return -1;
    if (matches(chunk, found, query) && accept(found)) return found;
    if (found === 0) return -1;
    at = found - 1;
  }
  return -1;
}

function matches(haystack: Uint8Array, offset: number, query: Uint8Array): boolean {
  for (let index = 1; index < query.length; index++) {
    if (haystack[offset + index] !== query[index]) return false;
  }
  return haystack[offset] === query[0];
}
