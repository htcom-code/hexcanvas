export * from "./hexcanvas-compare.js";
export * from "./hexcanvas-element.js";
export * from "./hexcanvas-finder.js";

import { defineHexCanvasCompare } from "./hexcanvas-compare.js";
import { defineHexCanvasElement } from "./hexcanvas-element.js";
import { defineHexCanvasFinder } from "./hexcanvas-finder.js";

// Registering on import is what a custom element package is expected to do;
// defineHexCanvasElement(tag) is there for a different tag name.
defineHexCanvasElement();
// The editor registers this itself when it needs one, but a host placing the
// panel outside the editor writes the tag in its own markup, where nothing would
// have upgraded it.
defineHexCanvasFinder();
defineHexCanvasCompare();
