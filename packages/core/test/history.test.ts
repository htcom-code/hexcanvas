import { beforeEach, describe, expect, it } from "vitest";
import { ChangeSet, MemoryByteSource } from "../src/byte-source";
import { ChangeHistory } from "../src/history";
import { PieceTableSource } from "../src/piece-table";

const bytes = (...values: number[]) => Uint8Array.of(...values);

describe("ChangeHistory", () => {
  let clock = 0;
  const history = () => new ChangeHistory({ coalesceWindow: 700, now: () => clock });

  beforeEach(() => {
    clock = 0;
  });

  it("applies a change and puts it back", () => {
    const source = new MemoryByteSource(bytes(0x48, 0x65));
    const undoable = history();
    undoable.push(source, ChangeSet.replace(0, 1, bytes(0x41)));
    expect(source.peek(0, 1)![0]).toBe(0x41);
    undoable.undo(source);
    expect(source.peek(0, 1)![0]).toBe(0x48);
    undoable.redo(source);
    expect(source.peek(0, 1)![0]).toBe(0x41);
  });

  it("reports what it can do", () => {
    const source = new MemoryByteSource(bytes(1));
    const undoable = history();
    expect(undoable.canUndo).toBe(false);
    undoable.push(source, ChangeSet.replace(0, 1, bytes(2)));
    expect(undoable.canUndo).toBe(true);
    expect(undoable.canRedo).toBe(false);
    undoable.undo(source);
    expect(undoable.canRedo).toBe(true);
  });

  it("drops the redo stack once a new change lands", () => {
    const source = new MemoryByteSource(bytes(1, 1));
    const undoable = history();
    undoable.push(source, ChangeSet.replace(0, 1, bytes(2)));
    undoable.undo(source);
    undoable.push(source, ChangeSet.replace(1, 2, bytes(3)));
    expect(undoable.canRedo).toBe(false);
  });

  it("merges the two nibbles of a byte and the run that follows", () => {
    const source = new MemoryByteSource(bytes(0, 0, 0));
    const undoable = history();
    undoable.push(source, ChangeSet.replace(0, 1, bytes(0xa0)), true);
    undoable.push(source, ChangeSet.replace(0, 1, bytes(0xab)), true);
    undoable.push(source, ChangeSet.replace(1, 2, bytes(0xc0)), true);
    expect([...source.toUint8Array()]).toEqual([0xab, 0xc0, 0]);
    expect(undoable.depth).toBe(1);
    undoable.undo(source);
    expect([...source.toUint8Array()]).toEqual([0, 0, 0]);
  });

  it("merges a run of inserts, and undoing removes all of them", () => {
    const table = new PieceTableSource(bytes(1, 2));
    const undoable = history();
    undoable.push(table, ChangeSet.insert(0, bytes(0xa0)), true);
    undoable.push(table, ChangeSet.replace(0, 1, bytes(0xab)), true);
    clock = 100;
    undoable.push(table, ChangeSet.insert(1, bytes(0xc0)), true);
    expect([...table.peek(0, table.length)!]).toEqual([0xab, 0xc0, 1, 2]);
    expect(undoable.depth).toBe(1);
    undoable.undo(table);
    expect([...table.peek(0, table.length)!]).toEqual([1, 2]);
    expect(table.length).toBe(2);
  });

  it("breaks the run after a pause", () => {
    const source = new MemoryByteSource(bytes(0, 0, 0));
    const undoable = history();
    undoable.push(source, ChangeSet.replace(0, 1, bytes(1)), true);
    clock = 2000;
    undoable.push(source, ChangeSet.replace(1, 2, bytes(2)), true);
    expect(undoable.depth).toBe(2);
  });

  it("breaks the run when the cursor jumps", () => {
    const source = new MemoryByteSource(bytes(0, 0, 0, 0));
    const undoable = history();
    undoable.push(source, ChangeSet.replace(0, 1, bytes(1)), true);
    undoable.push(source, ChangeSet.replace(3, 4, bytes(2)), true);
    expect(undoable.depth).toBe(2);
  });

  it("does not merge when the caller does not ask for it", () => {
    const source = new MemoryByteSource(bytes(0, 0));
    const undoable = history();
    undoable.push(source, ChangeSet.replace(0, 1, bytes(1)));
    undoable.push(source, ChangeSet.replace(1, 2, bytes(2)));
    expect(undoable.depth).toBe(2);
  });

  it("undoes a delete by restoring the bytes it removed", () => {
    const table = new PieceTableSource(bytes(1, 2, 3));
    const undoable = history();
    undoable.push(table, ChangeSet.remove(0, 2));
    expect([...table.peek(0, table.length)!]).toEqual([3]);
    undoable.undo(table);
    expect([...table.peek(0, table.length)!]).toEqual([1, 2, 3]);
  });

  it("returns the change it applied so a caller can follow the edit", () => {
    const source = new MemoryByteSource(bytes(1, 2, 3));
    const undoable = history();
    undoable.push(source, ChangeSet.replace(1, 2, bytes(9)));
    const applied = undoable.undo(source);
    expect(applied?.changes[0]?.from).toBe(1);
  });

  it("refuses to record against a read-only source", () => {
    const readOnly = { length: 1, version: 0, peek: () => bytes(1), ensure: () => Promise.resolve(), subscribe: () => () => {} };
    expect(history().push(readOnly, ChangeSet.replace(0, 1, bytes(2)))).toBe(false);
  });

  it("clears both stacks", () => {
    const source = new MemoryByteSource(bytes(1));
    const undoable = history();
    undoable.push(source, ChangeSet.replace(0, 1, bytes(2)));
    undoable.clear();
    expect(undoable.canUndo).toBe(false);
    expect(undoable.canRedo).toBe(false);
  });
});
