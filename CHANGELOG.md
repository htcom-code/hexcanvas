# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

All five packages release as one version — they depend on each other, and independent
version lines would multiply into combinations nobody tests.

## [Unreleased]

Nothing has been published. The version in every manifest is `0.1.0`, which is a
placeholder rather than a released version; the first release will carry the `next`
dist-tag rather than `latest`, because the decoration API changed shape twice in a
single session and pinning `latest` would make the change after that a breaking one.

What exists is described in [README.md](README.md), down to the costs that are known and
accepted; what will not exist is in [ROADMAP.md](ROADMAP.md). This file starts describing
releases once there is one.

### Fixed

Defects found while preparing the first release. They are listed before there is a
release because they say what kind of mistake this project makes — all six are things a
consumer would have met and no test could see.

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
- **Undocumented public surface.** 312 of 924 members had no doc comment, including the
  props and options that *are* the whole API for a React or Svelte consumer. Those are at
  zero; the rest is down to 132, with the remainder being platform callbacks and button
  labels where a comment would restate the name.

[Unreleased]: https://github.com/htcom-code/hexcanvas/commits/main
