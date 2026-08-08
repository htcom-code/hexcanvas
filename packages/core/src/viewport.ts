/** What `getVisibleRows` needs: the grid's shape and where it is scrolled to. */
export interface ViewportOptions {
  bytesPerRow: number;
  rowHeight: number;
  height: number;
  scrollTop: number;
}

/** The rows a viewport covers, and how many there are in total. */
export interface VisibleRows {
  first: number;
  last: number;
  total: number;
}

/** The bytes one row shows. A row with no bytes is a gap; see `RowPlan`. */
export interface RowSpan {
  offset: number;
  length: number;
}

/**
 * Which bytes each row shows.
 *
 * Normally row `r` holds `bytesPerRow` bytes starting at `r * bytesPerRow`, and
 * that arithmetic used to be written out in the renderer, the hit test, the
 * scroll maths and the arrow keys. It is a plan now because a comparison needs a
 * different one: once an edit script has recognised that a byte was inserted,
 * the two documents' corresponding bytes sit at different offsets, and keeping
 * them on the same line means one side leaving a gap where the other has
 * something extra. A row can therefore start anywhere, be short, or be empty.
 *
 * The default plan is the old arithmetic, so nothing that has not asked for a
 * comparison sees any difference.
 */
export interface RowPlan {
  readonly rows: number;
  /** What row `r` shows, or a zero-length span for a gap. */
  at(row: number): RowSpan;
  /** The row holding `offset`, for scrolling to it and for the cursor. */
  rowOf(offset: number): number;
  /** Where in its row `offset` sits, for the caret and the column scroll. */
  indexOf(offset: number): number;
}

/** Row `r` holds `bytesPerRow` bytes at `r * bytesPerRow`; the usual case. */
export function linearRowPlan(byteLength: number, bytesPerRow: number): RowPlan {
  const rows = Math.ceil(byteLength / bytesPerRow);
  return {
    rows,
    at: (row) => {
      const offset = row * bytesPerRow;
      return { offset, length: Math.max(0, Math.min(bytesPerRow, byteLength - offset)) };
    },
    rowOf: (offset) => Math.floor(offset / bytesPerRow),
    indexOf: (offset) => offset % bytesPerRow,
  };
}

/** Which rows a viewport covers at a scroll position. */
export function getVisibleRows(byteLength: number, options: ViewportOptions): VisibleRows {
  return rowsIn(Math.ceil(byteLength / options.bytesPerRow), options);
}

/**
 * A scroll position landing this far short of a row boundary counts as being on
 * it. Browsers do not store the number you assigned: Firefox keeps scroll offsets
 * in app units and hands 11000 back as 10999.650390625, which floors to the row
 * above and puts the wrong line at the top. Chromium and WebKit return it intact,
 * so this is the difference between "scrolled to row 500" meaning the same thing
 * on three engines and meaning it on two.
 *
 * Half a pixel rather than a whole one. The error measured is 0.35px, and the
 * tolerance is also what gets skipped: at a whole pixel, a genuine scroll of 21px
 * with 22px rows would report row 1 as first and leave row 0's last pixel unpainted.
 * Half covers the quantisation with room and cannot swallow a row's edge.
 */
const rowBoundaryTolerance = 0.5;

/** The same, for a plan whose row count is not the byte length over a width. */
export function rowsIn(total: number, options: Pick<ViewportOptions, "rowHeight" | "height" | "scrollTop">): VisibleRows {
  const first = Math.max(0, Math.floor((options.scrollTop + rowBoundaryTolerance) / options.rowHeight));
  const visible = Math.ceil(options.height / options.rowHeight) + 1;
  return { first: Math.min(first, Math.max(0, total - 1)), last: Math.min(total, first + visible), total };
}

/** The compression a document taller than the browser will scroll is laid out with. */
export interface ScrollScaleOptions {
  /**
   * Viewport height in DOM pixels. Both the scrollbar's range and the
   * document's exclude it, so leaving it out is only right for a document that
   * needs no compression.
   */
  viewportHeight?: number;
  maxScrollHeight?: number;
}

/** Maps a potentially huge file into a browser-safe scroll height. */
export function createScrollScale(totalRows: number, rowHeight: number, options: ScrollScaleOptions = {}) {
  const maxScrollHeight = options.maxScrollHeight ?? 16_000_000;
  const viewportHeight = options.viewportHeight ?? 0;
  const naturalHeight = totalRows * rowHeight;
  const height = Math.min(naturalHeight, maxScrollHeight);
  // What each end of the scrollbar means: its start is document pixel zero and
  // its end is the offset that puts the last row against the bottom edge, which
  // is `naturalHeight - viewportHeight`. Scaling the full heights against each
  // other instead maps the end to a smaller offset and leaves
  // `viewportHeight * (scale - 1)` document pixels — thousands of rows in a
  // large file — with no scroll position that reaches them.
  const domRange = Math.max(0, height - viewportHeight);
  const documentRange = Math.max(0, naturalHeight - viewportHeight);
  const scale = domRange > 0 && documentRange > domRange ? documentRange / domRange : 1;
  /**
   * The document's own end, whatever the scroller reports. A browser cannot lay
   * out a spacer of 15,999,389.5px exactly — Chrome rounds it up to the nearest
   * value it can hold — so the offset it will scroll to can exceed
   * `height - viewportHeight`, and the compression multiplies that slack by the
   * scale: 20px of it became 188px of blank space past the end of a 102 MB file.
   */
  const clamp = (logical: number) => Math.min(Math.max(0, logical), documentRange);

  return {
    height,
    /**
     * Scroll position in document pixels, unrounded. Snapping this to a row
     * boundary would lose `maxScrollTop % rowHeight` pixels at the very bottom,
     * which is where the last row lives.
     */
    toLogical(scrollTop: number) { return clamp(scrollTop * scale); },
    toRow(scrollTop: number) { return Math.floor(clamp(scrollTop * scale) / rowHeight); },
    toScrollTop(row: number) { return (row * rowHeight) / scale; },
    /** Inverse of `toLogical`, for scrolling to an exact document pixel. */
    fromLogical(logical: number) { return logical / scale; },
  };
}
