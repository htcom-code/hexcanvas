# Roadmap

What this library is not going to do, and why. A missing feature and a declined one
look identical from outside, so the declines are written down — most of what follows was
decided against after being tried or measured, not before.

What it *does* do is in [README.md](README.md).

## Declined

### 🚫 A CommonJS build

ESM only. The consumers are browsers and bundlers, and every one of them has handled ESM
for years. `require()` fails with a clear error rather than half-working, which is the
better of the two outcomes for someone who reaches for it by accident.

### 🚫 A stylesheet

There is nothing to import. Structural styles are inline because overriding them breaks
the editor; appearance is `--hexcanvas-*` custom properties. A stylesheet cannot reach a
canvas — the grid's colours have to be readable from script — so shipping one would mean
declaring every colour twice and watching the two drift.

### 🚫 Options for the renderer's own cell arithmetic

`rowHeight - 4`, the ±2 around a fill, the caret box. Each is tied to one drawing
operation, so an option for it would freeze the renderer's internals into the API for a
flexibility nobody has asked for — and the browser suite pins every one of them pixel for
pixel, so they are also what would have to be re-baselined.

They are named constants with their reasons attached, which is the part of the request
that was real: the same `2` meant a row inset, a fill's padding and a gutter stripe's
offset in three different places.

### 🚫 `maxScrollHeight` as a setting

It is a fact about what a browser will lay out, not a preference.

### 🚫 A list of code pages the library knows

The plain-text column takes a `printable` function instead. Any list would be missing the
one somebody needs, and three named encodings (`ascii`, `cp437`, `latin1`) cover what a
hex editor is actually asked for. A function must return exactly one character per byte —
the column is a grid of fixed cells — and `printableTable` substitutes for anything else,
so a host cannot break the layout by accident.

### 🚫 Two cursors in a comparison

`HexCompare` answers `differenceIndex` from the left pane. Two cursors moving
independently cannot both be "where you are", and picking whichever pane has focus would
make the count jump as focus moved. This is a decision rather than a defect, and it is
the one most likely to be revisited if someone shows a case it gets wrong.

### 🚫 Edit mode as two values

`EditMode` is one of `"read-only" | "overwrite" | "insert"`, not a mode plus a read-only
flag. Read-only makes the other two meaningless, so a separate flag could describe states
that do not exist. `engine.readOnly` is a getter over it.

### 🚫 The editor changing its own edit mode

There is no `Insert` key binding. That key does not exist on every keyboard, so a binding
would be unreachable on some machines — and the mode belongs to the host, which knows
whether the document may be written to. Render your own control for it.

### 🚫 Splitting the packages further

Five packages, one per framework surface. The whole feature set is about 30 kB min+gz,
which is not enough to be worth subpath exports and the version skew they bring. If a
consumer's bundle ever makes the case with a measurement, the exports can be split then.

## Deliberately unfinished

Not declines — things that are known to be partial, so nobody has to discover them.

| | State |
|---|---|
| **Screen reader** | The accessibility tree is audited by tests driving real keystrokes. **How it sounds has never been checked with a real screen reader** — verbosity, ordering, and how hex pairs are pronounced are unverified |
| **Firefox** | The browser suite runs chromium and WebKit. Gecko is untested — its canvas text metrics are a third implementation |
| **What the grid looks like** | The suite reads pixels back off the canvas, which pins geometry and continuity but not appearance. A change in glyph rendering passes as long as the probes still land |
| **Find and encodings** | Find encodes a text query as UTF-8. Below 0x80 that agrees with any code page; above it, a text query for a code-page character finds nothing. Hex mode is the exact answer |
| **In-place save** | `savePatch()` is exact about "is this the document that was written out" and conservative about everything else — a range whose bytes happen to match again stays dirty, because knowing better would mean keeping a copy |

## How to argue with this page

Open an issue with the case rather than the feature. A decline that turns out to be wrong
is worth reversing, and the ones above each say what would make them wrong — a bundle
measurement, a comparison whose left-pane cursor gives the wrong answer, a code page the
`printable` function cannot express.
