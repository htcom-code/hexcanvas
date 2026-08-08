import type { CommandId } from "./keymap.js";

/**
 * Every string the library shows a user, in one place so it can be replaced in
 * one place.
 *
 * English is the default rather than the only option. Anything with a value
 * interpolated into it is a function rather than a template with `{0}` holes:
 * word order differs by language, and a host that has to reassemble a sentence
 * from fragments cannot fix that.
 *
 * What is *not* here: the errors `resolveKeymap` throws. Those are programming
 * errors, read by whoever wrote the keymap and never by a user, so translating
 * them would only make them harder to search for.
 */
export interface HexText {
  // --- find panel ---------------------------------------------------------
  /**
   * Names the panel itself, not a control in it. Focus moves into the query
   * field when the panel opens, and a field announced by its own label alone
   * says what to type without saying what appeared — so a landmark with a name
   * is the difference between "Find text, edit" and "Find, search region, Find
   * text, edit".
   */
  searchPanel: string;
  /** Accessible name of the query field, per mode. */
  findHexField: string;
  /** Accessible name of the query field in text mode. */
  findTextField: string;
  /** Placeholder of the query field, per mode. An example, so it is not prose. */
  findHexPlaceholder: string;
  /** Placeholder in text mode. An example rather than prose. */
  findTextPlaceholder: string;
  /** Accessible name of the mode select beside the query. */
  searchModeField: string;
  /** Visible label beside the replace row, and the accessible name of its field. */
  replaceRow: string;
  replaceField: string;
  replacePlaceholder: string;
  /** Visible label beside the go-to row. */
  gotoRow: string;
  /** Accessible name of the go-to field. */
  gotoField: string;
  /** Placeholder for the go-to field. An example address. */
  gotoPlaceholder: string;
  findPreviousButton: string;
  findNextButton: string;
  toggleReplaceButton: string;
  closeSearchButton: string;
  replaceButton: string;
  replaceAllButton: string;
  closeReplaceButton: string;
  gotoButton: string;
  closeGotoButton: string;

  // --- outcomes the panel shows -------------------------------------------
  /** Said when find runs with nothing typed. */
  emptyQuery: string;
  /** Said when a query matches nothing. */
  noMatch: string;
  /** Shown when a query cannot be read; a provider's own complaint wins over it. */
  invalidQuery: string;
  /** Said when the replacement cannot be read as bytes in the current mode. */
  invalidReplacement: string;
  /** Said when an edit is refused because the document is read-only. */
  notEditable: string;
  /** Said when the go-to query does not read as an address. */
  notAnAddress: string;
  /** How many hits replace-all changed. */
  replaced: (count: number) => string;
  /**
   * The scan stopped at its cap, so the sweep is incomplete. Said rather than
   * hidden — the count alone would read as "done".
   */
  replacedTruncated: (count: number, limit: number) => string;

  // --- comparison ----------------------------------------------------------
  compareButton: string;
  previousDifferenceButton: string;
  nextDifferenceButton: string;
  closeCompareButton: string;
  /** The draggable divider between the two panes. */
  splitHandle: string;
  /** Shown while a comparison is running. */
  comparing: string;
  /** Shown when a comparison finds no differences. */
  identical: string;
  /** "3 of 128". Truncated says the cap was reached, so the total is a floor. */
  differencePosition: (index: number, count: number, truncated: boolean) => string;
  /** The documents were edited after the comparison, so its ranges are the old ones. */
  comparisonStale: string;
  /**
   * What a difference says in the label gutter. The byte count rather than the
   * offsets: the address is already in the row's own column.
   *
   * One per kind rather than one function taking the kind, because the three
   * are different sentences — a language that inflects the number differently
   * for "added" and "removed" cannot express that from a shared template.
   */
  replacedLabel: (bytes: number) => string;
  /** Label on a run of bytes only the right document has. */
  insertedLabel: (bytes: number) => string;
  /** Label on a run of bytes only the left document has. */
  deletedLabel: (bytes: number) => string;

  /**
   * What the count says out loud. The visible `2/205` is right for a strip of
   * chrome and wrong for a screen reader, which reads it as two numbers with a
   * slash between them; these are the same fact as a sentence.
   */
  searchPosition: (index: number, count: number, truncated: boolean) => string;
  /**
   * The hit count, with `truncated` set when the scan stopped at its cap — the count
   * is then a floor rather than a total, and the wording has to say so.
   */
  searchTotal: (count: number, truncated: boolean) => string;

  /**
   * Names for the two panes. Both were "Hex editor" until a screen reader was
   * pointed at a comparison and neither could be told from the other; a host
   * that knows what it is comparing should replace these with the two names.
   */
  leftPane: string;
  /** The other half of `leftPane`. */
  rightPane: string;

  // --- the live region ----------------------------------------------------
  /** The grid is painted, so this is the only thing a screen reader can read. */
  cursorByteNotLoaded: string;
  /** The byte under the cursor, given as two upper-case hex digits. */
  cursorByte: (hex: string) => string;
  /**
   * The character that byte draws as. Omitted when the encoding has no glyph for it,
   * rather than announcing the substitute.
   */
  cursorCharacter: (character: string) => string;
  /**
   * Which column has focus. One of these is always said, so a reader knows whether a
   * keystroke would type hex or text.
   */
  cursorHexColumn: string;
  /** The other half of `cursorHexColumn`. */
  cursorTextColumn: string;
  /** How much is selected. Said only when something is. */
  cursorSelection: (bytes: number) => string;
  /** Announced once when the mode changes, ahead of the cursor description. */
  cursorEditMode: (mode: string, describedCursor: string) => string;
  /**
   * Said when Escape arms the next Tab to move focus out. Tab switches column,
   * so without this the only way forward out of the grid is backwards, and a
   * way out nobody is told about is not a way out.
   */
  leaveWithTab: string;

  // --- read on demand -----------------------------------------------------
  /**
   * A whole row, asked for rather than moved through. The cursor description
   * says where you are and what one byte is; this is the sentence for "what is
   * on this line", which a sighted reader gets from the grid for free and a
   * screen reader could not get at all.
   *
   * `text` is the same glyphs the plain-text column drew, or empty when that
   * column is turned off — one function rather than two, because the branch is
   * a ternary and a second entry would be a second thing to translate.
   */
  rowDescription: (address: string, hex: string, text: string) => string;
  /** The row is inside the document but its bytes have not arrived yet. */
  rowNotLoaded: (address: string) => string;
  /** A comparison pads the shorter side with rows that hold nothing. */
  rowGap: string;
  /**
   * The selection read out: how much, from where to where, and the bytes
   * themselves up to the cap. Inclusive addresses — `to` is the last selected
   * byte, not the one after it, because that is the one a reader can go and
   * look at. Truncated says the bytes are a prefix, so the count is the fact and
   * the digits are a sample.
   */
  regionSelection: (from: string, to: string, bytes: number, hex: string, truncated: boolean) => string;
  /** A decorated range under the cursor: a parsed field, a bookmark, a hit. */
  regionDecoration: (label: string, from: string, to: string) => string;
  /** Stands in for a range that carries neither a label nor a kind. */
  unnamedRegion: string;
  /** Nothing is selected and nothing is highlighted where the cursor is. */
  nothingToRead: string;

  // --- command names, for a settings screen or a tooltip ------------------
  /**
   * One label per command, for a settings screen listing the keys. Overridden per
   * command rather than wholesale — `HexTextOverrides` keeps this one partial too.
   */
  commands: Record<CommandId, string>;
}

/** A host replaces the entries it cares about and keeps the rest. */
export type HexTextOverrides = Partial<Omit<HexText, "commands">> & {
  commands?: Partial<Record<CommandId, string>>;
};

/**
 * Every string the editor shows, in English. A host overrides what it needs and the
 * rest stay these.
 */
export const defaultText: HexText = {
  searchPanel: "Find",
  findHexField: "Find hexadecimal bytes",
  findTextField: "Find text",
  findHexPlaceholder: "DE AD BE EF",
  findTextPlaceholder: "text to find",
  searchModeField: "Search mode",
  replaceRow: "Replace",
  replaceField: "Replace with",
  replacePlaceholder: "CA FE",
  gotoRow: "Go to",
  gotoField: "Go to address",
  gotoPlaceholder: "0x1F00",
  findPreviousButton: "Find previous",
  findNextButton: "Find next",
  toggleReplaceButton: "Toggle replace",
  closeSearchButton: "Close search",
  replaceButton: "Replace match",
  replaceAllButton: "Replace all",
  closeReplaceButton: "Close replace",
  gotoButton: "Go",
  closeGotoButton: "Close go to",

  emptyQuery: "Enter something to find",
  noMatch: "No matching bytes",
  invalidQuery: "Invalid query",
  invalidReplacement: "Invalid replacement",
  notEditable: "This document cannot be edited",
  notAnAddress: "Not an address",
  replaced: (count) => `Replaced ${count}`,
  replacedTruncated: (count, limit) => `Replaced ${count}; more than ${limit} matched, so run it again`,

  compareButton: "Compare",
  previousDifferenceButton: "Previous difference",
  nextDifferenceButton: "Next difference",
  closeCompareButton: "Close comparison",
  splitHandle: "Resize the comparison panes",
  comparing: "Comparing…",
  identical: "The two are identical",
  differencePosition: (index, count, truncated) =>
    `${index > 0 ? `${index} of ` : ""}${count}${truncated ? "+" : ""} ${count === 1 && !truncated ? "difference" : "differences"}`,
  comparisonStale: "Edited since the comparison; run it again",
  searchPosition: (index, count, truncated) =>
    `match ${index} of ${count}${truncated ? " or more" : ""}`,
  searchTotal: (count, truncated) =>
    `${count}${truncated ? " or more" : ""} ${count === 1 && !truncated ? "match" : "matches"}`,
  leftPane: "Left document",
  rightPane: "Right document",
  // Short enough for the default sixteen-character gutter.
  replacedLabel: (bytes) => `${bytes} B changed`,
  insertedLabel: (bytes) => `${bytes} B added`,
  deletedLabel: (bytes) => `${bytes} B removed`,

  cursorByteNotLoaded: "not loaded",
  cursorByte: (hex) => `byte ${hex}`,
  cursorCharacter: (character) => `character ${character}`,
  cursorHexColumn: "hex column",
  cursorTextColumn: "text column",
  cursorSelection: (bytes) => `${bytes} bytes selected`,
  cursorEditMode: (mode, describedCursor) => `${mode} mode, ${describedCursor}`,
  leaveWithTab: "Press Tab to leave the editor",

  rowDescription: (address, hex, text) =>
    text === "" ? `row ${address}, ${hex}` : `row ${address}, ${hex}, text ${text}`,
  rowNotLoaded: (address) => `row ${address} has not loaded yet`,
  rowGap: "gap, no bytes on this row",
  regionSelection: (from, to, bytes, hex, truncated) =>
    `${bytes} bytes selected, ${from} to ${to}, ${hex}${truncated ? ", and more" : ""}`,
  regionDecoration: (label, from, to) => `${label}, ${from} to ${to}`,
  unnamedRegion: "highlighted",
  nothingToRead: "nothing selected here",

  commands: {
    find: "Find",
    findNext: "Find next",
    findPrevious: "Find previous",
    replace: "Replace",
    goto: "Go to offset",
    toggleBookmark: "Toggle bookmark",
    nextBookmark: "Next bookmark",
    previousBookmark: "Previous bookmark",
    nextDifference: "Next difference",
    previousDifference: "Previous difference",
    switchColumn: "Switch column",
    readRow: "Read this row",
    readRegion: "Read the selection or the region here",
  },
};

/** Defaults with the host's overrides on top. `commands` merges by key. */
export function resolveText(overrides?: HexTextOverrides): HexText {
  if (!overrides) return defaultText;
  return {
    ...defaultText,
    ...overrides,
    commands: { ...defaultText.commands, ...overrides.commands },
  };
}
