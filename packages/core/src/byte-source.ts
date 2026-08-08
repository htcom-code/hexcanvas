import type { BinaryBuffer } from "./binary-buffer.js";

/** One replacement in the pre-change coordinate space. */
export interface Change {
  /** Start offset before the change. */
  from: number;
  /** End offset (exclusive) before the change. */
  to: number;
  /** Bytes written in place of `[from, to)`; empty for a deletion. */
  insert: Uint8Array;
}

const emptyBytes = new Uint8Array(0);

/**
 * A batch of replacements plus the position mapping they imply. Every offset a
 * host holds — cursor, selection, bookmark, decoration, search hit — has to be
 * carried across an edit through `mapPos`, which is why changes travel as a set
 * rather than as a bare "something changed" signal.
 */
export class ChangeSet {
  /** The replacements, in document order, all in pre-change coordinates. */
  readonly changes: readonly Change[];

  constructor(changes: readonly Change[] = []) {
    this.changes = [...changes].sort((left, right) => left.from - right.from);
  }

  /** A change set that changes nothing — what a rejected edit returns. */
  static empty(): ChangeSet {
    return new ChangeSet();
  }

  /**
   * A half-open range replaced. With no bytes it is a delete; with a range of zero
   * length it is an insert.
   */
  static replace(from: number, to: number, insert: Uint8Array = emptyBytes): ChangeSet {
    return new ChangeSet([{ from, to, insert }]);
  }

  /** Bytes added at an offset, moving everything after it. */
  static insert(at: number, insert: Uint8Array): ChangeSet {
    return new ChangeSet([{ from: at, to: at, insert }]);
  }

  /** A half-open range deleted. */
  static remove(from: number, to: number): ChangeSet {
    return new ChangeSet([{ from, to, insert: emptyBytes }]);
  }

  /**
   * True when nothing moves. A source may still notify with one: that is how newly
   * resident bytes are announced.
   */
  get isEmpty(): boolean {
    return this.changes.length === 0;
  }

  /** How much the document grows (positive) or shrinks (negative). */
  get lengthDelta(): number {
    return this.changes.reduce((total, change) => total + change.insert.length - (change.to - change.from), 0);
  }

  /**
   * Maps an offset from before the change to after it. `assoc` decides which
   * side of a replaced range a position inside it lands on.
   */
  mapPos(pos: number, assoc: -1 | 1 = 1): number {
    let delta = 0;
    for (const change of this.changes) {
      if (pos < change.from) break;
      if (pos <= change.to) {
        return assoc < 0 ? change.from + delta : change.from + delta + change.insert.length;
      }
      delta += change.insert.length - (change.to - change.from);
    }
    return pos + delta;
  }
}

/**
 * Told what moved rather than that something did, so a listener written against one
 * version survives the next.
 */
export type ByteSourceListener = (changes: ChangeSet) => void;

/**
 * `AbortSignal.throwIfAborted` is recent enough that a host on an older runtime
 * would lose cancellation entirely, and `DOMException` is not guaranteed to be
 * global outside a browser. A plain error named `AbortError` is what every
 * caller actually tests for, and it is the name the platform uses.
 */
export function abortError(message = "The operation was aborted."): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/** Whether a rejection is a cancellation rather than a failure. */
export const isAbortError = (error: unknown): boolean => error instanceof Error && error.name === "AbortError";

/** Throws the cancellation this library recognises, for a source implementing `ensure`. */
export function throwIfAborted(signal: AbortSignal | undefined, message?: string): void {
  if (signal?.aborted) throw abortError(message);
}

/** Rejects when the signal fires, so a wait can race against it. */
function whenAborted(signal: AbortSignal, message?: string): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(abortError(message)), { once: true });
  });
}

/**
 * Storage contract. Reads are split in two: `peek` is synchronous and only
 * answers from what is already resident, so a renderer can call it inside a
 * frame; `ensure` is the asynchronous half that makes a range resident. A
 * source that omits `apply` is read-only.
 */
export interface ByteSource {
  readonly length: number;
  /** Increments on every mutation and whenever new bytes become resident. */
  readonly version: number;
  /**
   * Resident bytes, or undefined when the range still has to be fetched. The
   * result may alias internal storage and is only valid until the next change.
   */
  peek(offset: number, length: number, out?: Uint8Array): Uint8Array | undefined;
  /**
   * Makes a range resident. `signal` abandons the wait, and a source backed by
   * something cancellable should abandon the read as well.
   *
   * Optional on both sides: a source that cannot cancel — everything already
   * resident, a fetch with no way to stop — may ignore it, and a caller that
   * will wait however long it takes need not pass one. What a source must not
   * do is start new work once the signal is set.
   *
   * The reason it is here rather than only in the callers that scan: a caller
   * can stop awaiting on its own, and that is what searching and comparing used
   * to do. It leaves the reads already asked for running, which on a long scan
   * is the cost that matters.
   */
  ensure(offset: number, length: number, signal?: AbortSignal): Promise<void>;
  apply?(changes: ChangeSet): void;
  /** Returns the unsubscribe. */
  subscribe(listener: ByteSourceListener): () => void;
  /**
   * Yields the whole document in order for writing out. A length-changing edit
   * rules out patching the original in place, so saving has to stream.
   */
  save?(): AsyncIterable<Uint8Array>;
}

export abstract class AbstractByteSource implements ByteSource {
  /** Bumped by `notify`. A subclass reads it to answer `version`. */
  protected currentVersion = 0;
  private readonly listeners = new Set<ByteSourceListener>();

  abstract readonly length: number;
  abstract peek(offset: number, length: number, out?: Uint8Array): Uint8Array | undefined;
  abstract ensure(offset: number, length: number, signal?: AbortSignal): Promise<void>;

  get version(): number {
    return this.currentVersion;
  }

  subscribe(listener: ByteSourceListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Tells listeners what moved and bumps the version. A subclass calls this after it
   * has applied a change, not before.
   */
  protected notify(changes: ChangeSet): void {
    this.currentVersion++;
    for (const listener of this.listeners) listener(changes);
  }
}

/** Everything is resident, so `peek` never misses and `ensure` never waits. */
export class MemoryByteSource extends AbstractByteSource {
  private data: Uint8Array;

  constructor(data: Uint8Array | ArrayBuffer) {
    super();
    this.data = data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data.slice(0));
  }

  /** Bytes held. */
  get length(): number {
    return this.data.length;
  }

  /** Never misses: everything is resident. */
  peek(offset: number, length: number, out?: Uint8Array): Uint8Array | undefined {
    if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > this.data.length) return undefined;
    if (out && out.length >= length) {
      out.set(this.data.subarray(offset, offset + length));
      return out.subarray(0, length);
    }
    return this.data.subarray(offset, offset + length);
  }

  /** Resolves immediately, for the same reason. */
  ensure(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Reallocates the whole array for a length change, once per change in the set — use
   * `PieceTableSource` for a document being edited structurally.
   */
  apply(changes: ChangeSet): void {
    if (changes.isEmpty) return;
    // Applied back to front so the untouched prefix keeps its offsets.
    for (let index = changes.changes.length - 1; index >= 0; index--) {
      const change = changes.changes[index]!;
      const removed = change.to - change.from;
      if (removed === change.insert.length) {
        this.data.set(change.insert, change.from);
        continue;
      }
      const next = new Uint8Array(this.data.length - removed + change.insert.length);
      next.set(this.data.subarray(0, change.from), 0);
      next.set(change.insert, change.from);
      next.set(this.data.subarray(change.to), change.from + change.insert.length);
      this.data = next;
    }
    this.notify(changes);
  }

  /** Yields the document as one chunk. */
  async *save(): AsyncGenerator<Uint8Array> {
    yield this.data.slice();
  }

  /** A copy of the bytes. */
  toUint8Array(): Uint8Array {
    return this.data.slice();
  }
}

/**
 * A backend to page over. `fetch` is the only part a host writes; coalescing,
 * eviction and the page size are handled.
 */
export interface PagedByteSourceOptions {
  length: number;
  /**
   * Called for one page at a time; must resolve with exactly `length` bytes.
   *
   * `signal` fires when nobody is waiting for the page any more. A backend that
   * can stop — `fetch`, a worker, a native handle — should; one that cannot may
   * ignore it, and the page will simply arrive and be kept.
   */
  fetch: (offset: number, length: number, signal?: AbortSignal) => Promise<Uint8Array>;
  pageSize?: number;
  /** Resident page budget. Least recently used pages are dropped past it. */
  maxPages?: number;
}

/**
 * A page being fetched, and who is still waiting for it.
 *
 * Loads are shared: two scans over the same file ask for the same pages, and
 * fetching each twice would double the cost of the thing paging exists to make
 * cheap. Sharing is what makes cancelling delicate — one caller giving up must
 * not take the page away from another that is still waiting. So the fetch is
 * abandoned only when `waiting` reaches zero, and a caller that passed no signal
 * never decrements it, which is the honest reading of "this one cannot stop".
 */
interface PageLoad {
  promise: Promise<void>;
  controller: AbortController | undefined;
  waiting: number;
}

/**
 * Windowed reader over a slow backend — a file handle, IPC, a native module or
 * a remote range request. A host only implements `fetch`; paging, coalescing
 * and eviction happen here.
 */
export class PagedByteSource extends AbstractByteSource {
  readonly length: number;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly fetchPage: PagedByteSourceOptions["fetch"];
  private readonly pages = new Map<number, Uint8Array>();
  private readonly inFlight = new Map<number, PageLoad>();

  constructor(options: PagedByteSourceOptions) {
    super();
    this.length = options.length;
    this.pageSize = options.pageSize ?? 64 * 1024;
    this.maxPages = options.maxPages ?? 64;
    this.fetchPage = options.fetch;
  }

  get residentPages(): number {
    return this.pages.size;
  }

  peek(offset: number, length: number, out?: Uint8Array): Uint8Array | undefined {
    if (offset < 0 || length < 0 || offset + length > this.length) return undefined;
    const target = out && out.length >= length ? out.subarray(0, length) : new Uint8Array(length);
    let written = 0;
    while (written < length) {
      const position = offset + written;
      const index = Math.floor(position / this.pageSize);
      const page = this.pages.get(index);
      if (!page) return undefined;
      this.touch(index, page);
      const start = position - index * this.pageSize;
      const take = Math.min(page.length - start, length - written);
      target.set(page.subarray(start, start + take), written);
      written += take;
    }
    return target;
  }

  async ensure(offset: number, length: number, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (length <= 0 || offset >= this.length) return;
    const first = Math.floor(Math.max(0, offset) / this.pageSize);
    const lastIndex = Math.floor((Math.min(this.length, offset + length) - 1) / this.pageSize);
    const waits: Promise<void>[] = [];
    for (let index = first; index <= lastIndex; index++) {
      if (this.pages.has(index)) continue;
      waits.push(this.load(index, signal));
    }
    if (waits.length === 0) return;
    // Raced rather than merely awaited, so giving up is immediate. The loads
    // themselves are told separately, by `load`, and only once nobody is left.
    if (signal) await Promise.race([Promise.all(waits), whenAborted(signal)]);
    else await Promise.all(waits);
    this.notify(ChangeSet.empty());
  }

  private load(index: number, signal: AbortSignal | undefined): Promise<void> {
    const existing = this.inFlight.get(index);
    if (existing) {
      this.join(existing, signal);
      return existing.promise;
    }
    const offset = index * this.pageSize;
    const size = Math.min(this.pageSize, this.length - offset);
    // Only where there is something to abort. A caller with no signal keeps the
    // page alive for everyone, so there is no controller to make.
    const controller = signal && typeof AbortController === "function" ? new AbortController() : undefined;
    const load: PageLoad = { promise: undefined as unknown as Promise<void>, controller, waiting: 0 };
    load.promise = this.fetchPage(offset, size, controller?.signal)
      .then((bytes) => {
        this.pages.set(index, bytes);
        this.evict();
      })
      .finally(() => {
        this.inFlight.delete(index);
      });
    this.inFlight.set(index, load);
    this.join(load, signal);
    return load.promise;
  }

  /**
   * One more caller waiting for a page, and what to do when it stops. A caller
   * without a signal never stops, which is why it only increments.
   */
  private join(load: PageLoad, signal: AbortSignal | undefined): void {
    load.waiting++;
    if (!signal) return;
    const leave = () => {
      load.waiting--;
      if (load.waiting <= 0) load.controller?.abort();
    };
    if (signal.aborted) leave();
    else signal.addEventListener("abort", leave, { once: true });
  }

  private touch(index: number, page: Uint8Array): void {
    this.pages.delete(index);
    this.pages.set(index, page);
  }

  private evict(): void {
    while (this.pages.size > this.maxPages) {
      const oldest = this.pages.keys().next();
      if (oldest.done) return;
      this.pages.delete(oldest.value);
    }
  }
}

/** Adapts the original synchronous buffer contract to a `ByteSource`. */
export function fromBinaryBuffer(buffer: BinaryBuffer): ByteSource {
  class BinaryBufferSource extends AbstractByteSource {
    get length(): number {
      return buffer.length;
    }

    peek(offset: number, length: number, out?: Uint8Array): Uint8Array | undefined {
      if (offset < 0 || length < 0 || offset + length > buffer.length) return undefined;
      const bytes = buffer.read(offset, length);
      if (out && out.length >= length) {
        out.set(bytes);
        return out.subarray(0, length);
      }
      return bytes;
    }

    ensure(): Promise<void> {
      return Promise.resolve();
    }

    apply(changes: ChangeSet): void {
      for (const change of changes.changes) {
        if (change.to - change.from !== change.insert.length) {
          throw new RangeError("A BinaryBuffer cannot change length; use MemoryByteSource for insert or delete.");
        }
        buffer.write(change.from, change.insert);
      }
      this.notify(changes);
    }
  }
  return new BinaryBufferSource();
}

/** Distinguishes the contract from the older synchronous buffer. */
export function isByteSource(value: BinaryBuffer | ByteSource): value is ByteSource {
  return typeof (value as ByteSource).peek === "function";
}
