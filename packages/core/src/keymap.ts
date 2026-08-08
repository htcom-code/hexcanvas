/**
 * Which keys run which command, and which keys are not the editor's to give away.
 *
 * The defaults differ by platform because the platforms disagree: `Mod+G` is
 * find-next on macOS and in the GNOME guidelines but go-to-offset in every
 * Windows hex editor, and `⌘H` is Hide Application rather than replace — the
 * page never sees that one, so a default bound to it would be no default at all.
 */

import { defaultText, type HexText } from "./text.js";

/** Whose keyboard conventions the defaults follow. */
export type Platform = "mac" | "windows" | "linux";

/** Closed set, so a keymap with a typo in it fails to compile. */
export type CommandId =
  | "find"
  | "findNext"
  | "findPrevious"
  | "replace"
  | "goto"
  | "toggleBookmark"
  | "nextBookmark"
  | "previousBookmark"
  | "nextDifference"
  | "previousDifference"
  | "switchColumn"
  | "readRow"
  | "readRegion";

/** A command with the keys it starts with, before a host's overrides. */
export interface Command {
  id: CommandId;
  /** For a settings screen. English; a host that translates supplies its own. */
  label: string;
  defaultKeys: readonly string[];
}

/** Command to key, or null to unbind. Partial: unnamed commands keep their default. */
export type Keymap = Partial<Record<CommandId, string | readonly string[] | null>>;

/** A command with the keys it ended up with, for a settings screen. */
export interface Keybinding {
  id: CommandId;
  label: string;
  keys: readonly string[];
}

/** The parts of a keyboard event a binding is matched against. */
export interface KeyInput {
  key: string;
  /**
   * `KeyboardEvent.code`. Needed for bindings that hold Alt: Option plus a letter
   * produces a different character on macOS, so `⌥⌘F` cannot be recognised by
   * key name.
   */
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

/** Order is the order a settings list shows them in. */
const commandOrder: readonly CommandId[] = [
  "find", "findNext", "findPrevious", "replace", "goto",
  "toggleBookmark", "nextBookmark", "previousBookmark",
  "nextDifference", "previousDifference", "switchColumn",
  "readRow", "readRegion",
];

const sharedDefaults: Partial<Record<CommandId, readonly string[]>> = {
  toggleBookmark: ["Mod+B"],
  nextBookmark: ["F2"],
  previousBookmark: ["Shift+F2"],
  // The function keys continue where bookmarks and find leave off — F2 walks
  // bookmarks, F3 walks matches, so F4 walks differences. Shared across the
  // three platforms for the same reason the bookmark keys are: none of them
  // collides with anything the platform reserves, so there is nothing to
  // resolve per platform.
  nextDifference: ["F4"],
  previousDifference: ["Shift+F4"],
  switchColumn: ["Tab"],
  // Reading a row and reading a region are shared for the same reason bookmarks
  // are — no platform has a convention for "say what is here", because no
  // platform has a widget that paints its content and cannot be read.
  //
  // Alt rather than another function key: the ladder is spent at F4, and F5 up
  // is where reload, caret browsing, the menu bar and the developer tools live
  // — and a function key needs Fn on a Mac laptop by default, which is a poor
  // ask for the one command a user unable to see the grid presses most. Mod is
  // the browser's own space. Alt is left, and an Alt-bearing binding is already
  // matched by `code` rather than by character, so ⌥R typing "®" on macOS
  // resolves by position — the mechanism `⌥⌘F` needed is the mechanism these
  // need.
  readRow: ["Alt+R"],
  readRegion: ["Shift+Alt+R"],
};

/**
 * Linux follows the editors rather than the GNOME guidelines for find-next: this
 * table spends `Ctrl+G` on go-to, which a hex editor reaches for far more often
 * than a text editor does, and `F3` is available from every editor anyway.
 */
const keyDefaults: Record<Platform, Partial<Record<CommandId, readonly string[]>>> = {
  mac: {
    find: ["Mod+F"],
    findNext: ["Mod+G"],
    findPrevious: ["Shift+Mod+G"],
    replace: ["Alt+Mod+F"],
    // Control, not Command: Command+G is find-next here, so go-to takes the
    // modifier macOS leaves free. This is how VS Code resolves the same collision.
    goto: ["Ctrl+G"],
    ...sharedDefaults,
  },
  windows: {
    find: ["Mod+F"],
    findNext: ["F3"],
    findPrevious: ["Shift+F3"],
    replace: ["Mod+H"],
    goto: ["Mod+G"],
    ...sharedDefaults,
  },
  linux: {
    find: ["Mod+F"],
    findNext: ["F3"],
    findPrevious: ["Shift+F3"],
    replace: ["Mod+H"],
    goto: ["Mod+G"],
    ...sharedDefaults,
  },
};

/**
 * Keys the editor will not hand over, because they are not its to give: the
 * platform taught them to the user. Rejected rather than merged, so a host
 * cannot rebind copy by accident — or on purpose.
 *
 * A host that means it can still have them: it sees the event first, so it can
 * consume the key and call the engine method itself.
 */
const reserved: readonly string[] = [
  "Mod+C", "Mod+X", "Mod+V", "Mod+A",
  "Mod+Z", "Shift+Mod+Z", "Mod+Y",
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End",
  "Delete", "Backspace",
];

/**
 * Combinations the platform itself takes, so the page never sees them. Absolute
 * and knowable, unlike the browser's own reserved list, which is neither current
 * nor uniform across browsers — that one is not enforced.
 */
const unreachable: Record<Platform, readonly string[]> = {
  // Hide Application, Quit, app switch, Spotlight.
  mac: ["Mod+H", "Mod+Q", "Mod+Tab", "Mod+Space"],
  // Windows reserves *every* Windows-key combination, defined or not, so the
  // check below is by modifier rather than by a list.
  windows: [],
  linux: [],
};

/** Resolved form of a binding string, for matching against an event. */
export interface Binding {
  /** Lower-cased `key`, or undefined when matching on `code`. */
  key?: string;
  code?: string;
  /** Command on macOS, Control elsewhere — how a binding stays right on both. */
  mod: boolean;
  /** Command or Windows, asked for by name rather than through `mod`. */
  meta: boolean;
  /** Control, asked for by name. */
  ctrl: boolean;
  /**
   * Option or Alt. A binding holding this is matched by `code`, because Option plus a
   * letter produces a different character on macOS.
   */
  alt: boolean;
  /** Shift. */
  shift: boolean;
}

const modifierTokens = new Set(["mod", "meta", "ctrl", "control", "alt", "option", "shift"]);

/**
 * Keys written by name rather than as a character. Spelled both ways because the
 * two are not the same string: the space bar is written `Space` in a binding and
 * arrives as `" "` in an event.
 */
const named: readonly (readonly [written: string, eventKey: string])[] = [
  ...["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown",
    "Delete", "Backspace", "Enter", "Escape", "Tab", "Insert",
    "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"]
    .map((name) => [name, name] as const),
  ["Space", " "] as const,
];

/** Written name, lower-cased, to the `KeyboardEvent.key` it matches. */
const namedKeys = new Map(named.map(([written, eventKey]) => [written.toLowerCase(), eventKey.toLowerCase()]));

/** The other direction, for writing a binding back out for a person to read. */
const namedSpellings = new Map(named.map(([written, eventKey]) => [eventKey.toLowerCase(), written]));

/** `KeyboardEvent.code` for the letters and digits, for Alt-bearing bindings. */
function codeFor(key: string): string | undefined {
  if (/^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return undefined;
}

/**
 * Parses `"Shift+Mod+G"`. Modifier order is not significant. Throws on anything
 * it cannot read, naming the token, because a keymap is host input and an
 * editor that silently ignores a rebinding cannot be debugged.
 */
export function parseBinding(text: string): Binding {
  const parts = text.split("+").map((part) => part.trim()).filter((part) => part !== "");
  if (parts.length === 0) throw new Error(`Empty key binding: "${text}"`);
  const binding: Binding = { mod: false, meta: false, ctrl: false, alt: false, shift: false };
  const keyParts: string[] = [];
  for (const part of parts) {
    const token = part.toLowerCase();
    if (!modifierTokens.has(token)) {
      keyParts.push(part);
      continue;
    }
    if (token === "mod") binding.mod = true;
    else if (token === "meta") binding.meta = true;
    else if (token === "ctrl" || token === "control") binding.ctrl = true;
    else if (token === "alt" || token === "option") binding.alt = true;
    else binding.shift = true;
  }
  if (keyParts.length !== 1) {
    throw new Error(`A key binding needs exactly one key, and "${text}" has ${keyParts.length}`);
  }
  const name = keyParts[0]!;
  const eventKey = namedKeys.get(name.toLowerCase());
  if (eventKey !== undefined) {
    binding.key = eventKey;
    return binding;
  }
  if (name.length !== 1) throw new Error(`Unknown key "${name}" in binding "${text}"`);
  const key = name.toLowerCase();
  // Option plus a letter is a different character on macOS, so a binding holding
  // Alt has to be recognised by position rather than by what was typed.
  if (binding.alt) {
    const code = codeFor(key);
    if (!code) throw new Error(`"${name}" cannot be combined with Alt; only letters and digits can`);
    binding.code = code;
    return binding;
  }
  binding.key = key;
  return binding;
}

function matches(binding: Binding, input: KeyInput, platform: Platform): boolean {
  const meta = Boolean(input.metaKey);
  const ctrl = Boolean(input.ctrlKey);
  // `Mod` is Command on macOS and Control elsewhere. Both are checked exactly, so
  // a binding for one is not satisfied by the other — which is what lets `Ctrl+G`
  // and `Mod+G` be different bindings on macOS.
  const wantMeta = binding.meta || (binding.mod && platform === "mac");
  const wantCtrl = binding.ctrl || (binding.mod && platform !== "mac");
  if (meta !== wantMeta || ctrl !== wantCtrl) return false;
  if (Boolean(input.altKey) !== binding.alt) return false;
  if (Boolean(input.shiftKey) !== binding.shift) return false;
  if (binding.code !== undefined) return input.code === binding.code;
  return input.key.toLowerCase() === binding.key;
}

/** Reads a platform name — from either source — into one of the three. */
export function platformFromName(name: string): Platform | undefined {
  if (/mac|iphone|ipad|ipod/i.test(name)) return "mac";
  if (/win/i.test(name)) return "windows";
  if (name.trim() === "") return undefined;
  return "linux";
}

/** Detects the platform, or undefined where there is nothing to ask — a server. */
export function detectPlatform(): Platform | undefined {
  if (typeof navigator === "undefined") return undefined;
  // Truthiness rather than `??`: Chrome reports `userAgentData.platform` as an
  // empty string often enough that treating "present" as "answered" mis-detects a
  // Mac as the fallback. An empty hint is not an answer.
  const hint = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform;
  // `userAgentData` is Chromium-only, so `platform` remains the fallback. It is
  // deprecated in the spec and universally present in practice; CodeMirror reads
  // the same thing, and agreeing with it matters more than agreeing with the spec.
  return platformFromName(hint || navigator.platform || "");
}

/**
 * The platform in force. The fallback is Ctrl-based rather than macOS on purpose:
 * Windows reserves every Windows-key combination at the system level, so macOS
 * defaults guessed onto Windows lose four shortcuts out of five, while Windows
 * defaults guessed onto macOS all still arrive — merely unidiomatically.
 */
export function resolvePlatform(platform?: Platform): Platform {
  return platform ?? detectPlatform() ?? "windows";
}

/**
 * Every rebindable command with the keys it ships with, in settings-list order.
 * Names come from the text bag rather than from here, so one override translates
 * the settings screen and the panel's tooltips together.
 */
export function commands(platform?: Platform, text: HexText = defaultText): readonly Command[] {
  const defaults = keyDefaults[resolvePlatform(platform)];
  return commandOrder.map((id) => ({ id, label: text.commands[id], defaultKeys: defaults[id] ?? [] }));
}

/** How a binding is written back out, for a tooltip or a settings row. */
export function formatBinding(text: string, platform: Platform): string {
  if (platform !== "mac") return text.replace(/\bMod\b/g, "Ctrl").replace(/\bMeta\b/g, "Win");
  // Apple's order and no separators, which is what a Mac user expects to read.
  const binding = parseBinding(text);
  const key = binding.code?.replace(/^Key|^Digit/, "") ?? binding.key ?? "";
  return [
    binding.ctrl ? "⌃" : "",
    binding.alt ? "⌥" : "",
    binding.shift ? "⇧" : "",
    binding.meta || binding.mod ? "⌘" : "",
    namedSpellings.get(key) ?? key.toUpperCase(),
  ].join("");
}

/** One resolved key, paired with the command it runs. What `commandFor` searches. */
export interface KeyLookupEntry {
  binding: Binding;
  id: CommandId;
}

/** What `resolveKeymap` answers: the bindings to show, and the table to match against. */
export interface ResolvedKeymap {
  /** Every command with the keys it ended up with — a host renders this. */
  bindings: readonly Keybinding[];
  /** Matching order, which is not display order: more specific bindings first. */
  lookup: readonly KeyLookupEntry[];
}

/**
 * Defaults merged with the host's overrides, checked. Throws rather than warning:
 * a bad keymap is a programming error and should not wait for a user to press
 * something to be discovered.
 */
export function resolveKeymap(platform: Platform, overrides: Keymap = {}, text: HexText = defaultText): ResolvedKeymap {
  const known = new Set<string>(commandOrder);
  for (const id of Object.keys(overrides)) {
    if (!known.has(id)) throw new Error(`Unknown command "${id}" in keymap`);
  }
  const reservedKeys = new Map<string, string>();
  for (const text of reserved) reservedKeys.set(signature(parseBinding(text), platform), text);
  const blocked = new Map<string, string>();
  for (const text of unreachable[platform]) blocked.set(signature(parseBinding(text), platform), text);

  const bindings: Keybinding[] = [];
  const lookup: KeyLookupEntry[] = [];
  const taken = new Map<string, CommandId>();
  for (const { id, label, defaultKeys } of commands(platform, text)) {
    const override = overrides[id];
    const keys = override === undefined ? defaultKeys : override === null ? [] : typeof override === "string" ? [override] : override;
    for (const text of keys) {
      const binding = parseBinding(text);
      const key = signature(binding, platform);
      const clashesWithReserved = reservedKeys.get(key);
      if (clashesWithReserved !== undefined) {
        throw new Error(`"${text}" cannot be bound to ${id}: ${clashesWithReserved} belongs to the platform`);
      }
      const cannotArrive = blocked.get(key);
      if (cannotArrive !== undefined) {
        throw new Error(`"${text}" cannot be bound to ${id}: ${platform} takes it before the page sees it`);
      }
      // Every Windows-key combination is reserved by Windows itself, whether or not
      // a shortcut is defined on it, and Linux window managers take Super. So an
      // explicit Meta is unusable off macOS rather than merely contested — on macOS
      // Meta is Command, which is where the defaults live.
      if (platform !== "mac" && binding.meta) {
        throw new Error(`"${text}" cannot be bound to ${id}: ${platform} reserves the Meta key`);
      }
      const already = taken.get(key);
      if (already !== undefined) throw new Error(`"${text}" is bound to both ${already} and ${id}`);
      taken.set(key, id);
      lookup.push({ binding, id });
    }
    bindings.push({ id, label, keys });
  }
  return { bindings, lookup };
}

/** Two bindings that the same event satisfies produce the same signature. */
function signature(binding: Binding, platform: Platform): string {
  const meta = binding.meta || (binding.mod && platform === "mac");
  const ctrl = binding.ctrl || (binding.mod && platform !== "mac");
  return [meta ? "M" : "", ctrl ? "C" : "", binding.alt ? "A" : "", binding.shift ? "S" : "", binding.code ?? binding.key].join("-");
}

/** The command a key press runs, or undefined when it runs none. */
export function commandFor(
  lookup: readonly KeyLookupEntry[],
  input: KeyInput,
  platform: Platform,
): CommandId | undefined {
  for (const entry of lookup) {
    if (matches(entry.binding, input, platform)) return entry.id;
  }
  return undefined;
}
