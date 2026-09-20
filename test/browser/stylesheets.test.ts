import { describe, expect, it } from "vitest";
import { MemoryByteSource } from "@hexcanvas/core";
import { defineHexCanvasCompare, type HexCanvasCompare } from "@hexcanvas/element";
import { bytes, finderRoot, hasPainted, mountEditor as mount, probeProperties, themedFixture, waitFor } from "./harness";

/**
 * The shadow styles must not be a `<style>` element. `style-src` applies to
 * those, so under a nonce-based policy without `'unsafe-inline'` the sheet was
 * blocked — and `:host` is in it, so the element lost its layout entirely and
 * the canvas grew past the 65,535px limit and painted nothing. The policy
 * cannot be exercised from a test page, so what is checked here is the
 * mechanism the report turned on: a constructed sheet, which `style-src` has
 * no say over, instead of an element it does.
 */
describe("shadow styles", () => {
  it("are adopted rather than appended as a style element a policy could block", async () => {
    const { element } = await mount({ attributes: { search: "native" } });
    const roots = [element.shadowRoot!, finderRoot(element)];
    for (const root of roots) {
      expect(root.querySelector("style")).toBeNull();
      expect(root.adoptedStyleSheets).toHaveLength(1);
    }
  });

  it("still reach :host, which is what the blocked sheet cost", async () => {
    const { element } = await mount();
    // Both come out of `:host`. Without them the viewport is not a flex item
    // and the element grows to the document-tall spacer.
    expect(getComputedStyle(element).display).toBe("flex");
    expect(Math.round(element.getBoundingClientRect().height)).toBe(240);
  });

  it("are one sheet shared by every instance of an element", async () => {
    const first = await mount();
    const second = await mount();
    const sheet = first.element.shadowRoot!.adoptedStyleSheets[0];
    expect(sheet).toBeInstanceOf(CSSStyleSheet);
    expect(second.element.shadowRoot!.adoptedStyleSheets[0]).toBe(sheet);
  });

  it("are adopted by the compare element too", async () => {
    defineHexCanvasCompare();
    const host = themedFixture(1600, 240);
    const element = document.createElement("hexcanvas-compare") as HexCanvasCompare;
    for (const [property, value] of Object.entries({ ...probeProperties, "--hexcanvas-height": "240px" })) {
      element.style.setProperty(property, value);
    }
    host.append(element);
    element.left = new MemoryByteSource(bytes(256));
    element.right = new MemoryByteSource(bytes(256));
    const canvases = [...element.shadowRoot!.querySelectorAll("hexcanvas-editor")].map(
      (editor) => editor.shadowRoot!.querySelector("canvas")!,
    );
    await waitFor(() => canvases.every((canvas) => hasPainted(canvas)), "both panes to paint");
    expect(element.shadowRoot!.querySelector("style")).toBeNull();
    expect(element.shadowRoot!.adoptedStyleSheets).toHaveLength(1);
    expect(getComputedStyle(element).display).toBe("flex");
  });
});
