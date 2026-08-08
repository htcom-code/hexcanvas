# @hexcanvas/react

[hexcanvas.htcom.org](https://hexcanvas.htcom.org) · [Repository](https://github.com/htcom-code/hexcanvas)

The React binding for [HexCanvas](https://github.com/htcom-code/hexcanvas), a hex viewer
and editor painted on a canvas. `<HexEditor>` is a wrapper over the `<hexcanvas-editor>` custom
element that maps props to attributes and events to callbacks; it holds no editor logic and no
chrome of its own, so a React release cannot drift from the Vue or Svelte one.

```sh
npm install @hexcanvas/react @hexcanvas/core
```

React 18 or 19 (`react` and `react-dom` are peer dependencies).

```tsx
import { HexEditor } from "@hexcanvas/react";
import { MemoryByteSource } from "@hexcanvas/core";

const source = useMemo(() => new MemoryByteSource(bytes), [bytes]);

<HexEditor source={source} byteGroup={4} onChange={(changes) => markDirty(changes)} />;
```

## Props

`source` is the only required prop — a `ByteSource` from `@hexcanvas/core`, or the older
synchronous `BinaryBuffer`, which is adapted.

| Prop | Effect |
| --- | --- |
| `bytesPerRow`, `rowHeight` | Grid size. Both default to the editor's own. |
| `addressRadix` | `"hex"` (default) or `"decimal"`. |
| `byteGroup` | Extra spacing every 1, 2, 4 or 8 bytes. |
| `font` | Grid font. Column widths are measured from it, not assumed. |
| `highlightCursorAddress`, `highlightCursorAscii` | Cursor emphasis; both default to `true`. |
| `editMode` | `"read-only"`, `"overwrite"` or `"insert"`. The editor never changes it itself. |
| `theme` | A `HexTheme` override; by default the grid resolves its colours from the CSS custom properties. |
| `cursor`, `selection` | Positions to hold — see below. |
| `className`, `style` | Land on the element itself, not on anything inside it. |
| `onChange`, `onCursorChange`, `onSelectionChange`, `onCopy` | Callbacks. |
| `onEngine` | Receives the `HexEngine`, for driving search, history or the cursor. |

## Cursor and selection as inputs

The editor moves the cursor itself and says so, and it also takes the position as an input, so
a host can hold it as its own state — the pairing a structure view needs, where clicking a
field selects bytes and clicking bytes highlights a field.

```tsx
<HexEditor
  source={source}
  cursor={{ offset }}
  selection={selection}
  onCursorChange={(cursor) => setOffset(cursor.offset)}
  onSelectionChange={setSelection}
/>
```

Echoing an event straight back into the prop cannot loop: assigning a position the editor
already holds does nothing.

## Styling

There is no stylesheet to import, and the chrome lives in a shadow root, so `::part()` is how
you restyle it. Appearance reads `--hexcanvas-*` custom properties declared anywhere above the
editor, and both the DOM chrome and the painted grid follow them.

```css
.my-editor { --hexcanvas-bg: #fff; --hexcanvas-selection: #bcd9ff; }
.my-editor::part(panel) { border-radius: 0; }
```

The full list of custom properties, the keymap, the byte sources and the decoration API are in
the [repository README](https://github.com/htcom-code/hexcanvas).

## Licence

MIT. See `LICENSE`.
