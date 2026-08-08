# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

All five packages release as one version — they depend on each other, and independent
version lines would multiply into combinations nobody tests.

## [Unreleased]

Nothing since 0.1.0-next.0.

## [0.1.0-next.0] — 2026-08-08

The first release. It carries the **`next` dist-tag and nothing carries `latest`**, so
installing it means asking for it by name:

```sh
npm install @hexcanvas/core@next
```

`npm install @hexcanvas/core` is an error rather than an older version, which is the
intended shape: the decoration API changed twice in a single session before this was
public, and pinning `latest` now would make the next change a breaking one for anyone who
typed the short command. A caret range does not reach this version either — npm excludes
prereleases from ranges — so nobody receives it without asking.

What exists is described in [README.md](README.md), down to the costs that are known and
accepted; what will not exist is in [ROADMAP.md](ROADMAP.md).

### Fixed

Defects found while preparing this release. They are listed in the first release rather
than left out because they say what kind of mistake this project makes — all eight are
things a consumer would have met and no test could see.

- **Types named by the public API but not exported.** `parseBinding()` could be called
  and its return type could not be written down; the same for the Svelte action's return.
  `Binding`, `ActionReturn`, `ResolvedKeymap` and `KeyLookupEntry` are exported now, and
  an API report is committed so it cannot happen quietly again.
- **Documentation on setters.** Eight element properties carried their doc comment on the
  setter, where an editor does not read it — the property looked undocumented on hover.
- **Source maps in the published tarballs.** Every emitted file shipped a `.js.map` and a
  `.d.ts.map` resolving against a `src/` that `files` does not publish: two thirds of the
  package weight for a link to nothing. Maps are off, and `check:publish` fails on a stray
  one.
- **Package links pointing at a host consumers cannot reach.** The five package READMEs —
  which ship inside the tarballs and render on the package page — still linked to the
  private repository this was developed in.
- **`engines` missing.** No manifest declared the Node it is built against.
- **The browser suite ran one engine.** Adding WebKit found two things chromium
  could not: a fixture that hard-coded a 640px canvas, which the same font's wider
  metrics on WebKit overflowed — taking all 25 renderer assertions with it as a
  skipped precondition rather than a failure — and an exact pixel comparison
  between the batched and per-byte drawing paths that holds only where the engine
  rounds the way chromium does. Neither was a defect in the editor, which is the
  useful part of the answer.
- **A scroll to a row boundary did not land on it in Firefox.** Gecko does not hand
  back the offset you assigned — 11000 comes out as 10999.650390625 — which floored
  to the row above and put the wrong line at the top of the viewport. A host asking
  for `row * rowHeight` got row 499 when it asked for 500. Rows now tolerate half a
  pixel at the boundary; the bound is pinned from both sides, because a larger one
  would stop painting a row that is genuinely still on screen.
- **Undocumented public surface.** 312 of 924 members had no doc comment, including the
  props and options that *are* the whole API for a React or Svelte consumer. Those are at
  zero; the rest is down to 132, with the remainder being platform callbacks and button
  labels where a comment would restate the name.

[Unreleased]: https://github.com/htcom-code/hexcanvas/compare/v0.1.0-next.0...main
[0.1.0-next.0]: https://github.com/htcom-code/hexcanvas/releases/tag/v0.1.0-next.0
