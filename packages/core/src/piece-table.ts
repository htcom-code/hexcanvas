import { AbstractByteSource, ChangeSet, MemoryByteSource, type ByteSource } from "./byte-source.js";
import { PieceTree, type Piece } from "./piece-tree.js";

/**
 * Insert and delete without rewriting the original. The document is a list of
 * pieces pointing either at the untouched original source or at an append-only
 * buffer of inserted bytes, so an edit never rewrites the file however large it
 * is — and because the original stays a `ByteSource`, it can still be a lazily
 * paged one.
 *
 * The pieces live in a tree rather than an array: an array finds a piece in
 * logarithmic time but rewrites its offset index on every mutation, so editing
 * cost grew with fragmentation. See `PieceTree`.
 */
export class PieceTableSource extends AbstractByteSource {
  private readonly original: ByteSource;
  private readonly tree: PieceTree;
  private added = new Uint8Array(1024);
  private addedLength = 0;
  private edited = false;
  /** Reused by `peek`, which runs once per rendered row per frame. */
  private readonly scratch: Piece[] = [];

  constructor(original: ByteSource | Uint8Array) {
    super();
    this.original = original instanceof Uint8Array ? new MemoryByteSource(original) : original;
    const length = this.original.length;
    this.tree = new PieceTree(length > 0 ? [{ origin: "original", offset: 0, length }] : []);
    // Pages arriving in the original are new bytes for us too.
    this.original.subscribe(() => this.notify(ChangeSet.empty()));
  }

  /** Bytes the document has now, after the edits. */
  get length(): number {
    return this.tree.bytes;
  }

  /** Pieces currently in the table; a proxy for how fragmented the document is. */
  get pieceCount(): number {
    return this.tree.pieceCount;
  }

  /** Whether anything has been applied since it wrapped the original. */
  get hasEdits(): boolean {
    return this.edited;
  }

  /**
   * Reads across the pieces the window spans. Misses when what they point at has not
   * got those bytes yet.
   */
  peek(offset: number, length: number, out?: Uint8Array): Uint8Array | undefined {
    if (offset < 0 || length < 0 || offset + length > this.length) return undefined;
    if (length === 0) return new Uint8Array(0);
    const target = out && out.length >= length ? out.subarray(0, length) : new Uint8Array(length);
    let written = 0;
    for (const segment of this.tree.collect(offset, length, this.scratch)) {
      const into = target.subarray(written, written + segment.length);
      if (segment.origin === "added") {
        into.set(this.added.subarray(segment.offset, segment.offset + segment.length));
      } else {
        // Handing the original the slice it should fill saves assembling the bytes
        // twice — once into its own buffer and once into this one.
        const bytes = this.original.peek(segment.offset, segment.length, into);
        if (!bytes) return undefined;
        if (bytes.buffer !== into.buffer || bytes.byteOffset !== into.byteOffset) into.set(bytes);
      }
      written += segment.length;
    }
    return target;
  }

  /** Makes a range resident in whatever the pieces point at. */
  async ensure(offset: number, length: number, signal?: AbortSignal): Promise<void> {
    const clamped = Math.min(length, Math.max(0, this.length - offset));
    if (clamped <= 0) return;
    const waits: Promise<void>[] = [];
    // Its own array, not the scratch one: this is the only path that awaits.
    for (const segment of this.tree.collect(offset, clamped, [])) {
      // Handed straight down: added bytes are already here, so the only thing
      // that can be slow — and so the only thing worth cancelling — is the
      // original underneath.
      if (segment.origin === "original") waits.push(this.original.ensure(segment.offset, segment.length, signal));
    }
    if (waits.length > 0) await Promise.all(waits);
  }

  /**
   * Splits and joins the tree rather than rewriting the document, so an edit costs the
   * pieces it touches rather than the file.
   */
  apply(changes: ChangeSet): void {
    if (changes.isEmpty) return;
    // Back to front, so offsets ahead of each change are still pre-change.
    for (let index = changes.changes.length - 1; index >= 0; index--) {
      const change = changes.changes[index]!;
      this.tree.remove(change.from, change.to);
      if (change.insert.length > 0) {
        this.tree.insert(change.from, { origin: "added", offset: this.appendAdded(change.insert), length: change.insert.length });
      }
    }
    this.edited = true;
    this.notify(changes);
  }

  /**
   * Yields the document in order, walking the pieces. A length change rules out
   * patching the original in place, which is why saving streams.
   */
  async *save(chunkSize = 64 * 1024): AsyncGenerator<Uint8Array> {
    for (let offset = 0; offset < this.length; offset += chunkSize) {
      const length = Math.min(chunkSize, this.length - offset);
      await this.ensure(offset, length);
      const bytes = this.peek(offset, length);
      yield bytes ? bytes.slice() : new Uint8Array(length);
    }
  }

  /** Append-only, grown geometrically, so inserted bytes are never recopied. */
  private appendAdded(bytes: Uint8Array): number {
    if (this.addedLength + bytes.length > this.added.length) {
      const grown = new Uint8Array(Math.max(this.added.length * 2, this.addedLength + bytes.length));
      grown.set(this.added.subarray(0, this.addedLength));
      this.added = grown;
    }
    const at = this.addedLength;
    this.added.set(bytes, at);
    this.addedLength += bytes.length;
    return at;
  }
}
