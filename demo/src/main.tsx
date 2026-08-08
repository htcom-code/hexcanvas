import { StrictMode, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { bookmarkKind, MemoryByteSource, PagedByteSource, PieceTableSource, type AddressRadix, type ByteGroupSize, type ByteSource, type EditMode, type FeatureMode, type HexEngine, type HexSpacing, type HexTextOverrides, type LabelWidth, type Platform, type SearchRequest } from "@hexcanvas/core";
import { createAnchoredDiffProvider, createEditScriptDiffProvider, type DiffProvider } from "@hexcanvas/core";
import { HexEditor } from "@hexcanvas/react";
// Imported for the side effect: the package registers `<hexcanvas-compare>` on
// import, and the demo places the tag rather than a React component.
import type { HexCanvasCompare } from "@hexcanvas/element";
import "@hexcanvas/element";
import "./styles.css";

const text = new TextEncoder().encode("HexCanvas MVP\nEdit hexadecimal digits or ASCII text.\nUse Tab to switch columns.\n");
const bytes = new Uint8Array(16 * 1024);
for (let index = 0; index < bytes.length; index++) bytes[index] = text[index % text.length]!;

const memorySource = new MemoryByteSource(bytes);
// Stands in for a file handle or IPC: pages arrive late, so unread rows render
// as pending until `ensure` resolves.
const pagedSource = new PagedByteSource({
  length: bytes.length,
  pageSize: 1024,
  fetch: (offset, length) => new Promise((resolve) => {
    setTimeout(() => resolve(bytes.slice(offset, offset + length)), 400);
  }),
});
// Insert and delete without rewriting the original, over the same lazy pages.
const pieceTableSource = new PieceTableSource(new MemoryByteSource(bytes));
/**
 * Every byte value, in order, repeated.
 *
 * The other three documents are ASCII text, which makes them useless for the
 * one thing the text-encoding setting does: below 0x80 all three encodings
 * agree, so switching between them changed one newline and nothing else. A
 * control the reader cannot see working is not a control.
 */
const everyByteSource = new MemoryByteSource(
  Uint8Array.from({ length: 4 * 1024 }, (_, at) => at & 0xff),
);

const sources: Record<string, ByteSource> = {
  memory: memorySource,
  "piece table": pieceTableSource,
  "paged (400ms)": pagedSource,
  "every byte value": everyByteSource,
};

/**
 * The same document with a few bytes rewritten and eight appended, so a
 * comparison has something to find that is worth looking at: three replaced runs
 * spread through the file, and one insertion hanging off the end. Aligned
 * comparison is exactly what this pair is fair to — nothing is *shifted*, which
 * is the case it cannot describe and an edit script can.
 */
const modifiedBytes = (() => {
  const copy = new Uint8Array(bytes.length + 8);
  copy.set(bytes);
  for (const at of [0x14, 0x15, 0x16, 0x402, 0x403, 0x1000]) copy[at] = 0x2a;
  copy.set(new TextEncoder().encode("APPENDED"), bytes.length);
  return copy;
})();

/**
 * A deterministic stream, so the comparison is the same on every load. With
 * `Math.random` the demo would show a different number of differences each
 * time, which is exactly the thing a demo must not do.
 */
function makeNoise(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/**
 * A second build of the same document, differing the way a real one does rather
 * than in one place: a header field bumped, a table edited entry by entry, a
 * whole payload region rewritten, single bytes flipped through the tail, and a
 * trailer appended. Around 160 differences of four different shapes, which is
 * what the counter, the list and walking them are actually for.
 */
const rebuiltBytes = (() => {
  const copy = new Uint8Array(bytes.length + 32);
  copy.set(bytes);
  const random = makeNoise(0x5eed);
  // A header field, so the first row already shows one.
  copy.set(new TextEncoder().encode("HEX2"), 0);
  // A table whose entries were edited through it: two bytes per record.
  for (let entry = 0x100; entry < 0x400; entry += 16) {
    copy[entry + 4] = (copy[entry + 4]! + 1) & 0xff;
    copy[entry + 5] = copy[entry + 5]! ^ 0x5a;
  }
  // A region rewritten whole. XORed with something non-zero rather than
  // assigned at random, so every byte of it genuinely differs and the run does
  // not break wherever the noise happened to land on the original value.
  for (let at = 0x1000; at < 0x1400; at++) copy[at] = bytes[at]! ^ (1 + Math.floor(random() * 255));
  // Single bytes flipped through the rest.
  for (let at = 0x1800; at < bytes.length; at += 97) copy[at] = copy[at]! ^ 0xff;
  copy.set(new TextEncoder().encode("REBUILT-TRAILER-0123456789ABCDE"), bytes.length);
  return copy;
})();

/**
 * The case aligned comparison cannot describe, kept in the demo on purpose. One
 * byte at the front shifts every offset after it, so a comparison that reads
 * offset against offset calls almost the whole file different — hundreds of
 * runs for what a person would call a single insertion. Recognising that is an
 * edit script, which is S8b; until then this is what the honest answer looks
 * like.
 */
const shiftedBytes = (() => {
  const copy = new Uint8Array(bytes.length + 1);
  copy[0] = 0x3e;
  copy.set(bytes, 1);
  return copy;
})();

/**
 * A real file, read a page at a time. `File.slice().arrayBuffer()` is already the
 * shape `fetch` asks for, so nothing is loaded until a row needs it — and wrapping
 * it in a piece table means a 100 MB file can be edited without rewriting it.
 */
const fromFile = (file: File): ByteSource => new PieceTableSource(new PagedByteSource({
  length: file.size,
  pageSize: 64 * 1024,
  fetch: async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()),
}));

/** Built once: a provider holds no per-comparison state.
 */
const editScriptProvider = createEditScriptDiffProvider();
/**
 * What the edit script hands off to past 8 MiB, offered here directly because
 * the playground's documents are far under that and it would never be seen
 * otherwise. Small blocks, since these documents are small.
 */
const anchoredProvider = createAnchoredDiffProvider({ blockSize: 256 });

const modifiedSource = new MemoryByteSource(modifiedBytes);
const rebuiltSource = new MemoryByteSource(rebuiltBytes);
const shiftedSource = new MemoryByteSource(shiftedBytes);

/** What the right-hand side can be, beyond the sources the left offers. */
const againstSources: Record<string, ByteSource> = {
  "modified copy": modifiedSource,
  "rebuilt (many edits)": rebuiltSource,
  "shifted by one byte": shiftedSource,
};

const byteGroups: ByteGroupSize[] = [1, 2, 4, 8];
// 32 makes a row wider than most windows, which is what horizontal scrolling is for.
const rowWidths = [8, 16, 24, 32];
const editModes: EditMode[] = ["read-only", "overwrite", "insert"];
const labelWidths: LabelWidth[] = [16, 32, 64];
// "off" leaves ⌘F to the browser; "custom" hands it to the host below.
const featureModes: FeatureMode[] = ["off", "native", "custom"];
/** The three the element's `text-encoding` attribute names. */
const textEncodings = ["ascii", "cp437", "latin1"] as const;
type TextEncoding = (typeof textEncodings)[number];
/**
 * `display` is the library's default — paint once a frame, whatever the display
 * runs at. The rest are what a host would plausibly ask for; 120 is here so the
 * cap can be seen doing nothing on a 60Hz screen and something on a faster one.
 */
const frameRates = ["display", 120, 60, 30, 15] as const;
/**
 * Which comparison answers. `aligned` reads offset against offset and cannot see
 * a shift; `edit script` can, and falls back to the aligned answer for a pair it
 * cannot hold or cannot describe. Pick `shifted by one byte` on the right to see
 * what the difference is.
 */
const comparisons = ["aligned", "edit script", "anchored"] as const;
// The library detects this; the demo forces it so the keys can be compared.
const platformNames: (Platform | "detect")[] = ["detect", "mac", "windows", "linux"];

/**
 * Colour templates. Each one is a block of `--hexcanvas-*` and `--ui-*` variables
 * in `styles.css` and nothing else — the editor reads its half back through
 * `refreshTheme`, which is the whole point of theming by custom property.
 *
 * The swatches are the four the eye checks first: page, grid, a decorated range,
 * a search hit.
 */
const themes = [
  { name: "dark", note: "The default." },
  { name: "light", note: "Plain white." },
  { name: "midnight", note: "One cool hue family, so a decorated region reads as structure rather than as a warning." },
  { name: "sepia", note: "A light theme that is not white, for long reading over a dump." },
  { name: "contrast", note: "Maximum separation rather than taste: a caret that cannot be mistaken for a selection." },
] as const;

const swatchProperties = ["--ui-bg", "--hexcanvas-bg", "--hexcanvas-decoration", "--hexcanvas-search"];

/**
 * Partial on purpose: only what a translator would actually change. Everything
 * left out keeps its English default, which is the point of the override being
 * partial rather than a whole table a host has to keep in step with releases.
 */
const korean: HexTextOverrides = {
  searchPanel: "찾기",
  findHexField: "16진 바이트 찾기",
  findTextField: "텍스트 찾기",
  findTextPlaceholder: "찾을 텍스트",
  searchModeField: "검색 방식",
  replaceRow: "바꾸기",
  replaceField: "바꿀 내용",
  gotoRow: "이동",
  gotoField: "이동할 주소",
  findPreviousButton: "이전 찾기",
  findNextButton: "다음 찾기",
  toggleReplaceButton: "바꾸기 열기",
  closeSearchButton: "검색 닫기",
  replaceButton: "이 항목 바꾸기",
  replaceAllButton: "모두 바꾸기",
  closeReplaceButton: "바꾸기 닫기",
  gotoButton: "이동",
  closeGotoButton: "이동 닫기",
  emptyQuery: "찾을 내용을 입력하세요",
  noMatch: "일치하는 바이트가 없습니다",
  invalidQuery: "검색어를 읽을 수 없습니다",
  invalidReplacement: "바꿀 내용을 읽을 수 없습니다",
  notEditable: "이 문서는 편집할 수 없습니다",
  notAnAddress: "주소가 아닙니다",
  replaced: (count) => `${count}건 바꿨습니다`,
  replacedTruncated: (count, limit) => `${count}건 바꿨습니다. ${limit}건을 넘겨 남았으니 다시 실행하세요`,
  cursorByteNotLoaded: "아직 읽지 않음",
  cursorByte: (hex) => `바이트 ${hex}`,
  cursorCharacter: (character) => `문자 ${character}`,
  cursorHexColumn: "16진 열",
  cursorTextColumn: "텍스트 열",
  cursorSelection: (bytes) => `${bytes}바이트 선택`,
  cursorEditMode: (mode, described) => `${mode} 모드, ${described}`,
  // Word order is the reason these are functions: Korean puts the count before
  // the verb and the verb last, which a template with holes in it cannot do.
  rowDescription: (address, hex, text) =>
    text === "" ? `${address} 행, ${hex}` : `${address} 행, ${hex}, 텍스트 ${text}`,
  rowNotLoaded: (address) => `${address} 행은 아직 읽지 않았습니다`,
  rowGap: "빈 행, 바이트가 없습니다",
  regionSelection: (from, to, bytes, hex, truncated) =>
    `${from}부터 ${to}까지 ${bytes}바이트 선택, ${hex}${truncated ? ", 이하 생략" : ""}`,
  regionDecoration: (label, from, to) => `${label}, ${from}부터 ${to}까지`,
  unnamedRegion: "표시된 범위",
  nothingToRead: "선택된 것도 표시된 것도 없습니다",
  commands: {
    find: "찾기",
    findNext: "다음 찾기",
    findPrevious: "이전 찾기",
    replace: "바꾸기",
    goto: "오프셋으로 이동",
    toggleBookmark: "북마크 토글",
    nextBookmark: "다음 북마크",
    previousBookmark: "이전 북마크",
    switchColumn: "열 전환",
    readRow: "이 행 읽기",
    readRegion: "선택 또는 이 범위 읽기",
  },
};

const languages = { English: undefined, "한국어": korean } as const;

/**
 * The column gaps, as presets rather than six number inputs. Each is what a real
 * host would actually want rather than a demonstration of the range: the defaults,
 * a tighter grid for a small window, and a wider one for reading.
 */
const spacings: Record<string, HexSpacing | undefined> = {
  default: undefined,
  tight: { addressPaddingLeft: 8, addressPaddingRight: 10, columnGutter: 16, byteGap: 0.5, minimumAddressDigits: 4 },
  roomy: { addressPaddingLeft: 16, addressPaddingRight: 24, columnGutter: 44, byteGap: 1.5 },
};

// Stands in for a parsed structure: a record with fields nested inside it.
const structureKind = "structure";
const structure = [
  { start: 0x00, end: 0x30, label: "record", color: "#6366f1", opacity: 0.25, kind: structureKind },
  { start: 0x00, end: 0x04, label: "magic", color: "#22c55e", kind: structureKind },
  { start: 0x04, end: 0x0d, label: "name", color: "#0ea5e9", kind: structureKind },
  { start: 0x14, end: 0x1c, label: "payload", color: "#f43f5e", kind: structureKind },
];

/** The enclosing range, named rather than repeated as literals in the footer. */
const record = structure[0]!;

const hex = (offset: number): string => offset.toString(16).padStart(8, "0").toUpperCase();

/**
 * How many of the others strictly contain this one. Quadratic, which is fine for
 * a parse result of four fields and would not be for a real one — a host with a
 * tree already has the depth and should use it rather than rediscovering it.
 */
const depthOf = (field: { start: number; end: number }, all: readonly { start: number; end: number }[]): number =>
  all.filter((other) => other !== field && other.start <= field.start && other.end >= field.end
    && other.end - other.start > field.end - field.start).length;

/**
 * The byte a bookmark sits on, or `··` where the page holding it has not arrived.
 * `peek` is the synchronous half of the source contract, so a miss is normal
 * rather than an error — the same reason the grid paints pending rows dimmed.
 */
const byteAt = (engine: HexEngine | undefined, offset: number): string => {
  const byte = engine?.read(offset, 1)?.[0];
  return byte === undefined ? "··" : byte.toString(16).padStart(2, "0").toUpperCase();
};

/**
 * What the page remembers between visits, under one prefix so clearing it is one
 * thing to explain.
 *
 * Storage can throw rather than merely be empty — a browser in private mode, a
 * host that turned it off, a quota that is full — and a playground that will not
 * load because it could not read a preference is worse than one that forgets.
 * So every read and write is allowed to fail into the default.
 */
const stored = {
  read(key: string): unknown {
    try {
      const value = localStorage.getItem(`hexcanvas-demo:${key}`);
      return value === null ? undefined : JSON.parse(value);
    } catch {
      return undefined;
    }
  },
  write(key: string, value: unknown): void {
    try {
      localStorage.setItem(`hexcanvas-demo:${key}`, JSON.stringify(value));
    } catch {
      // Nothing to do and nothing worth saying: the page works either way.
    }
  },
};

/**
 * State that survives a reload.
 *
 * `accept` is not optional and not decoration. What was written last time was
 * written by a previous version of this page, and an option it named may no
 * longer exist — a template that was renamed, a row width that was dropped.
 * Restoring one of those puts the page in a state its own controls cannot
 * describe, so anything that does not still pass falls back to the default.
 */
function usePersisted<T>(key: string, initial: T, accept: (value: unknown) => boolean): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const found = stored.read(key);
    return found !== undefined && accept(found) ? (found as T) : initial;
  });
  useEffect(() => stored.write(key, value), [key, value]);
  return [value, setValue];
}

/** The commonest guard: still one of the options the control offers. */
const oneOf = (options: readonly unknown[]) => (value: unknown): boolean => options.includes(value);
const isBoolean = (value: unknown): boolean => typeof value === "boolean";

/** Where a layer was left: dragged offset, and a size if one was chosen. */
interface LayerGeometry {
  x: number;
  y: number;
  width?: string;
  height?: string;
}

const isGeometry = (value: unknown): value is LayerGeometry => {
  if (typeof value !== "object" || value === null) return false;
  const shape = value as Record<string, unknown>;
  return Number.isFinite(shape.x) && Number.isFinite(shape.y)
    && (shape.width === undefined || typeof shape.width === "string")
    && (shape.height === undefined || typeof shape.height === "string");
};

/**
 * A native `<dialog>` rather than a hand-rolled overlay: Escape, the backdrop and
 * focus containment come with it, and getting those three right by hand is most
 * of what an overlay is. React holds whether it is open, so the effect only has
 * to keep the element in step.
 */
function Layer({ title, name, open, onClose, children }: {
  title: string;
  /** Names the test hook and the close button, so two layers stay distinguishable. */
  name: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  /**
   * Where the host left it: an offset from where the dialog centres itself, plus
   * a size once one has been dragged. An offset rather than absolute coordinates
   * because `margin: auto` keeps doing the centring, so a resized window still
   * puts an untouched layer in the middle.
   */
  const [geometry, setGeometry] = useState<LayerGeometry>(
    () => {
      const found = stored.read(`layer:${name}`);
      return isGeometry(found) ? found : { x: 0, y: 0 };
    },
  );
  const at = geometry;
  const from = useRef<{ x: number; y: number } | undefined>(undefined);
  /**
   * The same value, reachable synchronously. A drag ends in a handler that was
   * created before the drag moved anything, so reading the state there reads
   * what it was when the pointer went down — which stored the position the layer
   * had *before* it was dragged.
   */
  const latest = useRef(geometry);

  const move = (next: LayerGeometry) => {
    latest.current = next;
    setGeometry(next);
  };

  /** Written on a settled gesture rather than on every pixel of one. */
  const remember = (next?: LayerGeometry) => {
    if (next) move(next);
    stored.write(`layer:${name}`, latest.current);
  };

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      // The size the host chose last time, before measuring whether it fits.
      if (geometry.width) element.style.width = geometry.width;
      if (geometry.height) element.style.height = geometry.height;
      element.showModal();
      // Dragged nearly off screen, then reopened, would be a layer with no visible
      // handle to drag back. Re-centre when its header would not be reachable —
      // which a remembered position from a larger window can also produce.
      const box = element.getBoundingClientRect();
      if (box.top < 0 || box.left > window.innerWidth - 80 || box.top > window.innerHeight - 40 || box.right < 80) {
        remember({ ...latest.current, x: 0, y: 0 });
      }
    }
    if (!open && element.open) element.close();
    // `geometry` is read here but must not re-run this: opening is what the
    // effect is for, and re-running on every drag would fight the drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /**
   * The native grip writes the size onto the element itself, so there is no
   * event to listen for — only the result to notice.
   */
  useEffect(() => {
    const element = dialog.current;
    if (!element || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => {
      const width = element.style.width;
      const height = element.style.height;
      // Empty until the grip has been used; before that the stylesheet owns the
      // size and there is nothing of the host's to remember.
      if (!width && !height) return;
      if (width === latest.current.width && height === latest.current.height) return;
      remember({ ...latest.current, width: width || undefined, height: height || undefined });
    });
    observer.observe(element);
    return () => observer.disconnect();
  });

  return <dialog
    ref={dialog}
    className={`layer ${name}`}
    data-testid={name}
    style={{ translate: `${at.x}px ${at.y}px` }}
    // Escape closes it without going through React, so the state is told after.
    onClose={onClose}
    /**
     * A click outside the box is a click on the backdrop. Measured rather than
     * asked, because the target cannot tell them apart: the resize grip belongs
     * to the dialog element itself, so `target === dialog` was also true of every
     * resize, and the layer closed the moment it was made bigger.
     *
     * `detail` is 0 for a click a keyboard synthesised, which carries no
     * coordinates and would read as the far corner of the screen.
     */
    onClick={(event) => {
      if (event.detail === 0) return;
      const box = dialog.current?.getBoundingClientRect();
      if (!box) return;
      const outside = event.clientX < box.left || event.clientX > box.right
        || event.clientY < box.top || event.clientY > box.bottom;
      if (outside) onClose();
    }}
  >
    <header
      // Pointer events rather than mouse, so a trackpad and a pen drag it too.
      // Capture means the drag survives the pointer leaving the header, which is
      // most of a drag.
      onPointerDown={(event) => {
        if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
        from.current = { x: event.clientX - at.x, y: event.clientY - at.y };
        // Capture keeps the drag alive once the pointer leaves the header, which
        // is most of a drag — but it is an improvement to it, not a requirement,
        // and it throws for a pointer id that is no longer down. Losing it must
        // not take the drag with it.
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // Left to the header's own pointermove, which still tracks inside it.
        }
      }}
      onPointerMove={(event) => {
        if (!from.current) return;
        move({
          ...latest.current,
          x: event.clientX - from.current.x,
          y: event.clientY - from.current.y,
        });
      }}
      onPointerUp={() => {
        if (!from.current) return;
        from.current = undefined;
        remember();
      }}
      onPointerCancel={() => { from.current = undefined; }}
    >
      <h2>{title}</h2>
      <button type="button" aria-label={`Close ${name}`} onClick={onClose}>×</button>
    </header>
    <div className="body">{children}</div>
  </dialog>;
}

/**
 * What `search="custom"` is for: the engine keeps the scanning, the matching and
 * the highlighting, and the host draws whatever it likes.
 *
 * A layer, like this page's other panels — deliberately *not* pinned over the
 * grid. Absolute positioning inside the editor's box is exactly the overlay the
 * library just took out, and rebuilding it here would be arguing with the change
 * while demonstrating it. The point of `custom` is not a different corner to
 * float in; it is that the scan is usable with no UI attached, which is what lets
 * this list the hits and jump to any of them — something the built-in panel has
 * no way to offer.
 */
function FindPanel({ engine, find, replacing, onToggleReplace }: {
  engine: HexEngine;
  find: FindState;
  replacing: boolean;
  onToggleReplace: () => void;
}) {
  const query = useRef<HTMLInputElement>(null);

  useEffect(() => {
    query.current?.focus();
    query.current?.select();
  }, [replacing]);

  const run = (direction: "next" | "previous") => void engine.runSearch(direction);

  return <div
    className="finder"
    data-testid="host-finder"
    // Enter and Shift+Enter walk the matches. Escape is the dialog's own job.
    onKeyDown={(event) => {
      if (event.key === "Enter") { event.preventDefault(); run(event.shiftKey ? "previous" : "next"); }
    }}
  >
    <div className="row">
      <select
        aria-label="Search mode"
        value={find.mode}
        onChange={(event) => engine.setSearchMode(event.target.value)}
      >
        {find.modes.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
      </select>
      <input
        ref={query}
        aria-label="Find"
        placeholder={find.mode === "hex" ? "DE AD BE EF" : "text to find"}
        value={find.query}
        onChange={(event) => {
          engine.setSearchQuery(event.target.value);
          // Scan as it is typed, which is a host decision — the built-in panel
          // waits to be asked. The engine caches per query, so this is one scan.
          if (event.target.value) void engine.findAllMatches();
        }}
      />
      <span className="count" data-testid="host-count">
        {find.count === 0 ? "" : `${find.index > 0 ? `${find.index}/` : ""}${find.count}${find.truncated ? "+" : ""}`}
      </span>
      <button type="button" aria-label="Find previous" onClick={() => run("previous")}>↑</button>
      <button type="button" aria-label="Find next" onClick={() => run("next")}>↓</button>
      {/* Without this, opening with the find shortcut left no way to reach
          replace at all — the built-in panel has the same toggle for the same
          reason, and leaving it out is not a difference worth having. */}
      <button type="button" aria-label="Toggle replace" aria-pressed={replacing} onClick={onToggleReplace}>⇄</button>
    </div>
    {replacing && <div className="row">
      <span className="label">Replace</span>
      <input
        aria-label="Replace with"
        placeholder={find.mode === "hex" ? "CA FE" : "replacement"}
        value={find.replacement}
        onChange={(event) => engine.setReplaceQuery(event.target.value)}
      />
      <button type="button" onClick={() => void engine.replace()}>This one</button>
      <button type="button" onClick={() => void engine.replaceAll()}>All</button>
    </div>}
    {find.message && <p className="message" data-tone={find.failed ? "error" : "info"}>{find.message}</p>}
    {/* The reason to build your own: the hits as a list. Capped, because a scan
        can hold a thousand and this is a panel, not a report. */}
    {find.matches.length > 0 && <ol className="hits" data-testid="host-hits">
      {find.matches.map((match) => <li key={match.start}>
        <button
          type="button"
          // The hit the cursor is inside, not the one it starts at: `select` leaves
          // the cursor at the end of the range, so comparing starts never matches.
          className={find.at >= match.start && find.at < match.end ? "current" : undefined}
          onClick={() => engine.select(match.start, match.end)}
        >
          <span className="address">{hex(match.start)}</span>
          <span className="size">{match.end - match.start}B</span>
        </button>
      </li>)}
    </ol>}
  </div>;
}

/**
 * `<hexcanvas-compare>` placed by hand rather than written as JSX.
 *
 * The element is the whole feature here — two panes, the bar above them and the
 * coordinator holding their engines together all live inside it, so the demo's
 * job is to hand it two documents and get one engine back for the status bar.
 * Sources go on as properties, since an attribute can only carry a string.
 */
function CompareView({ left, right, names, options, properties, diffProvider, appearance, onEngine, onActivePane, onSearchRequest }: {
  left: ByteSource;
  right: ByteSource;
  /**
   * What to call each pane out loud. Both announce as "Hex editor" otherwise,
   * which tells a screen reader user there are two of something and nothing
   * about which is which — the same ambiguity the status bar's "reading left"
   * fixes for everyone who can see it.
   */
  names: { left: string; right: string };
  /** Forwarded to both panes as attributes, so the grids cannot disagree. */
  options: Record<string, string | number | boolean | undefined>;
  /** The settings an attribute cannot carry; the element hands them to both. */
  properties: { spacing: HexSpacing | undefined; text: HexTextOverrides | undefined };
  /** Replaces the comparison itself; undefined keeps the library's aligned one. */
  diffProvider: DiffProvider | undefined;
  /**
   * Only to know it changed. Switching template rewrites custom properties and
   * nothing watches the cascade, so both panes have to be told — asking the one
   * engine this hands back would repaint half the comparison.
   */
  appearance: string;
  /** Both fire again whenever the reader moves to the other pane. */
  onEngine: (engine: HexEngine) => void;
  onActivePane: (side: "left" | "right") => void;
  onSearchRequest: (kind: SearchRequest["kind"]) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [element, setElement] = useState<HexCanvasCompare>();

  useEffect(() => {
    const node = document.createElement("hexcanvas-compare") as HexCanvasCompare;
    host.current?.append(node);
    setElement(node);
    return () => node.remove();
  }, []);

  // The focused pane, reported again every time it changes. Everything the page
  // shows about "the document" — the offset, the selection, the find panel —
  // then follows the pane being read rather than the left one by convention.
  useEffect(() => {
    if (!element) return;
    const report = () => {
      onEngine(element.activeEditor.engine);
      onActivePane(element.activePane);
    };
    report();
    element.addEventListener("activepanechange", report);
    return () => element.removeEventListener("activepanechange", report);
  }, [element, onEngine, onActivePane]);

  useEffect(() => {
    if (!element) return;
    const handle = (event: Event) => onSearchRequest((event as CustomEvent).detail.kind);
    element.addEventListener("searchrequest", handle);
    return () => element.removeEventListener("searchrequest", handle);
  }, [element, onSearchRequest]);

  useEffect(() => {
    if (!element) return;
    element.spacing = properties.spacing;
    element.text = properties.text;
  }, [element, properties]);

  useEffect(() => {
    if (element) element.paneLabels = names;
  }, [element, names]);

  // A different comparison is a different answer, so it re-runs rather than
  // waiting for something else to change.
  useEffect(() => {
    if (!element) return;
    element.diffProvider = diffProvider;
    void element.compare(true);
  }, [element, diffProvider]);

  useEffect(() => {
    if (!element) return;
    for (const [name, value] of Object.entries(options)) {
      // `false` is written out, not removed. An absent attribute means "leave
      // the default alone", and three of these default to on — removing
      // `ascii-column` to turn the column off left it on.
      const next = value === undefined ? null : String(value);
      // Compared before writing: setting an attribute to the value it already
      // has still fires `attributeChangedCallback`, which would rebuild both
      // engines' options once per React render.
      if (element.getAttribute(name) === next) continue;
      if (next === null) element.removeAttribute(name);
      else element.setAttribute(name, next);
    }
  }, [element, options]);

  useEffect(() => {
    element?.refreshTheme();
  }, [element, appearance]);

  // Re-run whenever either document changes, which is what a reader means by
  // picking a different one to compare against.
  useEffect(() => {
    if (!element) return;
    element.left = left;
    element.right = right;
    void element.compare(true);
  }, [element, left, right]);

  return <div className="compare-host" ref={host} />;
}

/** What the panel above needs, read from the engine on every change. */
interface FindState {
  mode: string;
  modes: readonly string[];
  query: string;
  replacement: string;
  count: number;
  index: number;
  truncated: boolean;
  message: string | undefined;
  failed: boolean;
  at: number;
  matches: readonly { start: number; end: number }[];
}

const noFind: FindState = {
  mode: "hex", modes: ["hex", "text"], query: "", replacement: "",
  count: 0, index: 0, truncated: false, message: undefined, failed: false, at: 0, matches: [],
};

/** Enough to fill the list without materialising a thousand ranges for it. */
const shownHits = 40;

export function App() {
  /**
   * Every setting the panel offers survives a reload. A playground is somewhere
   * to try combinations, and losing the one you had set up on every refresh is
   * the difference between trying things and re-typing them. Each is guarded on
   * the way back in — see `usePersisted`.
   */
  const [addressRadix, setAddressRadix] = usePersisted<AddressRadix>("address-radix", "hex", oneOf(["hex", "decimal"]));
  const [byteGroup, setByteGroup] = usePersisted<ByteGroupSize>("byte-group", 1, oneOf(byteGroups));
  const [bytesPerRow, setBytesPerRow] = usePersisted("bytes-per-row", 16, oneOf(rowWidths));
  const [highlightCursorAddress, setHighlightCursorAddress] = usePersisted("highlight-address", true, isBoolean);
  const [highlightCursorAscii, setHighlightCursorAscii] = usePersisted("highlight-ascii", true, isBoolean);
  const [asciiColumn, setAsciiColumn] = usePersisted("ascii-column", true, isBoolean);
  const [textEncoding, setTextEncoding] = usePersisted<TextEncoding>("text-encoding", "ascii", oneOf(textEncodings));
  const [decorationLabels, setDecorationLabels] = usePersisted("decoration-labels", false, isBoolean);
  const [labelWidth, setLabelWidth] = usePersisted<LabelWidth>("label-width", 16, oneOf(labelWidths));
  // "native" here so the demo shows the panel; the library default is "off".
  const [search, setSearch] = usePersisted<FeatureMode>("search", "native", oneOf(featureModes));
  const [platform, setPlatform] = usePersisted<Platform | "detect">("platform", "detect", oneOf(platformNames));
  const [language, setLanguage] = usePersisted<keyof typeof languages>("language", "English", oneOf(Object.keys(languages)));
  const [spacing, setSpacing] = usePersisted("spacing", "default", oneOf(Object.keys(spacings)));
  /** Host-owned find: whether it is open, and whether the replace row shows. */
  const [finding, setFinding] = useState<{ replacing: boolean } | undefined>();
  const [find, setFind] = useState<FindState>(noFind);
  const [sourceName, setSourceName] = useState("memory");
  const [opened, setOpened] = useState<{ name: string; source: ByteSource }>();
  const [appearance, setAppearance] = usePersisted("appearance", "dark", oneOf(themes.map((theme) => theme.name)));
  const [engine, setEngine] = useState<HexEngine>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [structureOpen, setStructureOpen] = useState(false);
  /**
   * Held here rather than read back off an engine. A comparison has two, and
   * writing the mode into whichever one the page happens to hold left the other
   * pane editable while the footer said read-only.
   */
  const [editMode, setEditMode] = usePersisted<EditMode>("edit-mode", "overwrite", oneOf(editModes));
  const [maxFps, setMaxFps] = usePersisted<(typeof frameRates)[number]>("max-fps", "display", oneOf(frameRates));
  /** Compare mode replaces the single grid with two; see `CompareView`. */
  const [comparing, setComparing] = useState(false);
  const [againstName, setAgainstName] = usePersisted("against", "modified copy", oneOf(Object.keys(againstSources)));
  /** Which pane the reader is in, so the footer can name the document. */
  const [activePane, setActivePane] = useState<"left" | "right">("left");
  const [comparison, setComparison] = usePersisted<(typeof comparisons)[number]>("comparison", "aligned", oneOf(comparisons));
  const [status, setStatus] = useState({
    offset: 0, selected: 0, bookmarks: 0, structure: 0, length: 0, fields: "",
    // Read from the engine rather than held here: the keys depend on the platform
    // it resolved, so the host does not know them until it asks.
    keys: [] as { id: string; label: string; key: string | undefined }[],
    spacing: {} as Record<string, number>,
  });
  const [saved, setSaved] = useState<string>();
  const available: Record<string, ByteSource> = opened ? { ...sources, [opened.name]: opened.source } : sources;
  /** The right-hand side can also be a doctored copy, which the left never is. */
  const comparable: Record<string, ByteSource> = { ...available, ...againstSources };
  /** The document the footer's numbers and the Save buttons are about. */
  const activeName = comparing && activePane === "right" ? againstName : sourceName;
  /** Memoised: a fresh object every render would re-set the panes' names. */
  const paneNames = useMemo(() => ({ left: sourceName, right: againstName }), [sourceName, againstName]);
  /**
   * Only while the layer is open. `bookmarks()` builds an object per range, and
   * this component re-renders on every cursor move — `bookmarkCount` is what the
   * status bar reads for exactly that reason.
   */
  const bookmarkList = bookmarksOpen && engine ? engine.bookmarks() : [];
  // Bounded by the document the engine is actually over, not by the one the
  // Source select names. In a comparison those are different as soon as the
  // reader moves to the right pane, and the right document can be the longer.
  const structureList = structureOpen && engine
    ? engine.decorationsBetween(0, engine.byteSource.length, structureKind)
    : [];

  useEffect(() => {
    if (!engine) return;
    const read = () => {
      const state = engine.getState();
      setStatus({
        offset: state.cursor.offset,
        selected: state.selection ? state.selection.end - state.selection.start : 0,
        bookmarks: engine.bookmarkCount,
        structure: engine.decorationCount(structureKind),
        // From the engine, like everything else on this line. Reading it from
        // the Source select instead put the left document's byte count beside
        // the right pane's cursor offset as soon as the reader moved over.
        length: engine.byteSource.length,
        // Innermost first, which is what a structure view needs from a click.
        fields: engine.decorationsAt(state.cursor.offset, structureKind).map((field) => field.label).join(" ▸ "),
        keys: engine.keybindings.map(({ id, label }) => ({ id, label, key: engine.keyFor(id) })),
        spacing: engine.layout.spacing as unknown as Record<string, number>,
      });
      const search = engine.getState();
      setFind({
        mode: search.searchMode,
        modes: search.searchModes,
        query: search.searchQuery,
        replacement: search.replaceQuery,
        count: search.searchMatchCount,
        index: search.searchMatchIndex,
        truncated: search.searchTruncated,
        // Whichever of the two the engine has something to say about.
        message: search.replaceMessage ?? search.searchError,
        failed: search.replaceMessage === undefined ? search.searchError !== undefined : search.replaceFailed,
        at: search.cursor.offset,
        // `matches` builds an object per hit, so only while the panel is open.
        matches: engine.getState().searchMatchCount > 0 ? engine.matches.slice(0, shownHits) : [],
      });
    };
    read();
    return engine.subscribe(read);
    // `available` is rebuilt every render; the name and the engine are what change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, sourceName, opened]);

  /**
   * Held across renders rather than built inline. This component re-renders on
   * every cursor move, and a fresh object each time is a fresh object assigned
   * to both panes — which used to rebuild their whole option set, geometry
   * included, about three times a frame.
   */
  const compareProperties = useMemo(
    () => ({ spacing: spacings[spacing], text: languages[language] }),
    [spacing, language],
  );

  // Switching theme only rewrites CSS variables; the engine re-reads them.
  useEffect(() => {
    engine?.refreshTheme();
  }, [appearance, engine]);

  // The other save path: when no edit changed the length, only the changed ranges
  // have to be written, so the original file does not have to be rewritten.
  const savePatch = async () => {
    const stream = engine?.savePatch();
    if (!stream) {
      setSaved("a length changed — full save only");
      return;
    }
    let ranges = 0;
    let total = 0;
    for await (const patch of stream) {
      ranges++;
      total += patch.bytes.length;
    }
    engine?.markSaved();
    setSaved(ranges === 0 ? "nothing changed" : `patched ${ranges} range${ranges === 1 ? "" : "s"}, ${total} bytes`);
  };

  const save = async () => {
    const stream = engine?.save();
    if (!stream) {
      setSaved("this source cannot be saved");
      return;
    }
    let total = 0;
    for await (const chunk of stream) total += chunk.length;
    setSaved(`saved ${total} bytes`);
  };

  return <main data-theme={appearance}>
    {/* A heading rather than a span: the page had none at level one, and the
        layers' own h2s hung under nothing. Headings are how a screen reader
        user finds their way around a page they cannot see at a glance. */}
    <header><h1>HexCanvas</h1><small>Canvas-rendered virtual binary editor</small></header>
    {/* The document, not its settings: what to open stays in reach, and the
        editor options moved into the layer behind the button. */}
    <nav>
      <label>
        Source
        <select value={sourceName} onChange={(event) => setSourceName(event.target.value)}>
          {Object.keys(available).map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      </label>
      <label>
        Open a file
        <input
          type="file"
          data-testid="open-file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            setOpened({ name: `${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`, source: fromFile(file) });
            setSourceName(`${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`);
          }}
        />
      </label>
      <button type="button" data-testid="open-settings" onClick={() => setSettingsOpen(true)}>Settings</button>
      <button type="button" data-testid="open-bookmarks" onClick={() => setBookmarksOpen(true)}>
        View bookmarks{status.bookmarks > 0 ? ` (${status.bookmarks})` : ""}
      </button>
      <button type="button" data-testid="open-structure" onClick={() => setStructureOpen(true)}>
        View structure{status.structure > 0 ? ` (${status.structure})` : ""}
      </button>
      <button type="button" data-testid="toggle-compare" onClick={() => setComparing(!comparing)}>
        {comparing ? "Close comparison" : "Compare"}
      </button>
      {/* Only while comparing: the second document is meaningless otherwise, and
          a permanently visible control for it would suggest it is not. */}
      {comparing && <label>
        Against
        <select
          data-testid="compare-against"
          value={againstName}
          onChange={(event) => setAgainstName(event.target.value)}
        >
          {Object.keys(comparable).map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      </label>}
    </nav>
    <Layer title="Structure" name="structure" open={structureOpen} onClose={() => setStructureOpen(false)}>
      {structureList.length === 0
        ? <p className="empty">Nothing parsed yet. Press <strong>Mark structure</strong> below the grid.</p>
        : <ol data-testid="structure-list">
            {structureList.map((field, index) => <li key={`${field.start}-${field.end}-${index}`}>
              <button
                type="button"
                className="goto"
                // A range, so it selects rather than moving the cursor — which is
                // what a structure view is for.
                onClick={() => { engine?.select(field.start, field.end); setStructureOpen(false); }}
                // Indented by how many ranges contain it, so the nesting the
                // overlay paints is legible as a list too.
                style={{ paddingLeft: `${10 + depthOf(field, structureList) * 16}px` }}
              >
                <span className="swatch" style={{ background: field.color }} />
                <span className="field">{field.label ?? "—"}</span>
                <span className="range">
                  {hex(field.start)}–{hex(field.end)}
                  <span className="size">{field.end - field.start}B</span>
                </span>
              </button>
            </li>)}
          </ol>}
      {structureList.length > 0 && <p className="empty">
        Clicking a field selects its bytes. The status bar reads the innermost field the cursor is in, which is what <code>decorationsAt</code> answers.
      </p>}
    </Layer>
    <Layer
      title={finding?.replacing ? "Find and replace" : "Find"}
      name="find"
      open={Boolean(engine && finding && search === "custom")}
      onClose={() => { setFinding(undefined); engine?.clearMatches(); }}
    >
      {engine && finding && <FindPanel
        engine={engine}
        find={find}
        replacing={finding.replacing}
        onToggleReplace={() => setFinding({ replacing: !finding.replacing })}
      />}
    </Layer>
    <Layer title="Bookmarks" name="bookmarks" open={bookmarksOpen} onClose={() => setBookmarksOpen(false)}>
      {/* Built only while the layer is open: `bookmarks()` makes an object per
          range, and the status bar behind it repaints on every cursor move. */}
      {bookmarkList.length === 0
        ? <p className="empty">
            No bookmarks yet. Put the cursor on a byte and press <kbd>{status.keys.find((k) => k.id === "toggleBookmark")?.key ?? "Mod+B"}</kbd>,
            or click the address gutter.
          </p>
        : <ol data-testid="bookmark-list">
            {bookmarkList.map((mark) => <li key={mark.id}>
              <button
                type="button"
                className="goto"
                onClick={() => { engine?.moveCursor(mark.start); setBookmarksOpen(false); }}
              >
                <span className="address">{mark.label ?? mark.start.toString(16).padStart(8, "0").toUpperCase()}</span>
                <span className="byte">{byteAt(engine, mark.start)}</span>
              </button>
              <button
                type="button"
                aria-label={`Remove bookmark at ${mark.start}`}
                onClick={() => engine?.toggleBookmark(mark.start)}
              >×</button>
            </li>)}
          </ol>}
    </Layer>
    <Layer title="Settings" name="settings" open={settingsOpen} onClose={() => setSettingsOpen(false)}>
      <section>
        <h3>Appearance</h3>
        <label>
          Template
          <select value={appearance} onChange={(event) => setAppearance(event.target.value)}>
            {themes.map((theme) => <option key={theme.name} value={theme.name}>{theme.name}</option>)}
          </select>
        </label>
        {/* Painted from the template in force, so switching shows what changed
            rather than describing it. */}
        <p className="palette" data-testid="palette">
          {swatchProperties.map((property) => <span key={property} style={{ background: `var(${property})` }} title={property} />)}
        </p>
        <p>{themes.find((theme) => theme.name === appearance)?.note}</p>
        <label>
          Address
          <select value={addressRadix} onChange={(event) => setAddressRadix(event.target.value as AddressRadix)}>
            <option value="hex">hex</option>
            <option value="decimal">decimal</option>
          </select>
        </label>
        <label>
          Row
          <select value={bytesPerRow} onChange={(event) => setBytesPerRow(Number(event.target.value))}>
            {rowWidths.map((size) => <option key={size} value={size}>{size} bytes</option>)}
          </select>
        </label>
        <label>
          Group
          <select value={byteGroup} onChange={(event) => setByteGroup(Number(event.target.value) as ByteGroupSize)}>
            {byteGroups.map((size) => <option key={size} value={size}>{size} byte{size === 1 ? "" : "s"}</option>)}
          </select>
        </label>
      </section>
      <section>
        <h3>Spacing</h3>
        <label>
          Column gaps
          <select value={spacing} onChange={(event) => setSpacing(event.target.value)}>
            {Object.keys(spacings).map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        {/* Read back from the layout, which resolved them — a clamped value shows
            here as what took effect rather than as what was asked for. */}
        <dl data-testid="spacing">
          {Object.entries(status.spacing).map(([name, value]) => <div key={name}>
            <dt>{name.replace(/([A-Z])/g, " $1").toLowerCase()}</dt><dd>{value}</dd>
          </div>)}
        </dl>
        <p>Pixels, except <code>byteGap</code> and <code>minimumAddressDigits</code>, which are counted in characters so they follow the font.</p>
      </section>
      <section>
        <h3>Columns</h3>
        <label>
          <input type="checkbox" checked={asciiColumn} onChange={(event) => setAsciiColumn(event.target.checked)} />
          Plain-text column
        </label>
        <label>
          <input type="checkbox" checked={highlightCursorAddress} onChange={(event) => setHighlightCursorAddress(event.target.checked)} />
          Highlight the cursor's address
        </label>
        <label>
          <input type="checkbox" checked={highlightCursorAscii} onChange={(event) => setHighlightCursorAscii(event.target.checked)} />
          Invert the cursor's text cell
        </label>
        <label>
          Text encoding
          <select data-testid="text-encoding" value={textEncoding} onChange={(event) => setTextEncoding(event.target.value as TextEncoding)}>
            {textEncodings.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <p>
          What the plain-text column makes of a byte. <code>cp437</code> is the DOS character
          set, where every byte has a glyph. It reaches the cursor readout and a text copy too,
          but not find: a text query is still encoded as UTF-8, so use hex above 0x7F.
        </p>
      </section>
      <section>
        <h3>Decoration labels</h3>
        <label>
          <input type="checkbox" checked={decorationLabels} onChange={(event) => setDecorationLabels(event.target.checked)} />
          Show labels
        </label>
        <label>
          Reserved width
          <select value={labelWidth} onChange={(event) => setLabelWidth(Number(event.target.value) as LabelWidth)}>
            {labelWidths.map((size) => <option key={size} value={size}>{size} chars</option>)}
          </select>
        </label>
        <p>Off by default: a bookmark labels itself with its address, so on by default is a wall of text.</p>
      </section>
      <section>
        <h3>Find</h3>
        <label>
          Owned by
          <select value={search} onChange={(event) => setSearch(event.target.value as FeatureMode)}>
            {featureModes.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
          </select>
        </label>
        <p><code>off</code> leaves ⌘F to the browser · <code>native</code> is the editor's panel · <code>custom</code> hands the UI to this page.</p>
      </section>
      <section>
        <h3>Comparison</h3>
        <label>
          Answered by
          <select
            data-testid="comparison"
            value={comparison}
            onChange={(event) => setComparison(
              comparisons.find((name) => name === event.target.value) ?? "aligned",
            )}
          >
            {comparisons.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <p>
          <code>aligned</code> reads offset against offset, so a byte inserted at the front makes
          everything after it differ. <code>edit script</code> sees the shift and calls it one
          insertion — try it against <code>shifted by one byte</code>. <code>anchored</code> finds
          the places the two still agree without reading either whole, and is what the edit script
          hands off to past 8 MiB; it is here directly because these documents are far under that.
        </p>
      </section>
      <section>
        <h3>Painting</h3>
        <label>
          Frame rate
          <select
            data-testid="max-fps"
            value={maxFps}
            onChange={(event) => setMaxFps(
              frameRates.find((rate) => String(rate) === event.target.value) ?? "display",
            )}
          >
            {frameRates.map((rate) => <option key={rate} value={rate}>{rate === "display" ? "display" : `${rate} fps`}</option>)}
          </select>
        </label>
        <p>
          The editor paints once a frame at most, whatever changed in it. This caps it further —
          painting only, so a capped editor is no slower to type into. On a 60Hz display anything
          at or above 60 does nothing, the display already being the cap.
        </p>
      </section>
      {/* Widest and tallest, so it spans rather than leaving the cell beside it empty. */}
      <section className="wide">
        <h3>Keys</h3>
        <label>
          Defaults for
          <select value={platform} onChange={(event) => setPlatform(event.target.value as Platform | "detect")}>
            {platformNames.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <label>
          Language
          <select value={language} onChange={(event) => setLanguage(event.target.value as keyof typeof languages)}>
            {Object.keys(languages).map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        {/* Read back from the engine, which is the only thing that knows: a host
            that hardcoded these would be wrong on somebody's machine, and the
            names change with the language above. */}
        <dl data-testid="keybindings">
          {status.keys.map(({ id, label, key }) => <div key={id}><dt>{label}</dt><dd>{key ?? "—"}</dd></div>)}
        </dl>
        <p>Copy, cut, paste, select-all, undo and the arrow keys are not listed: those belong to the platform, so the editor does not offer them for rebinding.</p>
      </section>
    </Layer>
    {comparing ? <CompareView
      left={available[sourceName]!}
      right={comparable[againstName] ?? modifiedSource}
      names={paneNames}
      options={{
        "bytes-per-row": bytesPerRow,
        "address-radix": addressRadix,
        "byte-group": byteGroup,
        "highlight-cursor-address": highlightCursorAddress,
        "highlight-cursor-ascii": highlightCursorAscii,
        "ascii-column": asciiColumn,
        "decoration-labels": decorationLabels,
        "label-width": labelWidth,
        "text-encoding": textEncoding,
        platform: platform === "detect" ? undefined : platform,
        search,
        "edit-mode": editMode,
        "max-fps": maxFps === "display" ? undefined : maxFps,
      }}
      properties={compareProperties}
      diffProvider={comparison === "edit script" ? editScriptProvider : comparison === "anchored" ? anchoredProvider : undefined}
      appearance={appearance}
      onEngine={setEngine}
      onActivePane={setActivePane}
      onSearchRequest={(kind) => {
        if (kind === "goto") return;
        setFinding({ replacing: kind === "replace" });
      }}
    /> : <HexEditor
      source={available[sourceName]!}
      editMode={editMode}
      maxFps={maxFps === "display" ? undefined : maxFps}
      bytesPerRow={bytesPerRow}
      addressRadix={addressRadix}
      byteGroup={byteGroup}
      highlightCursorAddress={highlightCursorAddress}
      highlightCursorAscii={highlightCursorAscii}
      asciiColumn={asciiColumn}
      decorationLabels={decorationLabels}
      labelWidth={labelWidth}
      textEncoding={textEncoding}
      search={search}
      platform={platform === "detect" ? undefined : platform}
      text={languages[language]}
      spacing={spacings[spacing]}
      // What `search="custom"` is for: the editor keeps the scanning, the host
      // draws the UI. Here the "UI" is a prompt, to keep the demo short.
      // The editor consumed the key and told us; opening the UI is ours to do.
      // `goto` is left alone here, so ⌃G falls through to nothing — a host that
      // wants it would set `goto="native"` and keep the editor's own row.
      onSearchRequest={({ kind }) => {
        if (kind === "goto") return;
        setFinding({ replacing: kind === "replace" });
      }}
      onEngine={setEngine}
      onChange={(changes) => console.info(changes.changes.map((change) => ({ from: change.from, to: change.to, inserted: change.insert.length })))}
    />}
    {/* Every number here is read out as a bare fragment without a label — "0x",
        "00000000", "0", " selected" — so each says what it is. `title` names it
        on hover too, which the abbreviated ones needed anyway. */}
    <footer>
      {/* Beside the value rather than inside it: the span is the displayed
          address and nothing else, which is what reads it. */}
      <span className="sr-only">Cursor address</span>
      <span data-testid="cursor-offset" title="Cursor address">
        0x{status.offset.toString(16).padStart(8, "0").toUpperCase()}
      </span>
      <span data-testid="selected">{status.selected} selected</span>
      <span data-testid="bookmarks">{status.bookmarks} bookmarks</span>
      {/* The editor has no key for this, so the host provides the control. */}
      <select
        data-testid="edit-mode"
        aria-label="Edit mode"
        value={editMode}
        onChange={(event) => setEditMode(event.target.value as EditMode)}
      >
        {editModes.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
      </select>
      <span data-testid="length">{status.length} bytes</span>
      {/* Which document every other number on this line came from. The values
          follow the focused pane, and without this the reader has to guess
          which one that is.

          A live region, because the pane changes under the reader rather than
          because they asked: focusing the other grid silently re-pointed every
          number on this line, and a screen reader was never told. */}
      {comparing && <span data-testid="active-pane" role="status">
        reading <strong>{activePane}</strong> · {activeName}
      </span>}
      {/* An em dash alone reads as an em dash. */}
      <span data-testid="fields" title="Structure fields under the cursor">
        {status.fields || <><span className="sr-only">No structure field here</span><span aria-hidden="true">—</span></>}
      </span>
      <button type="button" onClick={() => engine?.setDecorations(structure, structureKind)}>Mark structure</button>
      {/* The outermost structure range, which contains three others. Selecting it
          is where selection and decoration have to be told apart: the tint under
          the bytes is a decoration, the wash over them is the selection, and a
          host asking for one must not look like it painted the other. The
          structure layer selects individual fields; this is the enclosing case. */}
      <button type="button" onClick={() => engine?.select(record.start, record.end)}>Select record</button>
      {/* Named while comparing, unlike the buttons above it. Marking structure
          on the wrong pane is a glance to undo; writing out the wrong document
          is not, so this one says which rather than leaving it to the note. */}
      <button type="button" onClick={() => void save()}>Save{comparing ? ` (${activePane})` : ""}</button>
      <button type="button" onClick={() => void savePatch()}>Save patch{comparing ? ` (${activePane})` : ""}</button>
      {saved && <span data-testid="saved">{saved}</span>}
      <span>Pick the mode on the left · Delete/Backspace remove · ⌘X cut · paste writes bytes</span>
    </footer>
  </main>;
}

/**
 * Only where there is one. The tests import this module for `App` and mount it
 * themselves; a top-level mount into a page with no root would throw before
 * they ever got hold of it.
 */
const root = document.getElementById("root");
if (root) createRoot(root).render(<StrictMode><App /></StrictMode>);
