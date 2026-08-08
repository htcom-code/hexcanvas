import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { createApp } from "vue";
import { describe, expect, it } from "vitest";
import type { ByteSource, HexEngine } from "@hexcanvas/core";
import { MemoryByteSource } from "@hexcanvas/core";
import { HexEditor as ReactHexEditor } from "@hexcanvas/react";
import { HexEditor as VueHexEditor } from "@hexcanvas/vue";
import { createHexEditor } from "@hexcanvas/svelte";
import { Painted, bytes, canvasIn, carets, hasPainted, onCleanup, themedFixture, waitFor } from "./harness";

interface Mounted {
  engine: HexEngine;
  canvas: HTMLCanvasElement;
}

/**
 * One suite over every binding rather than one per package: what a host needs is
 * the same everywhere, so a binding that drifts should fail the shared list.
 */
const bindings: { name: string; mount(container: HTMLElement, source: ByteSource): Promise<Mounted> }[] = [
  {
    name: "react",
    async mount(container, source) {
      let engine: HexEngine | undefined;
      const root = createRoot(container);
      onCleanup(() => root.unmount());
      root.render(createElement(ReactHexEditor, { source, onEngine: (value: HexEngine) => (engine = value) }));
      await waitFor(() => Boolean(engine && canvasIn(container)), "react to mount");
      return { engine: engine!, canvas: canvasIn(container)! };
    },
  },
  {
    name: "vue",
    async mount(container, source) {
      let engine: HexEngine | undefined;
      const app = createApp(VueHexEditor, { source, onReady: (value: HexEngine) => (engine = value) });
      onCleanup(() => app.unmount());
      app.mount(container);
      await waitFor(() => Boolean(engine && canvasIn(container)), "vue to mount");
      return { engine: engine!, canvas: canvasIn(container)! };
    },
  },
  {
    name: "svelte",
    async mount(container, source) {
      let engine: HexEngine | undefined;
      createHexEditor(container, { source, onEngine: (value) => (engine = value) });
      await waitFor(() => Boolean(engine && canvasIn(container)), "the svelte action to mount");
      return { engine: engine!, canvas: canvasIn(container)! };
    },
  },
];

for (const binding of bindings) {
  describe(`@hexcanvas/${binding.name}`, () => {
    it("mounts a canvas and paints the document into it", async () => {
      const container = themedFixture();
      const { engine, canvas } = await binding.mount(container, new MemoryByteSource(bytes(1024)));
      await waitFor(() => hasPainted(canvas), "the first frame");
      expect(engine.getState().viewportHeight).toBeGreaterThan(0);
      expect(engine.totalRows).toBe(64);
      expect(canvas.width).toBeGreaterThan(0);
    });

    it("gets its chrome from the custom element rather than building one", async () => {
      const container = themedFixture();
      const { canvas, engine } = await binding.mount(container, new MemoryByteSource(bytes(256)));
      const root = canvas.getRootNode();
      expect(root instanceof ShadowRoot).toBe(true);
      const host = (root as ShadowRoot).host;
      expect(host.tagName.toLowerCase()).toBe("hexcanvas-editor");
      // Same object, so the panels a host restyles are the panels the engine drives.
      expect((host as { engine?: unknown }).engine).toBe(engine);
      expect(container.querySelector("canvas")).toBe(null);
    });

    it("repaints where the engine moved the cursor", async () => {
      const container = themedFixture();
      const { engine, canvas } = await binding.mount(container, new MemoryByteSource(bytes(1024)));
      await waitFor(() => hasPainted(canvas), "the first frame");
      const caretIn = (row: number) => {
        const painted = new Painted(canvas);
        const y = row * 22 + 11;
        return Boolean(painted.spanWhere(carets, y, engine.layout.hexStart - 4, engine.layout.asciiStart));
      };

      engine.moveCursor(16 * 3 + 2);
      await waitFor(() => caretIn(3), "the caret to be painted on row three");
      expect(caretIn(0)).toBe(false);
    });

    it("bounds its own height so the scroll spacer cannot inflate it", async () => {
      const container = themedFixture();
      const { canvas } = await binding.mount(container, new MemoryByteSource(bytes(64 * 1024)));
      await waitFor(() => hasPainted(canvas), "the first frame");
      const scroller = canvas.getRootNode() instanceof ShadowRoot ? (canvas.getRootNode() as ShadowRoot).host : canvas.parentElement!;
      expect(Math.round(scroller.getBoundingClientRect().height)).toBe(240);
      expect(scroller.scrollHeight).toBeGreaterThan(4000);
    });

    it("scrolls the view when the host drives the cursor to the end", async () => {
      const container = themedFixture();
      const { engine, canvas } = await binding.mount(container, new MemoryByteSource(bytes(4096)));
      await waitFor(() => hasPainted(canvas), "the first frame");
      engine.moveCursor(4095);
      await waitFor(() => engine.getState().scrollTop > 0, "the engine to scroll");
      const scroller = canvas.getRootNode() instanceof ShadowRoot ? (canvas.getRootNode() as ShadowRoot).host : canvas.parentElement!;
      await waitFor(() => Math.abs(scroller.scrollTop - engine.getState().scrollTop) < 2, "the scroller to follow");
      // The cursor sits on the last row, so the caret has to be painted inside
      // the viewport rather than below its bottom edge.
      const lastRow = engine.totalRows - 1;
      const y = lastRow * 22 - engine.logicalScrollTop + 11;
      expect(y).toBeLessThan(240);
      await waitFor(
        () => Boolean(new Painted(canvas).spanWhere(carets, y, engine.layout.hexStart - 4, engine.layout.asciiStart)),
        "the caret to be painted on the last row",
      );
    });
  });
}

describe("@hexcanvas/react props", () => {
  const render = (container: HTMLElement, props: Record<string, unknown>) => {
    const root = createRoot(container);
    onCleanup(() => root.unmount());
    return {
      root,
      update: (next: Record<string, unknown>) => root.render(createElement(ReactHexEditor, { ...props, ...next } as never)),
    };
  };

  it("holds the cursor and the selection as props", async () => {
    const container = themedFixture();
    const source = new MemoryByteSource(bytes(1024));
    const moves: number[] = [];
    let engine: HexEngine | undefined;
    const props = {
      source,
      onEngine: (value: HexEngine) => (engine = value),
      onCursorChange: (cursor: { offset: number }) => moves.push(cursor.offset),
    };
    const view = render(container, props);
    view.update({ cursor: { offset: 0 } });
    await waitFor(() => Boolean(engine), "react to mount");

    view.update({ cursor: { offset: 0x30 }, selection: { start: 0x30, end: 0x34 } });
    await waitFor(() => engine!.getState().cursor.offset === 0x30, "the cursor prop to land");
    expect(engine!.getState().selection).toEqual({ start: 0x30, end: 0x34 });
    // Both props were honoured: a selection assigned second must not drag the
    // cursor to its end and contradict what the host asked for.
    expect(engine!.getState().cursor.offset).toBe(0x30);

    // The editor still moves the cursor itself, and reports it.
    engine!.handleKey({ key: "ArrowRight" });
    expect(moves.at(-1)).toBe(0x31);

    view.update({ cursor: { offset: 0x30 }, selection: null });
    await waitFor(() => engine!.getState().selection === undefined, "the selection to be cleared");
  });
});
