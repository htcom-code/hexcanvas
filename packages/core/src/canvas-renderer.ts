import type { ByteSource } from "./byte-source.js";
import {
  byPaintOrder,
  diffDeleteKind,
  diffInsertKind,
  diffReplaceKind,
  searchKind,
  type Decoration,
  type DecorationInput,
  type DecorationQuery,
} from "./decorations.js";
import { hasUniformAdvance, type HexLayout } from "./layout.js";
import type { ByteSelection, Cursor } from "./model.js";
import { printableTable } from "./printable.js";
import { linearRowPlan, type RowPlan, type VisibleRows } from "./viewport.js";

/**
 * Every colour the canvas paints with. Resolved from the `--hexcanvas-*` custom
 * properties unless a host sets it, because a selector cannot reach a canvas.
 */
export interface HexTheme {
  /** Behind the grid. */
  background: string;
  /** Hex digits and text. */
  foreground: string;
  /** The address column, and anything else deliberately quieter. */
  muted: string;
  /** Behind selected bytes. */
  selection: string;
  /** The box around the cursor byte, and the underline marking the nibble. */
  caret: string;
  /** Backdrop for the address of the row holding the cursor. */
  cursorRow: string;
  /** Backdrop for the inverted ASCII cell of the cursor byte. */
  cursorByte: string;
  /** Glyph colour drawn on top of `cursorByte`. */
  cursorByteText: string;
  /** Default tint for decorated ranges, and the address-gutter marker. */
  decoration: string;
  /** Tint for search hits, so they do not read as bookmarks. */
  searchMatch: string;
  /** Colour of decoration labels drawn past the ASCII column. */
  decorationLabel: string;
  /** A comparison: same offsets, different bytes. */
  diffReplace: string;
  /** A comparison: bytes only the right document has. */
  diffInsert: string;
  /** A comparison: bytes only the left document has. */
  diffDelete: string;
}

/** The palette used when nothing declares the custom properties. */
export const darkTheme: HexTheme = {
  background: "#111827", foreground: "#e5e7eb", muted: "#7c8799", selection: "#264f78", caret: "#f8fafc",
  cursorRow: "#1f2937", cursorByte: "#e5e7eb", cursorByteText: "#111827",
  decoration: "#b45309", decorationLabel: "#fbbf24", searchMatch: "#0e7490",
  // Green for added and red for removed is the one diff convention every reader
  // already has; the third is amber, which is close to `decoration` but a
  // comparison and a structure overlay are rarely on screen together.
  diffReplace: "#a16207", diffInsert: "#15803d", diffDelete: "#b91c1c",
};

/** The options that change how a row is painted without changing its geometry. */
export interface HexDisplayOptions {
  /** Highlight the address of the row that holds the cursor. Defaults to true. */
  highlightCursorAddress?: boolean;
  /** Draw the cursor byte inverted in the ASCII column. Defaults to true. */
  highlightCursorAscii?: boolean;
  /**
   * Draw decoration labels. Defaults to false: a bookmark labels itself with its
   * address and a parse result labels every field, so on by default turns a
   * document into a wall of text nobody asked for. A single range can still opt
   * in with `Decoration.labelVisible`.
   */
  decorationLabels?: boolean;
  /**
   * The 256 glyphs the plain-text column draws, from `printableTable`. Defaults
   * to ASCII.
   *
   * A baked table rather than the function itself, because the renderer asks
   * per byte per frame and a host's code page should be walked once. An engine
   * builds this from its `printable` option; a renderer used directly can pass
   * `printableTable(cp437Printable)`.
   */
  printableChars?: readonly string[];
  /**
   * Alpha for a decoration that names none of its own. Defaults to 0.45 — dark
   * enough to read as a band and light enough to leave the bytes legible.
   *
   * Per-range `opacity` already existed, which is the wrong place to change a
   * house style: a parser marking a thousand fields had to repeat it a thousand
   * times.
   */
  decorationOpacity?: number;
}

/** What the renderer is handed for one frame. */
export interface RenderRequest {
  source: ByteSource;
  visibleRows: VisibleRows;
  /**
   * Which bytes each row shows. Omitted, rows are `bytesPerRow` bytes at
   * `row * bytesPerRow`, which is what they are outside a comparison.
   */
  plan?: RowPlan;
  /** Column geometry; the same instance must drive pointer hit-testing. */
  layout: HexLayout;
  rowHeight: number;
  scrollTop: number;
  /** Horizontal offset in grid pixels. The address column does not move with it. */
  scrollLeft?: number;
  cursor: Cursor;
  selection?: ByteSelection;
  /**
   * A list, or an index to ask. Every visible row queries this on every frame, so
   * a host with thousands of overlays should pass something that can answer
   * without a full pass — `DecorationStore` is one.
   */
  decorations?: readonly Decoration[] | DecorationQuery;
  theme?: HexTheme;
  display?: HexDisplayOptions;
}

/**
 * Thickness of the edge that puts a decoration back over the selection. Two
 * device-independent pixels: one is lost to rounding on a fractional row, and
 * more starts reading as a second band rather than as a boundary.
 */
const edgeHeight = 2;

/*
 * The cell arithmetic: what turns a row of `rowHeight` pixels into the boxes a
 * background, a caret and an underline are actually drawn in.
 *
 * Named here and nowhere else on purpose. Each of these is tied to one drawing
 * operation rather than to an appearance a host would choose between, so putting
 * them in `HexDisplayOptions` would freeze the renderer's internals into the API
 * for a flexibility nobody has asked for — and the browser suite pins every one
 * of them pixel for pixel, which is what would have to be re-baselined with
 * them. What they were not is readable: the same 2 meant three different things
 * in three places, and the caret's 1.5 could not be told from a typo.
 */

/**
 * How far a cell is inset from its row, top and bottom. Two rows of decorated
 * bytes read as two bands because of this; without it their fills touch and the
 * pair reads as one region twice as tall.
 */
const cellInset = 2;

/**
 * Breathing room at each end of a background fill, per column. Only the ends:
 * a run of bytes is one rect, so the gaps between the bytes inside it are
 * already covered, and what these stop is the first and last glyph sitting flush
 * against the edge of the band. The text column's is half the hex column's
 * because its cell is one character wide against three.
 */
const hexCellPad = 2;
const textCellPad = 1;

/**
 * The caret is stroked rather than filled, and a 1px stroke straddles its path,
 * so a box on whole pixels lights two rows of device pixels at half intensity.
 * Offsetting the path by half a pixel puts it back on one. Both columns take the
 * hex padding here: it is the offset the suite measured, and in the text column
 * it lands the stroke half a pixel outside the cell its fill uses.
 */
const caretStroke = 1;
const caretAlign = 0.5;

/**
 * The underline marking which nibble a hex keystroke would land in. Sits
 * directly on top of the caret's bottom stroke — `cellHeight - nibbleUnderline -
 * caretStroke` is the row above the one the stroke covers — so the two read as
 * one mark rather than overlapping into a thicker smudge.
 */
const nibbleUnderline = 2;

/** The stripe in the address gutter saying a row holds a decoration. */
const rowMarkerX = 2;
const rowMarkerWidth = 3;

/**
 * How far the cursor row's backdrop is inset into the address column, each side,
 * so it reads as a pill around the digits rather than as a band running into the
 * bytes. Half the default `addressPaddingLeft`, and taken from `addressX` rather
 * than from the padding itself, which means a host that sets a padding under
 * this pushes the backdrop's left edge off the canvas — clipped, and cheaper
 * than making the pill's shape another thing a host can get wrong.
 */
const cursorRowInset = 6;

/**
 * Kinds the library colours from the theme rather than from the range. Without
 * this a search hit and a comparison's bytes would all paint as bookmarks, and
 * every host would have to tint them itself — which is the same colour written
 * twice, once here and once in the host's CSS, drifting apart from then on.
 */
const themedKinds: Readonly<Record<string, keyof HexTheme>> = {
  [searchKind]: "searchMatch",
  [diffReplaceKind]: "diffReplace",
  [diffInsertKind]: "diffInsert",
  [diffDeleteKind]: "diffDelete",
};

/**
 * Every glyph the grid can draw, worked out once instead of per byte per frame.
 * `toString(16).padStart(2, "0").toUpperCase()` is three string allocations, and
 * a full viewport asked for it about six hundred times a frame.
 */
const hexPairs: readonly string[] = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0").toUpperCase());
/** ASCII, for a request that named no encoding; see `HexDisplayOptions.printable`. */
const defaultPrintable = printableTable();

/** What a byte that has not arrived looks like in each column. */
const pendingPair = "··";
const pendingChar = "·";

const noDecorations: readonly DecorationInput[] = [];

const emptyQuery: DecorationQuery = { between: () => [] };

/** Wraps a plain list so the renderer has one thing to ask. */
const asQuery = (decorations: RenderRequest["decorations"]): DecorationQuery => {
  if (!decorations) return emptyQuery;
  if (!Array.isArray(decorations)) return decorations as DecorationQuery;
  const items = decorations as readonly DecorationInput[];
  if (items.length === 0) return emptyQuery;
  return { between: (from, to) => items.filter((item) => item.start < to && item.end > from) };
};

/** What both passes over a row need, worked out once. */
interface RowPaint {
  y: number;
  cellTop: number;
  offset: number;
  rowLength: number;
  holdsCursor: boolean;
  decorations: readonly DecorationInput[];
}

/**
 * Paints the grid. A host uses `engine.render(canvas)` instead; this is for a host
 * that owns its own frame loop.
 */
export class HexCanvasRenderer {
  /** Reused so a repaint does not allocate one row buffer per visible row. */
  private scratch = new Uint8Array(0);
  /** The whole visible window, read in one go. See `readWindow`. */
  private window = new Uint8Array(0);

  /**
   * Every visible byte in one read, or undefined when any of it is not resident.
   * Undefined is not an error: the caller then reads the rows it can, one at a time.
   */
  private readWindow(request: RenderRequest, rows: readonly RowPaint[]): Uint8Array | undefined {
    const first = rows[0];
    const last = rows[rows.length - 1];
    if (!first || !last) return undefined;
    const length = last.offset + last.rowLength - first.offset;
    if (length <= 0) return undefined;
    if (this.window.length < length) this.window = new Uint8Array(length);
    return request.source.peek(first.offset, length, this.window);
  }

  render(canvas: HTMLCanvasElement, request: RenderRequest): void {
    const context = canvas.getContext("2d");
    if (!context) return;
    const ratio = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    if (canvas.width !== Math.floor(cssWidth * ratio) || canvas.height !== Math.floor(cssHeight * ratio)) {
      canvas.width = Math.floor(cssWidth * ratio);
      canvas.height = Math.floor(cssHeight * ratio);
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const theme = request.theme ?? darkTheme;
    const highlightAddress = request.display?.highlightCursorAddress ?? true;
    const layout = request.layout;
    const asciiColumn = layout.asciiColumn;
    // Meaningless without the column it inverts a cell in.
    const highlightAscii = asciiColumn && (request.display?.highlightCursorAscii ?? true);
    const decorationLabels = request.display?.decorationLabels ?? false;
    const printableChars = request.display?.printableChars ?? defaultPrintable;
    const decorationOpacity = request.display?.decorationOpacity ?? 0.45;
    const charWidth = layout.charWidth;
    const bytesPerRow = layout.bytesPerRow;
    const decorations = asQuery(request.decorations);
    const scrollLeft = request.scrollLeft ?? 0;
    const cellHeight = request.rowHeight - cellInset * 2;
    if (this.scratch.length < bytesPerRow) this.scratch = new Uint8Array(bytesPerRow);
    context.fillStyle = theme.background;
    context.fillRect(0, 0, cssWidth, cssHeight);
    context.font = layout.font;
    context.textBaseline = "middle";

    /**
     * Whether a row can be drawn as one string per column. Needs the face to
     * advance uniformly, and a byte to be exactly three characters wide — which
     * grouping and any gap other than the default both break, because they put
     * space between bytes that no run of text would reproduce.
     */
    const runnable = layout.byteGroup === 1
      && layout.spacing.byteGap === 1
      && hasUniformAdvance((text) => context.measureText(text).width, layout.font, charWidth, printableChars);

    // A search hit and a bookmark are both decorations, so without this they would
    // be painted the same colour and the host would have to tint hits itself.
    const tint = (item: DecorationInput): string => {
      if (item.color !== undefined) return item.color;
      const themed = item.kind === undefined ? undefined : themedKinds[item.kind];
      return themed === undefined ? theme.decoration : theme[themed];
    };

    const plan = request.plan ?? linearRowPlan(request.source.length, bytesPerRow);
    const rows: RowPaint[] = [];
    for (let row = request.visibleRows.first; row < request.visibleRows.last; row++) {
      const y = row * request.rowHeight - request.scrollTop + request.rowHeight / 2;
      const { offset, length } = plan.at(row);
      const rowLength = Math.max(0, Math.min(length, request.source.length - offset));
      rows.push({
        y,
        cellTop: y - request.rowHeight / 2 + cellInset,
        offset,
        rowLength,
        // A gap holds nothing, so it cannot hold the cursor however the offsets
        // happen to fall around it.
        holdsCursor: rowLength > 0 && request.cursor.offset >= offset && request.cursor.offset < offset + rowLength,
        decorations: rowLength === 0 ? noDecorations : [...decorations.between(offset, offset + rowLength)].sort(byPaintOrder),
      });
    }

    // One read for the whole viewport rather than one per row. Forty calls cost
    // more than the walks they perform: around 4µs a frame even on a document of
    // one piece, against 0.12µs for the same bytes in a single call.
    const windowBytes = this.readWindow(request, rows);
    const windowStart = rows[0]?.offset ?? 0;

    // The grid scrolls; the address column is painted over it afterwards, so its
    // offsets stay readable however far right the view has moved.
    context.save();
    context.translate(-scrollLeft, 0);

    for (const { y, cellTop, offset, rowLength, holdsCursor, decorations: rowDecorations } of rows) {
      // Undefined means the range has not been fetched yet; draw it as pending.
      // The fallback is per row on purpose: for a paged source one page short of
      // the window would otherwise blank every row instead of the missing ones.
      const bytes = windowBytes ?? request.source.peek(offset, rowLength, this.scratch);
      const base = windowBytes ? offset - windowStart : 0;

      // Backgrounds paint as one rect per contiguous run so the gap between
      // bytes is covered too; per-byte rects read as stripes, not a region.
      const fillRun = (first: number, last: number): void => {
        const left = layout.byteX(first) - hexCellPad;
        context.fillRect(left, cellTop, layout.byteX(last) + charWidth * 2 + hexCellPad - left, cellHeight);
        if (!asciiColumn) return;
        const asciiLeft = layout.asciiX(first) - textCellPad;
        context.fillRect(asciiLeft, cellTop, layout.asciiX(last) + charWidth + textCellPad - asciiLeft, cellHeight);
      };
      /**
       * A run's own colour along its bottom edge, at full alpha. Used to put a
       * decoration back on top of the selection, which is opaque — see below.
       */
      const edgeRun = (first: number, last: number): void => {
        const top = cellTop + cellHeight - edgeHeight;
        const left = layout.byteX(first) - hexCellPad;
        context.fillRect(left, top, layout.byteX(last) + charWidth * 2 + hexCellPad - left, edgeHeight);
        if (!asciiColumn) return;
        const asciiLeft = layout.asciiX(first) - textCellPad;
        context.fillRect(asciiLeft, top, layout.asciiX(last) + charWidth + textCellPad - asciiLeft, edgeHeight);
      };
      const clipToRow = (start: number, end: number): [number, number] | undefined => {
        const first = Math.max(start, offset) - offset;
        const last = Math.min(end, offset + rowLength) - offset - 1;
        return last >= first ? [first, last] : undefined;
      };
      for (const decoration of rowDecorations) {
        const run = clipToRow(decoration.start, decoration.end);
        if (!run) continue;
        context.fillStyle = tint(decoration);
        context.globalAlpha = decoration.opacity ?? decorationOpacity;
        fillRun(run[0], run[1]);
        context.globalAlpha = 1;
      }
      if (request.selection) {
        const run = clipToRow(request.selection.start, request.selection.end);
        if (run) {
          context.fillStyle = theme.selection;
          fillRun(run[0], run[1]);
          // The selection is opaque, so anything decorated underneath it has just
          // been erased — select a parsed record and every field boundary inside
          // it disappears. Each covered range comes back as an edge in its own
          // colour. Only where the selection actually covers it, so an unselected
          // document looks exactly as it did.
          for (const decoration of rowDecorations) {
            const decorated = clipToRow(decoration.start, decoration.end);
            if (!decorated) continue;
            const first = Math.max(decorated[0], run[0]);
            const last = Math.min(decorated[1], run[1]);
            if (last < first) continue;
            context.fillStyle = tint(decoration);
            edgeRun(first, last);
          }
        }
      }

      // Bytes are resident a row at a time, so a pending row is pending whole
      // and its colour is uniform. What breaks uniformity is a decoration
      // recolouring part of the row, and the inverted cell under the cursor.
      const recoloured = rowDecorations.some((item) => item.textColor !== undefined);
      const invertedCell = highlightAscii && holdsCursor;

      if (runnable && !recoloured && !invertedCell) {
        // One call per column instead of one per byte. Every glyph advances by
        // exactly `charWidth` and a byte is exactly three characters wide, so a
        // single run puts each byte where `byteX` says it goes — verified
        // pixel-for-pixel against the loop below, and about four times cheaper.
        context.fillStyle = bytes === undefined ? theme.muted : theme.foreground;
        let hex = "";
        let plain = "";
        for (let index = 0; index < rowLength; index++) {
          const byte = bytes?.[base + index];
          if (index > 0) hex += " ";
          hex += byte === undefined ? pendingPair : hexPairs[byte]!;
          if (asciiColumn) plain += byte === undefined ? pendingChar : printableChars[byte]!;
        }
        context.fillText(hex, layout.byteX(0), y);
        if (asciiColumn) context.fillText(plain, layout.asciiX(0), y);
      } else {
        for (let index = 0; index < rowLength; index++) {
          const byteOffset = offset + index;
          const x = layout.byteX(index);
          const byte = bytes?.[base + index];
          // Last match wins: rowDecorations is in paint order, so this is the topmost.
          let textColor: string | undefined;
          for (const decoration of rowDecorations) {
            if (decoration.textColor && byteOffset >= decoration.start && byteOffset < decoration.end) textColor = decoration.textColor;
          }
          context.fillStyle = byte === undefined ? theme.muted : textColor ?? theme.foreground;
          context.fillText(byte === undefined ? pendingPair : hexPairs[byte]!, x, y);
          if (!asciiColumn) continue;
          const asciiX = layout.asciiX(index);
          const printable = byte === undefined ? pendingChar : printableChars[byte]!;
          if (highlightAscii && byteOffset === request.cursor.offset) {
            context.fillStyle = theme.cursorByte;
            context.fillRect(asciiX - textCellPad, cellTop, charWidth + textCellPad * 2, cellHeight);
            context.fillStyle = theme.cursorByteText;
          }
          context.fillText(printable, asciiX, y);
        }
      }
      // The gutter is only reserved when labels are in use, and a label drawn
      // outside it would sit past the scrollable width where nothing reaches it.
      const labelled = layout.labelWidth === 0 ? undefined : rowDecorations.find((item) =>
        item.label !== undefined
        && (item.labelVisible ?? decorationLabels)
        && item.start >= offset && item.start < offset + rowLength);
      if (labelled) {
        // Clipped to the reserved width, so the widest label a host can produce
        // still cannot escape the width the layout promised.
        context.save();
        context.beginPath();
        context.rect(layout.labelStart, cellTop, layout.labelWidth, cellHeight);
        context.clip();
        context.fillStyle = labelled.color ?? theme.decorationLabel;
        context.fillText(labelled.label!, layout.labelStart, y);
        context.restore();
      }
      if (holdsCursor) {
        const index = request.cursor.offset - offset;
        const onHex = request.cursor.column === "hex";
        // The caret box spans the whole byte; the active nibble gets an underline.
        const boxX = onHex ? layout.byteX(index) : layout.asciiX(index);
        const boxWidth = onHex ? charWidth * 2 + hexCellPad * 2 : charWidth + textCellPad * 2;
        context.strokeStyle = theme.caret;
        context.lineWidth = caretStroke;
        context.strokeRect(boxX - hexCellPad + caretAlign, cellTop + caretAlign, boxWidth, cellHeight - caretStroke);
        if (onHex) {
          context.fillStyle = theme.caret;
          const underlineTop = cellTop + cellHeight - nibbleUnderline - caretStroke;
          context.fillRect(layout.nibbleX(index, request.cursor.nibble), underlineTop, charWidth, nibbleUnderline);
        }
      }
    }

    context.restore();

    // Only worth covering when something has scrolled underneath it.
    if (scrollLeft > 0) {
      context.fillStyle = theme.background;
      context.fillRect(0, 0, layout.addressWidth, cssHeight);
    }
    for (const { y, cellTop, offset, rowLength, holdsCursor, decorations: rowDecorations } of rows) {
      // A gap has no address, because it is not anywhere. Printing one would
      // repeat the address of the row below it, which reads as a duplicate.
      if (rowLength === 0) continue;
      if (rowDecorations.length > 0) {
        context.fillStyle = tint(rowDecorations[0]!);
        context.fillRect(rowMarkerX, cellTop, rowMarkerWidth, cellHeight);
      }
      if (holdsCursor && highlightAddress) {
        context.fillStyle = theme.cursorRow;
        context.fillRect(layout.addressX - cursorRowInset, cellTop, layout.addressWidth - cursorRowInset * 2, cellHeight);
      }
      context.fillStyle = holdsCursor && highlightAddress ? theme.foreground : theme.muted;
      context.fillText(layout.formatAddress(offset), layout.addressX, y);
    }
  }
}
