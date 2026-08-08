# Security Policy

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private reporting —
[Security → Report a vulnerability](https://github.com/htcom-code/hexcanvas/security/advisories/new)
— or email <htjulia1@gmail.com>.

Please include what you would need yourself to reproduce it: the input, the offsets, the
package and version, and the browser. A proof of concept that runs is worth more than a
description of one.

Expect an acknowledgement within a week. This is a small project with no on-call, so a
fix window depends on the finding; you will get a real estimate rather than a promise.

## What happens after you report

The report is triaged against the scope below and you are told which side it landed on
and why — including when the answer is "this is the host's boundary", because that
reasoning is the useful part of a decline.

A fix ships as a normal release, with a GitHub advisory naming the versions affected. You
are credited in it unless you ask not to be. There is no bounty; nothing here is funded.

Please give the fix a chance to ship before disclosing publicly. If it is taking too long,
say so — an unfixed report going public is a fair response to silence, not a breach of
anything.

## Supported versions

Nothing is published yet. Once it is, the current minor line receives fixes; older lines
do not, unless the finding is severe and the upgrade path is not.

## What is in scope

HexCanvas renders and edits bytes that a host hands it. The host decides where those
bytes come from, so most of the interesting surface is about **untrusted input being
rendered or parsed**:

- A byte sequence that makes the renderer, the layout, or the hit test loop, hang, or
  read out of bounds.
- A decoration source, `ByteSource`, `DiffProvider` or `SearchProvider` whose returned
  offsets are out of range or overlapping in a way the engine does not survive.
- Text that reaches the DOM through a label, an announcement, or the find panel and is
  interpreted rather than displayed.
- A path that lets page script reach something the embedding host did not offer it.

## What is not

- **Denial of service by size.** Handing the editor a document larger than the machine
  can hold, or a decoration set of tens of millions of ranges, is expected to be slow.
  Those costs are measured rather than guessed at — `pnpm bench` is where — and the
  README says which of them a host is expected to plan around.
- **The host's own choices.** HexCanvas does not fetch, authenticate, or persist
  anything. If a `ByteSource` reads a file the user should not have, that is the host's
  boundary, not this library's.
- **Dependencies of the playground.** `demo/` is a development page, not shipped in any
  package.
