# @hexcanvas/svelte

[hexcanvas.htcom.org](https://hexcanvas.htcom.org) · [Repository](https://github.com/htcom-code/hexcanvas)

The Svelte binding for [HexCanvas](https://github.com/htcom-code/hexcanvas), a hex viewer
and editor painted on a canvas. It is an action over the `<hexcanvas-editor>` custom element
rather than a component, so the package needs no compiler and no Svelte dependency — and the
editor chrome stays in the element, where the React and Vue bindings share it.

```sh
npm install @hexcanvas/svelte@next @hexcanvas/core@next
```

```svelte
<script lang="ts">
  import { hexEditor } from "@hexcanvas/svelte";
  import { MemoryByteSource } from "@hexcanvas/core";

  const source = new MemoryByteSource(bytes);
</script>

<hexcanvas-editor use:hexEditor={{ source, byteGroup: 4 }} on:change={markDirty} />
```

The action expects a `<hexcanvas-editor>`; applied to any other element it upgrades nothing and
throws instead of silently doing nothing. To mount one yourself — outside a template, or into a
container you already have:

```ts
import { createHexEditor } from "@hexcanvas/svelte";

const element = createHexEditor(container, { source, editMode: "read-only" });
element.engine.findAllMatches();
```

## Options

`HexEditorOptions` takes `source` (required — a `ByteSource` from `@hexcanvas/core`, or the
older synchronous `BinaryBuffer`), plus `bytesPerRow`, `rowHeight`, `addressRadix` (`"hex"` or
`"decimal"`), `byteGroup` (1, 2, 4 or 8), `font`, `editMode` (`"read-only"`, `"overwrite"` or
`"insert"`), `theme`, and `onEngine` — which hands over the `HexEngine` for driving search,
history or the cursor. Reassigning the options object applies the difference to the element the
action is on.

Events come from the element itself, so listen for `change`, `cursorchange` and
`selectionchange` the ordinary way.

## Styling

There is no stylesheet to import. Appearance reads `--hexcanvas-*` custom properties declared
anywhere above the editor, and the chrome — living in a shadow root — is restyled through
`::part()`.

```css
hexcanvas-editor { --hexcanvas-bg: #fff; --hexcanvas-selection: #bcd9ff; }
hexcanvas-editor::part(panel) { border-radius: 0; }
```

The full list of custom properties, the keymap, the byte sources and the decoration API are in
the [repository README](https://github.com/htcom-code/hexcanvas).

## Licence

MIT. See `LICENSE`.
