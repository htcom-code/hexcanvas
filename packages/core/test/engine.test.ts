import { describe, expect, it, vi } from "vitest";
import { ChangeSet, MemoryByteSource, PagedByteSource, type ByteSource } from "../src/byte-source";
import { HexEngine, bookmarkKind, searchMatchLimit, type HexEngineOptions } from "../src/engine";
import { commands, platformFromName } from "../src/keymap";
import { defaultText } from "../src/text";
import { PieceTableSource } from "../src/piece-table";

/**
 * The engine needs no DOM until it renders, so its behaviour is testable here.
 *
 * The platform is pinned rather than detected. Command keys differ by it, so a
 * test that presses one and lets the machine decide passes on the author's Mac
 * and fails on a Linux runner — which is exactly what happened to the bookmark
 * tests. `mac` because these tests spell the modifier as `metaKey`.
 */
const setup = (options: Partial<HexEngineOptions> = {}) => {
  const source = new PieceTableSource(Uint8Array.from({ length: 256 }, (_, index) => index));
  const engine = new HexEngine({ source, platform: "mac", ...options });
  engine.setViewportSize(800, 220); // ten of sixteen rows visible
  return { engine, source };
};

/**
 * Find is off unless asked for, so every test about finding has to ask. Spelled
 * out rather than defaulted in `setup`, because "off by default" is the behaviour
 * under test in `HexEngine features`.
 */
const finding = { search: "native" } as const;

const key = (engine: HexEngine, key: string, modifiers: Record<string, boolean | string> = {}) => engine.handleKey({ key, ...modifiers } as never);
const at = (engine: HexEngine) => engine.getState().cursor.offset;
const selection = (engine: HexEngine) => engine.getState().selection;

describe("HexEngine cursor", () => {
  it("moves with the arrow keys and clamps at the edges", () => {
    const { engine } = setup();
    expect(key(engine, "ArrowRight")).toBe(true);
    expect(at(engine)).toBe(1);
    key(engine, "ArrowDown");
    expect(at(engine)).toBe(17);
    key(engine, "ArrowLeft");
    key(engine, "ArrowUp");
    expect(at(engine)).toBe(0);
    key(engine, "ArrowLeft");
    expect(at(engine)).toBe(0);
  });

  it("jumps to the ends of a row", () => {
    const { engine } = setup();
    engine.moveCursor(20);
    key(engine, "End");
    expect(at(engine)).toBe(31);
    key(engine, "Home");
    expect(at(engine)).toBe(16);
  });

  it("switches columns with Tab and keeps the selection", () => {
    const { engine } = setup();
    engine.select(0, 4);
    key(engine, "Tab");
    expect(engine.getState().cursor.column).toBe("ascii");
    expect(selection(engine)).toEqual({ start: 0, end: 4 });
  });

  it("extends the selection with shift and collapses it without", () => {
    const { engine } = setup();
    engine.moveCursor(4);
    key(engine, "ArrowRight", { shiftKey: true });
    key(engine, "ArrowRight", { shiftKey: true });
    // The cursor sits on a byte, so extending covers both ends of the range.
    expect(selection(engine)).toEqual({ start: 4, end: 7 });
    key(engine, "ArrowRight");
    expect(selection(engine)).toBeUndefined();
  });

  it("shows the last row when scrolled to the bottom", () => {
    const { engine } = setup();
    // A viewport that is not a whole number of rows is where snapping used to
    // hide the final row.
    engine.setViewportSize(800, 205);
    engine.setScrollTop(engine.scrollHeight - 205);
    const rows = engine.visibleRows;
    expect(rows.last).toBe(rows.total);
    const lastRowBottom = rows.total * 22;
    expect(lastRowBottom - engine.logicalScrollTop).toBeLessThanOrEqual(205);
  });

  it("puts the cursor row fully inside the viewport, flush at the bottom", () => {
    const { engine } = setup();
    engine.setViewportSize(800, 205);
    engine.moveCursor(255); // 256 bytes over 16 rows, so the last one
    const top = engine.logicalScrollTop;
    const rowTop = 15 * 22;
    expect(rowTop).toBeGreaterThanOrEqual(top);
    expect(rowTop + 22).toBeLessThanOrEqual(top + 205);
    // And no further than needed: the document bottom sits on the viewport edge.
    expect(top).toBe(16 * 22 - 205);
  });

  it("does not scroll when the cursor is already visible", () => {
    const { engine } = setup();
    engine.setViewportSize(800, 205);
    engine.moveCursor(0);
    engine.moveCursor(3 * 16);
    expect(engine.getState().scrollTop).toBe(0);
  });

  it("scrolls the cursor back into view", () => {
    const { engine } = setup();
    for (let index = 0; index < 12; index++) key(engine, "ArrowDown");
    expect(engine.getState().scrollTop).toBeGreaterThan(0);
    for (let index = 0; index < 12; index++) key(engine, "ArrowUp");
    expect(engine.getState().scrollTop).toBe(0);
  });

  it("selects a range from outside, with the cursor at either end", () => {
    const { engine } = setup();
    engine.select(8, 12);
    expect([selection(engine), at(engine)]).toEqual([{ start: 8, end: 12 }, 11]);
    engine.select(8, 12, "start");
    expect(at(engine)).toBe(8);
  });

  it("selects everything", () => {
    const { engine } = setup();
    key(engine, "a", { metaKey: true });
    expect(selection(engine)).toEqual({ start: 0, end: 256 });
  });
});

describe("HexEngine editing", () => {
  it("writes a byte from two nibbles and advances", () => {
    const { engine, source } = setup();
    key(engine, "a");
    key(engine, "b");
    expect(source.peek(0, 1)![0]).toBe(0xab);
    expect(at(engine)).toBe(1);
  });

  it("writes a character in the ascii column", () => {
    const { engine, source } = setup();
    key(engine, "Tab");
    key(engine, "Z");
    expect(source.peek(0, 1)![0]).toBe(0x5a);
  });

  it("inserts in insert mode instead of overwriting", () => {
    const { engine, source } = setup();
    engine.setEditMode("insert");
    expect(engine.getState().editMode).toBe("insert");
    key(engine, "a");
    key(engine, "b");
    expect(source.length).toBe(257);
    expect(source.peek(0, 2)![0]).toBe(0xab);
  });

  it("undoes a typed byte in one step", () => {
    const { engine, source } = setup();
    key(engine, "a");
    key(engine, "b");
    key(engine, "z", { metaKey: true });
    expect(source.peek(0, 1)![0]).toBe(0);
    key(engine, "z", { metaKey: true, shiftKey: true });
    expect(source.peek(0, 1)![0]).toBe(0xab);
  });

  it("deletes forwards, backwards and by selection", () => {
    const { engine, source } = setup();
    key(engine, "Delete");
    expect(source.length).toBe(255);
    engine.moveCursor(4);
    key(engine, "Backspace");
    expect(source.length).toBe(254);
    engine.select(0, 10);
    key(engine, "Delete");
    expect(source.length).toBe(244);
    expect(selection(engine)).toBeUndefined();
  });

  it("refuses every edit when read-only", () => {
    const { engine, source } = setup({ editMode: "read-only" });
    key(engine, "a");
    key(engine, "Delete");
    key(engine, "Backspace");
    key(engine, "x", { metaKey: true });
    engine.paste("FF");
    expect(source.length).toBe(256);
    expect(source.peek(0, 1)![0]).toBe(0);
  });

  it("exposes read-only as a getter derived from the mode", () => {
    const { engine } = setup();
    expect(engine.readOnly).toBe(false);
    expect(engine.editable).toBe(true);
    engine.setEditMode("read-only");
    expect(engine.readOnly).toBe(true);
    expect(engine.editable).toBe(false);
    engine.setEditMode("insert");
    expect(engine.readOnly).toBe(false);
  });

  it("is not editable when the source cannot apply changes, whatever the mode", () => {
    const engine = new HexEngine({
      source: { length: 4, version: 0, peek: () => Uint8Array.of(0, 0, 0, 0), ensure: () => Promise.resolve(), subscribe: () => () => {} },
    });
    expect(engine.readOnly).toBe(false);
    expect(engine.editable).toBe(false);
  });

  it("defaults to overwrite and keeps the mode across an options update", () => {
    const { engine } = setup();
    expect(engine.getState().editMode).toBe("overwrite");
    engine.setEditMode("insert");
    engine.setOptions({ byteGroup: 4 });
    expect(engine.getState().editMode).toBe("insert");
    engine.setOptions({ byteGroup: 4, editMode: "read-only" });
    expect(engine.getState().editMode).toBe("read-only");
  });

  it("reports edits as change sets", () => {
    const onChange = vi.fn();
    const { engine } = setup({ onChange });
    key(engine, "a");
    expect(onChange.mock.calls[0]![0].changes[0]).toMatchObject({ from: 0, to: 1 });
  });

  it("pastes as hex or as text depending on the column", () => {
    const { engine, source } = setup();
    expect(engine.paste("DE AD")).toBe(true);
    expect([...source.peek(0, 2)!]).toEqual([0xde, 0xad]);
    engine.moveCursor(0);
    key(engine, "Tab");
    engine.paste("Hi");
    expect([...source.peek(0, 2)!]).toEqual([0x48, 0x69]);
  });

  it("rejects a paste that is not hex while in the hex column", () => {
    const { engine } = setup();
    expect(engine.paste("not hex")).toBe(false);
  });

  it("inserts a paste over the selection", () => {
    const { engine, source } = setup();
    engine.select(0, 4);
    engine.paste("FF FF");
    expect(source.length).toBe(254);
    expect([...source.peek(0, 2)!]).toEqual([0xff, 0xff]);
  });

  it("copies in the format of the active column", () => {
    const onCopy = vi.fn();
    const { engine } = setup({ onCopy });
    engine.select(0x41, 0x43);
    key(engine, "c", { metaKey: true });
    engine.select(0x41, 0x43);
    key(engine, "Tab");
    key(engine, "c", { metaKey: true });
    expect(onCopy.mock.calls.map((call) => call[0])).toEqual(["41 42", "AB"]);
  });

  it("cuts the selection", () => {
    const onCopy = vi.fn();
    const { engine, source } = setup({ onCopy });
    engine.select(0, 2);
    key(engine, "x", { metaKey: true });
    expect(source.length).toBe(254);
    expect(onCopy).toHaveBeenCalledWith("00 01");
  });
});

describe("HexEngine search and goto", () => {
  it("finds hex bytes", async () => {
    const { engine } = setup(finding);
    engine.setSearchQuery("0A 0B");
    await engine.runSearch();
    expect(selection(engine)).toEqual({ start: 10, end: 12 });
  });

  it("wraps back to the only match rather than dead-ending", async () => {
    const { engine } = setup(finding);
    engine.setSearchQuery("0A 0B");
    await engine.runSearch();
    await engine.runSearch();
    expect(selection(engine)).toEqual({ start: 10, end: 12 });
    expect(engine.getState().searchError).toBeUndefined();
  });

  it("walks matches backwards", async () => {
    const { engine } = setup(finding);
    engine.setSearchQuery("0A");
    await engine.runSearch();
    expect(at(engine)).toBe(10);
    await engine.runSearch("previous");
    // Only one 0x0A byte exists, so going back wraps onto it again.
    expect(at(engine)).toBe(10);
  });

  it("reports a query that matches nothing", async () => {
    const { engine } = setup(finding);
    engine.setSearchQuery("DE AD BE EF");
    await engine.runSearch();
    expect(engine.getState().searchError).toBe("No matching bytes");
  });

  it("searches text and lands in the ascii column", async () => {
    const source = new MemoryByteSource(new TextEncoder().encode("find the needle here"));
    const engine = new HexEngine({ source, platform: "mac", ...finding });
    engine.setViewportSize(800, 220);
    engine.setSearchMode("text");
    engine.setSearchQuery("needle");
    await engine.runSearch();
    expect(selection(engine)).toEqual({ start: 9, end: 15 });
    expect(engine.getState().cursor.column).toBe("ascii");
  });

  it("reports a malformed query instead of throwing", async () => {
    const { engine } = setup(finding);
    engine.setSearchQuery("zz");
    await engine.runSearch();
    expect(engine.getState().searchError).toBeTruthy();
  });

  it("goes to an address in several notations", () => {
    const { engine } = setup(finding);
    expect(engine.gotoAddress("0x20")).toBe(true);
    expect(at(engine)).toBe(32);
    expect(engine.gotoAddress("$10")).toBe(true);
    expect(at(engine)).toBe(16);
    expect(engine.gotoAddress("nope")).toBe(false);
  });

  it("reads bare digits in the configured radix", () => {
    const { engine } = setup(finding);
    engine.setOptions({ addressRadix: "decimal" });
    engine.gotoAddress("20");
    expect(at(engine)).toBe(20);
  });
});

describe("HexEngine decorations", () => {
  it("toggles a bookmark and traverses them", () => {
    const { engine } = setup();
    engine.moveCursor(8);
    key(engine, "b", { metaKey: true });
    engine.moveCursor(32);
    key(engine, "b", { metaKey: true });
    expect(engine.bookmarks()).toHaveLength(2);
    key(engine, "F2");
    expect(at(engine)).toBe(8);
    key(engine, "F2");
    expect(at(engine)).toBe(32);
    key(engine, "F2", { shiftKey: true });
    expect(at(engine)).toBe(8);
    key(engine, "b", { metaKey: true });
    expect(engine.bookmarks()).toHaveLength(1);
  });

  it("counts ranges without building them", () => {
    const { engine } = setup();
    expect(engine.bookmarkCount).toBe(0);
    expect(engine.decorationCount()).toBe(0);
    engine.toggleBookmark(8);
    engine.toggleBookmark(32);
    engine.setDecorations([{ start: 0, end: 4 }, { start: 8, end: 12 }], "structure");
    // Per kind, and the total across them.
    expect(engine.bookmarkCount).toBe(2);
    expect(engine.decorationCount("structure")).toBe(2);
    expect(engine.decorationCount()).toBe(4);
    expect(engine.bookmarkCount).toBe(engine.bookmarks().length);
    expect(engine.decorationCount()).toBe(engine.decorations.length);
    engine.toggleBookmark(8);
    expect(engine.bookmarkCount).toBe(1);
    // A kind nobody used is zero rather than undefined.
    expect(engine.decorationCount("nothing")).toBe(0);
  });

  it("labels a bookmark with its address by default", () => {
    const { engine } = setup();
    engine.moveCursor(0x10);
    engine.toggleBookmark();
    expect(engine.bookmarks()[0]?.label).toBe("00000010");
  });

  it("replaces a whole kind in one revision bump", () => {
    const { engine } = setup();
    const before = engine.getState().decorationRevision;
    engine.setDecorations([{ start: 0, end: 4 }, { start: 8, end: 12 }], "structure");
    expect(engine.getState().decorationRevision).toBe(before + 1);
    expect(engine.decorations).toHaveLength(2);
  });

  it("keeps bookmarks when structure ranges are replaced", () => {
    const { engine } = setup();
    engine.toggleBookmark(0);
    engine.setDecorations([{ start: 8, end: 12 }], "structure");
    expect(engine.decorations.filter((item) => item.kind === bookmarkKind)).toHaveLength(1);
  });

  it("carries ranges across an edit", () => {
    const { engine } = setup();
    engine.setDecorations([{ start: 10, end: 12 }], "structure");
    engine.moveCursor(0);
    engine.setEditMode("insert");
    key(engine, "f");
    key(engine, "f");
    expect(engine.decorationsAt(11, "structure")).toHaveLength(1);
  });
});

describe("HexEngine features", () => {
  it("leaves the shortcuts alone when find is off, which is the default", () => {
    const { engine } = setup();
    expect(engine.getState().searchFeature).toBe("off");
    // False, so the host does not preventDefault and the browser's own find opens.
    expect(key(engine, "f", { metaKey: true })).toBe(false);
    expect(key(engine, "h", { metaKey: true })).toBe(false);
    expect(key(engine, "g", { metaKey: true })).toBe(false);
    expect(engine.getState().searchOpen).toBe(false);
    expect(engine.getState().gotoOpen).toBe(false);
  });

  it("does nothing when a search command is called with find off", async () => {
    const { engine } = setup();
    engine.setSearchQuery("0A 0B");
    engine.openSearch();
    await engine.runSearch();
    expect(engine.getState().searchQuery).toBe("");
    expect(engine.getState().searchOpen).toBe(false);
    expect(selection(engine)).toBeUndefined();
    expect(await engine.findAllMatches()).toBe(0);
    expect(await engine.replaceAll()).toBe(0);
  });

  it("opens its own panel when find is native", () => {
    // Pinned rather than detected: the keys differ by platform, so a test that let
    // the host machine decide would assert something different on each of them.
    const { engine } = setup({ ...finding, platform: "mac" });
    expect(key(engine, "f", { metaKey: true })).toBe(true);
    expect(engine.getState().searchOpen).toBe(true);
    // ⌥⌘F, because ⌘H is Hide Application and never reaches the page.
    expect(key(engine, "f", { metaKey: true, altKey: true, code: "KeyF" })).toBe(true);
    expect(engine.getState().replaceOpen).toBe(true);
  });

  it("uses the platform's own keys for the same commands", () => {
    const mac = setup({ ...finding, platform: "mac" }).engine;
    const windows = setup({ ...finding, platform: "windows" }).engine;

    // Go to offset: ⌃G on macOS, because ⌘G is find-next there.
    expect(key(mac, "g", { ctrlKey: true })).toBe(true);
    expect(mac.getState().gotoOpen).toBe(true);
    expect(key(windows, "g", { ctrlKey: true })).toBe(true);
    expect(windows.getState().gotoOpen).toBe(true);

    // And ⌘G on macOS is find-next, which on Windows is F3.
    expect(key(mac, "g", { metaKey: true })).toBe(true);
    expect(mac.getState().searchOpen).toBe(true); // no query yet, so it opens the panel
    expect(key(windows, "g", { metaKey: true })).toBe(false);
    expect(key(windows, "F3")).toBe(true);
  });

  it("reports the keys in force, written the way the platform writes them", () => {
    const mac = setup({ ...finding, platform: "mac" }).engine;
    expect(mac.keyPlatform).toBe("mac");
    expect(mac.keyFor("findNext")).toBe("⌘G");
    expect(mac.keyFor("findPrevious")).toBe("⇧⌘G");
    expect(mac.keyFor("replace")).toBe("⌥⌘F");
    expect(mac.keyFor("goto")).toBe("⌃G");

    const windows = setup({ ...finding, platform: "windows" }).engine;
    expect(windows.keyFor("findNext")).toBe("F3");
    expect(windows.keyFor("replace")).toBe("Ctrl+H");
    expect(windows.keyFor("goto")).toBe("Ctrl+G");

    expect(commands("mac").find((command) => command.id === "goto")?.defaultKeys).toEqual(["Ctrl+G"]);
    expect(commands("windows").find((command) => command.id === "goto")?.defaultKeys).toEqual(["Mod+G"]);
  });

  it("advances the search from the grid, which is what the platform key is for", async () => {
    const { engine } = setup({ ...finding, platform: "mac" });
    // No query yet, so the key opens the panel rather than doing nothing.
    expect(key(engine, "g", { metaKey: true })).toBe(true);
    expect(engine.getState().searchOpen).toBe(true);

    engine.setSearchQuery("0A 0B");
    // With a query it advances. The scan is asynchronous, so settle before reading.
    expect(key(engine, "g", { metaKey: true })).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(at(engine)).toBe(10);
  });

  it("takes a host keymap over its own defaults", () => {
    const { engine } = setup({ ...finding, platform: "mac", keymap: { find: "Ctrl+Shift+F", goto: null } });
    expect(engine.keyFor("find")).toBe("⌃⇧F");
    // The default is gone, not merely shadowed.
    expect(key(engine, "f", { metaKey: true })).toBe(false);
    expect(key(engine, "f", { ctrlKey: true, shiftKey: true })).toBe(true);
    expect(engine.getState().searchOpen).toBe(true);
    // Unbound, so nothing runs and the platform keeps the key.
    expect(engine.keyFor("goto")).toBeUndefined();
    expect(key(engine, "g", { ctrlKey: true })).toBe(false);
  });

  it("reads a platform name from either of the two things a browser reports", () => {
    expect(platformFromName("MacIntel")).toBe("mac");
    expect(platformFromName("macOS")).toBe("mac");
    expect(platformFromName("iPad")).toBe("mac");
    expect(platformFromName("Win32")).toBe("windows");
    expect(platformFromName("Windows")).toBe("windows");
    expect(platformFromName("Linux x86_64")).toBe("linux");
    expect(platformFromName("X11")).toBe("linux");
    // Chrome reports userAgentData.platform as an empty string often enough that
    // treating "present" as "answered" mis-detected a Mac as the fallback.
    expect(platformFromName("")).toBeUndefined();
    expect(platformFromName("   ")).toBeUndefined();
  });

  it("says what a host told it to say, and keeps English for the rest", async () => {
    const { engine } = setup({
      ...finding,
      platform: "mac",
      text: {
        noMatch: "일치하는 바이트가 없습니다",
        replaced: (count) => `${count}건 바꿨습니다`,
        cursorHexColumn: "16진 열",
        commands: { findNext: "다음 찾기" },
      },
    });
    engine.setSearchQuery("DE AD BE EF");
    await engine.runSearch();
    expect(engine.getState().searchError).toBe("일치하는 바이트가 없습니다");
    // Interpolation is the host's function, so word order is theirs too.
    expect(engine.text.replaced(3)).toBe("3건 바꿨습니다");
    expect(engine.describeCursor()).toContain("16진 열");
    // A named command is translated; the others keep their default.
    expect(engine.keybindings.find((binding) => binding.id === "findNext")?.label).toBe("다음 찾기");
    expect(engine.keybindings.find((binding) => binding.id === "find")?.label).toBe("Find");
    // Untouched entries are still English.
    expect(engine.text.emptyQuery).toBe("Enter something to find");
  });

  it("uses its own strings when the host supplies none", async () => {
    const { engine } = setup(finding);
    engine.setSearchQuery("DE AD BE EF");
    await engine.runSearch();
    expect(engine.getState().searchError).toBe("No matching bytes");
    expect(engine.text).toBe(defaultText);
  });

  it("refuses a keymap it cannot honour", () => {
    const rejected: [string, Partial<HexEngineOptions>][] = [
      ["unknown command", { keymap: { nope: "Mod+K" } as never }],
      ["unparseable key", { keymap: { find: "Mod+" } }],
      ["two keys in one binding", { keymap: { find: "Mod+F+G" } }],
      ["a key the platform owns", { keymap: { find: "Mod+C" } }],
      ["a key macOS takes first", { platform: "mac", keymap: { find: "Mod+H" } }],
      ["the Meta key off macOS", { platform: "windows", keymap: { find: "Meta+K" } }],
      ["one key on two commands", { keymap: { find: "Mod+K", replace: "Mod+K" } }],
    ];
    for (const [reason, options] of rejected) {
      expect(() => setup({ ...finding, ...options }), reason).toThrow();
    }
    // And the same key is fine where the platform does not take it first. Replace
    // has to be unbound because Mod+H is already its default on Windows — which is
    // itself the point: the key is usable there and unusable on macOS.
    expect(() => setup({ ...finding, platform: "windows", keymap: { find: "Mod+H", replace: null } })).not.toThrow();
  });

  it("asks the host to open its own panel when find is custom", () => {
    const requests: string[] = [];
    const { engine } = setup({ search: "custom", platform: "mac", onSearchRequest: (request) => requests.push(request.kind) });
    // Consumed even though nothing opened here: the host was told, so the
    // browser's find bar must not open on top of whatever it shows.
    expect(key(engine, "f", { metaKey: true })).toBe(true);
    expect(key(engine, "f", { metaKey: true, altKey: true, code: "KeyF" })).toBe(true);
    expect(key(engine, "g", { ctrlKey: true })).toBe(true);
    expect(requests).toEqual(["search", "replace", "goto"]);
    // No panel state of its own; the host owns that.
    expect(engine.getState().searchOpen).toBe(false);
  });

  it("still scans and highlights in custom mode", async () => {
    const { engine } = setup({ search: "custom" });
    engine.setSearchQuery("0A 0B");
    await engine.runSearch();
    expect(selection(engine)).toEqual({ start: 10, end: 12 });
    expect(await engine.findAllMatches()).toBe(1);
  });

  it("can find without replacing", async () => {
    const { engine } = setup({ search: "native", replace: "off" });
    engine.setSearchQuery("0A");
    engine.setReplaceQuery("FF");
    await engine.runSearch();
    expect(at(engine)).toBe(10);
    expect(engine.getState().replaceQuery).toBe("");
    expect(await engine.replace()).toBe(false);
  });

  it("closes an open panel when the feature is turned off", async () => {
    const { engine } = setup(finding);
    engine.setSearchQuery("0A");
    await engine.runSearch();
    engine.openSearch();
    expect(engine.getState().searchOpen).toBe(true);
    engine.setOptions({ search: "off" });
    expect(engine.getState().searchOpen).toBe(false);
    // The highlights outlived the only thing that could have cleared them.
    expect(engine.matches).toHaveLength(0);
  });

  it("routes the scan through a host provider", async () => {
    const asked: string[] = [];
    const { engine } = setup({
      search: "native",
      searchModes: ["glob"],
      searchProvider: {
        // Honours `from` like any matcher must, or the find-all fallback would
        // keep being handed the same hit.
        findNext: async (_source, query, mode, from) => {
          asked.push(`${mode}:${query}@${from}`);
          return from <= 4 ? { start: 4, end: 6 } : undefined;
        },
        findPrevious: async () => undefined,
      },
    });
    engine.setSearchMode("glob");
    engine.setSearchQuery("0?");
    await engine.runSearch();
    // The jump, then the highlighting pass that follows it.
    expect(asked).toEqual(["glob:0?@1", "glob:0?@0", "glob:0?@5"]);
    expect(selection(engine)).toEqual({ start: 4, end: 6 });
    expect(engine.getState().searchModes).toEqual(["glob"]);
  });

  it("reports a provider's complaint rather than throwing", async () => {
    const { engine } = setup({
      search: "native",
      searchProvider: {
        findNext: () => Promise.reject(new Error("bad pattern")),
        findPrevious: () => Promise.reject(new Error("bad pattern")),
      },
    });
    engine.setSearchQuery("(");
    await engine.runSearch();
    expect(engine.getState().searchError).toBe("bad pattern");
    expect(engine.getState().searching).toBe(false);
  });

  it("falls back to repeated findNext when a provider has no findAll", async () => {
    const { engine } = setup({
      search: "native",
      searchProvider: {
        findNext: async (_source, _query, _mode, from) => (from <= 8 ? { start: 8, end: 9 } : undefined),
        findPrevious: async () => undefined,
      },
    });
    engine.setSearchQuery("x");
    expect(await engine.findAllMatches()).toBe(1);
    expect(engine.matches.map((match) => match.start)).toEqual([8]);
  });
});

describe("HexEngine plain-text column", () => {
  it("drops the column, its width and its hit region", () => {
    const { engine } = setup();
    const withColumn = engine.layout;
    engine.setOptions({ asciiColumn: false });
    const without = engine.layout;
    expect(withColumn.asciiColumn).toBe(true);
    expect(without.asciiColumn).toBe(false);
    expect(without.width).toBeLessThan(withColumn.width);
    // Anywhere to the right of the hex column is still the hex column.
    expect(without.hitTest(withColumn.asciiStart + 4).region).toBe("hex");
  });

  it("keeps the cursor out of a column that is not drawn", () => {
    const { engine } = setup();
    key(engine, "Tab");
    expect(engine.getState().cursor.column).toBe("ascii");
    engine.setOptions({ asciiColumn: false });
    expect(engine.getState().cursor.column).toBe("hex");
    // Tab has nothing to switch to, so it stays a focus key.
    expect(key(engine, "Tab")).toBe(false);
    expect(engine.getState().cursor.column).toBe("hex");
    engine.moveCursor(4, "ascii");
    expect(engine.getState().cursor.column).toBe("hex");
  });

  it("does not land a text search in the hidden column", async () => {
    const source = new MemoryByteSource(new TextEncoder().encode("find the needle here"));
    const engine = new HexEngine({ source, ...finding, asciiColumn: false });
    engine.setViewportSize(800, 220);
    engine.setSearchMode("text");
    engine.setSearchQuery("needle");
    await engine.runSearch();
    expect(selection(engine)).toEqual({ start: 9, end: 15 });
    expect(engine.getState().cursor.column).toBe("hex");
  });
});

describe("HexEngine spacing", () => {
  it("moves the columns and keeps hit-testing with them", () => {
    const { engine } = setup();
    const before = engine.layout;
    engine.setOptions({ spacing: { addressPaddingRight: 40, columnGutter: 60 } });
    const after = engine.layout;

    expect(after.hexStart).toBe(before.hexStart + 24);
    expect(after.asciiStart).toBe(before.asciiStart + 24 + 32);
    expect(after.width).toBeGreaterThan(before.width);
    // The gap is hit-tested from its own half, so the boundary moved with it.
    expect(after.hitTest(after.asciiStart - 31).region).toBe("hex");
    expect(after.hitTest(after.asciiStart - 29).region).toBe("ascii");
    // And the renderer's coordinates agree, since both read the same layout.
    expect(after.byteX(0)).toBe(after.hexStart);
    expect(after.spacing.columnGutter).toBe(60);
  });

  it("makes a byte narrower when the gap after it is closed", () => {
    const { engine } = setup();
    const wide = engine.layout;
    engine.setOptions({ spacing: { byteGap: 0 } });
    const tight = engine.layout;
    // Two digits rather than three character widths per byte.
    expect(tight.byteX(1) - tight.byteX(0)).toBeCloseTo(tight.charWidth * 2, 5);
    expect(wide.byteX(1) - wide.byteX(0)).toBeCloseTo(wide.charWidth * 3, 5);
    expect(tight.width).toBeLessThan(wide.width);
    // The nibble underline still lands inside the byte it belongs to.
    expect(tight.nibbleX(0, 1) - tight.byteX(0)).toBeCloseTo(tight.charWidth, 5);
  });

  it("shortens the address column when a shorter floor is asked for", () => {
    const { engine } = setup();
    expect(engine.layout.addressDigits).toBe(8);
    engine.setOptions({ spacing: { minimumAddressDigits: 4 } });
    // 256 bytes needs two digits, so the floor is what decides.
    expect(engine.layout.addressDigits).toBe(4);
    expect(engine.layout.formatAddress(0x10)).toBe("0010");
    // A floor below what the document needs does not truncate the address.
    engine.setOptions({ spacing: { minimumAddressDigits: 1 } });
    expect(engine.layout.addressDigits).toBe(2);
  });

  it("clamps a gap that has no meaning rather than throwing", () => {
    // A slider one step past its end should not take the editor down with it.
    const { engine } = setup({ spacing: { columnGutter: -50, minimumAddressDigits: 0, byteGap: Number.NaN } });
    expect(engine.layout.spacing.columnGutter).toBe(0);
    expect(engine.layout.spacing.minimumAddressDigits).toBe(1);
    // Not a number, so the default stands rather than poisoning every coordinate.
    expect(engine.layout.spacing.byteGap).toBe(1);
    expect(Number.isFinite(engine.layout.width)).toBe(true);
  });

  it("reports the defaults when the host asks for nothing", () => {
    const { engine } = setup();
    expect(engine.layout.spacing).toEqual({
      addressPaddingLeft: 12,
      addressPaddingRight: 16,
      columnGutter: 28,
      labelGutter: 16,
      byteGap: 1,
      minimumAddressDigits: 8,
    });
  });
});

describe("HexEngine decoration labels", () => {
  it("reserves no room for labels by default", () => {
    const { engine } = setup();
    expect(engine.layout.labelWidth).toBe(0);
    // The gutter is part of the scrollable width, so with none the row ends at the column.
    expect(engine.scrollWidth).toBe(engine.layout.width);
  });

  it("reserves the asked-for number of characters when labels are on", () => {
    const { engine } = setup({ display: { decorationLabels: true } });
    const narrow = engine.layout;
    expect(narrow.labelWidth).toBe(16 * narrow.charWidth);
    // A label sits inside the row's width, so it can be scrolled to.
    expect(narrow.labelStart + narrow.labelWidth).toBeLessThanOrEqual(narrow.width);
    engine.setOptions({ display: { decorationLabels: true }, labelWidth: 64 });
    expect(engine.layout.labelWidth).toBe(64 * engine.layout.charWidth);
    expect(engine.layout.width).toBeGreaterThan(narrow.width);
  });

  it("reserves the gutter for a single range that asks for its own label", () => {
    const { engine } = setup();
    expect(engine.layout.labelWidth).toBe(0);
    engine.addDecoration({ start: 0, end: 4, label: "header", labelVisible: true });
    expect(engine.layout.labelWidth).toBeGreaterThan(0);
    engine.clearDecorations();
    expect(engine.layout.labelWidth).toBe(0);
  });

  it("does not reserve it for a label that only inherits the default", () => {
    const { engine } = setup();
    engine.addDecoration({ start: 0, end: 4, label: "header" });
    expect(engine.layout.labelWidth).toBe(0);
  });

  it("carries the override through the store", () => {
    const { engine } = setup();
    engine.setDecorations([
      { start: 0, end: 2, label: "shown", labelVisible: true },
      { start: 4, end: 6, label: "hidden", labelVisible: false },
      { start: 8, end: 10, label: "inherits" },
    ], "structure");
    const [first, second, third] = engine.decorations;
    expect(first?.labelVisible).toBe(true);
    expect(second?.labelVisible).toBe(false);
    // Absent rather than false, so "not stated" stays distinct from "hidden".
    expect(third && "labelVisible" in third).toBe(false);
  });

  it("keeps the override with its range across an edit", () => {
    const { engine } = setup();
    engine.setDecorations([{ start: 10, end: 12, label: "field", labelVisible: true }], "structure");
    engine.moveCursor(0);
    engine.setEditMode("insert");
    key(engine, "f");
    key(engine, "f");
    expect(engine.decorationsAt(11, "structure")[0]?.labelVisible).toBe(true);
  });
});

describe("HexEngine find all", () => {
  // "MVP" appears three times, at 20, 60 and 100.
  const text = () => {
    const source = new MemoryByteSource(new TextEncoder().encode("x".repeat(20) + "MVP" + "y".repeat(37) + "MVP" + "z".repeat(37) + "MVP" + "!"));
    const engine = new HexEngine({ source, platform: "mac", ...finding });
    engine.setViewportSize(800, 220);
    engine.setSearchMode("text");
    engine.setSearchQuery("MVP");
    return { engine, source };
  };

  it("highlights every hit as a decoration of its own kind", async () => {
    const { engine } = text();
    expect(await engine.findAllMatches()).toBe(3);
    expect(engine.matches.map((match) => match.start)).toEqual([20, 60, 100]);
    expect(engine.getState().searchMatchCount).toBe(3);
    expect(engine.getState().searchTruncated).toBe(false);
  });

  it("reports which hit the cursor is on", async () => {
    const { engine } = text();
    await engine.findAllMatches();
    expect(engine.getState().searchMatchIndex).toBe(0);
    engine.moveCursor(61);
    expect(engine.getState().searchMatchIndex).toBe(2);
    engine.moveCursor(0);
    expect(engine.getState().searchMatchIndex).toBe(0);
  });

  it("does not rescan while the query is unchanged", async () => {
    const { engine, source } = text();
    const peek = vi.spyOn(source, "peek");
    await engine.findAllMatches();
    const reads = peek.mock.calls.length;
    await engine.findAllMatches();
    expect(peek.mock.calls.length).toBe(reads);
    engine.setSearchQuery("VP");
    await engine.findAllMatches();
    expect(peek.mock.calls.length).toBeGreaterThan(reads);
  });

  it("moves to a hit first and highlights the rest afterwards", async () => {
    const { engine } = text();
    await engine.runSearch();
    // The jump does not wait for a whole-document scan; on a large file that scan
    // is seconds and it would sit between the key press and the movement.
    expect(engine.getState().selection).toEqual({ start: 20, end: 23 });
    await engine.findAllMatches();
    expect(engine.getState().searchMatchCount).toBe(3);
    expect(engine.getState().searchMatchIndex).toBe(1);
  });

  it("scans once however many callers ask at the same time", async () => {
    const { engine, source } = text();
    const peek = vi.spyOn(source, "peek");
    // What a key press does: stream to the hit, and start highlighting.
    const [count] = await Promise.all([engine.findAllMatches(), engine.runSearch(), engine.findAllMatches()]);
    const reads = peek.mock.calls.length;
    expect(count).toBe(3);
    await engine.findAllMatches();
    expect(peek.mock.calls.length).toBe(reads);
  });

  it("does not let a slow scan land on a query that has moved on", async () => {
    // A source whose reads are held open one at a time, so the first scan can be
    // made to finish last — which is what happens when a query changes while a
    // large document is still being read.
    const data = new TextEncoder().encode("aXbYcXdY");
    const gates: (() => void)[] = [];
    let ready = false;
    const source: ByteSource = {
      length: data.length,
      version: 0,
      peek: (offset, length) => (ready ? data.subarray(offset, offset + length) : undefined),
      ensure: () => new Promise<void>((resolve) => gates.push(() => { ready = true; resolve(); })),
      subscribe: () => () => {},
    };
    const engine = new HexEngine({ source, platform: "mac", ...finding });
    engine.setViewportSize(800, 220);
    engine.setSearchMode("text");

    engine.setSearchQuery("X");
    const first = engine.findAllMatches();
    engine.setSearchQuery("Y");
    const second = engine.findAllMatches();

    // Release the newer scan, then the older one, so the stale one lands last.
    expect(gates).toHaveLength(2);
    gates[1]!();
    await second;
    gates[0]!();
    await first;

    // "Y" sits at 3 and 7; "X" at 1 and 5. The newer query has to be the one shown.
    expect(engine.matches.map((match) => match.start)).toEqual([3, 7]);
    expect(engine.getState().searchMatchCount).toBe(2);
  });

  /**
   * The other half of the same defect. The generation guard has always thrown a
   * superseded scan's *result* away; until the source could be told, the reads
   * behind it ran to the end of the file for a query nobody was waiting on.
   */
  it("stops a superseded scan reading, not just discarding it", async () => {
    const data = new TextEncoder().encode("aXbYcXdY");
    const signals: (AbortSignal | undefined)[] = [];
    const source: ByteSource = {
      length: data.length,
      version: 0,
      peek: (offset, length) => data.subarray(offset, offset + length),
      // Never resolves: the only way out is being told to stop.
      ensure: (_offset, _length, signal) => new Promise<void>(() => { signals.push(signal); }),
      subscribe: () => () => {},
    };
    const engine = new HexEngine({ source, platform: "mac", ...finding });
    engine.setViewportSize(800, 220);
    engine.setSearchMode("text");

    engine.setSearchQuery("X");
    void engine.findAllMatches();
    await Promise.resolve();
    expect(signals.length).toBeGreaterThan(0);
    expect(signals[0]?.aborted).toBe(false);

    // A newer query supersedes it.
    engine.setSearchQuery("Y");
    void engine.findAllMatches();
    expect(signals[0]?.aborted).toBe(true);
  });

  it("stops a scan when the highlights are cleared", async () => {
    const data = new TextEncoder().encode("aXbYcXdY");
    const signals: (AbortSignal | undefined)[] = [];
    const source: ByteSource = {
      length: data.length,
      version: 0,
      peek: (offset, length) => data.subarray(offset, offset + length),
      ensure: (_offset, _length, signal) => new Promise<void>(() => { signals.push(signal); }),
      subscribe: () => () => {},
    };
    const engine = new HexEngine({ source, platform: "mac", ...finding });
    engine.setViewportSize(800, 220);
    engine.setSearchMode("text");
    engine.setSearchQuery("X");
    void engine.findAllMatches();
    await Promise.resolve();
    engine.clearMatches();
    expect(signals[0]?.aborted).toBe(true);
  });

  it("drops the highlights when the panel closes", async () => {
    const { engine } = text();
    await engine.findAllMatches();
    engine.closeSearch();
    expect(engine.matches).toHaveLength(0);
    expect(engine.getState().searchMatchCount).toBe(0);
  });
});

describe("HexEngine replace", () => {
  const setupText = (content: string, query: string, replacement: string) => {
    const source = new PieceTableSource(new TextEncoder().encode(content));
    const engine = new HexEngine({ source, platform: "mac", ...finding });
    engine.setViewportSize(800, 220);
    engine.setSearchMode("text");
    engine.setSearchQuery(query);
    engine.setReplaceQuery(replacement);
    return { engine, source };
  };
  const read = (source: PieceTableSource) => new TextDecoder().decode(source.peek(0, source.length)!);

  it("replaces the hit under the cursor and moves to the next", async () => {
    const { engine, source } = setupText("aXbXc", "X", "Y");
    await engine.runSearch();
    expect(engine.getState().cursor.offset).toBe(1);
    expect(await engine.replace()).toBe(true);
    expect(read(source)).toBe("aYbXc");
    // Moved on, so pressing it again works through the document.
    expect(engine.getState().cursor.offset).toBe(3);
  });

  it("only advances when the cursor is not on a hit", async () => {
    const { engine, source } = setupText("aXbXc", "X", "Y");
    expect(await engine.replace()).toBe(false);
    expect(read(source)).toBe("aXbXc");
    expect(engine.getState().cursor.offset).toBe(1);
  });

  it("replaces every hit in one undo step", async () => {
    const { engine, source } = setupText("aXbXcXd", "X", "Y");
    expect(await engine.replaceAll()).toBe(3);
    expect(read(source)).toBe("aYbYcYd");
    expect(engine.undo()).toBe(true);
    expect(read(source)).toBe("aXbXcXd");
    expect(engine.getState().canUndo).toBe(false);
  });

  it("keeps later offsets right when the replacement is longer", async () => {
    const { engine, source } = setupText("aXbXcXd", "X", "YYY");
    expect(await engine.replaceAll()).toBe(3);
    expect(read(source)).toBe("aYYYbYYYcYYYd");
    expect(engine.undo()).toBe(true);
    expect(read(source)).toBe("aXbXcXd");
  });

  it("treats an empty replacement as a deletion", async () => {
    const { engine, source } = setupText("aXXbXXc", "XX", "");
    expect(await engine.replaceAll()).toBe(2);
    expect(read(source)).toBe("abc");
    expect(engine.undo()).toBe(true);
    expect(read(source)).toBe("aXXbXXc");
  });

  it("does not replace overlapping hits twice", async () => {
    const { engine, source } = setupText("aAAAb", "AA", "-");
    // "AA" matches at 1 and at 2; replacing both would rewrite the same byte.
    expect(await engine.replaceAll()).toBe(1);
    expect(read(source)).toBe("a-Ab");
  });

  it("reports how many it replaced", async () => {
    const { engine } = setupText("aXbXc", "X", "Y");
    await engine.replaceAll();
    expect(engine.getState().replaceMessage).toBe("Replaced 2");
  });

  it("says so when there is nothing to replace", async () => {
    const { engine } = setupText("abc", "X", "Y");
    expect(await engine.replaceAll()).toBe(0);
    expect(engine.getState().replaceMessage).toBe("No matching bytes");
  });

  it("refuses to replace in a read-only document", async () => {
    const { engine, source } = setupText("aXb", "X", "Y");
    engine.setEditMode("read-only");
    expect(await engine.replaceAll()).toBe(0);
    expect(engine.getState().replaceMessage).toBe("This document cannot be edited");
    expect(read(source)).toBe("aXb");
  });

  it("rejects a replacement that is not hex in hex mode", async () => {
    const { engine, source } = setupText("aXb", "58", "zz");
    engine.setSearchMode("hex");
    engine.setSearchQuery("58");
    engine.setReplaceQuery("zz");
    expect(await engine.replaceAll()).toBe(0);
    expect(engine.getState().replaceMessage).toContain("hexadecimal");
    expect(read(source)).toBe("aXb");
  });

  it("says the cap was hit rather than pretending it replaced everything", async () => {
    const { engine, source } = setupText("A".repeat(searchMatchLimit + 500), "A", "b");
    expect(await engine.replaceAll()).toBe(searchMatchLimit);
    expect(engine.getState().replaceMessage).toContain(`more than ${searchMatchLimit} matched`);
    expect(read(source).endsWith("A".repeat(500))).toBe(true);
    // Running it again finishes the job, which is what the message says to do.
    expect(await engine.replaceAll()).toBe(500);
    expect(read(source)).toBe("b".repeat(searchMatchLimit + 500));
  });

  it("leaves the highlights ready to rescan after an edit", async () => {
    const { engine } = setupText("aXbXc", "X", "X");
    await engine.findAllMatches();
    engine.moveCursor(0);
    engine.writeByte(0, 0x7a);
    // The written byte could itself be a hit, so the scanned set is no longer trusted.
    expect(await engine.findAllMatches()).toBe(2);
  });
});

describe("HexEngine text alternative", () => {
  it("describes where the cursor is and what is under it", () => {
    const { engine } = setup();
    engine.moveCursor(0x41);
    // 0x41 is byte 0x41, which is also the letter A in the sample document.
    expect(engine.describeCursor()).toBe("00000041, byte 41, character A, hex column");
  });

  it("leaves out the character when the byte is not printable", () => {
    const { engine } = setup();
    engine.moveCursor(1);
    expect(engine.describeCursor()).toBe("00000001, byte 01, hex column");
  });

  it("names the column and the size of the selection", () => {
    const { engine } = setup();
    engine.select(0x10, 0x20);
    key(engine, "Tab");
    expect(engine.describeCursor()).toContain("text column");
    expect(engine.describeCursor()).toContain("16 bytes selected");
  });

  it("says so rather than inventing a byte that has not arrived", async () => {
    const source = new PagedByteSource({ length: 4096, fetch: () => new Promise<Uint8Array>(() => {}) });
    const engine = new HexEngine({ source });
    engine.setViewportSize(800, 220);
    expect(engine.describeCursor()).toBe("00000000, not loaded, hex column");
  });
});

/**
 * The cursor description says where you are. These say what is there, which is
 * the half a painted grid gives a sighted reader for nothing and gave a screen
 * reader nothing at all.
 */
describe("HexEngine reading on demand", () => {
  it("reads the row the cursor is on", () => {
    const { engine } = setup();
    engine.moveCursor(0x41);
    // The row is 0x40-0x4F, which is "@" and then the alphabet — a row where the
    // hex and the text halves are both worth checking.
    expect(engine.describeRow()).toBe(
      "row 00000040, 40 41 42 43 44 45 46 47 48 49 4A 4B 4C 4D 4E 4F, text @ABCDEFGHIJKLMNO",
    );
  });

  it("leaves out the text half when there is no text column", () => {
    const { engine } = setup({ asciiColumn: false });
    engine.moveCursor(0x41);
    expect(engine.describeRow()).toBe("row 00000040, 40 41 42 43 44 45 46 47 48 49 4A 4B 4C 4D 4E 4F");
  });

  it("says a row has not arrived rather than reading bytes it does not have", () => {
    const source = new PagedByteSource({ length: 4096, fetch: () => new Promise<Uint8Array>(() => {}) });
    const engine = new HexEngine({ source });
    engine.setViewportSize(800, 220);
    expect(engine.describeRow()).toBe("row 00000000 has not loaded yet");
  });

  it("reads the selection back, with the addresses of its ends", () => {
    const { engine } = setup();
    engine.select(0x41, 0x45);
    // Inclusive: 0x44 is the last selected byte, and the offset after it is not
    // somewhere a reader can go and still be inside the selection.
    expect(engine.describeRegion()).toBe("4 bytes selected, 00000041 to 00000044, 41 42 43 44");
  });

  it("caps the bytes it reads and says that it did", () => {
    const { engine } = setup();
    engine.select(0, 200);
    const described = engine.describeRegion();
    // The count is the fact and the digits are a sample; a selection read out in
    // full is minutes of speech nobody waited for.
    expect(described).toContain("200 bytes selected");
    expect(described.endsWith(", and more")).toBe(true);
    expect(described.match(/\b[0-9A-F]{2}\b/g)!.length).toBe(64);
  });

  it("names what is highlighted here when nothing is selected", () => {
    const { engine } = setup();
    engine.addDecoration({ start: 0x40, end: 0x50, label: "ELF header" });
    engine.moveCursor(0x41);
    expect(engine.describeRegion()).toBe("ELF header, 00000040 to 0000004F");
  });

  it("falls back to the kind, and then to saying it is highlighted at all", () => {
    const { engine } = setup();
    engine.addDecoration({ start: 0, end: 4, kind: "checksum" });
    engine.addDecoration({ start: 8, end: 12 });
    engine.moveCursor(1);
    expect(engine.describeRegion()).toBe("checksum, 00000000 to 00000003");
    engine.moveCursor(9);
    expect(engine.describeRegion()).toBe("highlighted, 00000008 to 0000000B");
  });

  it("says so when there is neither a selection nor anything here", () => {
    const { engine } = setup();
    engine.moveCursor(3);
    expect(engine.describeRegion()).toBe(defaultText.nothingToRead);
  });

  it("answers the same question twice, because a second press is a second ask", () => {
    const { engine } = setup();
    engine.moveCursor(0x41);
    expect(engine.runCommand("readRow")).toBe(true);
    const first = engine.getState().announcement!;
    expect(engine.runCommand("readRow")).toBe(true);
    const second = engine.getState().announcement!;
    // Same words, and a view that compared words would have stayed silent.
    expect(second.text).toBe(first.text);
    expect(second.serial).toBe(first.serial + 1);
  });

  it("is bound to a key that arrives with Alt held", () => {
    const { engine } = setup();
    engine.moveCursor(0x41);
    // `⌥R` types "®" on macOS, which is why an Alt-bearing binding matches on
    // `code`. A test pressing the character would pass on a keyboard nobody has.
    expect(engine.handleKey({ key: "®", code: "KeyR", altKey: true } as never)).toBe(true);
    expect(engine.getState().announcement?.text).toContain("row 00000040");
    expect(engine.handleKey({ key: "®", code: "KeyR", altKey: true, shiftKey: true } as never)).toBe(true);
    expect(engine.getState().announcement?.text).toBe(defaultText.nothingToRead);
  });

  it("lets a host say something of its own in the same place", () => {
    const { engine } = setup();
    engine.announce("parse finished, 412 fields");
    expect(engine.getState().announcement?.text).toBe("parse finished, 412 fields");
    // Nothing to say is not an announcement; it would only overwrite one.
    engine.announce("");
    expect(engine.getState().announcement?.text).toBe("parse finished, 412 fields");
  });
});

describe("HexEngine controlled cursor", () => {
  it("reports every move once", () => {
    const moves: number[] = [];
    const { engine } = setup({ onCursorChange: (cursor) => moves.push(cursor.offset) });
    engine.moveCursor(4);
    engine.moveCursor(4);
    engine.moveCursor(9);
    key(engine, "ArrowRight");
    expect(moves).toEqual([4, 9, 10]);
  });

  it("reports a column switch, since a host holding the cursor needs it", () => {
    const columns: string[] = [];
    const { engine } = setup({ onCursorChange: (cursor) => columns.push(cursor.column) });
    engine.moveCursor(4, "ascii");
    expect(columns).toEqual(["ascii"]);
  });

  it("keeps the cursor inside a selection assigned from outside", () => {
    const { engine } = setup();
    engine.moveCursor(0x30);
    engine.select(0x30, 0x34, "keep");
    expect(at(engine)).toBe(0x30);
    // Outside the range there is nothing to keep, so it falls back to the end.
    engine.moveCursor(0);
    engine.select(0x30, 0x34, "keep");
    expect(at(engine)).toBe(0x33);
  });

  it("clears the selection without moving the cursor", () => {
    const { engine } = setup();
    engine.select(4, 8);
    expect(at(engine)).toBe(7);
    engine.clearSelection();
    expect(selection(engine)).toBeUndefined();
    expect(at(engine)).toBe(7);
  });
});

describe("HexEngine saving in place", () => {
  const patched = async (engine: HexEngine) => {
    const stream = engine.savePatch();
    if (!stream) return undefined;
    const written: { offset: number; bytes: number[] }[] = [];
    for await (const patch of stream) written.push({ offset: patch.offset, bytes: [...patch.bytes] });
    return written;
  };

  it("has nothing to write before an edit", async () => {
    const { engine } = setup();
    expect(engine.dirtyRanges).toEqual([]);
    expect(await patched(engine)).toEqual([]);
  });

  it("offers only the bytes that changed", async () => {
    const { engine } = setup();
    engine.writeByte(0x10, 0xaa);
    engine.writeByte(0x11, 0xbb);
    engine.writeByte(0x40, 0xcc);
    // Touching bytes join into one range; a distant one stays separate.
    expect(engine.dirtyRanges).toEqual([{ start: 0x10, end: 0x12 }, { start: 0x40, end: 0x41 }]);
    expect(await patched(engine)).toEqual([
      { offset: 0x10, bytes: [0xaa, 0xbb] },
      { offset: 0x40, bytes: [0xcc] },
    ]);
  });

  it("has nothing to write once an undo lands back on the saved state", async () => {
    const { engine } = setup();
    engine.writeByte(0x10, 0xaa);
    engine.undo();
    // Not by comparing bytes, which would mean holding a copy of the document:
    // by being back at the history state the file was written from, which is
    // proof the bytes match it and costs a number.
    expect(engine.dirtyRanges).toEqual([]);
    expect(await patched(engine)).toEqual([]);
  });

  it("owes the write again after a redo", () => {
    const { engine } = setup();
    engine.writeByte(0x10, 0xaa);
    engine.undo();
    engine.redo();
    expect(engine.dirtyRanges).toEqual([{ start: 0x10, end: 0x11 }]);
  });

  it("is clean again when a redo lands back on the saved state", () => {
    const { engine } = setup();
    engine.writeByte(0x10, 0xaa);
    engine.markSaved();
    engine.undo();
    engine.redo();
    // The document is again exactly what was written out, so there is nothing
    // owed. This is the case a state id has to survive a round trip for: hand
    // out a fresh one on the way back and the answer is a redundant write.
    expect(engine.dirtyRanges).toEqual([]);
  });

  it("stays conservative part of the way back", () => {
    const { engine } = setup();
    engine.writeByte(0x10, 0xaa);
    // Far enough apart not to coalesce into one step.
    engine.writeByte(0x40, 0xbb);
    engine.undo();
    // The first edit still stands, and whether 0x40 matches the file again is a
    // question only a comparison could answer. Both ranges stay owed.
    expect(engine.dirtyRanges).toEqual([{ start: 0x10, end: 0x11 }, { start: 0x40, end: 0x41 }]);
  });

  it("treats undoing past the saved point as an edit of its own", () => {
    const { engine } = setup();
    engine.writeByte(0x10, 0xaa);
    engine.markSaved();
    engine.undo();
    // The file holds 0xAA and the document no longer does. Being at the
    // original state is not being at the saved one.
    expect(engine.dirtyRanges).toEqual([{ start: 0x10, end: 0x11 }]);
  });

  it("does not mistake the same stack depth for the same document", () => {
    const { engine } = setup();
    engine.writeByte(0x10, 0xaa);
    engine.undo();
    engine.writeByte(0x10, 0xbb);
    // One entry deep and clean were the same thing under a depth count, and this
    // document has never been written out.
    expect(engine.dirtyRanges).toEqual([{ start: 0x10, end: 0x11 }]);
  });

  it("does not mistake a coalesced keystroke for no keystroke", () => {
    const { engine } = setup();
    engine.writeByte(0x10, 0xaa);
    engine.markSaved();
    // Rewrites what the previous step wrote, within the window, so it merges
    // into that entry: the stack is the same height and the document is not.
    engine.writeByte(0x10, 0xbb);
    expect(engine.dirtyRanges).toEqual([{ start: 0x10, end: 0x11 }]);
  });

  it("gives up the saved point once an edit arrives from outside the engine", () => {
    const { engine, source } = setup();
    // A host writing to the source itself is not in the history, so a history
    // position stops describing what is on disk — and the cheap proof is gone
    // until the next save.
    source.apply(ChangeSet.replace(0x80, 0x81, Uint8Array.of(0x99)));
    engine.writeByte(0x10, 0xaa);
    engine.undo();
    expect(engine.dirtyRanges).not.toEqual([]);
  });

  it("refuses the in-place path once a length has changed", async () => {
    const { engine } = setup();
    engine.setEditMode("insert");
    engine.insertBytes(Uint8Array.of(0xff), 0x10);
    expect(engine.lengthUnchanged).toBe(false);
    expect(engine.savePatch()).toBeUndefined();
    // The whole-document path is still there, which is what a shift needs.
    expect(engine.save()).toBeDefined();
  });

  it("carries earlier ranges across a later insert", () => {
    const { engine } = setup();
    engine.writeByte(0x20, 0xaa);
    engine.setEditMode("insert");
    engine.insertBytes(Uint8Array.of(0xff), 0x10);
    expect(engine.dirtyRanges).toEqual([{ start: 0x10, end: 0x11 }, { start: 0x21, end: 0x22 }]);
  });

  it("starts clean again once the host has written it out", () => {
    const { engine } = setup();
    engine.writeByte(0x10, 0xaa);
    engine.markSaved();
    expect(engine.dirtyRanges).toEqual([]);
    expect(engine.lengthUnchanged).toBe(true);
  });

  it("forgets the previous document's changes when the source is swapped", () => {
    const { engine } = setup();
    engine.writeByte(0x10, 0xaa);
    engine.setSource(new MemoryByteSource(Uint8Array.of(1, 2, 3)));
    expect(engine.dirtyRanges).toEqual([]);
  });
});

describe("HexEngine host decoration sources", () => {
  /** A host that owns its offsets and answers per window, like a lazy parser. */
  const source = (ranges: { start: number; end: number; label: string }[]) => {
    const asked: [number, number][] = [];
    return {
      asked,
      query: {
        between(from: number, to: number) {
          asked.push([from, to]);
          return ranges.filter((range) => range.start < to && range.end > from);
        },
      },
    };
  };

  it("answers a kind from the host instead of the store", () => {
    const { engine } = setup();
    const host = source([{ start: 8, end: 16, label: "header" }, { start: 32, end: 40, label: "body" }]);
    engine.setDecorationSource("structure", host.query);

    expect(engine.decorationsBetween(0, 20, "structure").map((item) => item.label)).toEqual(["header"]);
    expect(engine.decorationsAt(10, "structure").map((item) => item.label)).toEqual(["header"]);
    expect(engine.decorationsAt(24, "structure")).toEqual([]);
    // Asked about the window, not for everything it has.
    expect(host.asked.every(([from, to]) => to - from <= 20)).toBe(true);
    expect(engine.hostedKinds).toEqual(["structure"]);
  });

  it("stamps the kind it was registered under", () => {
    const { engine } = setup();
    engine.setDecorationSource("structure", source([{ start: 0, end: 4, label: "magic" }]).query);
    expect(engine.decorationsAt(1, "structure")[0]).toMatchObject({ kind: "structure", label: "magic" });
    // A different kind must not see it.
    expect(engine.decorationsAt(1, "bookmark")).toEqual([]);
  });

  it("keeps the store's own kinds alongside a hosted one", () => {
    const { engine } = setup();
    engine.setDecorationSource("structure", source([{ start: 0, end: 8, label: "field" }]).query);
    engine.toggleBookmark(2);
    expect(engine.decorationsAt(2).map((item) => item.kind)).toEqual(expect.arrayContaining(["structure", bookmarkKind]));
    expect(engine.bookmarks()).toHaveLength(1);
  });

  it("orders a mixed window by offset and a single byte innermost first", () => {
    const { engine } = setup();
    engine.setDecorationSource("structure", source([
      { start: 0, end: 64, label: "record" },
      { start: 8, end: 16, label: "inner" },
    ]).query);
    expect(engine.decorationsBetween(0, 64, "structure").map((item) => item.label)).toEqual(["record", "inner"]);
    expect(engine.decorationsAt(10, "structure").map((item) => item.label)).toEqual(["inner", "record"]);
  });

  it("gives the kind back when the source is removed", () => {
    const { engine } = setup();
    engine.setDecorationSource("structure", source([{ start: 0, end: 4, label: "gone" }]).query);
    engine.setDecorationSource("structure", undefined);
    expect(engine.hostedKinds).toEqual([]);
    expect(engine.decorationsAt(1, "structure")).toEqual([]);
  });

  it("repaints when the host says it knows more", () => {
    const { engine } = setup();
    engine.setDecorationSource("structure", source([]).query);
    const before = engine.getState().decorationRevision;
    engine.invalidateDecorations("structure");
    expect(engine.getState().decorationRevision).toBe(before + 1);
  });
});

describe("HexEngine reading back", () => {
  it("hands over the bytes of a range", () => {
    const { engine } = setup();
    expect([...engine.read(4, 4)!]).toEqual([4, 5, 6, 7]);
  });

  it("reads what the document has now, not what the file had", () => {
    const { engine } = setup();
    engine.writeByte(4, 0x99);
    expect([...engine.read(4, 2)!]).toEqual([0x99, 5]);
  });

  it("hands over a copy, so a host cannot write through it", () => {
    const { engine } = setup();
    const taken = engine.read(0, 4)!;
    taken[0] = 0xff;
    expect([...engine.read(0, 1)!]).toEqual([0]);
  });

  it("refuses a range outside the document", () => {
    const { engine } = setup();
    expect(engine.read(-1, 4)).toBeUndefined();
    expect(engine.read(250, 100)).toBeUndefined();
  });

  it("says nothing yet for a range that has to be fetched, then answers", async () => {
    const pages = new Map<number, Uint8Array>();
    const source = new PagedByteSource({
      length: 4096,
      pageSize: 1024,
      fetch: async (offset, length) => {
        const bytes = Uint8Array.from({ length }, (_, index) => (offset + index) & 0xff);
        pages.set(offset, bytes);
        return bytes;
      },
    });
    const engine = new HexEngine({ source });
    engine.setViewportSize(800, 220);

    expect(engine.read(2048, 16)).toBeUndefined();
    await engine.ensureRead(2048, 16);
    expect([...engine.read(2048, 4)!]).toEqual([0x00, 0x01, 0x02, 0x03]);
  });
});
