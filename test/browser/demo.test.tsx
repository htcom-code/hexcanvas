import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import type { HexCanvasCompare } from "@hexcanvas/element";
import { App } from "../../demo/src/main";
import { fixture, frames, onCleanup, waitFor } from "./harness";

/** Everything the playground wrote, so each test starts from the defaults. */
function clearStored(): void {
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith("hexcanvas-demo:")) localStorage.removeItem(key);
  }
}

/**
 * The playground is the first thing anyone reading this repository runs, so a
 * defect in it is a defect. It is also where two documents first existed at
 * once, and every mistake that produced came from the same place: the page was
 * written when there was one of everything, and a comparison has two.
 *
 * These mount the real `App`. The library suite cannot see any of this — the
 * wiring under test is the page's, not the editor's.
 */
async function mountDemo() {
  // The playground remembers its settings, so a test that did not clear them
  // would inherit whatever the one before it chose. Found the hard way: the
  // comparison target persisted and the next test read the wrong document name.
  clearStored();
  const host = fixture(1400, 800);
  const root = createRoot(host);
  root.render(createElement(App));
  onCleanup(() => root.unmount());
  await waitFor(() => Boolean(host.querySelector("hexcanvas-editor")), "the playground to mount");
  const at = (testId: string) => host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  const click = (testId: string) => at(testId)?.click();
  const choose = (testId: string, value: string) => {
    const select = at(testId) as HTMLSelectElement | null;
    if (!select) throw new Error(`no ${testId}`);
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const saveCaptions = () => [...host.querySelectorAll("footer button")]
    .map((button) => button.textContent ?? "")
    .filter((caption) => caption.startsWith("Save"));
  return { host, at, click, choose, saveCaptions };
}

/** Opens the settings layer, does something in it, and closes it again. */
async function inSettings(demo: Awaited<ReturnType<typeof mountDemo>>, act: () => void) {
  demo.click("open-settings");
  await waitFor(() => Boolean(demo.host.querySelector("dialog.settings")), "the settings layer");
  act();
  // React commits on a microtask and the element applies on the next frame, so
  // the layer must not be closed in the same turn the control was changed.
  await frames(2);
  demo.host.querySelector<HTMLButtonElement>('dialog.settings button[aria-label="Close settings"]')?.click();
  await frames(1);
}

const compareBox = (demo: Awaited<ReturnType<typeof mountDemo>>) =>
  demo.host.querySelector("hexcanvas-compare") as HexCanvasCompare;

describe("the playground, comparing", () => {
  it("reports the focused pane's document, not the one the Source select names", async () => {
    const demo = await mountDemo();
    demo.click("toggle-compare");
    await waitFor(() => Boolean(demo.host.querySelector("hexcanvas-compare")), "the comparison");
    demo.choose("compare-against", "rebuilt (many edits)");
    const box = compareBox(demo);
    await waitFor(() => box.rightEditor.engine.byteSource.length === 16416, "the longer document");

    box.leftEditor.focus();
    await waitFor(() => demo.at("length")?.textContent === "16384 bytes", "the left length");

    // The bug this replaces: the offset followed the pane and the length did
    // not, so the right pane's cursor sat beside the left document's size.
    box.rightEditor.focus();
    box.rightEditor.engine.moveCursor(16400);
    await waitFor(() => demo.at("length")?.textContent === "16416 bytes", "the right length");
    expect(demo.at("cursor-offset")?.textContent).toBe("0x00004010");
  });

  it("names the pane and the document the numbers came from", async () => {
    const demo = await mountDemo();
    expect(demo.at("active-pane")).toBeNull();
    demo.click("toggle-compare");
    await waitFor(() => Boolean(demo.host.querySelector("hexcanvas-compare")), "the comparison");
    const box = compareBox(demo);
    await waitFor(() => demo.at("active-pane")?.textContent?.includes("left") ?? false, "the note");
    expect(demo.at("active-pane")?.textContent).toContain("memory");

    box.rightEditor.focus();
    await waitFor(() => demo.at("active-pane")?.textContent?.includes("right") ?? false, "the note to follow");
    expect(demo.at("active-pane")?.textContent).toContain("modified copy");
  });

  /**
   * The note above is the visible half of telling the panes apart. These are the
   * other half, which was missing entirely: the page said "reading left" to
   * anyone who could see it and said nothing at all to anyone who could not.
   */
  it("tells a screen reader the panes apart, and which one is being read", async () => {
    const demo = await mountDemo();
    demo.click("toggle-compare");
    await waitFor(() => Boolean(demo.host.querySelector("hexcanvas-compare")), "the comparison");
    const box = compareBox(demo);
    // Not merely "some name": the element applies its own fallback first, so
    // waiting for one at all would pass on "Left document".
    await waitFor(() => box.leftEditor.getAttribute("aria-label") === "memory", "the documents' own names");

    // Named after the documents, not "Hex editor" twice.
    expect(box.leftEditor.getAttribute("aria-label")).toBe("memory");
    expect(box.rightEditor.getAttribute("aria-label")).toBe("modified copy");

    // And the note is a live region, because the pane changes under the reader
    // rather than because they asked for it.
    expect(demo.at("active-pane")?.getAttribute("role")).toBe("status");
    demo.choose("compare-against", "shifted by one byte");
    await waitFor(() => box.rightEditor.getAttribute("aria-label") === "shifted by one byte", "the new name");
  });

  // Writing out the wrong document is not a glance to undo, so these two say
  // which in the caption rather than relying on the note having been read.
  it("says which document Save writes, and only while there are two", async () => {
    const demo = await mountDemo();
    expect(demo.saveCaptions()).toEqual(["Save", "Save patch"]);
    demo.click("toggle-compare");
    await waitFor(() => demo.saveCaptions()[0] === "Save (left)", "the named captions");
    compareBox(demo).rightEditor.focus();
    await waitFor(() => demo.saveCaptions()[0] === "Save (right)", "the captions to follow");
    expect(demo.saveCaptions()).toEqual(["Save (right)", "Save patch (right)"]);
  });
});

describe("the playground, read rather than looked at", () => {
  it("has a heading for the page itself", async () => {
    const demo = await mountDemo();
    // The title was a span, so the layers' own h2s hung under nothing and there
    // was no level-one heading to jump to.
    const h1 = demo.host.querySelector("h1");
    expect(h1?.textContent).toBe("HexCanvas");
  });

  it("says what the numbers in the status bar are", async () => {
    const demo = await mountDemo();
    const footer = demo.host.querySelector("footer")!;
    // "0x00000000" on its own is a number with no name attached.
    expect(footer.textContent).toContain("Cursor address");
    // And an em dash on its own is an em dash.
    expect(demo.at("fields")?.textContent).toContain("No structure field here");
    expect(demo.at("fields")?.querySelector("[aria-hidden='true']")?.textContent).toBe("—");
  });
});

/**
 * Every one of these settings reached one pane or neither at some point. They
 * are cheap to check and they were expensive to find by hand.
 */
describe("the playground's settings, in a comparison", () => {
  const bothPanes = async (demo: Awaited<ReturnType<typeof mountDemo>>) => {
    demo.click("toggle-compare");
    await waitFor(() => Boolean(demo.host.querySelector("hexcanvas-compare")), "the comparison");
    const box = compareBox(demo);
    return [box.leftEditor, box.rightEditor] as const;
  };

  it("turns the plain-text column off in both, not neither", async () => {
    const demo = await mountDemo();
    const panes = await bothPanes(demo);
    await inSettings(demo, () => {
      const box = [...demo.host.querySelectorAll<HTMLInputElement>('dialog.settings input[type="checkbox"]')]
        .find((input) => input.closest("label")?.textContent?.includes("Plain-text column"));
      box?.click();
    });
    // False has to be written out: an absent attribute means "keep the default",
    // and this one defaults to on.
    await waitFor(() => panes.every((pane) => !pane.engine.layout.asciiColumn), "the column to go");
  });

  it("hands the column gaps to both, which no attribute could carry", async () => {
    const demo = await mountDemo();
    const panes = await bothPanes(demo);
    await inSettings(demo, () => demo.choose("compare-against", "modified copy"));
    await inSettings(demo, () => {
      const select = [...demo.host.querySelectorAll<HTMLSelectElement>("dialog.settings select")]
        .find((element) => element.closest("label")?.textContent?.includes("Column gaps"));
      if (!select) throw new Error("no column gaps");
      select.value = "roomy";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(() => panes.every((pane) => pane.engine.layout.spacing.columnGutter === 44), "the wider gaps");
  });

  // The rule this enforces: an opt-in nobody can turn on has not been finished.
  it("reaches the frame rate cap, and both panes with it", async () => {
    const demo = await mountDemo();
    const panes = await bothPanes(demo);
    await inSettings(demo, () => demo.choose("max-fps", "30"));
    await waitFor(() => panes.every((pane) => pane.maxFps === 30), "the cap");
    await inSettings(demo, () => demo.choose("max-fps", "display"));
    await waitFor(() => panes.every((pane) => pane.maxFps === undefined), "the cap to lift");
  });

  // The rule again: an opt-in nobody can turn on has not been finished. This one
  // replaces the comparison itself.
  it("reaches the comparison the differences are answered by", async () => {
    const demo = await mountDemo();
    await bothPanes(demo);
    const box = compareBox(demo);
    await inSettings(demo, () => demo.choose("compare-against", "shifted by one byte"));
    await waitFor(() => box.comparison.differences.length > 50, "the aligned answer");

    await inSettings(demo, () => demo.choose("comparison", "edit script"));
    // One byte at the front, which aligned calls hundreds of runs and an edit
    // script calls one insertion.
    await waitFor(() => box.comparison.differences.length === 1, "the edit script answer");
    expect(box.comparison.differences[0]!.kind).toBe("insert");
  });

  it("repaints both panes when the template changes", async () => {
    const demo = await mountDemo();
    const panes = await bothPanes(demo);
    await inSettings(demo, () => {
      const select = [...demo.host.querySelectorAll<HTMLSelectElement>("dialog.settings select")]
        .find((element) => element.closest("label")?.textContent?.includes("Template"));
      if (!select) throw new Error("no template");
      select.value = "light";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // The canvas is painted, so a stylesheet cannot reach it; the box has to be
    // told, and it has to tell both. Read back off the engines' resolved theme.
    await waitFor(
      () => panes.every((pane) => {
        const canvas = pane.shadowRoot?.querySelector("canvas");
        if (!canvas) return false;
        const pixel = canvas.getContext("2d")?.getImageData(canvas.width - 4, canvas.height - 4, 1, 1).data;
        return pixel?.[0] === 255 && pixel[1] === 255 && pixel[2] === 255;
      }),
      "both panes to go white",
    );
  });
});

describe("the playground's layers", () => {
  // Every one of them rendered from page load once: an author `display: flex`
  // on `.layer` beats the UA's `dialog:not([open])` at any specificity.
  it("keeps every layer closed until it is asked for", async () => {
    const demo = await mountDemo();
    const layers = [...demo.host.querySelectorAll("dialog.layer")];
    expect(layers.length).toBeGreaterThan(0);
    for (const layer of layers) {
      expect(getComputedStyle(layer).display).toBe("none");
    }
    demo.click("open-settings");
    await waitFor(() => {
      const settings = demo.host.querySelector("dialog.settings");
      return settings !== null && getComputedStyle(settings).display === "flex";
    }, "the settings layer to open");
  });
});

describe("the playground's layers, resized and remembered", () => {
  const openSettings = async (demo: Awaited<ReturnType<typeof mountDemo>>) => {
    demo.click("open-settings");
    await waitFor(() => {
      const layer = demo.host.querySelector<HTMLDialogElement>("dialog.settings");
      return layer !== null && layer.open;
    }, "the settings layer");
    return demo.host.querySelector<HTMLDialogElement>("dialog.settings")!;
  };

  /**
   * The resize grip belongs to the dialog element, so the click that ends a
   * resize has the dialog as its target — which is what a backdrop click used to
   * be recognised by. Making the layer bigger closed it.
   */
  it("stays open when the corner it is resized by is clicked", async () => {
    const demo = await mountDemo();
    const layer = await openSettings(demo);
    const box = layer.getBoundingClientRect();
    layer.dispatchEvent(new MouseEvent("click", {
      bubbles: true, detail: 1, clientX: box.right - 3, clientY: box.bottom - 3,
    }));
    await frames(2);
    expect(layer.open).toBe(true);
  });

  it("still closes on a click that is actually outside it", async () => {
    const demo = await mountDemo();
    const layer = await openSettings(demo);
    const box = layer.getBoundingClientRect();
    layer.dispatchEvent(new MouseEvent("click", {
      bubbles: true, detail: 1, clientX: box.left - 20, clientY: box.top - 20,
    }));
    await waitFor(() => !layer.open, "the layer to close");
  });

  // A click a keyboard synthesised carries no coordinates, which would read as
  // the far corner of the screen and close the layer on Enter.
  it("ignores a click with no coordinates behind it", async () => {
    const demo = await mountDemo();
    const layer = await openSettings(demo);
    layer.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    await frames(2);
    expect(layer.open).toBe(true);
  });

  /**
   * A drag ends in a handler made before the drag began, so reading the state
   * there reads where the layer *was*. Caught live: the size persisted and the
   * position came back as 0,0.
   */
  it("remembers where it was dragged to, not where it started", async () => {
    const demo = await mountDemo();
    const layer = await openSettings(demo);
    const header = layer.querySelector("header")!;
    const box = header.getBoundingClientRect();
    const at = (x: number, y: number) => ({
      bubbles: true, cancelable: true, clientX: x, clientY: y,
      button: 0, buttons: 1, pointerId: 1, isPrimary: true,
    });
    header.dispatchEvent(new PointerEvent("pointerdown", at(box.left + 60, box.top + 12)));
    header.dispatchEvent(new PointerEvent("pointermove", at(box.left + 160, box.top + 92)));
    header.dispatchEvent(new PointerEvent("pointerup", at(box.left + 160, box.top + 92)));
    await waitFor(() => {
      const geometry = localStorage.getItem("hexcanvas-demo:layer:settings");
      if (geometry === null) return false;
      const parsed = JSON.parse(geometry) as { x: number; y: number };
      return parsed.x === 100 && parsed.y === 80;
    }, "the dragged position to be remembered");
  });

  it("remembers a size and a position across a reload", async () => {
    const first = await mountDemo();
    const layer = await openSettings(first);
    // What the native grip does: write the size onto the element.
    layer.style.width = "700px";
    layer.style.height = "480px";
    await waitFor(() => {
      const geometry = localStorage.getItem("hexcanvas-demo:layer:settings");
      return geometry !== null && geometry.includes("700px");
    }, "the size to be remembered");

    // Mounting again is what a reload is, minus the browser.
    const host = fixture(1400, 800);
    const root = createRoot(host);
    root.render(createElement(App));
    onCleanup(() => root.unmount());
    await waitFor(() => Boolean(host.querySelector("hexcanvas-editor")), "the second mount");
    host.querySelector<HTMLElement>('[data-testid="open-settings"]')?.click();
    await waitFor(() => {
      const restored = host.querySelector<HTMLDialogElement>("dialog.settings");
      return restored !== null && restored.style.width === "700px" && restored.style.height === "480px";
    }, "the size to come back");
  });
});

describe("the playground's settings, remembered", () => {
  it("comes back to the template that was chosen", async () => {
    const first = await mountDemo();
    await inSettings(first, () => {
      const select = [...first.host.querySelectorAll<HTMLSelectElement>("dialog.settings select")]
        .find((element) => element.closest("label")?.textContent?.includes("Template"));
      if (!select) throw new Error("no template");
      select.value = "sepia";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(() => localStorage.getItem("hexcanvas-demo:appearance") === '"sepia"', "the template to be stored");

    const host = fixture(1400, 800);
    const root = createRoot(host);
    root.render(createElement(App));
    onCleanup(() => root.unmount());
    await waitFor(
      () => host.querySelector("main")?.getAttribute("data-theme") === "sepia",
      "the template to come back",
    );
  });

  // What was written last time was written by a previous version of this page.
  it("falls back to the default when what was stored is no longer an option", async () => {
    clearStored();
    localStorage.setItem("hexcanvas-demo:appearance", '"a-template-that-was-removed"');
    localStorage.setItem("hexcanvas-demo:bytes-per-row", "999");
    const host = fixture(1400, 800);
    const root = createRoot(host);
    root.render(createElement(App));
    onCleanup(() => root.unmount());
    await waitFor(() => Boolean(host.querySelector("hexcanvas-editor")), "the playground to mount");
    expect(host.querySelector("main")?.getAttribute("data-theme")).toBe("dark");
    const editor = host.querySelector("hexcanvas-editor") as HTMLElement & { engine: { layout: { bytesPerRow: number } } };
    expect(editor.engine.layout.bytesPerRow).toBe(16);
  });
});
