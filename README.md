# HexCanvas

[![CI](https://github.com/htcom-code/hexcanvas/actions/workflows/ci.yml/badge.svg)](https://github.com/htcom-code/hexcanvas/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-hexcanvas.htcom.org-b45309.svg)](https://hexcanvas.htcom.org)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)
[![Types](https://img.shields.io/badge/types-included-3178c6.svg)](#typescript)
[![Bundle](https://img.shields.io/badge/bundle-30%20kB%20min%2Bgz-success.svg)](#size)
[![Dependencies](https://img.shields.io/badge/dependencies-0-success.svg)](#size)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-5fa04e.svg)](#requirements)

A hex viewer and editor painted on a canvas, embeddable from **any framework**.
Storage, editing, history and search are complete in the library — a host opts into the
parts it needs rather than supplying them.

**[hexcanvas.htcom.org](https://hexcanvas.htcom.org)** — the introduction, if you would
rather read a page than a README.

```html
<hexcanvas-editor id="editor" byte-group="4"></hexcanvas-editor>
<script type="module">
  import { MemoryByteSource } from "@hexcanvas/core";
  import "@hexcanvas/element";
  editor.source = new MemoryByteSource(bytes);
</script>
```

![The playground: a hex grid with a parsed structure drawn over the first rows as
nested coloured ranges, and the innermost field named in the status bar](assets/playground.png)

*The playground (`pnpm dev`), with a parsed structure handed to the editor as
decorations. Nested ranges paint innermost-last, and the status bar names the field under
the cursor.*

---

## Features

**Reads what will not fit in memory**
- `PagedByteSource` — you write `fetch(offset, length)`; paging, coalescing and eviction are handled
- Verified against a real 102 MB file; searching it runs at about 200 MB/s
- Reads are cancellable — abandoning a search stops the fetches behind it

**Edits without rewriting the file**
- Insert, delete and overwrite through a piece table; the insert rate is flat from 1,000 pieces to 50,000
- Undo/redo with a run of typing coalesced into one step
- `savePatch()` writes only the ranges that changed, and knows when it cannot

**Finds**
- Hex or plain text, forwards and backwards, wrapping, with every hit highlighted and counted
- Replace-all applies as a single `ChangeSet`, so it undoes in one step
- Replaceable: hand it a `SearchProvider` and it uses yours

**Overlays that scale to a parse result**
- Ranges with labels, colours and nesting — bookmarks and search hits are the same mechanism
- Two million ranges cost about 140 MB; a frame over 41,000 of them is 294× the linear pass it replaced
- Or keep the structure yourself and answer windows with `setDecorationSource`

**Compares two documents**
- Aligned streaming for a pair of any size, an exact edit script where it fits, anchored diffing where it does not
- Rows stay level across an insertion, so matching bytes sit side by side

**Fits into a page**
- No stylesheet to import — appearance is `--hexcanvas-*` custom properties, chrome is restyled through `::part()`
- `role="application"` with a live region, and commands to read a row or the region under the cursor
- Zero runtime dependencies, ESM, types included

## Quick start

```sh
npm install @hexcanvas/core @hexcanvas/element   # or pnpm add / yarn add
```

<details open>
<summary><b>Plain HTML — no framework</b></summary>

```html
<hexcanvas-editor id="editor" byte-group="4" edit-mode="overwrite"></hexcanvas-editor>
<script type="module">
  import { MemoryByteSource } from "@hexcanvas/core";
  import "@hexcanvas/element";

  const bytes = new Uint8Array(await (await fetch("/sample.bin")).arrayBuffer());
  editor.source = new MemoryByteSource(bytes);
  editor.addEventListener("change", () => console.log("edited"));
</script>
```
</details>

<details>
<summary><b>React</b> — <code>npm install @hexcanvas/react @hexcanvas/core</code></summary>

```tsx
import { HexEditor } from "@hexcanvas/react";
import { MemoryByteSource } from "@hexcanvas/core";

const source = useMemo(() => new MemoryByteSource(bytes), [bytes]);

<HexEditor source={source} byteGroup={4} onChange={markDirty} />;
```

React 18 or 19; `react` and `react-dom` are peer dependencies.
</details>

<details>
<summary><b>Vue</b> — <code>npm install @hexcanvas/vue @hexcanvas/core</code></summary>

```vue
<script setup lang="ts">
import { HexEditor } from "@hexcanvas/vue";
import { MemoryByteSource } from "@hexcanvas/core";

const source = new MemoryByteSource(bytes);
</script>

<template>
  <HexEditor :source="source" :byte-group="4" @change="markDirty" />
</template>
```

Vue 3.4 or later. The element is created in a render function, so no `isCustomElement` build option is needed.
</details>

<details>
<summary><b>Svelte</b> — <code>npm install @hexcanvas/svelte @hexcanvas/core</code></summary>

```svelte
<script lang="ts">
  import { hexEditor } from "@hexcanvas/svelte";
  import { MemoryByteSource } from "@hexcanvas/core";

  const source = new MemoryByteSource(bytes);
</script>

<hexcanvas-editor use:hexEditor={{ source, byteGroup: 4 }} on:change={markDirty} />
```

No Svelte dependency and no compiler — `createHexEditor(container, options)` mounts one outside a template.
</details>

Then run the playground to see everything wired together: `pnpm dev`.

## Packages

| Package | What it is | Size (min+gz) |
| --- | --- | --- |
| `@hexcanvas/core` | `ByteSource` contract and implementations, grid geometry, canvas renderer, and `HexEngine` — cursor, selection, scrolling, input, editing, history, search | 26 kB |
| `@hexcanvas/element` | `<hexcanvas-editor>` and `<hexcanvas-compare>`: the framework-free surface, owning the chrome in an open shadow root | +4 kB |
| `@hexcanvas/react` | `<HexEditor>` — props to attributes, events to callbacks | 1.5 kB |
| `@hexcanvas/vue` | The same wrapper for Vue 3 | 1.3 kB |
| `@hexcanvas/svelte` | `use:hexEditor` action plus `createHexEditor()` | 1.0 kB |

Every binding wraps the same custom element, so the chrome exists **once** and no binding
can drift from another. A binding is a forwarding layer, not a second implementation.

<a id="requirements"></a>
### Requirements

Node ≥ 22 to build; any browser with `<canvas>` and custom elements to run. ESM only —
there is no CommonJS build, so `require()` fails with a clear error rather than half-working.

<a id="typescript"></a>Types ship with every package; no `@types/*` to install.

## Byte sources

Reads are split in two: `peek` is synchronous and answers only from resident bytes, so the
renderer can call it inside a frame, and `ensure` is the asynchronous half that makes a
range resident. Rows that are not resident draw as pending and repaint when the bytes land.

| Source | Use |
| --- | --- |
| `MemoryByteSource` | An in-memory array. `peek` never misses; a length change reallocates. |
| `PieceTableSource` | Insert and delete without rewriting the original. Wraps any other source, so the original can still be paged. |
| `PagedByteSource` | A slow backend. Implement `fetch(offset, length)`; paging, coalescing and eviction are handled. |
| `fromBinaryBuffer(buffer)` | Adapts the older synchronous `BinaryBuffer`. Cannot change length. |

Edits travel as a `ChangeSet` — `{ from, to, insert }` replacements that also carry the
position mapping:

```ts
source.apply(ChangeSet.insert(0x40, new Uint8Array([0xde, 0xad])));
```

Anything holding an offset across an edit maps it with `changes.mapPos(offset)`. The engine
does this for the cursor, the selection and its anchor; a host does it for offsets of its own.

## Saving

A length that can change means the original cannot be patched in place, so saving streams:

```ts
for await (const chunk of engine.save() ?? []) await sink.write(chunk);
```

Overwrites are the common case and move nothing, so rewriting a whole file to change four
bytes is waste. The engine records which ranges were written and offers them alone — until
an insert or a delete shifts everything after it, at which point there is no patch to write:

```ts
const patches = engine.savePatch();          // undefined once a length has changed
if (patches) {
  for await (const { offset, bytes } of patches) await handle.write({ at: offset, data: bytes });
  engine.markSaved();                        // recording starts again from clean
} else {
  for await (const chunk of engine.save() ?? []) await sink.write(chunk);
}
```

`engine.dirtyRanges` is the same set without the bytes. `markSaved` records *which document
state* was written, so undoing back to it owes nothing — but a range whose bytes merely
happen to match again stays dirty, because knowing better would mean keeping a copy.

## Keyboard

| Key | Action |
| --- | --- |
| Arrows, `Home`, `End` | Move the cursor; hold `Shift` to extend the selection |
| `Tab` | Switch between the hex and text columns |
| `⌘/Ctrl+A` · `C` · `X` | Select all · copy · cut (hex from the left column, text from the right) |
| `Delete` · `Backspace` | Remove the selection, or one byte forwards/backwards |
| `⌘/Ctrl+Z` · `⇧⌘/Ctrl+Z` | Undo · redo. A run of typing collapses into one step |
| `⌘/Ctrl+F` · `H` · `G` | Find · replace · go to address (`0x1f`, `$1f`, or bare digits) |
| `⌘/Ctrl+B` · `F2` · `⇧F2` | Toggle a bookmark · next · previous |
| `Alt+R` · `⇧Alt+R` | Read the row · read the region under the cursor, to a screen reader |

Clicking the address gutter toggles a bookmark on that row. Every command above is
rebindable, and the platform's own shortcuts are deliberately not taken.

## Display options

| Prop | Attribute | Default | Effect |
| --- | --- | --- | --- |
| `addressRadix` | `address-radix` | `"hex"` | Address column base; `"decimal"` prints base-10 offsets |
| `byteGroup` | `byte-group` | `1` | Extra spacing every 1, 2, 4 or 8 bytes |
| `font` | `font` | monospace stack | Grid font — column widths are measured from it, not assumed |
| `editMode` | `edit-mode` | `"overwrite"` | `"read-only"`, `"overwrite"` or `"insert"` |
| `highlightCursorAddress` | `highlight-cursor-address` | `true` | Shades the address of the cursor's row |
| `highlightCursorAscii` | `highlight-cursor-ascii` | `true` | Draws the cursor byte inverted in the text column |
| `maxFps` | `max-fps` | uncapped | Caps painting alone; input and state stay immediate |

The two flags read `"false"` and `"0"` as off, and an absent attribute keeps the default
rather than meaning false.

**Edit mode is one value, and the editor never changes it.** `read-only` makes the other
two meaningless, so a separate flag could describe a state that does not exist. Render your
own control for it — the playground puts a select in its status bar.

A row wider than the viewport scrolls sideways, and **the address column stays put**: it is
painted over the grid after the grid has been offset, so offsets stay readable however far
right the view has gone.

## Theming

**There is no stylesheet to import.** Structural styles are inline because overriding them
breaks the editor; everything that is appearance reads a `--hexcanvas-*` custom property
with a built-in fallback. Declare them anywhere above the editor and both the DOM chrome
and the painted grid follow.

```css
.my-editor {
  --hexcanvas-bg: #fff;              --hexcanvas-fg: #16202c;
  --hexcanvas-muted: #7b8794;        --hexcanvas-selection: #bcd9ff;
  --hexcanvas-caret: #0b1520;        --hexcanvas-cursor-row: #eef1f5;
  --hexcanvas-cursor-byte: #16202c;  --hexcanvas-cursor-byte-text: #fff;
  --hexcanvas-decoration: #b45309;   --hexcanvas-decoration-label: #92400e;
  --hexcanvas-search: #fde68a;       --hexcanvas-danger: #b91c1c;
  --hexcanvas-panel-bg: #fff;        --hexcanvas-panel-fg: #1f2933;
  --hexcanvas-field-bg: #f6f7f9;     --hexcanvas-border: #c7ced6;
  --hexcanvas-font: 13px "JetBrains Mono", monospace;
  --hexcanvas-radius: 6px;           --hexcanvas-height: 24rem;
}
```

Comparison adds `--hexcanvas-diff-insert`, `--hexcanvas-diff-delete` and
`--hexcanvas-diff-replace`; the panels read `--hexcanvas-panel-font`,
`--hexcanvas-button-font`, `--hexcanvas-input-width` and `--hexcanvas-min-height`.

The canvas cannot be reached by a selector, so the grid's colours are a JS `HexTheme` — but
you do not set them twice: the engine resolves that theme from the same custom properties,
and `prefers-color-scheme` is picked up automatically. Change the variables at runtime and
call `engine.refreshTheme()`.

Chrome lives in a shadow root, so `::part()` is how it is restyled — `editor`, `overlay`,
`panel`, `input`, `select`, `button`, `message` and `canvas`:

```css
hexcanvas-editor::part(panel) { border-radius: 0; }
```

The scroll spacer is as tall as the document, so an unconstrained editor would grow to fit
the whole file — hence the `--hexcanvas-height: 24rem` default. Set that variable or an
ordinary `height` rule. Nothing outside the editor's own subtree is styled, no
`!important` is used, and no reset ships.

## Decorations

Ranges with labels, colours and nesting. Bookmarks and search hits use the same mechanism,
so a host's overlays are not a special case:

```ts
engine.setDecorations([
  { start: 0x00, end: 0x30, label: "record", color: "#6366f1", opacity: 0.25 },
  { start: 0x00, end: 0x04, label: "magic",  color: "#22c55e" },
  { start: 0x04, end: 0x0d, label: "name",   color: "#0ea5e9", textColor: "#f8fafc" },
], "structure");
```

- **Nesting works by default** — within one `priority`, the narrower range paints last, so a field stays visible inside the struct containing it
- **`setDecorations(list, kind)` replaces a whole kind in one repaint**; `addDecoration` is for single ranges
- **Decorations map through edits**, so an insert ahead of a range moves it rather than leaving it on the wrong bytes
- Backgrounds paint one rect per contiguous run, so a region reads as a band rather than as stripes

### When the host owns the structure

A parser that reads the file itself should not have to copy its result in. Hand it a kind
and answer windows instead — the `peek`/`ensure` split again, applied to ranges:

```ts
engine.setDecorationSource("structure", {
  // Synchronous: the renderer calls this inside a frame.
  between: (from, to) => myTree.overlapping(from, to),
});

engine.invalidateDecorations("structure");           // parsed further — repaint
engine.setDecorationSource("structure", undefined);  // hand the kind back
```

Which shape to use is decided by the format, not by taste:

| | Whole-file parsers (executables, archives) | Window parsers (media, streams) |
| --- | --- | --- |
| Why | defects only show against the whole thing — a section table, a checksum | the box or frame chain is self-describing and survives damage |
| Shape | `setDecorations(list, kind)` — it already has everything | `setDecorationSource(kind, query)` — answer the viewport |
| Editor's cost | grows with the parse | constant, a viewport's worth |

One thing moves to the host with a source: materialised ranges are carried across edits for
free, but a source owns its own offsets and remaps them itself from `onChange`.

### Reading it back

```ts
engine.decorationsAt(offset, kind?)          // innermost first — what does this byte mean
engine.decorationsBetween(from, to, kind?)   // what is highlighted in this window
engine.select(start, end)                    // the other direction: a field highlights its bytes
engine.read(offset, length)                  // the bytes as the document has them now
await engine.ensureRead(offset, length)      // make them resident first, for a paged source
```

`read` matters after an edit: the host parsed the file, but the piece table is what the
document *is* now.

## Cursor and selection as inputs

The editor moves the cursor and says so, and it also takes the position as an input — the
pairing a structure view needs, where clicking a field selects bytes and clicking bytes
highlights a field.

```tsx
<HexEditor
  source={source}
  cursor={{ offset }}
  selection={selection}
  onCursorChange={(cursor) => setOffset(cursor.offset)}
  onSelectionChange={setSelection}
/>
```

On the element these are properties plus a `cursorchange` event. Assigning a position the
editor already holds does nothing, so a host echoing the event back into the prop cannot
loop.

## Comparing two documents

![Two hex panes side by side, four differences marked in amber on both sides, with a
difference counter above them](assets/compare.png)

`<hexcanvas-compare>` — or `HexCompare` over two engines — puts two documents side by
side and reports the differences as a list and as decorations. Three providers, picked by
what the pair allows rather than by preference:

| Provider | When | Cost |
| --- | --- | --- |
| Aligned | Any size | One streaming pass over the shorter document, two windows of memory |
| Edit script | Both sides resident (≤ 8 MiB, ≤ 1,024 edits) | Myers, with the common prefix and suffix stripped first |
| Anchored | Too large for that | Blocks matched by rolling hash, **every anchor verified byte for byte** |

Once a shift is recognised, **rows stay level**: matching bytes sit side by side, and the
shorter side is padded with rows that hold nothing and deliberately show no address.

## Find and replace

![The find panel open in text mode with the query HexCanvas, a 5/205 counter, and every
hit highlighted in both the hex and the text column](assets/find.png)

Finding highlights **every** hit, not only the one it jumped to, and the panel shows
which hit the cursor is on out of how many.

```ts
await engine.findAllMatches();   // awaits the scan, running or not; returns the count
engine.matches;                  // the hits, as decorations, in document order
await engine.replace();          // the hit under the cursor, then move to the next
await engine.replaceAll();       // every hit, in one undo step
```

- **Finding moves first and highlights afterwards.** A full scan of 100 MB is seconds and must not stand between the key press and the jump — a nearby match lands in milliseconds
- **Replace-all is one `ChangeSet`, not a loop**, so later hits need no remapping and the whole sweep undoes in a single step
- **Scanning stops at 1,000 hits** (`searchMatchLimit`); the count reads `1000+` and replace-all says so rather than claiming it finished. Find-next streams from the cursor, so it works past the cap
- `SearchOptions` exposes `chunkSize` and `readAhead`; the defaults keep about 1 MB in flight

## Accessibility

The grid is painted, so there is no text for a screen reader to find. The element reports
itself as `role="application"` — which is also what lets it keep the arrow keys — with
`aria-roledescription="hex editor"` and a polite live region:

```text
0000001F, byte 4A, character J, hex column, 16 bytes selected
```

`Alt+R` reads the whole row and `Shift+Alt+R` the region under the cursor, on request
rather than on every arrow key. `engine.announce()` is public, so a host can speak through
the same channel. Any `role`, `aria-roledescription` or `aria-label` the host sets is left
alone.

The accessibility tree is audited by a test suite driving real keystrokes. What no
assertion can check is how it *sounds* — verbosity, ordering, pronunciation — and that pass
has not been done.

<a id="size"></a>
## Performance

Every number here is measured by `pnpm bench` or by the browser suite, not estimated.

| | |
| --- | --- |
| Whole editor, bundled | **30 kB** min+gz (core alone, 26 kB) |
| Runtime dependencies | **0** |
| Largest file exercised | 102 MB, over `File.slice` |
| Search throughput | ~200 MB/s (the matching loop alone manages 750 MB/s) |
| Overlay query, 41,000 ranges | 294× the linear pass it replaced |
| Decoration memory | ~40 B a range without a label, ~97 B with |
| Insert rate | flat from 1,000 pieces to 50,000 |
| Idle paints | 0 |

## Architecture

```text
ByteSource ──► HexEngine ──► Canvas renderer
                ▲     │         (layout owns every coordinate)
    key/pointer │     └──► state: cursor, selection, scroll, search
      from host │
            React / Vue / Svelte / Web Component binding
```

`HexEngine` is framework-free: a binding translates its platform's events into `handleKey`,
`pointerDown`/`Move`/`Up`, `setScrollTop` and `setViewportSize`, then redraws when
`subscribe` fires. Porting to another framework means writing that forwarding layer, not
reimplementing the editor.

`createLayout()` owns every horizontal coordinate — address width, byte and nibble
positions, text-column start, and the inverse mapping used for hit-testing. Renderers and
input handlers share one instance, so what is drawn and what is clicked cannot drift apart.

## Development

```sh
pnpm install
pnpm dev           # playground: React at /, custom element at /element.html, bindings at /frameworks.html
pnpm check         # build, type-check every package and its tests, run the core suite
pnpm test          # the core suite alone
pnpm test:browser  # renderer and bindings in headless chromium and WebKit
pnpm bench         # the two structures where cost, not correctness, is the risk
```

Two suites, because a canvas needs a browser. `pnpm test` covers `@hexcanvas/core` with no
DOM. What it cannot cover is what is *painted* — whether the caret lands on the byte the
hit-test returns, whether a selection reads as one band. `pnpm test:browser` drives a real
browser and **reads pixels back off the canvas**: the caret is located by scanning for its
colour, and its painted centre is fed to `hitTest`, so a drift between drawing and clicking
fails the suite. One shared list of expectations runs against all four bindings.

Install the browsers once with `npx playwright install chromium webkit`.

Both engines, because they disagree in ways nothing else here would catch: the same
font string measures 7.83px a character on chromium and 8.04px on WebKit, which is
enough to take a sixteen-byte row from fitting to not.

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request, and
[ROADMAP.md](ROADMAP.md) for what this library has decided not to do — a declined
feature and a missing one look the same from outside.

## Licence

MIT — see [LICENSE](LICENSE).
