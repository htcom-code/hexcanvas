# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

All five packages release as one version — they depend on each other, and independent
version lines would multiply into combinations nobody tests.

## [Unreleased]

### Fixed

- **A range covering no byte no longer breaks the decoration indexes.** One zero-length
  range was enough to make `new IntervalIndex(...)` exhaust the stack: a range with
  `start === end` cannot satisfy the centre test the build sorts on, so it was handed
  down a level at every step and, once alone in a list, split into itself for ever. A
  parser produces such ranges — a zero-length record is a fact about the file — so a
  consumer lost the whole view over one of them. `IntervalColumns` did not hang, but it
  reported an empty range as overlapping any query that contained it, which
  `DecorationStore.between` passed on to the renderer. Both indexes now leave out a range
  with `end <= start`, which is what half-open already means and what
  `DecorationStore.map` already did with a range an edit had emptied.
- **A range reaching to infinity is indexed instead of hanging.** Its midpoint is not
  finite, and a centre of `Infinity` pushes every range into one child — the same
  non-terminating split by another route. The centre falls back to a median start, which
  a range always covers, so the build makes progress whatever the bounds are. Finite
  ranges take the measured midpoint heuristic as before.

## [0.1.0] — 2026-08-08

The first stable release. Same code as `0.1.0-next.0`; what changed is how it is
released and what the version promises.

```sh
npm install @hexcanvas/core
```

**`0.1.0` is a first release, not a settled API.** Below 1.0.0 the minor is the breaking
position — `^0.1.0` resolves to `>=0.1.0 <0.2.0-0` — so a caret range will not carry a
consumer across a change of shape. That is the intended reading: the decoration surface
changed twice in a single session before this was public.

### Changed

- **Releases are staged rather than published.** A tag builds the release, proves it
  installs from a registry, and leaves it in npm's staging area; it becomes installable
  only when a maintainer approves it, which needs 2FA. A rejected stage frees its version
  number, so "not yet" costs nothing — the only gate in this repository that survives the
  irreversible step.
- **Published through OIDC.** The workflow holds no npm credential. The token used for
  `0.1.0-next.0` is revoked; a trusted publisher tied to this repository and workflow
  replaces it.
- **Provenance is attached.** `0.1.0-next.0` shipped without it: `pnpm publish` never
  reads the `provenance` setting, so the attestation was silently skipped despite the
  configuration and a working id-token. Releases are packed with pnpm — which is what
  rewrites `workspace:*` — and staged with npm, which does have the flag.

## [0.1.0-next.0] — 2026-08-08

The first release, and a prerelease:

```sh
npm install @hexcanvas/core
```

It was published with `--tag next` so that `latest` would keep pointing at a stable
version — the decoration API changed shape twice in a single session before this was
public, and a `latest` that means "prerelease" is a trap for anyone who types the short
command. **That is not what happened.** npm gives a brand-new package a `latest` tag
whatever `--tag` says, because a package is not allowed to have none, so this version is
both `latest` and `next`. The flag only controls the tag on releases after the first.

The practical difference is small — there is no stable version to be preferred over —
but it is the opposite of what was intended, and the documentation said the opposite
until this was measured on the registry.

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

[Unreleased]: https://github.com/htcom-code/hexcanvas/compare/v0.1.0...main
[0.1.0]: https://github.com/htcom-code/hexcanvas/compare/v0.1.0-next.0...v0.1.0
[0.1.0-next.0]: https://github.com/htcom-code/hexcanvas/releases/tag/v0.1.0-next.0
