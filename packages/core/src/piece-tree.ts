/**
 * Which store a piece points into — the document as it was opened, or the bytes
 * appended since.
 */
export type PieceOrigin = "original" | "added";

/** A run of bytes from one of the two stores. */
export interface Piece {
  origin: PieceOrigin;
  /** Offset inside the origin store, not inside the document. */
  offset: number;
  length: number;
}

interface Node extends Piece {
  left: Node | undefined;
  right: Node | undefined;
  /** Bytes in this subtree, which is what document offsets are searched by. */
  bytes: number;
  /** Pieces in this subtree, for reporting fragmentation. */
  count: number;
  /** Heap key. Random-looking but fixed, so a run of edits is reproducible. */
  priority: number;
}

/**
 * A treap of pieces, ordered implicitly by position: there is no key, only the
 * byte count of each subtree, so an offset is found by descending it.
 *
 * A plain array of pieces finds a piece by binary search, which is fast, but a
 * mutation splices the array and invalidates the running offsets, so an edit
 * costs a pass over every piece. That is the cost that shows up as typing going
 * slow in a document fragmented into thousands of pieces. A treap makes the
 * mutation logarithmic too, because split and join are the only operations an
 * edit needs and both follow one path down.
 *
 * Balance comes from the priorities rather than from rotations after the fact,
 * which is what keeps split and join short enough to be worth trusting.
 */
export class PieceTree {
  private root: Node | undefined;
  /** A fixed sequence rather than Math.random: same edits, same shape, every run. */
  private seed = 0x2f6e2b1;

  constructor(pieces: readonly Piece[] = []) {
    for (const piece of pieces) this.append(piece);
  }

  get bytes(): number {
    return this.root?.bytes ?? 0;
  }

  get pieceCount(): number {
    return this.root?.count ?? 0;
  }

  /** Pieces in document order. For tests and diagnostics, not for reads. */
  toArray(): Piece[] {
    const pieces: Piece[] = [];
    walk(this.root, pieces);
    return pieces;
  }

  insert(offset: number, piece: Piece): void {
    if (piece.length <= 0) return;
    const [left, right] = split(this.root, offset);
    // Typing is a run of one-byte inserts, each right after the last, and each
    // one appended to the same buffer — so without this the common case leaves a
    // piece per keystroke and pays for the depth that comes with them.
    if (extendLast(left, piece)) {
      this.root = join(left, right);
      return;
    }
    this.root = join(join(left, this.leaf(piece)), right);
  }

  remove(from: number, to: number): void {
    if (to <= from) return;
    const [left, rest] = split(this.root, from);
    const [, right] = split(rest, to - from);
    this.root = join(left, right);
  }

  private append(piece: Piece): void {
    if (piece.length <= 0) return;
    this.root = join(this.root, this.leaf(piece));
  }

  /**
   * The pieces covering `[offset, offset + length)`, each clipped to it.
   *
   * A plain function filling an array, not a recursive generator. The generator
   * version read better and cost twenty times more: `yield*` down the tree means
   * one generator frame per level and a delegation chain re-walked on every
   * `next()`, so the price was the depth of the tree — not the number of pieces
   * the row actually spans, which is usually one.
   */
  collect(offset: number, length: number, out: Piece[]): Piece[] {
    out.length = 0;
    if (length > 0) collectIn(this.root, offset, offset + length, out);
    return out;
  }

  /** The same, for a caller that would rather iterate than hold an array. */
  *segments(offset: number, length: number): Generator<Piece> {
    yield* this.collect(offset, length, []);
  }

  private leaf(piece: Piece): Node {
    // xorshift, so the priorities are spread out without being random.
    this.seed ^= this.seed << 13;
    this.seed ^= this.seed >>> 17;
    this.seed ^= this.seed << 5;
    this.seed |= 0;
    return {
      origin: piece.origin,
      offset: piece.offset,
      length: piece.length,
      left: undefined,
      right: undefined,
      bytes: piece.length,
      count: 1,
      priority: this.seed >>> 0,
    };
  }
}

const sizeOf = (node: Node | undefined): number => node?.bytes ?? 0;

function pull(node: Node): Node {
  node.bytes = node.length + sizeOf(node.left) + sizeOf(node.right);
  node.count = 1 + (node.left?.count ?? 0) + (node.right?.count ?? 0);
  return node;
}

/**
 * Cuts the tree at a document offset, splitting the piece that straddles it. The
 * two halves are independent trees, which is what makes insert and remove the
 * same three lines.
 */
function split(node: Node | undefined, at: number): [Node | undefined, Node | undefined] {
  if (!node) return [undefined, undefined];
  const leftBytes = sizeOf(node.left);
  if (at <= leftBytes) {
    const [first, second] = split(node.left, at);
    node.left = second;
    return [first, pull(node)];
  }
  const within = at - leftBytes;
  if (within >= node.length) {
    const [first, second] = split(node.right, within - node.length);
    node.right = first;
    return [pull(node), second];
  }
  // Inside this piece: keep the head here and hand the tail to the right side.
  const tail: Node = {
    origin: node.origin,
    offset: node.offset + within,
    length: node.length - within,
    left: undefined,
    right: node.right,
    bytes: 0,
    count: 1,
    priority: node.priority,
  };
  pull(tail);
  node.length = within;
  node.right = undefined;
  return [pull(node), tail];
}

/**
 * Grows the last piece of a tree instead of adding one, when the two are the
 * same run of bytes — same store, and the new piece starting exactly where the
 * last one ends. Walks the right spine and re-totals on the way back, so nothing
 * is touched unless the merge actually happens.
 */
function extendLast(node: Node | undefined, piece: Piece): boolean {
  if (!node) return false;
  if (node.right) {
    const merged = extendLast(node.right, piece);
    if (merged) pull(node);
    return merged;
  }
  if (node.origin !== piece.origin || node.offset + node.length !== piece.offset) return false;
  node.length += piece.length;
  pull(node);
  return true;
}

/** Both trees keep their order; the higher priority becomes the root. */
function join(left: Node | undefined, right: Node | undefined): Node | undefined {
  if (!left) return right;
  if (!right) return left;
  if (left.priority >= right.priority) {
    left.right = join(left.right, right);
    return pull(left);
  }
  right.left = join(left, right.left);
  return pull(right);
}

function collectIn(node: Node | undefined, from: number, to: number, out: Piece[]): void {
  if (!node || to <= 0 || from >= node.bytes) return;
  const leftBytes = sizeOf(node.left);
  if (from < leftBytes) collectIn(node.left, from, Math.min(to, leftBytes), out);
  const ownEnd = leftBytes + node.length;
  const start = Math.max(from, leftBytes);
  const end = Math.min(to, ownEnd);
  if (end > start) out.push({ origin: node.origin, offset: node.offset + (start - leftBytes), length: end - start });
  if (to > ownEnd) collectIn(node.right, Math.max(0, from - ownEnd), to - ownEnd, out);
}

function walk(node: Node | undefined, out: Piece[]): void {
  if (!node) return;
  walk(node.left, out);
  out.push({ origin: node.origin, offset: node.offset, length: node.length });
  walk(node.right, out);
}
