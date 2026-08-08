import { afterEach, expect } from "vitest";
import { MemoryByteSource, type ByteSource, type HexTheme } from "@hexcanvas/core";
import { defineHexCanvasElement, type HexCanvasElement } from "@hexcanvas/element";

const disposals: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposals.splice(0).reverse()) dispose();
});

/** A container removed after the test, so one file's DOM cannot leak into the next. */
export function fixture(width = 640, height = 240): HTMLDivElement {
  const element = document.createElement("div");
  element.style.cssText = `position: fixed; left: 0; top: 0; width: ${width}px; height: ${height}px;`;
  document.body.append(element);
  disposals.push(() => element.remove());
  return element;
}

export function onCleanup(dispose: () => void): void {
  disposals.push(dispose);
}

/** A detached-but-laid-out canvas, for testing the renderer without a binding. */
export function canvasFixture(width = 640, height = 240): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = `display: block; width: ${width}px; height: ${height}px;`;
  fixture(width, height).append(canvas);
  return canvas;
}

/**
 * Primary colours only, and fully opaque tints: a test that samples pixels has
 * to be able to name what it found, which the shipped palette's blends and
 * 0.45 default alpha make impossible.
 */
export const probeTheme: HexTheme = {
  background: "#000000",
  foreground: "#ffffff",
  muted: "#808080",
  selection: "#0000ff",
  caret: "#ff0000",
  cursorRow: "#000000",
  cursorByte: "#000000",
  cursorByteText: "#ffffff",
  decoration: "#00ff00",
  decorationLabel: "#00ff00",
  searchMatch: "#00ffff",
  diffReplace: "#ffff00",
  diffInsert: "#ff00ff",
  diffDelete: "#800080",
};

/**
 * `probeTheme` as custom properties. Set on a container they reach every
 * binding, because custom properties inherit and cross shadow boundaries —
 * which is the mechanism under test as much as it is a convenience here.
 */
export const probeProperties: Record<string, string> = {
  "--hexcanvas-height": "240px",
  "--hexcanvas-bg": probeTheme.background,
  "--hexcanvas-fg": probeTheme.foreground,
  "--hexcanvas-muted": probeTheme.muted,
  "--hexcanvas-selection": probeTheme.selection,
  "--hexcanvas-caret": probeTheme.caret,
  "--hexcanvas-cursor-row": probeTheme.cursorRow,
  "--hexcanvas-cursor-byte": probeTheme.cursorByte,
  "--hexcanvas-cursor-byte-text": probeTheme.cursorByteText,
  "--hexcanvas-decoration": probeTheme.decoration,
  "--hexcanvas-search": probeTheme.searchMatch,
  "--hexcanvas-diff-replace": probeTheme.diffReplace,
  "--hexcanvas-diff-insert": probeTheme.diffInsert,
  "--hexcanvas-diff-delete": probeTheme.diffDelete,
};

/** A fixture already carrying the probe palette, for binding-level tests. */
export function themedFixture(width = 640, height = 240, extra: Record<string, string> = {}): HTMLDivElement {
  const element = fixture(width, height);
  for (const [property, value] of Object.entries({ ...probeProperties, ...extra })) element.style.setProperty(property, value);
  return element;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * A snapshot of what was painted, addressed in CSS pixels. The canvas is sized
 * in device pixels, so every read has to divide by the ratio the renderer
 * multiplied by — reading raw would silently test the wrong coordinates on a
 * retina display.
 */
export class Painted {
  private readonly image: ImageData;
  private readonly ratio: number;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no 2d context");
    this.ratio = canvas.width / canvas.clientWidth;
    this.image = context.getImageData(0, 0, canvas.width, canvas.height);
  }

  at(x: number, y: number): Rgb {
    const deviceX = Math.min(this.canvas.width - 1, Math.max(0, Math.round(x * this.ratio)));
    const deviceY = Math.min(this.canvas.height - 1, Math.max(0, Math.round(y * this.ratio)));
    const index = (deviceY * this.canvas.width + deviceX) * 4;
    return { r: this.image.data[index]!, g: this.image.data[index + 1]!, b: this.image.data[index + 2]! };
  }

  /** One horizontal scan line, one sample per CSS pixel. */
  scanX(y: number, from: number, to: number): Rgb[] {
    const row: Rgb[] = [];
    for (let x = Math.round(from); x < Math.round(to); x++) row.push(this.at(x, y));
    return row;
  }

  /** Mean perceived brightness over a box; how "dim" a region reads. */
  brightness(x: number, y: number, width: number, height: number): number {
    let total = 0;
    let count = 0;
    for (let offsetY = 0; offsetY < height; offsetY++) {
      for (const pixel of this.scanX(y + offsetY, x, x + width)) {
        total += 0.299 * pixel.r + 0.587 * pixel.g + 0.114 * pixel.b;
        count++;
      }
    }
    return count === 0 ? 0 : total / count;
  }

  /** Horizontal extent of `colour` inside a scan line, or undefined if absent. */
  spanOf(colour: Rgb, y: number, from: number, to: number, tolerance = 40): { first: number; last: number } | undefined {
    return this.spanWhere((pixel) => near(pixel, colour, tolerance), y, from, to);
  }

  /**
   * Extent of whatever a predicate accepts. Hairlines are the reason this is not
   * an exact colour match: a 1px stroke on a fractional coordinate is spread
   * across two pixels, so the caret is never painted in its own pure colour.
   */
  spanWhere(test: (pixel: Rgb) => boolean, y: number, from: number, to: number): { first: number; last: number } | undefined {
    let first: number | undefined;
    let last = 0;
    const start = Math.round(from);
    this.scanX(y, from, to).forEach((pixel, index) => {
      if (!test(pixel)) return;
      first ??= start + index;
      last = start + index;
    });
    return first === undefined ? undefined : { first, last };
  }

  /** Longest unbroken run of pixels that are not the background. */
  longestRunOff(background: Rgb, y: number, from: number, to: number, tolerance = 12): number {
    let best = 0;
    let run = 0;
    for (const pixel of this.scanX(y, from, to)) {
      run = near(pixel, background, tolerance) ? 0 : run + 1;
      if (run > best) best = run;
    }
    return best;
  }

  countMatching(colour: Rgb, y: number, from: number, to: number, tolerance = 12): number {
    return this.scanX(y, from, to).filter((pixel) => near(pixel, colour, tolerance)).length;
  }
}

export const black: Rgb = { r: 0, g: 0, b: 0 };
export const red: Rgb = { r: 255, g: 0, b: 0 };
export const green: Rgb = { r: 0, g: 255, b: 0 };
export const blue: Rgb = { r: 0, g: 0, b: 255 };

/**
 * Any blend of the caret colour with the background. The caret is the only red
 * thing in `probeTheme`, so a red-dominant pixel can only have come from it.
 */
export const carets = (pixel: Rgb): boolean => pixel.r > 60 && pixel.g < pixel.r / 2 && pixel.b < pixel.r / 2;

export function near(left: Rgb, right: Rgb, tolerance = 12): boolean {
  return Math.abs(left.r - right.r) <= tolerance && Math.abs(left.g - right.g) <= tolerance && Math.abs(left.b - right.b) <= tolerance;
}

export function expectNear(actual: Rgb, expected: Rgb, tolerance = 40): void {
  expect(near(actual, expected, tolerance), `rgb(${actual.r}, ${actual.g}, ${actual.b}) is not near rgb(${expected.r}, ${expected.g}, ${expected.b})`).toBe(true);
}

/**
 * Two frames, because a binding's first frame can be the one that measures the
 * viewport and the second the one that paints with it.
 */
export function frames(count = 2): Promise<void> {
  return new Promise((resolve) => {
    let left = count;
    const step = () => (left-- > 0 ? requestAnimationFrame(step) : resolve());
    step();
  });
}

/** Polls per frame; a binding may need a resize observation before it paints. */
export async function waitFor(condition: () => boolean, description = "condition", timeout = 2000): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await frames(1);
  }
}

/** The canvas a binding mounted, whether it went into the light DOM or a shadow. */
export function canvasIn(container: ParentNode): HTMLCanvasElement | undefined {
  const direct = container.querySelector("canvas");
  if (direct) return direct;
  for (const element of container.querySelectorAll("*")) {
    const inShadow = element.shadowRoot?.querySelector("canvas");
    if (inShadow) return inShadow;
  }
  return undefined;
}

/**
 * True once anything at all has been painted. The first row, not the middle of
 * the canvas: a short document leaves the lower half empty for good.
 */
export function hasPainted(canvas: HTMLCanvasElement): boolean {
  if (canvas.width === 0 || canvas.height === 0) return false;
  const painted = new Painted(canvas);
  return painted.longestRunOff(painted.at(1, 1), Math.min(11, canvas.clientHeight - 1), 0, canvas.clientWidth) > 0;
}

export const bytes = (length: number): Uint8Array => Uint8Array.from({ length }, (_, index) => (index * 7 + 3) & 0xff);

/**
 * The find panel's shadow root. It is an element of its own inside the editor's,
 * so a query for its fields has to cross two boundaries rather than one.
 */
export function finderRoot(element: HexCanvasElement): ShadowRoot {
  const finder = element.shadowRoot!.querySelector("hexcanvas-finder");
  if (!finder?.shadowRoot) throw new Error("no find panel; the editor needs search=\"native\"");
  return finder.shadowRoot;
}

export interface MountOptions {
  length?: number;
  source?: ByteSource;
  width?: number;
  height?: number;
  attributes?: Record<string, string>;
  style?: Record<string, string>;
}

/**
 * A connected `<hexcanvas-editor>` that has painted once. Custom properties are
 * set before it is inserted, because that is when it reads them — setting them
 * afterwards would be testing `refreshTheme` instead.
 */
export async function mountEditor(options: MountOptions = {}): Promise<{
  element: HexCanvasElement;
  canvas: HTMLCanvasElement;
  engine: HexCanvasElement["engine"];
}> {
  defineHexCanvasElement();
  const host = fixture(options.width ?? 640, options.height ?? 240);
  const element = document.createElement("hexcanvas-editor") as HexCanvasElement;
  const height = `${options.height ?? 240}px`;
  for (const [property, value] of Object.entries({ ...probeProperties, "--hexcanvas-height": height, ...options.style })) {
    element.style.setProperty(property, value);
  }
  for (const [name, value] of Object.entries(options.attributes ?? {})) element.setAttribute(name, value);
  host.append(element);
  element.source = options.source ?? new MemoryByteSource(bytes(options.length ?? 256));
  const canvas = element.shadowRoot!.querySelector("canvas")!;
  await waitFor(() => hasPainted(canvas), "the element to paint");
  return { element, canvas, engine: element.engine };
}
