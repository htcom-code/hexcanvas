# @hexcanvas/element

[hexcanvas.htcom.org](https://hexcanvas.htcom.org) · [Repository](https://github.com/htcom-code/hexcanvas)

`<hexcanvas-editor>`, the framework-agnostic surface of
[HexCanvas](https://github.com/htcom-code/hexcanvas) — a hex viewer and editor painted on
a canvas. It owns the editor chrome (search panel, go-to panel, canvas, scroll spacer) in an
open shadow root, and is usable from plain HTML, Angular, or anything else that can put an
element on a page. The React, Vue and Svelte bindings all wrap this element rather than
building the chrome a second time.

```sh
npm install @hexcanvas/element
```

Importing the package registers the element. `defineHexCanvasElement(tag)` is exported for a
different tag name; registration is idempotent and no-ops without `customElements`, so the
import is safe on a server.

```html
<hexcanvas-editor id="editor" byte-group="4"></hexcanvas-editor>
<script type="module">
  import { MemoryByteSource } from "@hexcanvas/core";
  import "@hexcanvas/element";
  editor.source = new MemoryByteSource(bytes);
</script>
```

## Attributes, properties and events

Scalars travel as attributes: `bytes-per-row`, `row-height`, `address-radix`, `byte-group`,
`edit-mode`, `font`, `highlight-cursor-address`, `highlight-cursor-ascii`. The two flags read
`"false"` and `"0"` as off, and an absent attribute keeps the default rather than meaning
false.

Objects go on as properties — `source`, `theme`, `cursor`, `selection` — and `element.engine`
is the `HexEngine` itself, for driving search, history or the cursor from the host. The element
emits `change`, `cursorchange` and `selectionchange` as `CustomEvent`s.

```js
editor.addEventListener("cursorchange", (event) => show(event.detail.offset));
```

Assigning a position the editor already holds does nothing, so a host that echoes the event
straight back into the property cannot loop.

## Painting

The canvas is repainted at most once an animation frame, however many things changed in it.
State, events, scrolling and key handling stay immediate — only the drawing waits. A host that
reads pixels back off the canvas straight after an action therefore has to let a frame pass
first.

`max-fps` caps it further, for a host that knows something the editor does not — sharing a
machine with work that matters more, say. Uncapped by default, because a cap makes the editor
worse on hardware that did not need one. It caps painting only, so a capped editor is no slower
to type into; it redraws less often. On a 60Hz display it does nothing, the display already
being the cap.

```html
<hexcanvas-editor max-fps="30"></hexcanvas-editor>
```

## Styling

There is no stylesheet to import. Structural styles are inline because overriding them breaks
the editor; everything that is appearance reads a `--hexcanvas-*` custom property with a
built-in fallback, declared anywhere above the editor. Custom properties cross shadow
boundaries, which is why the painted grid can follow the same variables as the DOM chrome.

```css
hexcanvas-editor { --hexcanvas-bg: #fff; --hexcanvas-selection: #bcd9ff; }
hexcanvas-editor::part(panel) { border-radius: 0; }
```

Exposed parts: `editor`, `overlay`, `panel`, `input`, `select`, `button`, `message`, `canvas`.

Declare `color-scheme` alongside a dark palette. The grid scrolls inside an element this one
owns, and its scrollbar is painted by the browser rather than by any `--hexcanvas-*` property —
so without it a dark editor gets whatever scrollbar the operating system prefers, hover state
included. `color-scheme` is inherited and crosses shadow boundaries, so one declaration on the
same rule as the palette reaches the scroller.

```css
hexcanvas-editor { color-scheme: dark; --hexcanvas-bg: #111827; }
```

The full list of custom properties, the keymap, and the byte-source and decoration APIs are in
the [repository README](https://github.com/htcom-code/hexcanvas).

## Licence

MIT. See `LICENSE`.
