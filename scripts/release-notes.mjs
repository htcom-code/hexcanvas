// The body of a GitHub Release, taken from the version's section of CHANGELOG.md.
//
// The changelog stays the record; the Release only carries it to where GitHub readers
// look. So this copies the section rather than writing anything new, and adds two
// lines: the date the version was released — a Release created later shows its own
// creation time, and cannot be backdated — and the compare link the changelog already
// keeps for that version.
//
// It fails when the section is missing. The release workflow runs it before anything is
// staged, so a tag cut without its changelog entry stops there instead of leaving an
// empty Release beside a staged version.
//
//   node scripts/release-notes.mjs          # the version in the manifests
//   node scripts/release-notes.mjs 0.2.0    # a named version
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const version =
  process.argv[2] || JSON.parse(readFileSync(join(root, "packages/core/package.json"), "utf8")).version;
const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");

// Every link definition in the file, so a section that uses one defined elsewhere still
// renders; the version compare links at the bottom are among them.
const definitions = new Map(
  [...changelog.matchAll(/^\[([^\]]+)\]: (\S+)$/gm)].map(([, label, url]) => [label, url]),
);

const heading = new RegExp(`^## \\[${version.replaceAll(".", "\\.")}\\] — (\\S+)$`, "m");
const found = heading.exec(changelog);
if (!found) {
  console.error(`CHANGELOG.md has no "## [${version}] — <date>" section to release.`);
  process.exit(1);
}
const [, date] = found;
const rest = changelog.slice(found.index + found[0].length);
const next = rest.search(/^## /m);

// The version compare definitions belong to the file's footer, not to one section; the
// last section before the footer would otherwise carry all of them.
let body = (next === -1 ? rest : rest.slice(0, next))
  .replace(/^\[(Unreleased|\d[^\]]*)\]: .*$\n?/gm, "")
  .trim();
if (!body) {
  console.error(`CHANGELOG.md's section for ${version} is empty.`);
  process.exit(1);
}

const used = new Set([...body.matchAll(/\[([^\]]+)\](?!\()/g)].map(([, label]) => label));
const missing = [...used]
  .filter((label) => definitions.has(label) && !body.includes(`[${label}]:`))
  .sort();
if (missing.length > 0) {
  body += `\n\n${missing.map((label) => `[${label}]: ${definitions.get(label)}`).join("\n")}`;
}

const compare = definitions.get(version);
process.stdout.write(
  `Released ${date}.\n\n${body}${compare ? `\n\n**Full changelog:** ${compare}` : ""}\n`,
);
