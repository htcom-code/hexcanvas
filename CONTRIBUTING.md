# Contributing

Thanks for looking. HexCanvas is a library other people embed, so the bar is less
"does it work" and more "will it still be true in six months for a consumer we have
never met".

## The gate

Three commands. They are the same three CI jobs, so a green set locally is a green
pipeline:

```bash
pnpm check         # build, type-check every package and the playground, run the core suite
pnpm api           # the public API still matches the committed report
pnpm test:browser  # the headless browser suite — the renderer and all four bindings
```

**`pnpm api` failing is usually not a mistake.** It compares what the build emits
against the report in `packages/*/etc/*.api.md`, so it fails whenever the public
surface moves — which is exactly when someone should look. Run `pnpm api:update`,
read the diff, and say in the pull request what changed and why. A release cannot
take an API back.

It also fails on a type the API names but does not export: a consumer can call the
function and cannot write down what it returns. Two of those were found the first
time this ran.

`pnpm api:docs` regenerates the reference from the sources with typedoc, with its
warnings treated as errors — a broken `{@link}` or an undocumented reference stops
there. The JSON it writes is what the documentation site reads, so the site is never
a second copy of the API kept by hand.

`pnpm bench` exists for the indexed paths (decorations, the piece tree, search). It is
not part of the gate; run it when you touch one of them and quote the before and after.

`pnpm check:publish` packs all five packages and reads the tarballs back. Run it if you
touch a manifest, `files`, `exports`, or anything about the build's output — the mistakes
it catches are only visible inside the archive, and a published version cannot be edited.

Node 22 and pnpm 11 (`corepack enable` picks up the pinned version).

## Where things are

| Path | What is in it |
| --- | --- |
| `packages/core` | `ByteSource`, layout, the canvas renderer, `HexEngine`. No DOM chrome, no framework |
| `packages/element` | `<hexcanvas-editor>` and `<hexcanvas-compare>` — the chrome, in a shadow root |
| `packages/react`, `vue`, `svelte` | Forwarding layers over that element. No editor logic belongs here |
| `demo` | The playground, and a subject of the browser suite in its own right |
| `packages/*/test` | Unit suites — anything that needs no DOM |
| `test/browser` | The pixel-level suite: the renderer, and all four bindings against one shared list |
| `packages/*/bench` | The two structures where cost, not correctness, is the risk |
| `packages/*/etc` | The committed API report. Generated — edit the code, then `pnpm api:update` |
| `config/` | Shared tool configuration; `api-extractor-base.json` is the API gate's |
| `tools/docs` | TypeDoc, in a package of its own because it needs a TypeScript the build does not use |

Where a test goes follows from what it can see. Logic that can be checked without a
canvas belongs in a package's own suite, because it runs in a second. Anything about what
is *painted* — geometry, continuity, whether a click lands on the byte that was drawn —
has to be in `test/browser`, which reads pixels back off the canvas.

A change to the chrome or to any binding goes in the shared expectation list rather than
in a per-binding test, or the bindings drift and nothing notices.

## What must not break

Six invariants. Each is load-bearing somewhere that a test cannot easily reach, so they
are written down rather than left to be rediscovered. If a change needs one of them to
give, say so in the pull request — they are not sacred, but breaking one silently is how
this editor stops working in a way nobody can trace.

1. **One chrome.** Every binding wraps `<hexcanvas-editor>`. A binding that draws a panel
   of its own is a second implementation, and the four will drift. React had one for a
   while; converging cost less than keeping it.
2. **One layout instance.** The renderer and the pointer handling read the same
   `HexLayout`. Two instances mean what is drawn and what is clicked disagree, which
   shows up as a caret that lands one byte off — and only at certain widths.
3. **`peek` cannot await.** The renderer calls it inside a frame. Anything that needs to
   wait belongs behind `ensure`, and a row whose bytes are not resident draws as pending.
4. **A `ChangeSet` is in pre-change coordinates.** Applying replacements one at a time
   and remapping as you go is the bug this shape exists to prevent. Anything holding an
   offset across an edit maps it with `changes.mapPos`.
5. **The editor never changes its own edit mode.** Read-only is the host's statement about
   the document, not a UI state the editor may leave.
6. **The public API is what the report says.** `packages/*/etc/*.api.md` is committed;
   `pnpm api` fails when the surface moves. A type the API names must be exported, or a
   consumer can call the function and cannot write down what it returns.

## Making a change

Branch off `main` as `<type>/<short-description>` — lowercase and hyphenated, named for
the unit of work rather than the edit. Types: `feat` `fix` `refactor` `chore` `docs`
`test` `perf` `style` `ci`.

Commits follow [Conventional Commits](https://www.conventionalcommits.org/): a subject
under 50 characters, imperative and lowercase, no trailing period. The body is for
**why**, wrapped at 72 columns. What changed is already in the diff; why it changed is
not, and it is the part that is expensive to reconstruct later.

Open a pull request against `main`. Pull requests are squashed, so the pull request
body — not the intermediate commits — is what survives into the history. Put the
reasoning there, and lead with what a reviewer should be suspicious of.

## What a change is expected to carry

**A test that fails without it.** For a bug, the test should reproduce the report; for a
behaviour change, it should pin the new behaviour in a way that a plausible-but-wrong
implementation would not pass. Several tests in this repository exist because a
deliberate mutation of the code survived the suite — if you can break your change and
the suite stays green, the test is not finished.

**A measurement, if the claim is about speed.** `pnpm bench` numbers, before and after,
in the pull request body. "Should be faster" is not a review-able claim, and this
repository has a history of the guess being wrong about *where* the cost was.

**The reasoning, in the commit body or the pull request** if the change reverses a
decision the code currently encodes. Comments here record why a thing is the way it is,
so a change that makes one of them wrong has to say what replaced it — otherwise the
next reader trusts a comment that is no longer true.

**Nothing in `CHANGELOG.md` yet.** Nothing is published, so there is no released version
to describe. Entries go under `[Unreleased]` once the first release is cut.

## Style

Match the file you are editing: its comment density, its naming, its idioms. Comments
explain why a thing is the way it is, not what the line does — the interesting ones in
this codebase record a measurement, a rejected alternative, or a trap.

Code, comments, commits, pull requests and tests are written in English.

## Reporting instead

A bug report or a design question is a contribution. Use the issue templates; a hex
dump, the byte offsets, and the browser you saw it in are worth more than a description
of the symptom.

Security issues do not go in the issue tracker — see [SECURITY.md](SECURITY.md).
