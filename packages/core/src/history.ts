import { ChangeSet, type ByteSource, type Change } from "./byte-source.js";

/**
 * One undoable step, with the change and its inverse, and the document state it
 * produced — `markSaved` compares against that number rather than against bytes.
 */
export interface HistoryEntry {
  /** What was applied. */
  changes: ChangeSet;
  /** What puts it back. */
  inverse: ChangeSet;
  at: number;
  /**
   * Identifies the document state this entry leads to, so a caller can ask
   * whether the document is back somewhere it has been before.
   *
   * Not the stack depth, which answers that question wrongly twice: undoing an
   * edit and typing a different one returns to the same depth and a different
   * document, and a keystroke that coalesces into the entry below it changes the
   * document without changing the depth at all. A number handed out once per
   * state has neither problem.
   */
  state: number;
}

/**
 * `coalesceWindow` is how long a run of typing keeps merging into one step. `now` is
 * replaceable so tests do not depend on a clock.
 */
export interface ChangeHistoryOptions {
  /** Consecutive contiguous overwrites within this many ms merge into one step. */
  coalesceWindow?: number;
  now?: () => number;
}

const isOverwrite = (change: Change): boolean => change.to - change.from === change.insert.length;

const concat = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left, 0);
  joined.set(right, left.length);
  return joined;
};

/**
 * Undo/redo over `ChangeSet`s. Byte-level entries could not express insert,
 * delete or paste, and typing a byte is two nibble writes, so entries also
 * coalesce while a run of overwrites stays contiguous.
 */
export class ChangeHistory {
  private readonly undoStack: HistoryEntry[] = [];
  private readonly redoStack: HistoryEntry[] = [];
  private readonly coalesceWindow: number;
  private readonly now: () => number;
  /** Hands out state ids. Never reset, so an id is never reused after `clear`. */
  private states = 0;

  constructor(options: ChangeHistoryOptions = {}) {
    this.coalesceWindow = options.coalesceWindow ?? 700;
    this.now = options.now ?? (() => Date.now());
  }

  /** Whether there is a step behind the current one. */
  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /** Whether anything was undone and not yet redone. */
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * Steps behind the current position. Not a document identity — two different
   * documents can sit at the same depth, which is why `markSaved` uses a state id.
   */
  get depth(): number {
    return this.undoStack.length;
  }

  /**
   * Which document state this is. Zero is the document as it was handed over,
   * and every state reached by an edit has an id of its own — so two moments
   * with the same id hold the same bytes, and a caller holding an id from
   * earlier can tell whether it has come back.
   *
   * The converse does not hold: undoing an edit and typing the same bytes again
   * produces the same document under a new id. Saying "different" about two
   * identical documents costs a redundant write; saying "same" about two
   * different ones loses an edit, so the doubt goes that way deliberately.
   */
  get stateId(): number {
    return this.undoStack[this.undoStack.length - 1]?.state ?? 0;
  }

  /** Drops the history. The document is untouched. */
  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  /** Applies `changes` to the source and records how to undo them. */
  push(source: ByteSource, changes: ChangeSet, coalesce = false): boolean {
    if (!source.apply || changes.isEmpty) return false;
    const inverse = this.invert(source, changes);
    source.apply(changes);
    this.redoStack.length = 0;
    const at = this.now();
    const previous = this.undoStack[this.undoStack.length - 1];
    if (coalesce && previous && at - previous.at <= this.coalesceWindow && this.merge(previous, changes, inverse)) {
      previous.at = at;
      // A coalesced keystroke leaves the stack the same height and the document
      // different, so the entry it merged into is a different state now.
      previous.state = ++this.states;
      return true;
    }
    this.undoStack.push({ changes, inverse, at, state: ++this.states });
    return true;
  }

  /** Returns the change set that was applied, so a caller can follow the edit. */
  undo(source: ByteSource): ChangeSet | undefined {
    const entry = this.undoStack.pop();
    if (!entry || !source.apply) return undefined;
    const redo = this.invert(source, entry.inverse);
    source.apply(entry.inverse);
    // The id travels with the entry rather than being handed out again, so
    // redoing lands back on the state this undo just left rather than on a new
    // one that happens to hold the same bytes.
    this.redoStack.push({ changes: entry.inverse, inverse: redo, at: this.now(), state: entry.state });
    return entry.inverse;
  }

  /**
   * Re-applies the step last undone and returns what it moved, or undefined when
   * there is nothing to redo.
   */
  redo(source: ByteSource): ChangeSet | undefined {
    const entry = this.redoStack.pop();
    if (!entry || !source.apply) return undefined;
    const undoAgain = this.invert(source, entry.inverse);
    source.apply(entry.inverse);
    this.undoStack.push({ changes: entry.inverse, inverse: undoAgain, at: this.now(), state: entry.state });
    return entry.inverse;
  }

  /** Reads the bytes a change is about to overwrite, before it is applied. */
  private invert(source: ByteSource, changes: ChangeSet): ChangeSet {
    const inverted: Change[] = [];
    let delta = 0;
    for (const change of changes.changes) {
      const removed = source.peek(change.from, change.to - change.from)?.slice() ?? new Uint8Array(0);
      const from = change.from + delta;
      inverted.push({ from, to: from + change.insert.length, insert: removed });
      delta += change.insert.length - (change.to - change.from);
    }
    return new ChangeSet(inverted);
  }

  /**
   * Merges an edit that continues the previous one. Typing a byte is a nibble
   * written twice, and in insert mode the first nibble is an insert and the
   * second an overwrite, so the rules cover rewriting inside what the previous
   * step wrote as well as extending a run of overwrites or of inserts.
   */
  private merge(previous: HistoryEntry, changes: ChangeSet, inverse: ChangeSet): boolean {
    if (previous.changes.changes.length !== 1 || changes.changes.length !== 1) return false;
    const before = previous.changes.changes[0]!;
    const next = changes.changes[0]!;
    const writtenEnd = before.from + before.insert.length;

    // Rewrites bytes the previous step just wrote, so the undo target is unchanged.
    if (isOverwrite(next) && next.from >= before.from && next.to <= writtenEnd) {
      const patched = new Uint8Array(before.insert);
      patched.set(next.insert, next.from - before.from);
      previous.changes = new ChangeSet([{ from: before.from, to: before.to, insert: patched }]);
      return true;
    }

    if (next.from !== writtenEnd) return false;

    // A run of overwrites: extend both the change and what undoes it.
    if (isOverwrite(before) && isOverwrite(next)) {
      const beforeInverse = previous.inverse.changes[0]!;
      const nextInverse = inverse.changes[0]!;
      previous.changes = ChangeSet.replace(before.from, next.to, concat(before.insert, next.insert));
      previous.inverse = ChangeSet.replace(beforeInverse.from, nextInverse.to, concat(beforeInverse.insert, nextInverse.insert));
      return true;
    }

    // A run of inserts: undoing removes everything the run added.
    if (before.to === before.from && next.to === next.from) {
      const merged = concat(before.insert, next.insert);
      previous.changes = ChangeSet.insert(before.from, merged);
      previous.inverse = ChangeSet.remove(before.from, before.from + merged.length);
      return true;
    }
    return false;
  }
}
