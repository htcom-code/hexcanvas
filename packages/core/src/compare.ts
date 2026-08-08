import { isAbortError, type ByteSource, type ChangeSet } from "./byte-source.js";
import { diffDeleteKind, diffInsertKind, diffReplaceKind, type DecorationInput } from "./decorations.js";
import {
  createAlignedDiffProvider,
  diffKinds,
  diffLimit,
  type DiffKind,
  type DiffProvider,
  type HexDifference,
} from "./diff.js";
import type { HexEngine } from "./engine.js";
import type { ByteSelection } from "./model.js";
import { alignedRowPlans } from "./row-alignment.js";
import type { HexText } from "./text.js";

/**
 * Above a structure overlay, below a search hit. A difference you are stepping
 * through should not be buried under a parse result — but if a comparison and a
 * search are both live, the hit is the thing being looked for.
 */
const diffPriority = 4;

const paintedKinds = [diffReplaceKind, diffInsertKind, diffDeleteKind] as const;

type Side = "left" | "right";

/**
 * Two engines and how to compare them. `provider` replaces the default; `limit` caps
 * the differences kept, the way the search cap does.
 */
export interface HexCompareOptions {
  left: HexEngine;
  right: HexEngine;
  /** Replaces the comparison. Defaults to the library's aligned one. */
  provider?: DiffProvider;
  /** Stop after this many differences. Defaults to `diffLimit`. */
  limit?: number;
  /** Keep the two views on the same offset. Defaults to true. */
  syncScroll?: boolean;
}

/**
 * What a comparison is doing and what it found. `stale` means the documents were
 * edited since it ran.
 */
export interface HexCompareState {
  /** True while a comparison is in flight. */
  comparing: boolean;
  /** True once one has run and not been cleared, so a count of 0 means identical. */
  compared: boolean;
  differenceCount: number;
  /** 1-based position of the difference the left cursor is inside, or 0. */
  differenceIndex: number;
  /** True when the cap was reached, so the count is a floor rather than a total. */
  differenceTruncated: boolean;
  /** An edit landed afterwards, so the ranges describe bytes that have moved on. */
  stale: boolean;
  error: string | undefined;
}

const initialState: HexCompareState = {
  comparing: false,
  compared: false,
  differenceCount: 0,
  differenceIndex: 0,
  differenceTruncated: false,
  stale: false,
  error: undefined,
};

/**
 * Two editors compared, as a thing that owns neither of them.
 *
 * A comparison is not a property of a document, so it is not engine state: each
 * engine keeps being a complete editor over its own source — its own cursor,
 * selection, edits and undo stack — and this holds the pair. That is what keeps
 * the renderer, the layout and the hit-testing out of it entirely: the
 * differences are painted as decorations, which the grid already draws, and the
 * two views are kept in step by scrolling, which the engines already do.
 *
 * The consequence worth knowing: everything here reads the **left** engine's
 * cursor as the place the reader is. `differenceIndex` and which difference
 * `nextDifference` moves to are answered from it, because two cursors moving
 * independently cannot both be "where you are".
 */
export class HexCompare {
  private readonly left: HexEngine;
  private readonly right: HexEngine;
  private readonly provider: DiffProvider;
  private readonly limit: number;
  private readonly syncScroll: boolean;
  private readonly listeners = new Set<() => void>();
  private readonly cleanups: (() => void)[] = [];
  /** Per side, so a swapped source can be noticed and re-watched. */
  private readonly sources: Record<Side, ByteSource | undefined> = { left: undefined, right: undefined };
  private readonly sourceCleanups: Record<Side, (() => void) | undefined> = { left: undefined, right: undefined };
  /** Last first-visible row seen per side, so an echo is not read as a scroll. */
  private readonly rows: Record<Side, number> = { left: -1, right: -1 };
  /** Last left-cursor offset seen, so a repaint is not read as a cursor move. */
  private cursor = -1;
  private results: readonly HexDifference[] = [];
  private state: HexCompareState = initialState;
  /** Bumped when a newer comparison starts, so a slow older one cannot land. */
  private generation = 0;
  private running: Promise<number> | undefined;
  private aborter: AbortController | undefined;
  /** Guards the scroll mirror against the notification its own write causes. */
  private syncing = false;
  /**
   * True while `align` has the two panes laid out together, which is what makes
   * a row — rather than an offset — the thing they have in common.
   */
  private aligned = false;

  constructor(options: HexCompareOptions) {
    this.left = options.left;
    this.right = options.right;
    this.provider = options.provider ?? createAlignedDiffProvider();
    this.limit = options.limit ?? diffLimit;
    this.syncScroll = options.syncScroll ?? true;

    for (const side of ["left", "right"] as const) {
      const engine = this[side];
      this.watchSource(side);
      this.cleanups.push(engine.subscribe(() => this.onEngineChanged(side)));
      engine.setCommandHandler("nextDifference", () => this.nextDifference());
      engine.setCommandHandler("previousDifference", () => this.previousDifference());
      this.cleanups.push(() => {
        engine.setCommandHandler("nextDifference", undefined);
        engine.setCommandHandler("previousDifference", undefined);
      });
    }
  }

  // --- reactive surface -----------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): HexCompareState => this.state;

  private patch(next: Partial<HexCompareState>): void {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }

  /** Every difference, in left-document order. */
  get differences(): readonly HexDifference[] {
    return this.results;
  }

  // --- running it -----------------------------------------------------------

  /**
   * Compares the two documents and paints the result.
   *
   * One comparison at a time, whoever asks: a second call while one is in flight
   * is handed the same promise rather than starting a second pass over both
   * documents. `force` supersedes instead — the older one is aborted and its
   * result discarded even if it lands first.
   */
  compare(force = false): Promise<number> {
    if (this.running && !force) return this.running;
    const run = this.run(++this.generation);
    this.running = run;
    void run.finally(() => {
      if (this.running === run) this.running = undefined;
    });
    return run;
  }

  private async run(generation: number): Promise<number> {
    this.aborter?.abort();
    const aborter = new AbortController();
    this.aborter = aborter;
    this.patch({ comparing: true, error: undefined });
    let found: HexDifference[];
    try {
      found = await this.provider.compare(this.left.byteSource, this.right.byteSource, {
        limit: this.limit,
        signal: aborter.signal,
      });
    } catch (error) {
      // A superseded run has already had its state replaced by the newer one, so
      // it must not report its own failure over it.
      if (generation !== this.generation) return this.state.differenceCount;
      this.patch({ comparing: false, error: isAbortError(error) ? undefined : message(error) });
      return this.state.differenceCount;
    }
    if (generation !== this.generation) return this.state.differenceCount;
    this.results = found;
    this.paint();
    this.cursor = this.left.getState().cursor.offset;
    this.patch({
      comparing: false,
      compared: true,
      stale: false,
      differenceCount: found.length,
      differenceTruncated: found.length >= this.limit,
      differenceIndex: this.indexAt(this.left.getState().cursor.offset),
    });
    return found.length;
  }

  /** Drops the result and its highlights. The next `compare` starts over. */
  clear(): void {
    this.aborter?.abort();
    this.aborter = undefined;
    // Bumped so a run still in flight cannot land on the cleared state.
    this.generation++;
    this.results = [];
    this.cursor = -1;
    this.aligned = false;
    this.left.setRowPlan(undefined);
    this.right.setRowPlan(undefined);
    for (const kind of paintedKinds) {
      this.left.clearDecorations(kind);
      this.right.clearDecorations(kind);
    }
    this.state = initialState;
    for (const listener of this.listeners) listener();
  }

  // --- walking it -----------------------------------------------------------

  /**
   * The first difference starting past the left cursor, wrapping to the first.
   * Wrapping rather than stopping, for the reason a search wraps: stepping
   * through differences should never dead-end at the edge of the document.
   */
  nextDifference(): boolean {
    if (this.results.length === 0) return false;
    const from = this.left.getState().cursor.offset;
    const at = this.results.findIndex((difference) => difference.left.start > from);
    this.reveal(at === -1 ? 0 : at);
    return true;
  }

  previousDifference(): boolean {
    if (this.results.length === 0) return false;
    const from = this.left.getState().cursor.offset;
    let found = -1;
    for (let at = 0; at < this.results.length; at++) {
      if (this.results[at]!.left.start >= from) break;
      found = at;
    }
    this.reveal(found === -1 ? this.results.length - 1 : found);
    return true;
  }

  private reveal(at: number): void {
    const difference = this.results[at]!;
    // Both sides move together, so the mirror must not treat the first of them
    // as a scroll to answer with the second.
    this.syncing = true;
    try {
      show(this.left, difference.left);
      show(this.right, difference.right);
      // A side the difference is absent from has no offset of its own to be
      // scrolled to: under an aligned plan the rows opposite the bytes are
      // gaps, which hold nothing, so an offset there answers with the row
      // *after* them and the panes come apart by the height of the gap. The
      // side holding the bytes decides the row.
      if (this.aligned) {
        if (isEmpty(difference.left)) this.left.scrollToRow(this.right.visibleRows.first);
        else if (isEmpty(difference.right)) this.right.scrollToRow(this.left.visibleRows.first);
      }
    } finally {
      this.syncing = false;
    }
    this.rows.left = this.left.visibleRows.first;
    this.rows.right = this.right.visibleRows.first;
    // Where it was walked to, not where the cursor ended up. An insertion has no
    // left range for a cursor to be inside, so asking the cursor would answer
    // with whichever difference it was on before — "3 of 4" while looking at the
    // fourth.
    this.cursor = this.left.getState().cursor.offset;
    this.patch({ differenceIndex: at + 1 });
  }

  /**
   * Which difference covers `offset` in the left document, counting from one.
   * Binary search rather than a scan because it is answered on every cursor
   * move, and the list holds up to `limit` of them.
   *
   * Relies on the provider answering in left-document order, which the aligned
   * one does by construction.
   */
  private indexAt(offset: number): number {
    let low = 0;
    let high = this.results.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const range = this.results[middle]!.left;
      if (offset < range.start) high = middle - 1;
      // An empty range is a side the bytes are absent from, so nothing is ever
      // inside it — this branch takes it, which is what leaves it unmatchable.
      else if (offset >= range.end) low = middle + 1;
      else return middle + 1;
    }
    return 0;
  }

  // --- painting -------------------------------------------------------------

  private paint(): void {
    const left: DecorationInput[] = [];
    const right: DecorationInput[] = [];
    for (const difference of this.results) {
      const kind = diffKinds[difference.kind];
      // Only the side the bytes are actually on. An insertion has nothing to
      // paint in the left document; a zero-width decoration would be invisible
      // anyway, and carrying it would only cost a row in the store.
      //
      // Labelled always, and `labelVisible` left unset so the label follows the
      // host's `decorationLabels` rather than overriding it. Written even when
      // labels are off, because the option can be turned on afterwards and a
      // comparison is not re-run to answer it — a few dozen bytes a difference,
      // against a cap of ten thousand.
      if (difference.left.end > difference.left.start) {
        left.push({ ...difference.left, kind, priority: diffPriority, label: describe(this.left.text, difference.kind, difference.left) });
      }
      if (difference.right.end > difference.right.start) {
        right.push({ ...difference.right, kind, priority: diffPriority, label: describe(this.right.text, difference.kind, difference.right) });
      }
    }
    apply(this.left, left);
    apply(this.right, right);
    this.align();
  }

  /**
   * Puts corresponding bytes on the same line, where the two documents no longer
   * agree about where they are.
   *
   * Only when something actually shifted: a comparison whose differences are all
   * the same length on both sides already lines up, and laying it out again
   * would break rows for nothing. The panes share `bytesPerRow` — the box
   * forwards it — so one width is right for both.
   */
  private align(): void {
    const plans = alignedRowPlans(
      this.results,
      this.left.byteSource.length,
      this.right.byteSource.length,
      this.left.layout.bytesPerRow,
    );
    this.aligned = plans !== undefined;
    // Both plans go in before either pane's notification is answered. Setting a
    // plan is a change like any other, so the first one would run the mirror
    // against a pane still laid out the old way.
    this.syncing = true;
    try {
      this.left.setRowPlan(plans?.left);
      this.right.setRowPlan(plans?.right);
    } finally {
      this.syncing = false;
    }
    this.rows.left = this.left.visibleRows.first;
    this.rows.right = this.right.visibleRows.first;
  }

  // --- keeping up with the engines ------------------------------------------

  private onEngineChanged(side: Side): void {
    this.watchSource(side);
    if (side === "left") this.refreshIndex();
    this.mirrorScroll(side);
  }

  /**
   * Mirrors the scroll position by row where the panes are laid out together,
   * and by offset otherwise. Never by pixels: the two documents can be
   * different lengths, and `createScrollScale` compresses each against its own,
   * so the same `scrollTop` is a different place in each.
   *
   * Which of row and offset is the shared thing depends on the plan. Once
   * `align` has put corresponding bytes on the same line, the two plans are the
   * same height and row `r` is the same line in both, while the offsets on it
   * differ by the shift — going through one would land the other that far from
   * where it was asked for, which is the alignment undone at the last step.
   * Without a plan nothing says the panes share `bytesPerRow`, and then the
   * offset is what means the same in both.
   */
  private mirrorScroll(from: Side): void {
    if (!this.syncScroll || this.syncing) return;
    const source = this[from];
    const target = from === "left" ? this.right : this.left;
    const row = source.visibleRows.first;
    if (row === this.rows[from]) return;
    this.rows[from] = row;
    this.syncing = true;
    try {
      if (this.aligned) target.scrollToRow(row);
      else target.scrollToOffset(row * source.layout.bytesPerRow);
    } finally {
      this.syncing = false;
    }
    // Where the other one actually landed, which is not always where it was
    // asked to go — it clamps to its own end.
    this.rows[from === "left" ? "right" : "left"] = target.visibleRows.first;
  }

  /**
   * Recomputed only when the cursor actually moved. Running it on every
   * notification would undo what `reveal` just set, since the reveal of an
   * insertion leaves the left cursor where it was.
   */
  private refreshIndex(): void {
    const offset = this.left.getState().cursor.offset;
    if (offset === this.cursor) return;
    this.cursor = offset;
    if (!this.state.compared) return;
    const index = this.indexAt(offset);
    if (index === this.state.differenceIndex) return;
    this.patch({ differenceIndex: index });
  }

  /**
   * Follows a `setSource`. Without this a comparison would keep describing the
   * document that was swapped out — wrong in the direction nobody checks, since
   * stale ranges still paint and still count.
   */
  private watchSource(side: Side): void {
    const current = this[side].byteSource;
    if (current === this.sources[side]) return;
    this.sourceCleanups[side]?.();
    this.sources[side] = current;
    this.sourceCleanups[side] = current.subscribe((changes) => this.onSourceChanged(changes));
    this.markStale();
  }

  private onSourceChanged(changes: ChangeSet): void {
    // An empty set means bytes became resident, not that the document changed.
    if (changes.isEmpty) return;
    this.markStale();
  }

  private markStale(): void {
    if (!this.state.compared || this.state.stale) return;
    this.patch({ stale: true });
  }

  /** Detaches from both engines and both sources, and abandons a run in flight. */
  destroy(): void {
    this.aborter?.abort();
    this.aborter = undefined;
    this.generation++;
    this.aligned = false;
    // The panes outlive this, so the layout they were given must not.
    this.left.setRowPlan(undefined);
    this.right.setRowPlan(undefined);
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.length = 0;
    for (const side of ["left", "right"] as const) {
      this.sourceCleanups[side]?.();
      this.sourceCleanups[side] = undefined;
      this.sources[side] = undefined;
    }
    this.listeners.clear();
  }
}

/**
 * One replace per kind, because `setDecorations` replaces a single kind and
 * passing no kind would clear the host's bookmarks and structure along with it.
 */
function apply(engine: HexEngine, items: readonly DecorationInput[]): void {
  for (const kind of paintedKinds) {
    engine.setDecorations(items.filter((item) => item.kind === kind), kind);
  }
}

/**
 * Brings a difference into view on one side. The side a difference is absent
 * from is scrolled rather than selected: putting a cursor on bytes that are not
 * part of the difference would claim something that is not true.
 */
function show(engine: HexEngine, range: ByteSelection): void {
  if (range.end > range.start) engine.select(range.start, range.end, "start");
  else engine.scrollToOffset(range.start);
}

/** A side the difference's bytes are absent from — an insertion's left, say. */
function isEmpty(range: ByteSelection): boolean {
  return range.end === range.start;
}

/**
 * What one side of a difference says in the label gutter. Sized from the range
 * being labelled rather than from the difference, so the side that holds the
 * bytes reports its own count.
 */
function describe(text: HexText, kind: DiffKind, range: ByteSelection): string {
  const bytes = range.end - range.start;
  if (kind === "insert") return text.insertedLabel(bytes);
  if (kind === "delete") return text.deletedLabel(bytes);
  return text.replacedLabel(bytes);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "The comparison failed.";
}
