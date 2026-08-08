import { defineComponent, h, onBeforeUnmount, onMounted, ref, watch, type PropType } from "vue";
import { defineHexCanvasElement, type HexCanvasElement } from "@hexcanvas/element";
import type {
  AddressRadix,
  BinaryBuffer,
  ByteGroupSize,
  ByteSource,
  EditMode,
  FeatureMode,
  HexEngine,
  HexSpacing,
  HexTextOverrides,
  HexTheme,
  Keymap,
  LabelWidth,
  Platform,
  SearchMode,
  SearchProvider,
  SearchRequest,
} from "@hexcanvas/core";

defineHexCanvasElement();

/**
 * A wrapper over `<hexcanvas-editor>`, not a second implementation. The editor
 * chrome exists once, in the custom element, so a Vue release cannot drift from
 * the Svelte one.
 */
export const HexEditor = defineComponent({
  name: "HexEditor",
  props: {
    source: { type: Object as PropType<ByteSource | BinaryBuffer>, required: true },
    bytesPerRow: { type: Number, default: undefined },
    rowHeight: { type: Number, default: undefined },
    addressRadix: { type: String as PropType<AddressRadix>, default: undefined },
    byteGroup: { type: Number as PropType<ByteGroupSize>, default: undefined },
    font: { type: String, default: undefined },
    editMode: { type: String as PropType<EditMode>, default: undefined },
    theme: { type: Object as PropType<HexTheme>, default: undefined },
    asciiColumn: { type: Boolean, default: undefined },
    decorationLabels: { type: Boolean, default: undefined },
    labelWidth: { type: Number as PropType<LabelWidth>, default: undefined },
    /** Defaults to `"off"`, like the element: find is asked for, not assumed. */
    search: { type: String as PropType<FeatureMode>, default: undefined },
    replace: { type: String as PropType<FeatureMode>, default: undefined },
    goto: { type: String as PropType<FeatureMode>, default: undefined },
    searchProvider: { type: Object as PropType<SearchProvider>, default: undefined },
    searchModes: { type: Array as PropType<readonly SearchMode[]>, default: undefined },
    platform: { type: String as PropType<Platform>, default: undefined },
    keymap: { type: Object as PropType<Keymap>, default: undefined },
    text: { type: Object as PropType<HexTextOverrides>, default: undefined },
    spacing: { type: Object as PropType<HexSpacing>, default: undefined },
  },
  emits: {
    change: (_detail: unknown) => true,
    selectionchange: (_detail: unknown) => true,
    searchrequest: (_request: SearchRequest) => true,
    ready: (_engine: HexEngine) => true,
  },
  setup(props, { emit, expose }) {
    const host = ref<HexCanvasElement>();

    const onChange = (event: Event) => emit("change", (event as CustomEvent).detail);
    const onSelectionChange = (event: Event) => emit("selectionchange", (event as CustomEvent).detail);
    const onSearchRequest = (event: Event) => emit("searchrequest", (event as CustomEvent<SearchRequest>).detail);

    onMounted(() => {
      const element = host.value;
      if (!element) return;
      element.addEventListener("change", onChange);
      element.addEventListener("selectionchange", onSelectionChange);
      element.addEventListener("searchrequest", onSearchRequest);
      // Objects go on as properties; only scalars can travel as attributes.
      element.source = props.source;
      if (props.theme) element.theme = props.theme;
      if (props.searchProvider) element.searchProvider = props.searchProvider;
      if (props.searchModes) element.searchModes = props.searchModes;
      if (props.keymap) element.keymap = props.keymap;
      if (props.text) element.text = props.text;
      if (props.spacing) element.spacing = props.spacing;
      emit("ready", element.engine);
    });

    onBeforeUnmount(() => {
      host.value?.removeEventListener("change", onChange);
      host.value?.removeEventListener("selectionchange", onSelectionChange);
      host.value?.removeEventListener("searchrequest", onSearchRequest);
    });

    watch(() => props.source, (source) => {
      if (host.value) host.value.source = source;
    });
    watch(() => props.theme, (theme) => {
      if (host.value) host.value.theme = theme;
    });
    watch(() => props.searchProvider, (provider) => {
      if (host.value) host.value.searchProvider = provider;
    });
    watch(() => props.searchModes, (modes) => {
      if (host.value) host.value.searchModes = modes;
    });
    watch(() => props.keymap, (keymap) => {
      if (host.value) host.value.keymap = keymap;
    });
    watch(() => props.text, (text) => {
      if (host.value) host.value.text = text;
    });
    watch(() => props.spacing, (spacing) => {
      if (host.value) host.value.spacing = spacing;
    });

    expose({ engine: () => host.value?.engine, element: () => host.value });

    return () => h("hexcanvas-editor", {
      ref: host,
      "bytes-per-row": props.bytesPerRow,
      "row-height": props.rowHeight,
      "address-radix": props.addressRadix,
      "byte-group": props.byteGroup,
      "edit-mode": props.editMode,
      font: props.font,
      // Omitted rather than stringified, so the element keeps its own default.
      "ascii-column": flag(props.asciiColumn),
      "decoration-labels": flag(props.decorationLabels),
      "label-width": props.labelWidth,
      search: props.search,
      replace: props.replace,
      goto: props.goto,
      platform: props.platform,
    });
  },
});

const flag = (value: boolean | undefined): string | undefined => (value === undefined ? undefined : String(value));

export type { HexCanvasElement };
