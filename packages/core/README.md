# @hexcanvas/core

[hexcanvas.htcom.org](https://hexcanvas.htcom.org) · [Repository](https://github.com/htcom-code/hexcanvas)

The framework-free half of [HexCanvas](https://github.com/htcom-code/hexcanvas): byte
storage, grid geometry, the Canvas renderer, and `HexEngine` — cursor, selection, scrolling,
key and pointer handling, editing, history and search. It has no DOM framework dependency and
knows nothing about how it is mounted.

Most applications want a binding instead: [`@hexcanvas/element`](https://www.npmjs.com/package/@hexcanvas/element)
(any framework), [`@hexcanvas/react`](https://www.npmjs.com/package/@hexcanvas/react),
[`@hexcanvas/vue`](https://www.npmjs.com/package/@hexcanvas/vue) or
[`@hexcanvas/svelte`](https://www.npmjs.com/package/@hexcanvas/svelte). Reach for this package
directly when you are porting the editor to another framework, or when you want the byte
sources and the search machinery without the editor chrome.

```sh
npm install @hexcanvas/core@next
```

## Byte sources

Reads are split in two, because a renderer cannot await inside a frame. `peek` is synchronous
and answers only from resident bytes; `ensure` is the asynchronous half that makes a range
resident. Rows that are not resident draw as pending and repaint when the bytes land, which is
what lets one editor serve both an in-memory array and a file arriving over IPC.

| Source | Use |
| --- | --- |
| `MemoryByteSource` | An in-memory array. `peek` never misses; a length change reallocates. |
| `PieceTableSource` | Insert and delete without rewriting the original. Wraps any other source, so the original can still be a paged one. |
| `PagedByteSource` | A slow backend. You implement `fetch(offset, length)`; paging, coalescing and eviction are handled for you. |
| `fromBinaryBuffer(buffer)` | Adapts the older synchronous `BinaryBuffer`. Cannot change length. |

Edits travel as a `ChangeSet` — `{ from, to, insert }` replacements that also carry the
position mapping. Anything holding an offset across an edit maps it with
`changes.mapPos(offset)`.

```ts
import { ChangeSet, MemoryByteSource, PieceTableSource } from "@hexcanvas/core";

const source = new PieceTableSource(new MemoryByteSource(bytes));
source.apply(ChangeSet.insert(0x40, new Uint8Array([0xde, 0xad])));
```

## Engine

`HexEngine` is the editor itself. A binding translates its platform's events into `handleKey`,
`pointerDown`/`pointerMove`/`pointerUp`, `setScrollTop` and `setViewportSize`, then redraws
whenever `subscribe` fires — porting to another framework means writing that forwarding layer,
not reimplementing the editor.

```ts
import { HexEngine, createLayout } from "@hexcanvas/core";
```

`createLayout()` owns every horizontal coordinate — address width, byte and nibble positions,
ASCII start, and the inverse mapping used for pointer hit-testing. A renderer and its input
handling must share one layout instance, or what is drawn and what is clicked will drift apart.

Saving streams, since a length change means the original can no longer be patched in place:

```ts
for await (const chunk of engine.save() ?? []) await sink.write(chunk);
```

Overwrites are the common case and move nothing, so `engine.savePatch()` offers just the
written ranges — and returns `undefined` once an insert or a delete has shifted everything
after it.

## Decorations

Bookmarks, search hits and host-supplied structure overlays are all `Decoration` ranges,
separated by `kind`. The store keeps a centred interval tree and holds ranges in columns rather
than as an object each, so a parse result of hundreds of thousands of ranges is affordable to
hand over.

```ts
engine.setDecorations([
  { start: 0x00, end: 0x30, label: "record", color: "#6366f1", opacity: 0.25 },
  { start: 0x00, end: 0x04, label: "magic",  color: "#22c55e" },
], "structure");

engine.decorationsAt(offset, "structure");  // innermost first
```

A host that already owns the structure can answer windows instead of copying its result in:

```ts
engine.setDecorationSource("structure", { between: (from, to) => myTree.overlapping(from, to) });
engine.invalidateDecorations("structure");
```

## Comparing two documents

`HexCompare` holds two engines rather than being part of one, so each pane stays a complete
editor and the grid needs no changes to show a comparison. Differences are painted as
decorations of `diff-replace`, `diff-insert` and `diff-delete`.

```ts
const comparison = new HexCompare({ left: leftEngine, right: rightEngine });
await comparison.compare();
comparison.differences;      // [{ left, right, kind }], in left-document order
comparison.nextDifference(); // walks them, wrapping, and scrolls both panes
```

The shipped comparison is **aligned**: it streams both documents offset for offset, so cost is
one pass over the shorter and it works at any size — but a document with bytes inserted at the
front differs from that offset on, which it reports as one long run rather than as a shift.
Recognising a shift is an edit script; supply one through `DiffProvider` if you have it.

The count is capped at `diffLimit` and the cap is reported as `differenceTruncated`, exactly as
a search reports its own.

Full documentation, including theming, accessibility and the search API, is in the
[repository README](https://github.com/htcom-code/hexcanvas).

## Licence

MIT. See `LICENSE`.
