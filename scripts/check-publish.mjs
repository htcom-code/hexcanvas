// What the registry will actually receive, checked before it receives it.
//
// npm keeps a published version forever — unpublishing frees no version number —
// so the mistakes worth catching are the ones that are only visible in the
// tarball: a missing README (a blank package page), a `workspace:*` range that
// pnpm failed to rewrite (an uninstallable package), a `dist` that was never
// built. Packing is the only way to see them, so this packs.
//
//   node scripts/check-publish.mjs          # check the tarballs
//   node scripts/check-publish.mjs 0.1.0    # ...and that every version is 0.1.0
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const expected = process.argv[2];
const root = new URL("..", import.meta.url).pathname;
const required = ["package/README.md", "package/LICENSE", "package/package.json"];

const packages = readdirSync(join(root, "packages"))
  .map((dir) => join(root, "packages", dir))
  .map((dir) => ({ dir, manifest: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) }))
  .filter(({ manifest }) => !manifest.private);

const failures = [];
const fail = (name, message) => failures.push(`${name}: ${message}`);

const versions = new Set(packages.map(({ manifest }) => manifest.version));
if (versions.size > 1) {
  fail("workspace", `versions disagree — ${[...versions].join(", ")}. One tag releases all five.`);
}
if (expected && !(versions.size === 1 && versions.has(expected))) {
  fail("workspace", `expected version ${expected}, found ${[...versions].join(", ")}`);
}

const staging = mkdtempSync(join(tmpdir(), "hexcanvas-publish-"));
try {
  for (const { dir, manifest } of packages) {
    const { name } = manifest;
    // pnpm rewrites `workspace:*` into a real range as it packs; npm does not,
    // which is why publishing must go through pnpm.
    const output = execFileSync("pnpm", ["pack", "--pack-destination", staging], { cwd: dir, encoding: "utf8" });
    const tarball = output.trim().split("\n").at(-1);

    const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).split("\n");
    for (const file of required) {
      if (!entries.includes(file)) fail(name, `${file.replace("package/", "")} is missing from the tarball`);
    }
    if (!entries.some((entry) => entry.endsWith(".js"))) fail(name, "no built output — run pnpm build first");
    if (!entries.some((entry) => entry.endsWith(".d.ts"))) fail(name, "no type declarations in the tarball");
    // A map resolves against `../src`, which `files` does not publish, so one that
    // reaches the registry is dead weight pointing at nothing. The build emits none
    // (tsconfig.base.json); this catches a `dist` left over from one that did.
    const maps = entries.filter((entry) => entry.endsWith(".map"));
    if (maps.length > 0) fail(name, `${maps.length} source map(s) in the tarball — rebuild, they reference unpublished src`);

    const packed = JSON.parse(execFileSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" }));
    for (const [dependency, range] of Object.entries(packed.dependencies ?? {})) {
      if (String(range).startsWith("workspace:")) fail(name, `${dependency} is still ${range} — pack with pnpm, not npm`);
    }
    for (const field of ["description", "license", "author", "homepage", "repository", "engines"]) {
      if (!packed[field]) fail(name, `${field} is missing`);
    }

    console.log(`${name}@${packed.version}  ${entries.filter(Boolean).length} files`);
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} problem(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`\nAll ${packages.length} packages are publishable${expected ? ` as ${expected}` : ""}.`);
