# @hexcanvas/vue

[hexcanvas.htcom.org](https://hexcanvas.htcom.org) · [Repository](https://github.com/htcom-code/hexcanvas)

The Vue binding for [HexCanvas](https://github.com/htcom-code/hexcanvas), a hex viewer and
editor painted on a canvas. It is a wrapper over the `<hexcanvas-editor>` custom element, not a
second implementation: the editor chrome exists once, so a Vue release cannot drift from the
React or Svelte one.

```sh
npm install @hexcanvas/vue @hexcanvas/core
```

Vue 3.4 or later (`vue` is a peer dependency).

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

## Props and events

`source` is required — a `ByteSource` from `@hexcanvas/core`, or the older synchronous
`BinaryBuffer`, which is adapted. The rest are optional: `bytesPerRow`, `rowHeight`,
`addressRadix` (`"hex"` or `"decimal"`), `byteGroup` (1, 2, 4 or 8), `font`, `editMode`
(`"read-only"`, `"overwrite"` or `"insert"`) and `theme`.

Events: `change`, `selectionchange`, and `ready`, which hands over the `HexEngine` so the host
can drive search, history or the cursor.

```vue
<HexEditor :source="source" edit-mode="read-only" @ready="(engine) => (hex = engine)" />
```

A template ref also exposes `engine()` and `element()`, for the same access outside the `ready`
handler. The element is created in a render function rather than in a template, so no
`isCustomElement` compiler option is needed in your build.

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
