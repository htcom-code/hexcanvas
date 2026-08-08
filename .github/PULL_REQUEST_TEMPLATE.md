<!--
Pull requests are squashed, so this body is what survives into the history.
Write it for the reviewer and for whoever reads `git log` in a year.
-->

## What this changes and why

<!-- Why, not what — the diff already says what. If it fixes something, say how the
     defect showed itself, not just which line was wrong. -->

## Where to look first

<!-- The part you are least sure of, or the one a reviewer would otherwise skim past.
     Naming it is not an admission; it is the most useful line in the body. -->

## Verification

- [ ] `pnpm check` — build, type-check, core suite
- [ ] `pnpm api` — the public surface still matches its committed report
- [ ] `pnpm test:browser` — headless browser suite

<!-- If `pnpm api` changed the report, that is a change to what consumers can see. Say
     what moved and why here; a release cannot take an API back. -->

## Invariants

The six in CONTRIBUTING. Tick only what the change actually touches, and if one of them
had to give, say so rather than leaving it unticked.

- [ ] One chrome — no binding grew a panel of its own
- [ ] One layout instance — drawing and hit-testing still read the same one
- [ ] `peek` still does not await
- [ ] `ChangeSet` still in pre-change coordinates; held offsets mapped
- [ ] The editor still does not change its own edit mode
- [ ] Nothing the API names is unexported

<!-- If the change claims speed, put the `pnpm bench` numbers here, before and after.
     If a test exists to pin this change, say what a wrong implementation would do to
     it — a test that passes against the broken version is not pinning anything. -->

## Follow-ups

<!-- Anything deliberately left out, and why it is safe to leave. Delete if none. -->
