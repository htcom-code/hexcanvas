import type { ChangeSet } from "./byte-source.js";
import { IntervalColumns } from "./interval-columns.js";

/**
 * The kinds the library itself puts in the store. They live here rather than
 * with the engine so the renderer can tint them without importing it.
 */
export const bookmarkKind = "bookmark";
/** Decoration kind the hits are stored under, so they tint and clear like any other layer. */
export const searchKind = "search";
/**
 * A comparison paints three kinds rather than one, because the three mean
 * different things and a reader has to tell them apart at a glance: bytes that
 * differ at the same offset, and bytes that exist on only one side. Separate
 * kinds rather than a colour per range so they stay themeable — a host that
 * wants its own palette sets three custom properties, not ten thousand colours.
 */
export const diffReplaceKind = "diff-replace";
/** Decoration kind for bytes present on one side only. */
export const diffInsertKind = "diff-insert";
/** Decoration kind for bytes missing from the other side. */
export const diffDeleteKind = "diff-delete";

/**
 * A labelled byte range drawn over the grid. Bookmarks, search hits and
 * structure overlays are all consumers of this one mechanism rather than
 * separate features.
 */
export interface Decoration {
  id: string;
  /** Inclusive start byte. */
  start: number;
  /** Exclusive end byte. */
  end: number;
  label?: string;
  /**
   * Whether to draw `label`. Overrides `HexDisplayOptions.decorationLabels`,
   * which is off by default — so a parser can label everything and show only the
   * ranges worth naming.
   */
  labelVisible?: boolean;
  /** Tint drawn behind the bytes; falls back to the theme decoration colour. */
  color?: string;
  /** Glyph colour for the covered bytes. Left alone when omitted. */
  textColor?: string;
  /** Tint alpha. Defaults to 0.45 so overlapping ranges stay readable. */
  opacity?: number;
  /**
   * Higher paints later, so it wins where ranges overlap. Within one priority
   * the narrower range paints last, which is what nesting needs: a field
   * inside a struct stays visible.
   */
  priority?: number;
  /** Consumer tag, e.g. "bookmark". */
  kind?: string;
}

/** Outer and lower-priority ranges first, so the innermost paints on top. */
export function byPaintOrder(left: DecorationInput, right: DecorationInput): number {
  const priority = (left.priority ?? 0) - (right.priority ?? 0);
  if (priority !== 0) return priority;
  return (right.end - right.start) - (left.end - left.start);
}

/**
 * A decoration without the store's handle on it. This is what a caller hands over
 * to add, and what a source answers with: an `id` exists so a stored range can be
 * removed by one, which a host that answers windows has no use for — it removes a
 * range by no longer returning it.
 */
export type DecorationInput = Omit<Decoration, "id"> & { id?: string };

/**
 * The read side a renderer needs. Named so a host can hand the renderer its own
 * index — a structure viewer that already has a tree does not have to copy it
 * into a second one.
 */
export interface DecorationQuery {
  /**
   * Decorations overlapping `[from, to)`. Called once per visible row per frame, so
   * it has to answer without reading the whole document — and synchronously, for
   * the same reason `peek` is synchronous: a frame cannot await.
   */
  between(from: number, to: number): readonly DecorationInput[];
}

/**
 * Values that repeat across a parse result, held once and referred to by index.
 *
 * Only for low-cardinality fields — colours, kinds. Interning something that is
 * distinct per range, a label, costs a map entry on top of the string and made the
 * store *heavier* than the objects it replaced: measured at 365 bytes a range
 * against 272 before. Labels go in a plain slot instead.
 */
class Strings {
  private readonly indexes = new Map<string, number>();
  private readonly values: (string | undefined)[] = [undefined];

  /** 0 means "not set", so an absent value costs nothing but its slot. */
  intern(value: string | undefined): number {
    if (value === undefined) return 0;
    const existing = this.indexes.get(value);
    if (existing !== undefined) return existing;
    const at = this.values.push(value) - 1;
    this.indexes.set(value, at);
    return at;
  }

  read(at: number): string | undefined {
    return this.values[at];
  }
}

const growth = 1.6;

/**
 * Ranges in columns rather than one object each, with objects built only for what
 * a query answers.
 *
 * A parse result is the reason. As objects, a range cost about 350 bytes once the
 * store had copied it, stamped an id string on it and let the index hold two
 * references to it — so half a million ranges were 180 MB and a sample table of a
 * few million was out of reach. Stripping labels and colours changed nothing,
 * which is what ruled out the obvious fix. Columns cost a few dozen bytes, and the
 * repeated values — colours, kinds — are interned rather than stored per range.
 *
 * A host that would rather not hand its ranges over at all should use
 * `HexEngine.setDecorationSource` instead; this is for parsers that already have
 * everything, which is most whole-file formats.
 */
export class DecorationStore implements DecorationQuery {
  private starts = new Float64Array(0);
  private ends = new Float64Array(0);
  private priorities = new Int32Array(0);
  private opacities = new Float32Array(0);
  private colors = new Int32Array(0);
  private textColors = new Int32Array(0);
  private kinds = new Int32Array(0);
  /** One slot per row, not interned: labels are distinct per range. */
  private labels: (string | undefined)[] = [];
  /**
   * Tri-state, so "not stated" stays distinct from "hidden": 0 inherits the
   * display default, 1 shows, 2 hides. A typed column rather than a boolean
   * array for the same reason as the rest of them.
   */
  private labelFlags = new Uint8Array(0);
  /** Recounted on demand; see `hasVisibleLabels`. */
  private visibleLabels = 0;
  private visibleLabelsStale = true;
  private strings = new Strings();
  /** Ids only for the ranges that have been given or asked for one. */
  private ids = new Map<number, string>();
  private byId = new Map<string, number>();
  private length = 0;
  private sequence = 1;
  private index: IntervalColumns | undefined;
  /** Reused by every query, which happens once per row per frame. */
  private readonly scratch: number[] = [];

  /** How many ranges are held, across every kind. */
  get size(): number {
    return this.length;
  }

  /**
   * Whether any range asks for its label outright. The layout needs this: a
   * label drawn without a reserved gutter sits past `width`, where no amount of
   * scrolling reaches it. Recounted lazily because it is asked when the layout is
   * rebuilt, not per frame.
   */
  get hasVisibleLabels(): boolean {
    if (this.visibleLabelsStale) {
      this.visibleLabels = 0;
      for (let at = 0; at < this.length; at++) if (this.labelFlags[at] === 1) this.visibleLabels++;
      this.visibleLabelsStale = false;
    }
    return this.visibleLabels > 0;
  }

  /**
   * Every range as an object, in document order. This materialises the whole
   * store, so it is for small sets — bookmarks, a search's hits — and not for a
   * parse result. `size` and `countOfKind` answer without building anything.
   */
  get all(): readonly Decoration[] {
    const items: Decoration[] = new Array(this.length);
    for (let at = 0; at < this.length; at++) items[at] = this.materialise(at);
    return items;
  }

  /** Adds one range and returns it with its id. */
  add(decoration: DecorationInput): Decoration {
    // Placed where it belongs rather than appended and sorted afterwards: the
    // caller gets this range back, so which row it is has to be known, not guessed.
    const at = this.positionFor(decoration.start);
    this.openRow(at);
    this.write(at, decoration);
    if (decoration.id !== undefined) this.setId(at, decoration.id);
    return this.materialise(at);
  }

  /** One shot for a whole parse result; returns how many landed. */
  addAll(decorations: readonly DecorationInput[]): number {
    return this.appendAll(decorations, undefined);
  }

  /**
   * Replaces every decoration of `kind`, or all of them when kind is omitted.
   * The kind is stamped onto entries that do not carry one, so the caller does
   * not have to repeat it on every range of a parse result.
   */
  replace(decorations: readonly DecorationInput[], kind?: string): number {
    this.clear(kind);
    return this.appendAll(decorations, kind);
  }

  /** Removes by id. False when nothing had it. */
  remove(id: string): boolean {
    const at = this.byId.get(id);
    if (at === undefined) return false;
    this.removeAt(at);
    return true;
  }

  /** Removes one kind, or everything. */
  clear(kind?: string): void {
    if (kind === undefined) {
      this.length = 0;
      this.labels = [];
      this.ids.clear();
      this.byId.clear();
      this.index = undefined;
      this.visibleLabels = 0;
      this.visibleLabelsStale = false;
      return;
    }
    const wanted = this.strings.intern(kind);
    const keep: number[] = [];
    for (let at = 0; at < this.length; at++) if (this.kinds[at] !== wanted) keep.push(at);
    this.keepRows(keep);
  }

  /** Decorations overlapping `[from, to)`, in document order. */
  between(from: number, to: number): Decoration[] {
    const found = this.intervals.overlapping(from, to, this.scratch);
    return this.materialiseAll(found).sort((left, right) => left.start - right.start);
  }

  /** The innermost range covering an offset, or the innermost of one kind. */
  at(offset: number, kind?: string): Decoration | undefined {
    const found = this.intervals.covering(offset, this.scratch);
    const wanted = kind === undefined ? -1 : this.strings.intern(kind);
    let best = -1;
    for (const index of found) {
      if (wanted !== -1 && this.kinds[index] !== wanted) continue;
      if (best === -1 || this.starts[index]! < this.starts[best]!) best = index;
    }
    return best === -1 ? undefined : this.materialise(best);
  }

  /**
   * Every range covering `offset`, innermost first — the order a structure
   * tree wants when turning a clicked byte back into the field that holds it.
   */
  allAt(offset: number, kind?: string): Decoration[] {
    const found = this.intervals.covering(offset, this.scratch);
    const wanted = kind === undefined ? -1 : this.strings.intern(kind);
    const matching = wanted === -1 ? found : found.filter((index) => this.kinds[index] === wanted);
    return this.materialiseAll(matching).sort((left, right) => byPaintOrder(right, left));
  }

  /**
   * Every range of a kind, in document order. Builds an object each — `countOfKind`
   * answers how many without building any.
   */
  ofKind(kind: string): Decoration[] {
    const wanted = this.strings.intern(kind);
    const items: Decoration[] = [];
    for (let at = 0; at < this.length; at++) {
      if (this.kinds[at] === wanted) items.push(this.materialise(at));
    }
    return items;
  }

  /** How many of a kind there are, without building any of them. */
  countOfKind(kind: string): number {
    const wanted = this.strings.intern(kind);
    let count = 0;
    for (let at = 0; at < this.length; at++) if (this.kinds[at] === wanted) count++;
    return count;
  }

  /**
   * Which of a kind covers `offset`, counting from one in document order — what a
   * "hit 3 of 17" display needs, without materialising the other sixteen.
   */
  ordinalOfKindAt(kind: string, offset: number): number {
    const wanted = this.strings.intern(kind);
    let ordinal = 0;
    for (let at = 0; at < this.length; at++) {
      if (this.kinds[at] !== wanted) continue;
      ordinal++;
      if (offset >= this.starts[at]! && offset < this.ends[at]!) return ordinal;
    }
    return 0;
  }

  /**
   * Carries every range across an edit. Without this, inserting a byte ahead of
   * a bookmark leaves it pointing at the wrong one. A range the edit consumed
   * entirely is dropped. Ends map with `-1` so inserting immediately after a
   * range does not stretch it.
   */
  map(changes: ChangeSet): boolean {
    if (changes.isEmpty || this.length === 0) return false;
    let moved = false;
    const keep: number[] = [];
    const mapped: [number, number][] = [];
    for (let at = 0; at < this.length; at++) {
      const start = changes.mapPos(this.starts[at]!, 1);
      const end = changes.mapPos(this.ends[at]!, -1);
      if (end <= start) {
        moved = true;
        continue;
      }
      if (start !== this.starts[at]! || end !== this.ends[at]!) moved = true;
      keep.push(at);
      mapped.push([start, end]);
    }
    this.keepRows(keep);
    for (let at = 0; at < mapped.length; at++) {
      this.starts[at] = mapped[at]![0];
      this.ends[at] = mapped[at]![1];
    }
    this.sortByStart();
    return moved;
  }

  // --- columns ------------------------------------------------------------

  private get intervals(): IntervalColumns {
    this.index ??= new IntervalColumns(this.starts, this.ends, this.length);
    return this.index;
  }

  /**
   * Appends and sorts once, which is what a parse result wants: no row index has
   * to survive, because the caller is handed a count.
   */
  private appendAll(decorations: readonly DecorationInput[], kind: string | undefined): number {
    this.reserve(this.length + decorations.length);
    const stamped = kind === undefined ? 0 : this.strings.intern(kind);
    for (const decoration of decorations) {
      const at = this.length++;
      this.write(at, decoration);
      if (stamped !== 0 && this.kinds[at] === 0) this.kinds[at] = stamped;
      if (decoration.id !== undefined) this.setId(at, decoration.id);
    }
    this.sortByStart();
    this.index = undefined;
    return decorations.length;
  }

  private write(at: number, decoration: DecorationInput): void {
    this.starts[at] = decoration.start;
    this.ends[at] = decoration.end;
    this.priorities[at] = decoration.priority ?? 0;
    // NaN rather than a sentinel: the renderer's default is not zero.
    this.opacities[at] = decoration.opacity ?? Number.NaN;
    this.colors[at] = this.strings.intern(decoration.color);
    this.textColors[at] = this.strings.intern(decoration.textColor);
    this.kinds[at] = this.strings.intern(decoration.kind);
    this.labels[at] = decoration.label;
    this.labelFlags[at] = decoration.labelVisible === undefined ? 0 : decoration.labelVisible ? 1 : 2;
    this.index = undefined;
    this.visibleLabelsStale = true;
  }

  /** First row whose start is past `start`, or the end. */
  private positionFor(start: number): number {
    let low = 0;
    let high = this.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.starts[middle]! > start) high = middle;
      else low = middle + 1;
    }
    return low;
  }

  /** Makes room at `at` by shifting the rest right. */
  private openRow(at: number): void {
    this.reserve(this.length + 1);
    if (at < this.length) {
      for (const column of this.columns()) column.copyWithin(at + 1, at, this.length);
      this.labels.splice(at, 0, undefined);
    }
    this.length++;
    this.remapIds((row) => (row >= at ? row + 1 : row));
  }

  private removeAt(at: number): void {
    for (const column of this.columns()) column.copyWithin(at, at + 1, this.length);
    this.labels.splice(at, 1);
    this.length--;
    this.remapIds((row) => (row === at ? undefined : row > at ? row - 1 : row));
    this.index = undefined;
    this.visibleLabelsStale = true;
  }

  /**
   * Keeps the listed rows, in the order given, and drops the rest. Every reorder
   * and every removal goes through this, so the id bookkeeping is written once.
   */
  private keepRows(keep: readonly number[]): void {
    if (keep.length === this.length && keep.every((row, position) => row === position)) return;
    const copies = this.columns().map((column) => column.slice(0, this.length));
    const labels = this.labels;
    const nextLabels: (string | undefined)[] = new Array(keep.length);
    const positions = new Map<number, number>();
    const columns = this.columns();
    for (let to = 0; to < keep.length; to++) {
      const from = keep[to]!;
      positions.set(from, to);
      for (let which = 0; which < columns.length; which++) {
        columns[which]![to] = copies[which]![from]!;
      }
      nextLabels[to] = labels[from];
    }
    this.labels = nextLabels;
    this.length = keep.length;
    this.remapIds((row) => positions.get(row));
    this.index = undefined;
    // A reorder leaves the count alone, but every removal comes through here too.
    this.visibleLabelsStale = true;
  }

  private sortByStart(): void {
    const order = Array.from({ length: this.length }, (_, at) => at)
      .sort((a, b) => this.starts[a]! - this.starts[b]!);
    this.keepRows(order);
  }

  /**
   * Ids live in a map keyed by row, so any reorder has to move them. Rebuilt from
   * the mapping rather than patched in place, because a permutation cannot be
   * applied entry by entry without stepping on itself.
   */
  private remapIds(mapping: (row: number) => number | undefined): void {
    if (this.ids.size === 0) return;
    const next = new Map<number, string>();
    const nextById = new Map<string, number>();
    for (const [row, id] of this.ids) {
      const to = mapping(row);
      if (to === undefined) continue;
      next.set(to, id);
      nextById.set(id, to);
    }
    this.ids = next;
    this.byId = nextById;
  }

  private columns(): (Float64Array<ArrayBuffer> | Int32Array<ArrayBuffer> | Float32Array<ArrayBuffer> | Uint8Array<ArrayBuffer>)[] {
    return [this.starts, this.ends, this.priorities, this.opacities, this.colors, this.textColors, this.kinds, this.labelFlags];
  }

  private materialise(at: number): Decoration {
    const item: Decoration = {
      id: this.idOf(at),
      start: this.starts[at]!,
      end: this.ends[at]!,
    };
    const label = this.labels[at];
    if (label !== undefined) item.label = label;
    const labelFlag = this.labelFlags[at]!;
    if (labelFlag !== 0) item.labelVisible = labelFlag === 1;
    const color = this.strings.read(this.colors[at]!);
    if (color !== undefined) item.color = color;
    const textColor = this.strings.read(this.textColors[at]!);
    if (textColor !== undefined) item.textColor = textColor;
    const kind = this.strings.read(this.kinds[at]!);
    if (kind !== undefined) item.kind = kind;
    const opacity = this.opacities[at]!;
    if (!Number.isNaN(opacity)) item.opacity = opacity;
    const priority = this.priorities[at]!;
    if (priority !== 0) item.priority = priority;
    return item;
  }

  private materialiseAll(indices: readonly number[]): Decoration[] {
    const items: Decoration[] = new Array(indices.length);
    for (let at = 0; at < indices.length; at++) items[at] = this.materialise(indices[at]!);
    return items;
  }

  /** Assigned on demand: a range nobody removes never needs one. */
  private idOf(at: number): string {
    const existing = this.ids.get(at);
    if (existing !== undefined) return existing;
    const id = `decoration-${this.sequence++}`;
    this.setId(at, id);
    return id;
  }

  private setId(at: number, id: string): void {
    this.ids.set(at, id);
    this.byId.set(id, at);
  }

  private reserve(capacity: number): void {
    if (capacity <= this.starts.length) return;
    const size = Math.max(capacity, Math.ceil(this.starts.length * growth), 16);
    this.starts = grow(this.starts, size);
    this.ends = grow(this.ends, size);
    this.priorities = growInt(this.priorities, size);
    this.opacities = growFloat32(this.opacities, size);
    this.colors = growInt(this.colors, size);
    this.textColors = growInt(this.textColors, size);
    this.kinds = growInt(this.kinds, size);
    this.labelFlags = growUint8(this.labelFlags, size);
  }
}

const grow = (column: Float64Array<ArrayBuffer>, size: number): Float64Array<ArrayBuffer> => {
  const next = new Float64Array(size);
  next.set(column);
  return next;
};

const growFloat32 = (column: Float32Array<ArrayBuffer>, size: number): Float32Array<ArrayBuffer> => {
  const next = new Float32Array(size);
  next.set(column);
  return next;
};

const growInt = (column: Int32Array<ArrayBuffer>, size: number): Int32Array<ArrayBuffer> => {
  const next = new Int32Array(size);
  next.set(column);
  return next;
};

const growUint8 = (column: Uint8Array<ArrayBuffer>, size: number): Uint8Array<ArrayBuffer> => {
  const next = new Uint8Array(size);
  next.set(column);
  return next;
};
